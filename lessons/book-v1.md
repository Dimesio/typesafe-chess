# Lesson book v1 (proposed)

Mined 2026-09-19T04:05:48.607Z from 6 log files. Parent: none (first book).

13900 graded Jev decisions in all. Pattern statistics use undecided positions only (best eval within ±5 pawns), and pick statistics use assisted setups only, the ones a lesson can reach.

- **Training data** (games and asks, suite positions left out): 2771 undecided positions, where 44% of all legal moves are failures (mistakes or blunders). 2605 assisted picks, of which 246 failed (9%).
- **Held out** (suite positions): 105 undecided positions (44% of moves are failures). 5367 assisted picks, 420 failed (8%).
- **Rules:** a pattern is promoted when it explains at least 10 training failures (matches the pick and no best move), assisted picks with it fail at least 2× as often as assisted picks overall, and at least 50% of all legal moves with it are failures. The lesson says "usually" when at least 75% of the moves with it are failures, else "often".

## Patterns (level 1: `lesson`)

| pattern | promoted | train: explains | train: picks with it that failed | train: moves with it that are failures | held out: explains | held out: picks failed | held out: moves failures |
|---|---|---|---|---|---|---|---|
| lands_hanging | no | 11 | 10% of 106 | 73% of 23460 | 36 | 18% of 196 | 84% of 857 |
| exchange_loses | no | 5 | 27% of 22 | 74% of 23862 | 38 | 72% of 53 | 85% of 890 |
| leaves_hanging | no | 13 | 18% of 223 | 66% of 27276 | 23 | 19% of 750 | 65% of 1047 |
| behind_after_reply | **yes** (often) | 30 | 28% of 284 | 67% of 47389 | 71 | 41% of 490 | 70% of 1831 |
| allows_mate | no | 6 | 75% of 8 | 72% of 513 | 0 | 0% of 33 | 89% of 18 |
| allows_fork | no | 58 | 22% of 414 | 48% of 17117 | 66 | 18% of 1037 | 49% of 801 |
| passes_up_material | **yes** (usually) | 19 | 74% of 31 | 80% of 28839 | 48 | 100% of 48 | 90% of 1036 |

- `lands_hanging`: not promoted: picks with it fail 1.1× as often as all picks (needs 2×).
- `exchange_loses`: not promoted: explains 5 training failures (needs 10).
- `leaves_hanging`: not promoted: picks with it fail 1.9× as often as all picks (needs 2×).
- `behind_after_reply`: "This move leaves you behind in material after the opponent's best capture. In your past games, moves like that were often mistakes."
- `allows_mate`: not promoted: explains 6 training failures (needs 10).
- `allows_fork`: not promoted: 48% of moves with it are failures (needs 50%).
- `passes_up_material`: "This move passes up another move that comes out further ahead in material. In your past games, moves like that were usually mistakes."

When several promoted patterns match a move, they share one lesson: "This move … and …", with the stronger adverb.

143 of 246 failed assisted picks in training (58%) match no pattern that the best move doesn't also match (held out: 264 of 420). No level-1 lesson can reach them; new detectors in server/lessons.js can.

## Memory (level 2: `last_time_here`)

- 394 failed moves in 390 positions (229 blunders, 165 mistakes), from 401 failed picks in any setup. Suite positions are never remembered.
- 105 of 6420 training positions came up in more than one game.
- Replaying the training logs in order: 20 decisions came in a position the memory already held, and 7 of them picked a move already remembered as a failure there. That's the most memory could have prevented in these logs.

## Failures no pattern explains (the costliest 20)

Assisted picks in undecided training positions: candidates for the next detector.

