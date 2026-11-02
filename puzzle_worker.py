"""Per-game puzzle extraction, run inside a worker process by server.py.

Reuses the unmodified logic from pgn_puzzles.py (analyse / is_puzzle / count_only_moves / critical_depth).
One engine per game, always quit in `finally` (a long-lived engine per worker hung the pool at shutdown).
"""
import io

import chess
import chess.engine
import chess.pgn

from pgn_puzzles import analyse, count_only_moves, critical_depth, is_puzzle

GAP, WIN, MIN_BEST, MIN_ONLY = 200, 150, -50, 2


def pretty_time_control(tc):
    """'300+3' -> '5+3', '180+2' -> '3+2', '-' -> '-'."""
    try:
        base, inc = tc.split("+")
        base = int(base)
        mins = f"{base // 60}" if base % 60 == 0 else f"{base / 60:.1f}"
        return f"{mins}+{int(inc)}"
    except Exception:
        return tc or "?"


MAX_SOLVER = 4  # cap on solver moves per puzzle (count_only_moves default)


def is_repeat(moves_uci, p_ply, p_sol, p_capped, q_ply, q_sol):
    """True if puzzle Q (position after q_ply) is just the tail of earlier puzzle P's line.

    That happens when the game follows P's solution: every later solver-to-move position on the line
    is also a valid puzzle (same tactic, one move later). Q is a repeat only if the game really played
    P's line up to Q's position AND Q's first move is P's next solver move. A puzzle with a different
    best move at that point is a different puzzle and is kept.
    """
    d = q_ply - p_ply
    if d <= 0 or d % 2:  # not a later position with the same side to move
        return False
    if d < len(p_sol):
        return moves_uci[p_ply:p_ply + d] == p_sol[:d] and q_sol[0] == p_sol[d]
    if d == len(p_sol) + 1 and p_capped:  # P's walk stopped at the solver-move cap; the tactic continues
        return moves_uci[p_ply:p_ply + len(p_sol)] == p_sol
    return False


def analyse_game(job):
    """job = (pgn_text, perf, username, engine_path, depth, game_index). Returns a dict, never raises."""
    pgn_text, perf, username, engine_path, depth, game_index = job
    info = {"perf": perf, "game_index": game_index}
    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
        if game is None:
            return {"game": info, "puzzles": [], "error": "unreadable PGN"}
        h = game.headers
        game_id = h.get("GameId") or h.get("Site", "?").rstrip("/").split("/")[-1]
        white, black = h.get("White", "?"), h.get("Black", "?")
        user_color = "white" if white.lower() == username.lower() else "black"
        opponent = black if user_color == "white" else white
        result = h.get("Result", "*")
        if result == "1/2-1/2":
            user_outcome = "draw"
        elif result in ("1-0", "0-1"):
            user_outcome = "won" if (result == "1-0") == (user_color == "white") else "lost"
        else:
            user_outcome = "unknown"
        info.update({
            "game_id": game_id, "white": white, "black": black, "opponent": opponent,
            "user_color": user_color, "result": result, "date": h.get("UTCDate", h.get("Date", "?")),
            "time_control": pretty_time_control(h.get("TimeControl", "")),
        })

        moves = list(game.mainline_moves())
        moves_uci = [m.uci() for m in moves]
        puzzles = []
        raw = []        # every puzzle found, kept or not, so chains of repeats are caught
        repeats = []    # ids dropped as repeats (for diagnostics)
        engine = chess.engine.SimpleEngine.popen_uci(engine_path)
        try:
            engine.configure({"Threads": 1, "Hash": 64})
            board = game.board()
            for ply, move in enumerate(moves, start=1):
                board.push(move)  # position AFTER the move; side to move is the potential solver
                if board.is_game_over():
                    break
                lines = analyse(engine, board, depth)
                if not is_puzzle(lines, GAP, WIN, MIN_BEST, board):
                    continue
                only_moves, solution = count_only_moves(engine, board, lines, depth, GAP, WIN, MAX_SOLVER)
                if only_moves < MIN_ONLY:
                    continue
                dup = any(is_repeat(moves_uci, p_ply, p_sol, p_cap, ply, solution) for p_ply, p_sol, p_cap in raw)
                raw.append((ply, solution, only_moves >= MAX_SOLVER))
                if dup:
                    repeats.append(f"{game_id}-{ply}")
                    continue
                best_cp, best_move, pv = lines[0]
                sol_moves = [chess.Move.from_uci(u) for u in solution]
                solver_color = "white" if board.turn else "black"
                played = moves[ply] if ply < len(moves) else None  # move actually played from this position
                puzzles.append({
                    "played": played.uci() if played else None,
                    "played_san": board.san(played) if played else None,
                    "played_correct": (played == best_move) if played else None,
                    "result": result,
                    "termination": h.get("Termination", ""),
                    "user_outcome": user_outcome,
                    "id": f"{game_id}-{ply}",
                    "game_id": game_id,
                    "game_url": f"https://lichess.org/{game_id}/{user_color}#{ply}",
                    "perf": perf,
                    "game_index": game_index,
                    "fen": board.fen(),
                    "turn": solver_color,
                    "ply": ply,
                    "move_number": board.fullmove_number,
                    "solver_is_player": solver_color == user_color,
                    "user_color": user_color,
                    "opponent": opponent,
                    "time_control": info["time_control"],
                    "best": best_move.uci(),
                    "best_san": board.san(best_move),
                    "best_cp": best_cp,
                    "second_san": board.san(lines[1][1]),
                    "second_cp": lines[1][0],
                    "only_moves": only_moves,
                    "critical_depth": critical_depth(engine, board, best_move),
                    "recapture": board.is_capture(best_move) and best_move.to_square == board.peek().to_square,
                    "solution": solution,
                    "solution_san": board.variation_san(sol_moves),
                    "line_san": board.variation_san(pv[:6]),
                    "white": white,
                    "black": black,
                    "date": info["date"],
                })
        finally:
            engine.quit()
        return {"game": info, "puzzles": puzzles, "repeats": repeats, "error": None}
    except Exception as e:  # keep the pool alive; report per game
        return {"game": info, "puzzles": [], "error": f"{type(e).__name__}: {e}"}
