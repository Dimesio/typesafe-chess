# Findings: TypeSafe Jev as a chess decision-maker

Bench run on 2026-09-18 against `jev-1.13.0` (the `jev-latest` alias) using the live TypeSafe
API. Every number below comes from these log files:
- `runs/bench-suite-2026-09-18T13-37-46-248Z.jsonl`: the position suite, 2,260 decisions
- `runs/bench-games-2026-09-18T13-43-11-677Z.jsonl`: 79 finished games, 2,978 decisions
- `runs/summary-2026-09-18T13-58-06-270Z.md`: the generated report
- Section 7 (foresight levels, the same evening): `runs/bench-suite-2026-09-18T22-58-07-870Z.jsonl`,
  4,520 decisions, and its report `runs/summary-2026-09-18T23-10-21-562Z.md`; games in
  `runs/bench-games-2026-09-19T01-00-00-427Z.jsonl` (58 games, 2,294 decisions) and
  `runs/summary-2026-09-19T01-17-11-437Z.md`

Re-run the report with `npm run bench -- --report <files>`.

## What was measured
- **Four setups:** `raw` or `assisted` input, crossed with the `choice` or `noul` strategy
  (PLAN.md §3). All four used argmax picks, shuffled options in games, and no FEN.
- **The grader:** Stockfish 19 lite at depth 12, with MultiPV over every legal move and evals
  capped at ±1000. It never sees or influences Jev's input.
- **"Undecided cp loss"** is the average loss over positions where the best eval is within
  ±5 pawns. That excludes decided positions, where every move is capped and "loses" nothing
  (PLAN.md §4).
- **Position suite:** 113 positions, each asked once per setup in 5 option orders (fixed,
  reversed and 3 seeded shuffles):
  - 13 curated positions (mates in 1, a hanging queen, a fork, and so on)
  - 100 undecided positions sampled from the calibration's Stockfish-vs-Stockfish games
- **Games:** 20 per setup against the calibrated Stockfish ladder (`bench/elo-calibration.json`),
  in 2 chains that each start in the middle and move by result.
  - 79 of 80 games finished. The run was stopped during the last assisted-noul game, which
    is excluded.
  - Performance Elo only counts games against opponents with a real rating. The random mover
    and greedy capture rungs are bounds (≤ about 1020), so games against them are left out.
- **Not run:** the planned depth-16 recheck of 60 positions was stopped before it started.
  See "Caveats".

## Headline results

| setup | suite: undecided cp loss | suite: blunder rate | suite: top-1 | games: undecided cp loss | games vs rated Stockfish | games vs baselines (random, greedy) | tokens / decision |
|---|---|---|---|---|---|---|---|
| assisted-choice | **106** | 9% | 29% | 119 | 1 W, 13 L | **6 W, 0 D, 0 L** | 2,335 |
| assisted-noul | **90** | **5%** | **31%** | 118 | 0 W, 10 L | **8 W, 1 D, 0 L** | 3,026 |
| raw-choice | 279 | 35% | 19% | 129 | 1 W, 1 D, 11 L | 1 W, 6 D, 0 L | 1,079 |
| raw-noul | 294 | 35% | 12% | 163 | 0 W, 1 D, 6 L | 2 W, 11 D, 0 L | 1,583 |

### 1. How strong Jev is on this ladder
- **Every setup plays below the ladder's lowest rated rung (1517).** On this scale, 1517 is
  Stockfish skill 0 searching one ply.
  - Against rated opponents, the setups won 2 games out of 44.
  - Every setup's undecided cp loss (90–294) is above the calibration curve's top end (75 cp
    at 1517), so move-quality Elo reads "< 1517" for all four. The two measurements agree.
- **The assisted setups sit between greedy capture and that bottom rung.** They beat the
  random mover and greedy capture 14 times out of 15 (one draw). Against skill 0 at depth 1
  they lost 14 of 15, with one win.
  - Their cp loss (about 90–120) is also between the calibration's greedy capture (182) and
    skill 0 at depth 1 (75).
  - So assisted Jev plays at about "≤ 1026 < Jev < 1517" on this ladder.
- **Performance Elo can't separate the setups yet.** The maximum-likelihood numbers are
  assisted-choice 1134 [777–1492], raw-choice 1312 [1003–1621] and raw-noul 1247 [729–1765];
  assisted-noul is "< 1517", having lost all 10 rated games.
  - All of these extrapolate below the lowest rated rung, from 7–14 games each.
  - The intervals overlap heavily. Raw-choice's higher number comes from one win against
    Elo 1500 (rated 1769). It's noise, not a ranking.
