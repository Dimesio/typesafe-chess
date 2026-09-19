# TypeSafe Chess

A local app for testing TypeSafe **Jev** (System One) as a chess decision-maker. Jev picks
from the legal moves, and Stockfish grades each pick. **The full design and milestones are in
[PLAN.md](PLAN.md). Read it before starting work.**

## Before writing TypeSafe code
- Use the TypeSafe skill (`/typesafe:typesafe-ai`). If it isn't installed:
  `claude plugin marketplace add typesafe-ai/skills` then `claude plugin install typesafe@typesafe-ai`.
- The live docs at https://docs.typesafe.ai are the source of truth. Start from
  `https://docs.typesafe.ai/llms.txt` and append `.md` to a page path to get Markdown. Read the
  API/SDK page and the relevant primitive page before changing a request.
- SDK: `@typesafe-ai/sdk` (Node ≥ 20). Types live in `node_modules/@typesafe-ai/sdk`.

## API key: handle with care
- The key is in `.typesafe-api-key` (one line, raw key) at the repo root. The server reads
  `TYPESAFE_API_KEY` from the environment first and falls back to that file.
- **Never print, cat, log, echo or commit the key**, and never send it to the browser. All
  TypeSafe calls go through the Node server. `.typesafe-api-key` is in `.gitignore`.

## Ground rules for the experiment
- **Make no assumptions about how strong Jev is**, and don't weaken anything to fit an
  expectation. Finding out what Jev can do is the point of the app. Measurement ranges (the
  Elo ladder, grading depth) must be able to show any result, from the bottom to the top.
- Code owns the rules (chess.js); Jev only chooses. Stockfish is **only a grader**: its output
  must never reach Jev's state or criteria.
- Keep `raw` and `assisted` setups exactly as PLAN.md §3 defines them. If you add an assisted
  fact, document it in `server/position.js` and add a unit test.
- Foresight levels (`setup.foresight`, PLAN.md §3) are separate and opt-in. Level 0 must stay
  identical to plain assisted. A new lookahead fact is a new level on top, never a change to a
  lower one, and needs the same documentation and unit test.
- Keep the state small and list only facts that apply. Jev is weak at counting, arithmetic and
  large irrelevant state (see PLAN.md §1).
- Don't gate or override Jev's pick based on confidence. Log it instead.
- When a key is present and a call fails, show the error. Never fall back to mock silently.

## Commands (once scaffolded)
- `npm start` serves the app on http://localhost:5173
- `TYPESAFE_MOCK=1 npm start` runs offline with a fake Jev (the UI shows a MOCK badge)
- `npm test` runs `node --test`
- `node scripts/ask.js --fen "<fen>" [--setups raw-choice,assisted-noul] [--history "e4 e5"] [--json]`
  asks Jev about one position and prints each setup's distribution (live when a key exists)
- Setup names everywhere are `info-strategy` plus an optional foresight level for assisted:
  `assisted-choice-f2` (`public/setups.js`). Level 0 has no suffix, so M5 names still match.
- `node scripts/verify-live.js` re-runs the M0 API checks
- `npm run bench -- --calibrate` rates the Elo ladder and fits the cp loss → Elo curve. It writes
  `bench/elo-calibration.json` and takes about an hour on 10 workers. `--quick` is a
  30-second smoke test; send its `--out` to a scratch path.
- http://localhost:5173/dashboard.html is the session dashboard (per setup stats, performance
  Elo, confidence vs loss, the ladder, and calibration)
- `npm run bench -- --all` runs the M5 bench against the live API (about 5–6k requests, well under $1):
  - the position suite: 13 curated plus 100 sampled positions, every setup, 5 option orders
  - 20 ladder games per setup
  - a depth-16 check of 60 positions
  - a report written to `runs/summary-*.md`
- The parts run separately with `--suite bench/positions.json [--sample 100]`, `--games 20`,
  `--check 60 --from <files>` and `--report <files>`. `--mock` gives an offline smoke test (move
  its files out of `runs/` afterwards).

