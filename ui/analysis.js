// Puzzle extraction that runs entirely in the browser (no backend): a JS port of
// pgn_puzzles.py + puzzle_worker.py, driving Stockfish 19 lite (WASM) in a pool of Web Workers.
//
//   Analysis.run({ username, blitz, rapid, onProgress, onUpdate }) -> handle { promise, cancel() }
//
// Same rules as the Python version: depth 18, MultiPV 2 at every position; puzzle if
// best >= 300, best-second >= 200, second < 150, best >= -50; only-move walk (max 4 solver moves,
// >= 2 required); critical depth 1..12; repeat-line suppression.
// Needs chess.js 0.10.3 (global `Chess`).
const Analysis = (() => {
  const WORKER_URL = 'vendor/stockfish/stockfish-19-lite-single.js';
  const DEPTH = 18, GAP = 200, WIN = 150, MIN_BEST = -50, MIN_ONLY = 2, MAX_SOLVER = 4, MATE_SCORE = 10000;
  const HASH_MB = 32;   // per worker (the Python run used 64; WASM memory is the constraint in a browser)

  class Cancelled extends Error {}

  // ---------- one Stockfish in a Web Worker, promise API ----------
  class UciEngine {
    constructor() {
      this.w = new Worker(WORKER_URL);
      this.mpv = 1; this.job = null; this.waiter = null; this.dead = null;
      this.w.onmessage = (ev) => this._line(String(ev.data));
      this.w.onerror = (ev) => {
        this.dead = new Error(ev.message || 'engine worker failed');
        if (this.job) { this.job.reject(this.dead); this.job = null; }
        if (this.waiter) { this.waiter.reject(this.dead); this.waiter = null; }
      };
    }
    _send(c) { this.w.postMessage(c); }
    _wait(token) {
      return new Promise((resolve, reject) => {
        if (this.dead) return reject(this.dead);
        this.waiter = { token, resolve, reject };
      });
    }
    async init() {
      this._send('uci'); await this._wait('uciok');
      this._send(`setoption name Hash value ${HASH_MB}`);
      this._send('isready'); await this._wait('readyok');
    }
    async newGame() {   // clears the hash between games so games do not influence each other
      this._send('ucinewgame'); this._send('isready'); await this._wait('readyok');
    }
    // -> [{cp, pv:[uci...]}] best-first, cp from the SIDE TO MOVE's view (mate scores -> +-(10000 - n)), like python-chess pov().score(mate_score=10000)
    search(fen, depth, multipv = 1) {
      return new Promise((resolve, reject) => {
        if (this.dead) return reject(this.dead);
        if (this.mpv !== multipv) { this._send(`setoption name MultiPV value ${multipv}`); this.mpv = multipv; }
        this.job = { resolve, reject, lines: [] };
        this._send('position fen ' + fen);
        this._send('go depth ' + depth);
      });
    }
    _line(l) {
      if (this.waiter && l === this.waiter.token) { const w = this.waiter; this.waiter = null; w.resolve(); return; }
      if (!this.job) return;
      if (l.startsWith('info ')) {
        const s = /\bscore (cp|mate) (-?\d+)/.exec(l), pv = / pv (.+)$/.exec(l);
        if (!s || !pv || /\b(lowerbound|upperbound)\b/.test(l)) return;
        const mp = /\bmultipv (\d+)/.exec(l), idx = (mp ? +mp[1] : 1) - 1, v = parseInt(s[2], 10);
        const cp = s[1] === 'cp' ? v : (v > 0 ? MATE_SCORE - v : -MATE_SCORE - v);
        this.job.lines[idx] = { cp, pv: pv[1].trim().split(/\s+/) };
      } else if (l.startsWith('bestmove')) {
        const j = this.job; this.job = null;
        j.resolve(j.lines.filter(Boolean));
      }
    }
    terminate() { try { this.w.terminate(); } catch (e) {} }
  }

  // ---------- chess helpers (chess.js 0.10.3) ----------
  const uciMove = (u) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? u[4] : undefined });
  const isOver = (c) => c.in_checkmate() || c.in_stalemate() || c.insufficient_material();
  const fullmove = (fen) => +fen.split(' ')[5];

  function sanOf(fen, uci) { const c = new Chess(fen); const m = c.move(uciMove(uci)); return m ? m.san : uci; }
  // python-chess variation_san style: "12. Qxh7+ Kxh7 13. Rh3+" / "12... Kxh7 13. Rh3+"
  function sanLine(fen, ucis) {
    const c = new Chess(fen), out = [];
    ucis.forEach((u, i) => {
      const turn = c.turn(), n = fullmove(c.fen()), m = c.move(uciMove(u));
      if (!m) return;
      out.push(turn === 'w' ? `${n}. ${m.san}` : (i === 0 ? `${n}... ${m.san}` : m.san));
    });
    return out.join(' ');
  }

  // ---------- the pgn_puzzles.py logic ----------
  async function analyseLines(eng, fen, depth, multipv = 2) {
    const lines = await eng.search(fen, depth, multipv);
    return lines.map(l => ({ cp: l.cp, move: l.pv[0], pv: l.pv }));
  }

  function isPuzzle(lines) {
    if (lines.length < 2) return false;                       // only one legal move -> forced
    const best = lines[0].cp, second = lines[1].cp;
    return best >= 300 && best - second >= GAP && second < WIN && best >= MIN_BEST;
  }

  async function countOnlyMoves(eng, fen, lines, depth, maxSolver = MAX_SOLVER) {
    const b = new Chess(fen);
    let count = 0;
    const solution = [];
    for (let i = 0; i < maxSolver; i++) {
      if (lines.length < 2) break;
      const best = lines[0].cp, second = lines[1].cp;
      if (!(best - second >= GAP && second < WIN)) break;
      count++;
      const pv = lines[0].pv;
      solution.push(pv[0]);
      b.move(uciMove(pv[0]));
      if (isOver(b) || pv.length < 2) break;
      b.move(uciMove(pv[1]));
      if (isOver(b)) break;
      solution.push(pv[1]);
      lines = await analyseLines(eng, b.fen(), depth);
    }
    if (solution.length === 2 * count) solution.pop();
    return { count, solution };
  }

  async function criticalDepth(eng, fen, bestMove, maxDepth = 12) {
    let firstOk = null;
    for (let d = 1; d <= maxDepth; d++) {
      const top = (await eng.search(fen, d, 1))[0].pv[0];
      if (top === bestMove) { if (firstOk === null) firstOk = d; } else firstOk = null;
    }
    return firstOk !== null ? firstOk : maxDepth + 1;
  }

  // puzzle Q is the tail of earlier puzzle P's line when the game followed P's solution (see puzzle_worker.is_repeat)
  function isRepeat(movesUci, pPly, pSol, pCapped, qPly, qSol) {
    const d = qPly - pPly;
    if (d <= 0 || d % 2) return false;
    if (d < pSol.length) return movesUci.slice(pPly, pPly + d).join(' ') === pSol.slice(0, d).join(' ') && qSol[0] === pSol[d];
    if (d === pSol.length + 1 && pCapped) return movesUci.slice(pPly, pPly + pSol.length).join(' ') === pSol.join(' ');
    return false;
  }

  function prettyTimeControl(tc) {
    const m = /^(\d+)(?:\+(\d+))?$/.exec(tc || '');
    if (!m) return tc || '?';
    const base = +m[1];
    return `${base % 60 === 0 ? base / 60 : (base / 60).toFixed(1)}+${+(m[2] || 0)}`;
  }

  // Chess.com writes the ending as a sentence ("X won by resignation", "Game drawn by repetition", "X won on time"); keep the reason only.
  function prettyTermination(t, fromChessCom) {
    if (!t || !fromChessCom) return t || '';
    const m = /\b(?:by|on)\s+(.+)$/i.exec(t), w = m ? m[1] : t;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }

  // ---------- PGN ----------
  function parsePgn(text) {
    const headers = {};
    text.replace(/^\[(\w+) "(.*)"\]\s*$/gm, (_, k, v) => { headers[k] = v; return ''; });
    const body = text.replace(/^\[.*\]\s*$/gm, ' ').replace(/\{[^}]*\}/g, ' ').replace(/\([^)]*\)/g, ' ')
      .replace(/\$\d+/g, ' ').replace(/\d+\.(\.\.)?/g, ' ').replace(/1-0|0-1|1\/2-1\/2|\*/g, ' ');
    const toks = body.split(/\s+/).filter(Boolean);
    const c = headers.FEN ? new Chess(headers.FEN) : new Chess();
    const startFen = c.fen(), moves = [];
    for (const t of toks) {
      const m = c.move(t, { sloppy: true });
      if (!m) break;
      moves.push({ uci: m.from + m.to + (m.promotion || ''), san: m.san, to: m.to });
    }
    return { headers, startFen, moves };
  }

  // ---------- one game, split into independent per-position tasks ----------
  // (puzzle_worker.analyse_game did all positions of a game on one engine; here any worker can take any position,
  //  and the order-dependent repeat rule runs once all of a game's positions are done)

  // Replay the game once: the FEN after every ply up to the first game-over position.
  function prepareGame(pgnText, perf, username, gameIndex) {
    const { headers: h, startFen, moves } = parsePgn(pgnText);
    const info = { perf, game_index: gameIndex };
    if (!moves.length) return { info, error: 'unreadable PGN', fens: [], moves: [] };
    const link = h.Link || '';   // only Chess.com PGNs have this
    const gameId = link ? 'cc' + link.replace(/\/+$/, '').split('/').pop() : (h.GameId || (h.Site || '?').replace(/\/+$/, '').split('/').pop());
    const white = h.White || '?', black = h.Black || '?';
    const userColor = white.toLowerCase() === username.toLowerCase() ? 'white' : 'black';
    const result = h.Result || '*';
    Object.assign(info, {
      game_id: gameId, white, black, opponent: userColor === 'white' ? black : white, user_color: userColor, result,
      date: h.UTCDate || h.Date || '?', time_control: prettyTimeControl(h.TimeControl),
      user_outcome: result === '1/2-1/2' ? 'draw'
        : (result === '1-0' || result === '0-1') ? (((result === '1-0') === (userColor === 'white')) ? 'won' : 'lost') : 'unknown',
      termination: prettyTermination(h.Termination, !!link), url: link,
    });
    const board = new Chess(startFen), fens = [];
    for (const m of moves) {
      board.move(uciMove(m.uci));
      if (isOver(board)) break;       // no analysis once the game is over (same as the Python loop)
      fens.push(board.fen());
    }
    return { info, moves, movesUci: moves.map(m => m.uci), fens, error: null };
  }

  // One position (ply = 1-based). Returns a candidate puzzle or null.
  async function analysePosition(eng, ctx, ply) {
    const fen = ctx.fens[ply - 1];
    await eng.newGame();               // clear the hash so a result does not depend on which worker ran what before
    const lines = await analyseLines(eng, fen, DEPTH);
    if (!isPuzzle(lines)) return null;
    const { count: onlyMoves, solution } = await countOnlyMoves(eng, fen, lines, DEPTH);
    if (onlyMoves < MIN_ONLY) return null;
    return { ply, fen, lines, onlyMoves, solution, critical: await criticalDepth(eng, fen, lines[0].move) };
  }

  // All positions done: repeat-line rule in ply order, then build the puzzle records.
  function finishGame(ctx, cands) {
    const info = ctx.info, puzzles = [], raw = [];
    cands.sort((x, y) => x.ply - y.ply);
    for (const c of cands) {
      const { ply, fen, lines, onlyMoves, solution } = c;
      const dup = raw.some(r => isRepeat(ctx.movesUci, r.ply, r.sol, r.capped, ply, solution));
      raw.push({ ply, sol: solution, capped: onlyMoves >= MAX_SOLVER });
      if (dup) continue;
      const best = lines[0], bestMove = best.move;
      const solverColor = fen.split(' ')[1] === 'w' ? 'white' : 'black';
      const played = ply < ctx.moves.length ? ctx.moves[ply] : null;
      const bm = new Chess(fen).move(uciMove(bestMove));
      const isCapture = !!bm && (bm.flags.includes('c') || bm.flags.includes('e'));
      puzzles.push({
        played: played ? played.uci : null,
        played_san: played ? played.san : null,
        played_correct: played ? played.uci === bestMove : null,
        result: info.result, termination: info.termination, user_outcome: info.user_outcome,
        id: `${info.game_id}-${ply}`, game_id: info.game_id,
        game_url: info.url || `https://lichess.org/${info.game_id}/${info.user_color}#${ply}`,
        perf: info.perf, game_index: info.game_index, fen, turn: solverColor, ply,
        move_number: fullmove(fen), solver_is_player: solverColor === info.user_color,
        user_color: info.user_color, opponent: info.opponent, time_control: info.time_control,
        best: bestMove, best_san: bm ? bm.san : bestMove, best_cp: best.cp,
        second_san: sanOf(fen, lines[1].move), second_cp: lines[1].cp,
        only_moves: onlyMoves, critical_depth: c.critical,
        recapture: isCapture && bm.to === ctx.moves[ply - 1].to,
        solution, solution_san: sanLine(fen, solution), line_san: sanLine(fen, best.pv.slice(0, 6)),
        white: info.white, black: info.black, date: info.date,
      });
    }
    return puzzles;
  }

  // Sequential version (one engine, whole game) - used for testing against the Python output.
  async function analyseGame(eng, pgnText, perf, username, gameIndex, tok = { cancelled: false }) {
    const ctx = prepareGame(pgnText, perf, username, gameIndex);
    if (ctx.error) return { game: ctx.info, puzzles: [], error: ctx.error };
    try {
      const cands = [];
      for (let ply = 1; ply <= ctx.fens.length; ply++) {
        if (tok.cancelled) throw new Cancelled();
        const c = await analysePosition(eng, ctx, ply);
        if (c) cands.push(c);
      }
      return { game: ctx.info, puzzles: finishGame(ctx, cands), error: null };
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      return { game: ctx.info, puzzles: [], error: `${e.name}: ${e.message}` };
    }
  }

  // ---------- Lichess (CORS-enabled public API) ----------
  async function fetchGames(username, perf, count, tok) {
    const qs = new URLSearchParams({ max: count, perfType: perf, clocks: 'true', opening: 'false', moves: 'true' });
    let r;
    try {
      r = await fetch(`https://lichess.org/api/games/user/${encodeURIComponent(username)}?${qs}`,
        { headers: { Accept: 'application/x-chess-pgn' }, signal: tok.signal });
    } catch (e) {
      if (tok.cancelled) throw new Cancelled();
      throw new Error('Could not reach Lichess: ' + e.message);
    }
    if (r.status === 404) throw new Error(`Lichess user '${username}' not found`);
    if (r.status === 429) throw new Error('Lichess rate limit hit - wait a minute and try again');
    if (!r.ok) throw new Error('Lichess returned HTTP ' + r.status);
    const text = (await r.text()).replace(/\r\n/g, '\n').trim();
    if (!text) return [];
    return text.split(/\n\n(?=\[Event )/).filter(g => !/\[Variant "(?!Standard")/.test(g));
  }

  // ---------- Chess.com (public API, open to browsers) ----------
  // Games come as one JSON file per month. Walk the months newest-first until enough blitz / rapid games are collected.
  const CC_MAX_MONTHS = 36;
  async function ccJson(url, tok) {
    let r;
    try { r = await fetch(url, { signal: tok.signal }); }
    catch (e) { if (tok.cancelled) throw new Cancelled(); throw new Error('Could not reach Chess.com: ' + e.message); }
    if (r.status === 404) return null;
    if (r.status === 429) throw new Error('Chess.com rate limit hit - wait a minute and try again');
    if (!r.ok) throw new Error('Chess.com returned HTTP ' + r.status);
    return r.json();
  }
  async function fetchChessCom(username, want, tok) {   // want {blitz: n, rapid: n} -> {blitz: [pgn, ...], rapid: [...]}, newest first
    const arch = await ccJson(`https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`, tok);
    if (!arch) throw new Error(`Chess.com user '${username}' not found`);
    const out = { blitz: [], rapid: [] };
    for (const url of (arch.archives || []).slice().reverse().slice(0, CC_MAX_MONTHS)) {
      if (out.blitz.length >= (want.blitz || 0) && out.rapid.length >= (want.rapid || 0)) break;
      const month = await ccJson(url, tok);
      const games = ((month && month.games) || []).filter(g => g.rules === 'chess' && g.pgn && want[g.time_class] > 0)
        .sort((x, y) => y.end_time - x.end_time);
      for (const g of games) if (out[g.time_class].length < want[g.time_class]) out[g.time_class].push(g.pgn.replace(/\r\n/g, '\n'));
    }
    return out;
  }

  // ---------- the job ----------
  function defaultWorkers() { return Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)); }

  // cache (optional): { get(gameId) -> puzzles[] | null, put(gameId, puzzles) }. Games it already has are not analysed again.
  function run({ username, blitz, rapid, source = 'lichess', workers = defaultWorkers(), cache = null, onProgress = () => {}, onUpdate = () => {} }) {
    const ctl = new AbortController();
    const tok = { cancelled: false, signal: ctl.signal };
    const engines = [];
    const state = { phase: 'fetching games', total: 0, done: 0, cached: 0, fetched: {}, errors: 0, workers,
                    totalPlies: 0, donePlies: 0, puzzles: { blitz: [], rapid: [] } };
    const emit = () => onProgress({ ...state });
    const cancel = () => { tok.cancelled = true; ctl.abort(); engines.forEach(e => e.terminate()); };

    const promise = (async () => {
      try {
        emit();
        const games = [], tasks = [];   // tasks: every position of every game, in game order then ply order
        const fromCc = source === 'chesscom' ? await fetchChessCom(username, { blitz, rapid }, tok) : null;
        for (const [perf, n] of [['blitz', blitz], ['rapid', rapid]]) {
          if (n <= 0) continue;
          const pgns = fromCc ? fromCc[perf] : await fetchGames(username, perf, n, tok);
          state.fetched[perf] = pgns.length;
          pgns.forEach((pgn, i) => {
            const ctx = prepareGame(pgn, perf, username, i);
            ctx.cands = []; ctx.left = ctx.fens.length;
            games.push(ctx);
            const hit = cache && !ctx.error && ctx.info.game_id ? cache.get(ctx.info.game_id) : null;
            if (hit) { ctx.cachedPuzzles = hit; return; }   // analysed before: no positions queued
            for (let ply = 1; ply <= ctx.fens.length; ply++) tasks.push({ ctx, ply });
            state.totalPlies += ctx.fens.length;
          });
        }
        state.total = games.length;
        if (!games.length) { state.phase = 'done'; emit(); return state; }
        state.startedAt = performance.now();
        const gameDone = (ctx) => {
          state.done++;
          if (ctx.error) state.errors++;
          let found = [];
          if (ctx.cachedPuzzles) {
            state.cached++;
            found = ctx.cachedPuzzles.map(p => ({ ...p, game_index: ctx.info.game_index }));   // keep the order of this request
          } else if (!ctx.error) {
            found = finishGame(ctx, ctx.cands);
            if (cache && ctx.info.game_id) cache.put(ctx.info.game_id, found);
          }
          const list = state.puzzles[ctx.info.perf].concat(found);
          list.sort((a, b) => a.game_index - b.game_index || a.ply - b.ply);
          state.puzzles[ctx.info.perf] = list;
          emit(); onUpdate(state.puzzles);
        };
        games.filter(g => g.cachedPuzzles || g.fens.length === 0).forEach(gameDone);   // saved results, and unreadable / empty games
        if (!tasks.length) { state.phase = 'done'; emit(); return state; }
        state.phase = 'starting engines'; emit();
        const n = Math.min(workers, tasks.length);
        for (let i = 0; i < n; i++) engines.push(new UciEngine());
        await Promise.all(engines.map(e => e.init()));
        state.phase = 'analysing'; state.startedAt = performance.now(); emit();

        let next = 0;
        await Promise.all(engines.map(async (eng) => {
          while (!tok.cancelled && next < tasks.length) {
            const { ctx, ply } = tasks[next++];
            try {
              const c = await analysePosition(eng, ctx, ply);
              if (c) ctx.cands.push(c);
            } catch (e) {
              if (tok.cancelled) return;
              ctx.error = ctx.error || `${e.name}: ${e.message}`;
            }
            state.donePlies++;
            if (--ctx.left === 0) gameDone(ctx); else emit();
          }
        }));
        state.phase = 'done'; emit();
        return state;
      } finally {
        engines.forEach(e => e.terminate());
      }
    })();
    return { promise, cancel };
  }

  return { run, defaultWorkers, parsePgn, prepareGame, analyseGame, UciEngine, Cancelled };
})();