| FEN | pick | best | loss | label | setup |
|---|---|---|---|---|---|
| `4r1k1/5p2/1q5p/r1N3p1/2Rpb3/p7/PP1QP1PP/3K1B1R w - - 1 27` | Qxd4 | b4 | 1030 | blunder | assisted-noul-f1 |
| `2k5/ppq5/2pbb2r/6r1/B3P3/1P2NQ2/P1P2PP1/2R1R1K1 w - - 6 30` | Rf1 | b4 | 925 | blunder | assisted-choice |
| `2rk1b1r/pp1qp1p1/4p1Bp/2p5/3n1BQ1/2P3P1/PP3P2/R4RK1 b - - 0 19` | Nc6 | e5 | 874 | blunder | assisted-noul |
| `r1k1r3/p1p2Npp/1p6/5n2/4N3/8/PPnP1PPK/R1B1R3 w - - 2 21` | Rb1 | Ned6+ | 819 | blunder | assisted-choice |
| `r4b1r/pp3ppp/1k3p2/2p2N2/5Q1P/2q2P2/P5PK/RR6 b - - 1 28` | Kc6 | Ka6 | 782 | mistake | assisted-noul |
| `r1b1k2r/1ppp1ppp/p7/2qNb3/2B1P1n1/3Q4/PPP2PPP/R1B1R1K1 w kq - 7 12` | Rd1 | Qe2 | 769 | blunder | assisted-noul |
| `4k1r1/5p2/p1p5/4P2Q/P1p1P1p1/2P1K1P1/2q2P1P/6R1 w - - 1 30` | a5 | f4 | 767 | mistake | assisted-noul |
| `r1bq2k1/ppp1rppp/1nnb4/6N1/1P6/PB5P/1BQ1pPP1/RN2R1K1 b - - 3 16` | h6 | g6 | 751 | mistake | assisted-choice |
| `2r1kb1r/ppp1pppp/8/8/3q4/2Nb2Q1/PP3PPP/R1BR2K1 b k - 1 13` | Kd8 | Rd8 | 751 | blunder | assisted-noul-f2 |
| `r3r2k/p4p1p/1p6/1Pp1P3/P2bNP2/3P3Q/8/5K2 b - - 12 50` | Rad8 | Rg8 | 722 | mistake | assisted-noul-f2 |
| `4r2r/pppk1pp1/3b4/3p1q2/6p1/2P2N2/P1PP1PP1/R1BQR1K1 w - - 0 15` | Nd4 | Rxe8 | 689 | mistake | assisted-choice-f3 |
| `r3kb1r/pp3ppp/4p3/q3P3/b2Q1B2/8/PP3PPP/R2K1B1R w kq - 1 15` | Kc1 | Ke2 | 668 | mistake | assisted-noul-f2 |
| `6R1/4p1p1/p2k1p2/8/1PKB2r1/8/8/8 b - - 15 72` | Rg3 | e5 | 617 | blunder | assisted-noul-f1 |
| `2r2r2/5pbk/1q1p3p/p2Pp3/6bP/1P3NP1/PBP1Q1K1/2R3R1 w - - 1 31` | Rcd1 | Ng5+ | 615 | blunder | assisted-choice-f3 |
| `r2qkb1r/pp2pp1p/5p2/1Np2n2/3p4/3P3P/PPP1NPP1/R1BQK2R b KQkq - 1 10` | Nd6 | Qa5+ | 606 | blunder | assisted-noul |
| `2r1k1r1/1p3p2/p3N3/4P2Q/q1p1P1p1/2P3P1/PP3P1P/3K2R1 w - - 1 25` | Ke2 | Kc1 | 603 | blunder | assisted-noul |
| `8/3R4/2BK2p1/k2P1p2/3q4/1p5P/6P1/8 w - - 0 66` | Kc7 | Rb7 | 600 | blunder | assisted-noul |
| `4r1k1/5p2/1q5p/r1N2bp1/2RQ4/p7/PP2P1PP/3K1B1R w - - 1 28` | Kc1 | Nd3 | 577 | blunder | assisted-noul-f1 |
| `rn3rk1/ppp2ppp/3pbn2/8/q1NP4/2PBQ3/P1PB1PPP/3R1RK1 w - - 14 16` | Ra1 | Rb1 | 576 | blunder | assisted-noul |
| `3rkb1r/pb1q1ppp/p7/2ppB3/1n1Pn3/2N2P1N/1PP1B1PP/R2QR1K1 b k - 0 14` | Nf6 | cxd4 | 571 | mistake | assisted-noul |

## Next

Review the patterns and their wording above. If they look right:

```bash
npm run lessons -- --accept 1
```

Then measure each level against the same setup without lessons. Suite positions are held out, so the suite tests level 1. Memory (level 2) can only matter in positions that repeat, which means games:

```bash
npm run bench -- --suite bench/positions.json --sample 100 --setups assisted-noul-f1,assisted-noul-f1-L1b1
npm run bench -- --games 20 --setups assisted-noul-f1,assisted-noul-f1-L1b1,assisted-noul-f1-L2b1
```