## Verified live (M0, 2026-09-18, SDK 0.6.0; re-run `node scripts/verify-live.js`)
- **Model:** `jev-latest` answers as `jev-1.13.0`. `models.list()` returns only the aliases
  `jev-latest` and `jev-preview`.
- **SAN keys:** labels like `b8=Q#`, `Ra8#`, `b8=N`, `O-O` and `O-O-O` come back unchanged
  as Choice keys. Key Choices by SAN.
- **Questions per request:** there's no count limit, only the token budget. 2,048 Nouls
  (34k input tokens) worked. 4,096 failed with **HTTP 400** `max_tokens_exceeded` (not 422).
  Noul-per-move fits in one request for any position.
- **Latency and tokens:** raw-style descriptions, SAN keys.
  - A 33-option Choice took 137–212 ms, with about 1.3k input and 0.3k output tokens.
  - A 50-option Choice took 141–210 ms, with about 1.6k input and 0.4k output tokens.
  - Input costs about $0.00007 per decision.
- **Probabilities come in steps of 0.01.** Many options come back as exactly 0 (15 of 50 in
  one test). Metrics must handle ties: use average ranks for Spearman, and report ties when
  giving the rank of the best move.
- **Repeat variation:** sending the identical request 5 times moved individual
  probabilities by up to 0.02–0.04. "Ask again" can differ even without a shuffle.
- **Order:** reversing the option order moved probabilities by a few points (first look;
  measure it properly in M4).
- **Stockfish 19 lite (single-threaded WASM):**
  - Runs under Node as a UCI child process: `node public/vendor/stockfish/stockfish-19-lite-single.js`.
    That folder has a `package.json` with `"type": "commonjs"` because the build uses
    `require`.
  - Options: `UCI_Elo` 1320–3190, `Skill Level` 0–20, `MultiPV` up to 256, Threads 1.
  - Full-MultiPV grading in Node at depth 12 took 0.7–1.7 s per position; depth 16 took
    4–19 s.
  - **Lost positions are the exception:** with the best move capped at −1000, a depth-12 grade
    can take 10–120 s (one took 119 s in Node and 122 s in the browser). MultiPV works out
    exact mates for hopeless moves; single-PV on the same positions takes 6–11 ms.
  - **Speed (M4):** about 700–800k nodes/s in Node and 650–750k in the browser Worker, single
    process with nothing else running. That's why a Stockfish player's limit is a node budget
    (150k ≈ 200 ms) rather than a time limit, which varies with CPU load and core type.

