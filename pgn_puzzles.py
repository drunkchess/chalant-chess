# """Extract puzzle candidates from a PGN using Stockfish MultiPV.

# Usage:
#     pip install chess
#     python pgn_puzzles.py game.pgn --engine "C:/path/to/stockfish.exe"
# """

import argparse
import json
import sys
from pathlib import Path

import chess
import chess.engine
import chess.pgn

MATE_SCORE = 10000


def analyse(engine, board, depth, multipv=2):
    """Return [(cp, move, pv), ...] best-first, scored from the side to move's view."""
    infos = engine.analyse(board, chess.engine.Limit(depth=depth), multipv=multipv)
    lines = []
    for info in infos:
        pv = info.get("pv")
        if not pv:
            continue
        cp = info["score"].pov(board.turn).score(mate_score=MATE_SCORE)
        lines.append((cp, pv[0], pv))
    return lines


def is_puzzle(lines, gap, win_threshold, min_best,board):
    if len(lines) < 2:  # only one legal move -> forced, not a puzzle
        return False
    best, second = lines[0][0], lines[1][0]
    
    return (
        best>= 300
        and best - second >= gap          # best move is much better than the alternative
        and second < win_threshold    # the alternative doesn't also win
        and best >= min_best          # best move actually works (win or save), not "least bad of two losing moves"
    )
    
    # else:
    #     return (
    #     best<=-300
    #     and second-best>= gap          # best move is much better than the alternative
    #     and second > -win_threshold    # the alternative doesn't also win
    #     and best <= -min_best          # best move actually works (win or save), not "least bad of two losing moves"
    #     )


def count_only_moves(engine, board, lines, depth, gap, win, max_solver=4):
    """Walk the PV and count consecutive solver moves that are unique (best - second >= gap, second < win).

    The opponent always plays the engine's reply. Stops at the first non-unique solver move,
    a forced move, game end, or max_solver decisions.

    Returns (count, solution): solution is the verified UCI move list, alternating
    solver, opponent, solver, ... and ending on the last unique solver move.
    """
    b = board.copy()
    count = 0
    solution = []
    for _ in range(max_solver):
        if len(lines) < 2:
            break  # forced move, not a decision
        best, second = lines[0][0], lines[1][0]
        if not (best - second >= gap and second < win):
            break
        count += 1
        pv = lines[0][2]
        solution.append(pv[0].uci())
        b.push(pv[0])
        if b.is_game_over() or len(pv) < 2:
            break
        b.push(pv[1])
        if b.is_game_over():
            break
        solution.append(pv[1].uci())  # opponent reply; dropped below if no further solver move follows
        lines = analyse(engine, b, depth)
    if len(solution) == 2 * count:
        solution.pop()
    return count, solution


def critical_depth(engine, board, best_move, max_depth=12):
    """Shallowest depth from which the engine's top move stays best_move up to max_depth (max_depth+1 if never)."""
    first_ok = None
    for d in range(1, max_depth + 1):
        top = engine.analyse(board, chess.engine.Limit(depth=d))["pv"][0]
        if top == best_move:
            if first_ok is None:
                first_ok = d
        else:
            first_ok = None
    return first_ok if first_ok is not None else max_depth + 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pgn")
    ap.add_argument("--engine", required=True, help="path to stockfish executable")
    ap.add_argument("--depth", type=int, default=18)
    ap.add_argument("--gap", type=int, default=200, help="min cp gap between line 1 and 2")
    ap.add_argument("--win", type=int, default=150, help="line 2 must be below this cp")
    ap.add_argument("--min-best", type=int, default=-50, help="line 1 must be at least this cp")
    ap.add_argument("--min-only-moves", type=int, default=2, help="min consecutive unique solver moves along the line")
    ap.add_argument("--out", help="write puzzles to this JSON file (for the UI)")
    args = ap.parse_args()

    with open(args.pgn, encoding="utf-8") as f:
        game = chess.pgn.read_game(f)
    if game is None:
        sys.exit("No game found in PGN")

    engine = chess.engine.SimpleEngine.popen_uci(args.engine)
    puzzles = []
    try:
        board = game.board()
        found = 0
        for ply, move in enumerate(game.mainline_moves(), start=1):
            board.push(move)  # position AFTER the move; side to move is the potential solver
            if board.is_game_over():
                break
            lines = analyse(engine, board, args.depth)
            if is_puzzle(lines, args.gap, args.win, args.min_best,board):
                only_moves, solution = count_only_moves(engine, board, lines, args.depth, args.gap, args.win)
                if only_moves < args.min_only_moves:
                    continue
                found += 1
                best_cp, best_move, pv = lines[0]
                crit = critical_depth(engine, board, best_move)
                recapture = board.is_capture(best_move) and best_move.to_square == board.peek().to_square
                print(f"Puzzle #{found} (after ply {ply}, {'White' if board.turn else 'Black'} to move)")
                print(f"  Only moves: {only_moves}, critical depth: {crit}, recapture: {recapture}")
                print(f"  FEN:       {board.fen()}")
                print(f"  Best:      {board.san(best_move)} ({best_cp:+d} cp)")
                print(f"  2nd best:  {board.san(lines[1][1])} ({lines[1][0]:+d} cp)")
                print(f"  Line:      {board.variation_san(pv[:6])}")
                sol_moves = [chess.Move.from_uci(u) for u in solution]
                solution_san = board.variation_san(sol_moves)
                print(f"  Solution:  {solution_san}")
                puzzles.append({
                    "solution": solution,
                    "solution_san": solution_san,
                    "id": f"{Path(args.pgn).stem}-{ply}",
                    "fen": board.fen(),
                    "turn": "white" if board.turn else "black",
                    "ply": ply,
                    "best": best_move.uci(),
                    "best_san": board.san(best_move),
                    "best_cp": best_cp,
                    "second_san": board.san(lines[1][1]),
                    "second_cp": lines[1][0],
                    "only_moves": only_moves,
                    "critical_depth": crit,
                    "recapture": recapture,
                    "line": [m.uci() for m in pv[:6]],
                    "line_san": board.variation_san(pv[:6]),
                    "white": game.headers.get("White", "?"),
                    "black": game.headers.get("Black", "?"),
                    "date": game.headers.get("Date", "?"),
                })
        if not found:
            print("No puzzles found.")
    finally:
        engine.quit()
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(puzzles, f, indent=2)
        print(f"Wrote {len(puzzles)} puzzles to {args.out}")


if __name__ == "__main__":
    main()