- **To rate Jev precisely, the ladder needs rungs between greedy capture and skill 0 at
  depth 1.** In the calibration, those two were only linked by one-sided results.

### 2. Which setup plays best: assisted, by a wide margin
- **On fixed positions** (the suite), assisted input cut Jev's loss by nearly two thirds:
  - undecided cp loss: 90–106 against 279–294
  - blunders: 5–9% against 35%
  - top-1 picks: 29–31% against 12–19%
- **In games, raw Jev can't win won positions.** Against the scripted baselines, both raw
  setups mostly drew: 17 of 20 games, by threefold repetition, insufficient material or the
  300-ply cap. The assisted setups won 14 of 15.
- **The gap is smaller inside games than on the suite** (undecided cp loss 118–163 against
  90–294). Positions in games against weak opponents are simpler than the suite's positions,
  which come from strong-engine games.
- **Curated positions:**
  - Every setup found all three mates in 1, the knight fork (Nxc7+) and the promotion (f8=Q).
  - Raw-noul missed the hanging queen (Nc3 instead of Nxh4, a 603 cp loss).
  - Both raw setups fell into the stalemate trap. Qa7+ lets the king take the queen and
    throws away a won position (1009 cp). The assisted setups, which are told when a move
    lands on an attacked, undefended square, avoided both.
  - All four setups played O-O in the "castling" position, a shared 160 cp inaccuracy.
- **Choice vs Noul:**
  - On the suite, assisted-noul lost a little less than assisted-choice (90 against 106 cp,
    5% against 9% blunders). In games they were about even (118 against 119 cp).
  - Noul costs about 30% more tokens and gives no confidence. It's much less sensitive to
    option order (section 4).
  - Noul's normalized "p" is flat (average P(best) 8% against 23% on the suite), so
    distribution metrics aren't comparable between the two strategies (PLAN.md §4).

### 3. Does confidence predict move quality?
**With assisted input, yes. With raw input, barely.** Average cp loss of Jev's pick, by the
Choice confidence it reported:

| confidence | 0.0–0.2 | 0.2–0.4 | 0.4–0.6 | 0.6–0.8 | 0.8–1.0 | r (conf ↔ loss) |
|---|---|---|---|---|---|---|
| assisted-choice, games | 136 (n 203) | 83 (138) | 69 (90) | 36 (56) | **8 (64)** | −0.26 |
| assisted-choice, suite | 93 (33) | 155 (25) | 100 (26) | 104 (12) | **20 (18)** | −0.16 |
| raw-choice, games | 90 (261) | 102 (251) | 59 (129) | 86 (46) | 0 (15) | −0.07 |
| raw-choice, suite | 295 (26) | 254 (65) | 358 (16) | 148 (3) | 0 (3) | −0.08 |

- **Assisted-choice in games:** loss falls steadily with confidence. At confidence ≥ 0.8, its
  picks lost 8 cp on average.
- **On the suite:** only the top bin stands out (20 cp).
- **Raw-choice:** confidence carries little signal, and it is rarely high (18 of 815 graded
  decisions had ≥ 0.8).
- Per CLAUDE.md, confidence is logged and never used to gate a pick.

### 4. Option order matters for Choice
Same position, five option orders:

| setup | same pick in all 5 orders | pairwise pick agreement | avg cp-loss spread across orders | p × n by list position (1st → 5th fifth) |
|---|---|---|---|---|
| assisted-choice | 57% | 75% | 60 | 1.04 / 0.92 / 0.95 / 0.93 / **1.15** |
| raw-choice | 62% | 80% | 122 | 1.03 / 0.90 / 0.94 / 0.94 / **1.18** |
| assisted-noul | 77% | 88% | 28 | 1.00 / 1.00 / 1.01 / 0.99 / 1.00 |
| raw-noul | 76% | 88% | 79 | 1.01 / 0.99 / 0.99 / 0.99 / 1.02 |

- **Choice favors the end of the list.** Moves listed in the last fifth get 15–18% more
  probability than a uniform share; middle positions get 5–10% less.
