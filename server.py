"""Local backend: fetch a Lichess user's games, extract puzzles in parallel, serve the UI.

    python server.py            # then open http://127.0.0.1:8765

Endpoints:
    POST /api/analyse   {"username": "...", "blitz": 20, "rapid": 10}  -> {"job": "<id>"}
    GET  /api/job/<id>  -> progress + puzzles found so far, grouped by blitz / rapid
Everything else is served from ./ui
"""
import argparse
import io
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import chess
import chess.engine
import chess.pgn

from puzzle_worker import analyse_game

ROOT = Path(__file__).resolve().parent
UI_DIR = ROOT / "ui"
DEFAULT_ENGINE = str(ROOT / "stockfish" / "stockfish-windows-x86-64-universal.exe")
USER_AGENT = "chess-puzzle-project (personal, local)"
USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{2,30}$")
MAX_PER_PERF = 100

JOBS = {}
JOBS_LOCK = threading.Lock()
POOL = None
CFG = {"engine": DEFAULT_ENGINE, "depth": 18}


class ApiError(Exception):
    pass


# --- native eval (one persistent engine, one position at a time) ---
EVAL = {"engine": None}
EVAL_LOCK = threading.Lock()


def _eval_engine():
    if EVAL["engine"] is None:
        e = chess.engine.SimpleEngine.popen_uci(CFG["engine"])
        e.configure({"Threads": 1, "Hash": 128})
        EVAL["engine"] = e
    return EVAL["engine"]


def close_eval_engine():
    with EVAL_LOCK:
        if EVAL["engine"] is not None:
            try:
                EVAL["engine"].quit()
            except Exception:
                pass
            EVAL["engine"] = None


def native_eval(fen, depth):
    """Evaluate one position. Scores are from White's point of view. Raises ValueError on a bad FEN."""
    board = chess.Board(fen)
    if board.is_game_over():
        return {"over": True, "result": board.result(), "engine": "native"}
    t0 = time.time()
    with EVAL_LOCK:
        for attempt in (0, 1):
            try:
                info = _eval_engine().analyse(board, chess.engine.Limit(depth=depth))
                break
            except (chess.engine.EngineTerminatedError, chess.engine.EngineError):
                EVAL["engine"] = None  # engine died: restart once
                if attempt:
                    raise
    score = info["score"].white()
    pv = info.get("pv") or []
    return {"over": False, "cp": score.score(), "mate": score.mate(), "depth": info.get("depth"),
            "best_san": board.san(pv[0]) if pv else None, "ms": round((time.time() - t0) * 1000), "engine": "native"}