## Status
Plan written 2026-09-17. UI agreed with the user the same day (PLAN.md §5): Analysis mode,
step-by-step Jev turns, browsing with cut-off on rewind, human overrides (tagged and left out of
Jev's stats), a position editor, live game stats and an estimated Elo per setup (§4).
**M0 done 2026-09-18:**
- `package.json`, dependencies, the Stockfish files and the key loader
  (`server/typesafe.js`) are in place.
- The live checks are recorded above.

**M1 done 2026-09-18:**
- `server/position.js` (raw and assisted facts, with every fact documented at the top),
  `server/questions.js` (state and questions for choice and noul, and answer parsing),
  `server/mock.js` and `server/jev.js` (`askJev`, shared by the server and the bench).
- 29 unit tests pass.

**M2 done 2026-09-18:**
- `server/index.js` (static files, `/vendor/*` from node_modules, `POST /api/jev`,
  `POST /api/log`, `GET /api/status`, `GET /api/positions`). It binds to 127.0.0.1, accepts
  only JSON POSTs, and rejects foreign `Host` headers.
- The browser app (`public/`): `app.js` (controller), `game.js` (game model, cut and
  restore), `editor.js` with `editor-rules.js`, `board.js` and `api.js`, with an import map
  and no bundler.
- `bench/positions.json` holds 13 test positions.
- Tested in the browser pane, in mock and live: ask, arrows, decision panel, inspector,
  browsing, cut and undo, Play-mode pause, override and auto-play, the editor (trays, delete
  by dragging off the board, castling and en-passant sync, validation), the load dialog,
  promotion, and error display. 39 unit tests pass.
- `.claude/launch.json` has `app-mock` and `app-live`.

**Players and auto-play (2026-09-18, before M3, at the user's request):**
- Each color is Me, Jev or Stockfish, chosen in the top bar.
- Computer moves have a Step or Auto switch with a delay setting.
- Stockfish runs as a player in a Web Worker (`public/engine.js`), with settings for Elo
  1320–3190, skill 0–20 or full strength, plus think time.
- `Game` stores `players` and `engineMoves` (both survive cuts and undo) and caches status.
- Tested in mock and live: Jev vs Jev on Auto to checkmate, Jev vs Stockfish in Step and Auto
  (including pause and resume), Me vs Stockfish, and the settings validation. 40 unit tests
  pass.

**M3 done 2026-09-18:**
- `public/grading.js` (metrics, pure, shared with the bench), `public/elo.js` (performance
  MLE, ladder, move-quality mapping), `public/grader.js` (a separate grader worker, priority
  queue and cache), and `Engine.analyse()` / `parseInfo()`.
- **The UI:**
  - Ask → Grade → Play.
  - Eval and loss columns in the decision panel.
  - A blue best-move arrow.
  - The "This game: Jev" stat tiles, per side, with a confusion matrix.
  - The timeline.
  - ?! ? ?? labels in the move list.
  - Grading depth in the Stockfish dialog.
  - A stoppable depth +4 check.
- **Browser timing:** full-MultiPV grading at depth 12 took 0.3–1 s per position. A depth-16
  check of a 38–50 move position took about 17–19 s. Depth 24 didn't finish in 60 s, which is
  bench territory.
- **Depth matters:** on the quiet test position, depth 16 picked a different best move than
  depth 12. Keep the "grader must be stronger than the player" check (PLAN.md §7) in mind.
- 53 unit tests pass.

**M4 done 2026-09-18:**
- **Stockfish limits are node budgets** (150k ≈ 200 ms), so strength doesn't depend on CPU
  load or on browser vs Node.
- **Shared engine code:** `UciEngine` serves both the Worker and child-process transports.
  `bench/uci-node.js` is the Node side, and `public/baselines.js` holds the random and greedy
  players.
- **Calibration:** `bench/calibrate.js` and `bench/run.js --calibrate`, with `fitRatings` and
  `isotonicDecreasing` in `public/elo.js`.
- **Ratings and ladder:** `public/ratings.js` gives each opponent a rating (calibrated,
  interpolated or nominal) and runs the ladder, with color swapping and auto-advance in Auto.
- **Dashboard:** Compare setups, shadow runs, `public/sessions.js` and `dashboard.html`/`.js`,
  plus `GET /api/runs` and `/api/calibration`.
- **Export:** PGN with per-move comments, and JSONL from the dashboard.
- 64 unit tests pass.

**Calibration results (`bench/elo-calibration.json`, 2026-09-18):**
- 396 games at 150k nodes, graded at depth 12, with cp loss from undecided positions (±500).
- **Rated range:** 1517 (skill 0, depth 1) to 3349 (full strength, 750k nodes).
- **Bounds:** random mover ≤ 1016 and greedy capture ≤ 1026. They lost almost every game even
  to the weakest Stockfish rungs, so the games only give an upper limit.
- **UCI_Elo is compressed at 150k nodes:** nominal 1320–3190 fits to 1700–2843, and nominal
  2100 and 2300 came out the same (2179).
- **Full strength at depth 1 (1852) beats skill 0 at 150k (1646) and Elo 1320 (1700).**
- **The curve** runs from 75 cp (≈1517) down to 4.6 cp (≈3349). Above about 2700 it is nearly
  flat, because the depth-12 grader can't separate the strongest rungs. Move-quality Elo
  reports "< 1517" for any average undecided loss above 75.
- The first run (think-time limits and no bounds or band) is archived outside the repo. Don't
  use it.

**M5 done 2026-09-18:** the bench (`bench/common.js`, `games.js`, `suite.js`, `check.js`,
`report.js`), shared log lines (`public/loglines.js`), an explicit option `order` in
`buildRequest`/`askJev`, and **FINDINGS.md**.
- **Live run:** 5,238 decisions for $0.43. The suite had 113 positions × 4 setups × 5 orders,
  and 79 of 80 ladder games finished (the run was stopped during the last one). The deeper
  check didn't run. 69 unit tests pass.
- **Headline:** assisted input cuts undecided cp loss from about 285 to about 100 and blunders
  from 35% to 5–9%. Every setup plays below the lowest rated rung (1517). Assisted Jev beats
  random and greedy but loses to skill 0 at depth 1. Choice picks change with option order
  (the last fifth of the list gets about 1.16× the probability). Confidence ≥ 0.8
  (assisted-choice) predicts good moves.

**Grading queue fix (2026-09-18):** in Auto, the grading queue grew without end, and a reload
lost it (PLAN.md §4 "Why a pool and a hold").
- `Grader` is now a pool of cores − 2 workers, at most 4, made on demand. Grades are identical
  to one worker's.
- Auto holds a computer move while more grades are queued than there are workers. Step never
  waits.
- The chip shows "Grade queued (N ahead)".
- Tested in mock:
  - Jev vs Jev at full speed kept at most 4 grades queued, and 199 of 201 decisions were graded
    with a median lag of 1 s.
  - Play moves during a hold.
  - Step drains the queue.
  - A normal game graded fine next to two long lost-position grades.
- `.claude/launch.json` has `app-mock-5174` for when a live server holds 5173.
- 75 unit tests pass.

**Foresight levels (2026-09-18, branch `foresight-levels`, at the user's request):**
- `setup.foresight` 0–3 (assisted only) adds facts about the opponent's reply, one per level:
  - 1: material after their best capture
  - 2: whether they can mate in one
  - 3: whether they can fork (costing at least a minor piece)
- Chosen from assisted Jev's logged blunders. Documented in `server/position.js` and PLAN.md §3.
- **UI:** a "foresight 0 1 2 3" control in the top bar, disabled for raw.
- **Everywhere else:** setup names carry the level through stats, the dashboard, the bench and
  `scripts/ask.js`.
- **Speed:** exchange recursion uses only the pieces attacking the square, and reply positions
  come from their FEN. Level 3 went from 3.5 s to about 0.15 s per position, and level 0 got 25%
  faster.
- **Level 0 is unchanged:** identical output on all 4,826 logged positions.
- **Live suite** (4,520 decisions, FINDINGS.md §7):
  - Level 1 cut undecided cp loss from 95 to 86 (choice) and from 88 to 71 (noul), and
    blunders by about a third.
  - Levels 2 and 3 were heeded but added nothing measurable.
  - assisted-noul-f1's move-quality estimate (1718 [1517–1772]) is the first one inside the
    rated range.
- **Live games** (58 of 60, stopped on a 4-minute lost-position grade, FINDINGS.md §7):
  - assisted-noul performance Elo was 1356 at level 0, 1494 at level 1 and 1529 at level 2.
    Level 0 pooled with M5 is 1260.
  - That's the same direction as the suite, but within noise: the intervals are about ±200.
  - Levels 1–2 beat the 1646 and 1700 rungs for the first time.
- 87 unit tests pass.

**Open follow-ups** (FINDINGS.md "Next steps"):
- ladder rungs between greedy capture (≤ 1026) and skill 0 at depth 1 (1517)
- the deeper check (`--check 60 --from runs/bench-suite-… runs/bench-games-…`)
- `includeFen` and more assisted facts, tested one at a time
- more ladder games at foresight levels 0–2 (FINDINGS.md next step 5); slow grades stall them
- lost-position grades that take 10–120 s. Any fix changes the grading method, such as a node
  cap or not solving mates past the ±1000 cap. It would then need the bench and a new
  calibration, so it's the user's call.