- **Noul gives a noise floor.** Its questions are independent, so option order can't matter,
  yet its picks still agree only 88% of the time. That comes from the API's run-to-run
  variation (M0: ±0.02–0.04 per probability) on moves with close P(yes).
- **Choice's 75–80% agreement is below that floor,** so order moves Choice's pick beyond
  plain noise. Keep `shuffle` on, which the app does by default. Order bias then becomes
  noise rather than a fixed preference for whichever moves chess.js lists last.

### 5. Jev's own evaluation of the position
- **Jev's `position_eval` level matched Stockfish's bucket 45–57% of the time,** against 20%
  by chance: assisted-choice 57%, assisted-noul 51%, raw-noul 50%, raw-choice 45%.
- **Its errors pull toward the middle.** In decided positions it under-calls both ends:
  - Stockfish said "losing decisively" in 177 of assisted-choice's graded decisions, and Jev
    said so only 82 times.
  - For "winning decisively", the counts were 153 and 80.
  - Raw-choice was more extreme: Stockfish's 458 "losing decisively" against Jev's 220, and
    87 "winning decisively" against 23.
  - In the M1 Scholar's-mate position, Jev's eval missed a forced mate.

### 6. Latency and cost
- **Latency** across all 5,238 decisions: median 204 ms, 90th percentile 293 ms, 99th
  percentile 461 ms, maximum 737 ms. It was about the same for every setup (205–235 ms
  average).
- **Input tokens per decision:** raw-choice 1,079, raw-noul 1,583, assisted-choice 2,335,
  assisted-noul 3,026.
- **Cost:** the whole bench used 10.3M input tokens, $0.43 at $0.042 per million, with free
  output. A 40-move game costs about $0.004 with assisted-choice.

### 7. Foresight: facts about the opponent's reply
Assisted-choice and assisted-noul at foresight levels 0–3 (PLAN.md §3), on the same 113
positions and 5 option orders: 4,520 decisions. Level 1 adds the material you'd have after the
opponent's best capture, level 2 whether they can then mate in one, level 3 whether they can
then fork. Level 0 reproduced this morning's M5 run (95 and 88 cp, against 95 and 89).

| setup | undecided cp loss (± SE) | blunder rate | top-1 | tokens / decision |
|---|---|---|---|---|
| assisted-choice (level 0) | 95 ± 7 | 6.0% | 30% | 2,315 |
| assisted-choice-f1 | 86 ± 7 | 4.2% | 32% | 2,674 |
| assisted-choice-f2 | 83 ± 7 | 3.7% | 32% | 2,679 |
| assisted-choice-f3 | 85 ± 7 | 3.7% | 33% | 2,864 |
| assisted-noul (level 0) | 88 ± 7 | 4.8% | 30% | 3,033 |
| assisted-noul-f1 | **71 ± 6** | **3.2%** | 33% | 3,391 |
| assisted-noul-f2 | 74 ± 6 | 3.4% | 33% | 3,396 |
| assisted-noul-f3 | 74 ± 6 | 3.9% | 34% | 3,581 |

All five orders; the report's suite table uses the fixed order only.
- **Level 1 helps.** Compared with level 0 on the same position and order, cp loss changed by
  −9 ± 8 (choice) and −17 ± 11 (noul), with 95% intervals. Blunders fell by about a third.
  Jev picked a move the fact marks as losing material 68 times in 565 without it, and 42
  (choice) or 30 (noul) times with it.
- **Levels 2 and 3 add nothing measurable on the suite.** Against the level below, level 2
  changed cp loss by −2.5 ± 3.3 (choice) and +2.5 ± 5.3 (noul); level 3 by +1.2 ± 6.0 and
  +0.8 ± 6.4.
  - Jev heeds level 2: picks that allow a mate went from 5 to 0. But only 6 of the 113
    positions have such a move, so it can't move an average. It costs almost nothing, since it
    appears on 0.5% of moves.
  - Jev heeds level 3 too: picks that allow a fork roughly halved (119 to 69 for choice, 112 to
    49 for noul). Cp loss didn't improve, though. Level 3 changed Jev's pick more often (the
    same pick as level 0 in 75% and 68% of cases, against 83% and 76% at level 2) and adds
    about 7% more tokens. Avoiding a flagged fork isn't the same as finding a good move.