def fetch_games(username, perf, count):
    """Latest `count` games of one speed from Lichess, as a list of PGN strings (clocks included)."""
    qs = urllib.parse.urlencode({"max": count, "perfType": perf, "clocks": "true", "opening": "false", "moves": "true"})
    url = f"https://lichess.org/api/games/user/{urllib.parse.quote(username)}?{qs}"
    req = urllib.request.Request(url, headers={"Accept": "application/x-chess-pgn", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            text = r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise ApiError(f"Lichess user '{username}' not found")
        if e.code == 429:
            raise ApiError("Lichess rate limit hit - wait a minute and try again")
        raise ApiError(f"Lichess returned HTTP {e.code}")
    except (urllib.error.URLError, TimeoutError) as e:
        raise ApiError(f"Could not reach Lichess: {e}")
    games = []
    stream = io.StringIO(text)
    while True:
        g = chess.pgn.read_game(stream)
        if g is None:
            break
        if g.headers.get("Variant", "Standard") != "Standard":
            continue
        games.append(g.accept(chess.pgn.StringExporter(headers=True, variations=False, comments=True)))
    return games


def run_job(job):
    try:
        job["phase"] = "fetching games"
        work = []  # (pgn, perf)
        for perf in ("blitz", "rapid"):
            n = job["counts"][perf]
            if n <= 0:
                continue
            games = fetch_games(job["username"], perf, n)
            job["fetched"][perf] = len(games)
            work += [(pgn, perf) for pgn in games]
        job["total"] = len(work)
        if not work:
            job["phase"], job["status"] = "done", "done"
            return
        job["phase"] = "analysing"
        idx = {"blitz": 0, "rapid": 0}
        futs = []
        for pgn, perf in work:
            futs.append(POOL.submit(analyse_game, (pgn, perf, job["username"], CFG["engine"], CFG["depth"], idx[perf])))
            idx[perf] += 1
        for f in as_completed(futs):
            res = f.result()
            with JOBS_LOCK:
                job["done"] += 1
                job["puzzles"][res["game"]["perf"]] += res["puzzles"]
                job["games"].append({k: res["game"].get(k) for k in
                                     ("game_id", "perf", "game_index", "opponent", "result", "time_control")}
                                    | {"puzzles": len(res["puzzles"]), "error": res["error"]})
        job["phase"], job["status"] = "done", "done"
    except ApiError as e:
        job["status"], job["error"] = "error", str(e)
    except Exception as e:
        job["status"], job["error"] = "error", f"{type(e).__name__}: {e}"


def snapshot(job):
    with JOBS_LOCK:
        puzzles = {p: sorted(v, key=lambda x: (x["game_index"], x["ply"])) for p, v in job["puzzles"].items()}
        return {
            "status": job["status"], "phase": job["phase"], "error": job["error"], "username": job["username"],
            "total": job["total"], "done": job["done"], "fetched": job["fetched"],
            "games": sorted(job["games"], key=lambda g: (g["perf"], g["game_index"])),
            "puzzles": puzzles,
        }


class Handler(SimpleHTTPRequestHandler):
    # Windows can map these from the registry wrongly; browsers refuse a module/WASM with the wrong type
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".wasm": "application/wasm"}

    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(UI_DIR), **k)

    def end_headers(self):
        if not self.path.startswith("/api/"):   # static files: always revalidate, so edits show up on a normal refresh
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/job/" not in (self.path or ""):
            super().log_message(fmt, *args)

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/eval"):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                depth = max(1, min(30, int(q.get("depth", ["18"])[0])))
                return self._json(200, native_eval(q.get("fen", [""])[0], depth))
            except ValueError:
                return self._json(400, {"error": "bad fen or depth"})
            except Exception as e:
                return self._json(500, {"error": f"{type(e).__name__}: {e}"})
        if self.path.startswith("/api/job/"):
            job = JOBS.get(self.path.rsplit("/", 1)[-1])
            return self._json(200, snapshot(job)) if job else self._json(404, {"error": "unknown job"})
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/analyse":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            username = str(req.get("username", "")).strip()
            if not USERNAME_RE.match(username):
                return self._json(400, {"error": "Enter a valid Lichess username"})
            counts = {p: max(0, min(MAX_PER_PERF, int(req.get(p, d)))) for p, d in (("blitz", 20), ("rapid", 10))}
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"error": "bad request"})
        job_id = uuid.uuid4().hex[:12]
        job = {"username": username, "counts": counts, "status": "running", "phase": "starting", "error": None,
               "total": 0, "done": 0, "fetched": {}, "games": [], "puzzles": {"blitz": [], "rapid": []}}
        with JOBS_LOCK:
            JOBS[job_id] = job
            for old in list(JOBS)[:-20]:  # keep the last 20 jobs
                del JOBS[old]
        threading.Thread(target=run_job, args=(job,), daemon=True).start()
        self._json(200, {"job": job_id})


def main():
    global POOL
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--engine", default=DEFAULT_ENGINE)
    ap.add_argument("--depth", type=int, default=18)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args()
    CFG.update(engine=args.engine, depth=args.depth)
    if not Path(args.engine).exists():
        raise SystemExit(f"Stockfish not found at {args.engine} (use --engine)")
    POOL = ProcessPoolExecutor(max_workers=args.workers)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"depth={args.depth} workers={args.workers}  ->  http://127.0.0.1:{args.port}   (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        POOL.shutdown(wait=False, cancel_futures=True)
        close_eval_engine()


if __name__ == "__main__":
    main()