- **Move-quality Elo:** assisted-noul at levels 1–3 is the first setup whose estimate lands
  inside the calibrated range: 1718 [1517–1772] at level 1. Read that as "at the bottom rung".
  The interval reaches the floor, and on this part of the curve 4 cp is about 200 Elo. Suite
  positions also differ from game positions (section 2), so games have to confirm it.
- **Cost:** level 1 adds about 15% input tokens and 20–35 ms of latency, since the server
  computes the facts.

**Games.** 20 ladder games each for assisted-noul at levels 0, 1 and 2. The run was stopped
after 58 games: a level 0 game sat on one grade for over 4 minutes (a lost position; see the
grading caveat in CLAUDE.md). Its unfinished game's decisions are in the log without a result.

| setup | games | vs rated rungs (W/D/L) | performance Elo | vs random/greedy | undecided cp loss (n) |
|---|---|---|---|---|---|
| assisted-noul (level 0) | 18 | 3/1/12 | 1356 [1143–1568] | 2 W | 98 (404) |
| assisted-noul-f1 | 20 | 4/2/10 | 1494 [1298–1691] | 4 W | 91 (406) |
| assisted-noul-f2 | 20 | 6/1/11 | 1529 [1348–1709] | 2 W | 99 (321) |

- **Performance Elo rises with the level**, the same direction as the suite. Levels 1 and 2 beat
  rungs above the bottom one for the first time: skill 0 at 150k nodes (1646) and Elo 1320 at
  150k nodes (1700).
- **But it's within noise.** Level 0 itself did far better tonight than this morning against
  skill 0 at depth 1 (1517): 3 W, 1 D and 6 L, against 0 of 6. That's the same model
  (`jev-1.13.0`) and identical input, against a rung that plays randomized moves. Pooling both
  level 0 runs gives 1260 [1060–1460] from 26 rated games. So levels 1–2 gain somewhere around
  140–270 Elo, with overlapping intervals.
- **Move quality in games didn't show the suite's gain:** undecided cp loss 98, 91 and 99. The
  ladder confounds this: a setup that wins meets stronger opponents and harder positions.
- **Where that leaves Jev:** with foresight, assisted-noul plays at about the ladder's bottom
  rated rung, and both performance Elo and the suite's move-quality estimate now say so. That's
  up from "between greedy capture and the bottom rung".

## Caveats
- **Small samples.** There were 20 games per setup, and only 7–14 of each counted toward
  performance Elo. The ± ranges are 95% intervals and are wide. The suite has 105 undecided
  positions per setup.
- **The bottom of the ladder isn't rated yet.** Random mover and greedy capture are bounds,
  and Jev's rating falls in the unrated gap above them. More games would narrow the
  intervals, but only new rungs in that gap will pin the number down.
- **Grading depth.** The planned depth-16 recheck didn't run (`npm run bench -- --check 60
  --from <the two files above>`). Depth-12 Stockfish is far stronger than players below
  1517, so the grader shouldn't be what limits these conclusions. Individual labels can still
  shift: in M3, one quiet position's best move changed between depth 12 and 16.
- **Scale.** Ratings are on this project's Stockfish ladder at 150k nodes per move, anchored
  so the UCI_Elo rungs average their nominal values. They aren't FIDE or lichess ratings.
- **Scope.** One model version, one question design, and assisted facts that are one-ply
  rules facts, plus (section 7) facts about the opponent's single reply, tested on the suite
  only. `includeFen` and other wordings weren't tested.

## Next steps
1. **Add ladder rungs between greedy capture and skill 0 at depth 1**, then play more games
   to put a real number on Jev's rating. Candidates: a "safe greedy" player that avoids
   hanging pieces, or Stockfish at depth 1 with more randomness.
2. **Run the deeper check** on these runs, to confirm the depth-12 labels.
3. **Test `includeFen`** (on vs off), and try more assisted facts one at a time (each needs
   a unit test per CLAUDE.md), measured with this same suite.
4. **Use the confidence ≥ 0.8 signal** (assisted-choice) in analysis. It predicts good
   moves, so log it for decisions; don't gate on it.
5. **More games at foresight levels 0–2.** The first 58 (section 7) point the same way as the
   suite but can't separate the levels: 16–18 rated games each give ±200 Elo intervals, and
   run-to-run noise was as large as the effect. About 60 games per setup would halve the
   intervals. Slow lost-position grades stall bench games, so settle the grading follow-up
   (CLAUDE.md) first or expect stalls.
