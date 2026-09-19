# TypeSafe Chess — build plan

A local web app for testing how well TypeSafe's System One model (**Jev**) makes decisions,
using chess as the test bed. Jev picks moves from the legal-move list, and Stockfish grades
every choice. Each color is played by **Me, Jev or Stockfish** (chosen per game and changeable
mid-game), so the same app covers:

1. **Analysis**: Me vs Me. You move both sides and ask Jev whenever you want.
2. **Jev vs Me**: you play one color and Jev plays the other.
3. **Jev vs Jev** and **Jev vs Stockfish**: hands-off games, against a strength-limited or
   full-strength Stockfish.

Every game lets you step through Jev's turn (or let it play automatically), browse and rewind the game, and edit the
position. Jev gets an estimated Elo from its play (§4).

Every Jev decision can run with two kinds of input (**raw** or **assisted**) and two question
strategies (**Choice** or **Noul-per-move**). The point is to compare them on the same
positions.

Research for this plan was done on 2026-09-17 against the TypeSafe docs (docs.typesafe.ai)
and `@typesafe-ai/sdk` 0.6.0. **Re-read the live docs before writing integration code.** They
are the source of truth, and model details change.

---

## 1. Verified facts (re-check live)

### TypeSafe
- Endpoint: `POST https://api.typesafe.ai/v1/systemone`, Bearer auth. Model `jev-latest`
  (currently the same as `jev-1.13.0`; `jev-preview` is the same model too). Each response
  names the versioned model that answered, so log it.
- JS SDK: `npm i @typesafe-ai/sdk` (0.6.0, Node ≥ 20). `new TypeSafeClient()` reads
  `TYPESAFE_API_KEY`, or pass `{ apiKey }`. The SDK **refuses to run in a browser** unless
  given `dangerouslyAllowBrowser`, so all calls go through our Node server.
- Call: `client.systemOne({ state, questions, model? })` returns `{ model, answers, usage: { input_tokens, output_tokens } }`.
  - `choice(instructions, { label: description|null, ... })` returns `{ choice, confidence, probabilities }`. Up to 255 options.
  - `noul(instructions, { true?, false? })` returns `{ noul }` (P(yes); there is no separate confidence).
  - `score(instructions, [level0, level1, ...])` (array, ≥ 2 levels) returns `{ score, confidence, legend, probabilities }`.
  - `instructions`, criteria descriptions and `state` may each be a string, a JSON object or an array.
  - Question IDs are **not** sent to the model, so every question must carry its full meaning.
- Questions in a single request run in parallel and can't see each other's answers. Most
  requests finish in about 100 ms.
- Errors: 401 auth, 422 malformed, 429 rate limit, 529 overloaded. Retry 429/529 with
  backoff (the SDK has retry logic in `src/retry.ts`).
- Limits and pricing (they change dynamically): about 1,200 requests/min and 250k tokens/s.
  Input costs $0.042 per million tokens, and output is free.
- ~~The max number of questions per request isn't documented.~~ **Verified in M0:**
  - The only limit is the token budget. 2,048 Nouls worked; 4,096 returned HTTP 400
    `max_tokens_exceeded`.
  - Choice probabilities come back in steps of 0.01, so metrics must handle ties.
  - Repeating a request moves probabilities by up to about 0.04.
  - See CLAUDE.md, "Verified live".

### Known Jev 1.13 weaknesses that matter for chess (docs: model-jaggedness/jev-1.13)
- **Counting is unreliable.** FEN encodes empty squares as digits, so reading FEN means
  counting. Give Jev an explicit **piece-by-square list**. FEN can go in only as a secondary
  field (make it a flag and test with and without it).
- **Not a calculator; poor at numeric comparisons.** State material swings in words ("wins a
  knight"), not only as numbers.
- **Accuracy drops as irrelevant state grows.** Keep state small and list only facts that
  apply (skip "gives_check: false" noise).
- **Reads literally; struggles with indirection.** Word instructions plainly and in the
  mover's own terms ("you are White").

### Libraries
| Need | Package | Notes |
|---|---|---|
| Rules, SAN, attacks | `chess.js` 1.4.0 (BSD-2) | `moves({verbose:true})`, `attackers(sq, color)`, `isAttacked`, `isCheckmate`, `isDraw`, `history`, `pgn`, `setHeader`. ESM build is a single file: `dist/esm/chess.js`. |
| Board UI | `@lichess-org/chessground` 10.x (GPL-3), or legacy `chessground` 9.2.1 | The lichess board. ESM spread over several files in `dist/` with relative `.js` imports, so serve the folder statically. CSS lives in `assets/` (`chessground.base.css`, `chessground.brown.css`, `chessground.cburnett.css`). Arrows come from `setAutoShapes` with custom brushes. |
| Engine | Stockfish 19 **lite single-threaded** WASM (GPL-3) | **Don't `npm install stockfish`**: its tarball is 161 MB. Download only `stockfish-19-lite-single.js` and `.wasm` (about 1.8 MB) from `https://github.com/nmrugg/stockfish.js/releases/download/v19.0.0/` into `public/vendor/stockfish/`, and add its `Copying.txt`. It runs as a Web Worker without COOP/COEP headers, and also runs under Node (used by the headless bench). |

No framework and no bundler to start with: vanilla ES modules plus a `node:http` server.
Add esbuild only if import resolution gets messy.

---

## 2. Architecture

```
typesafe_chess/
  CLAUDE.md  PLAN.md  README.md  package.json  .gitignore
  .typesafe-api-key          # user's key, one line; gitignored; NEVER print or log
  server/
    index.js        # node:http: static files, /vendor routes into node_modules, POST /api/jev
    typesafe.js     # key loading (env TYPESAFE_API_KEY, else .typesafe-api-key), client, mock mode
    position.js     # piece list, move descriptions, assisted facts (pure, unit-tested)
    questions.js    # builds state + questions for each setup
  public/
    index.html  styles.css  app.js
    engine.js       # Stockfish worker wrapper: analyse(fen, {multipv, depth}), bestmove(fen, {elo, movetime})
    grading.js      # cp loss, win%, accuracy, distribution metrics (pure, shared with bench)
    elo.js          # performance Elo (MLE + interval), ladder step, move-quality Elo (pure, shared with bench)
    editor.js       # position editor: spare pieces, side to move, castling, en passant, validation
    vendor/stockfish/…
  bench/
    run.js          # headless Jev vs Stockfish + position suite, writes runs/*.jsonl; --calibrate for Elo
    positions.json  # fixed test positions (mates in 1, hanging pieces, forks, quiet moves); also the UI's test-position menu
    elo-calibration.json  # written by --calibrate: cp loss → Elo curve and anchor ratings
  runs/             # *.jsonl decision logs from the UI and the bench (same format)
  test/*.test.js    # node --test
```

Scripts: `npm start` (serves on http://localhost:5173), `npm test`, `npm run bench -- …`.

### `POST /api/jev`
Request:
```json
{ "fen": "…", "history": ["e4","e5","Nf3"], "setup": { "info": "raw|assisted", "strategy": "choice|noul", "shuffle": true, "includeFen": false, "foresight": 0, "lessons": 0, "book": null }, "model": "jev-latest" }
```
Response:
```json
{ "moves": [{ "san": "Nc6", "uci": "b8c6", "p": 0.41 }],   // sorted by p, sums to 1
  "pick": { "san": "Nc6", "uci": "b8c6" }, "confidence": 0.63,
  "positionEval": { "score": 2.1, "probabilities": { "0": 0.02, … } },
  "model": "jev-1.13.0", "usage": { "input_tokens": 0, "output_tokens": 0 }, "latencyMs": 0,
  "request": { "state": {}, "questions": {} },    // exact payload, for the inspector
  "mock": false }
```
The server validates that `pick` is legal (it always should be, since labels come from
`chess.js`). **Picking policy lives in the client**: argmax by default, or "sample from the
distribution" for varied autoplay games.

### `POST /api/log` and `GET /api/runs`
The client posts one line per graded decision, and the server appends it to
`runs/ui-YYYY-MM-DD.jsonl` in the bench's format (fields in §5, Logging). `GET /api/runs`
returns the logged lines for the session dashboard. Neither route ever touches the key.

### Mock mode
`TYPESAFE_MOCK=1`, or no key found, gives a heuristic distribution (softmax over captures and
checks plus noise). The UI shows a loud **MOCK** badge. When a key exists and a call fails,
**show the error. Never fall back to mock silently.**

---

## 3. The experiment: state and question design

### Common state (both setups)
```json
{
  "you_are": "white",
  "move_number": 12,
  "in_check": false,
  "pieces": {
    "yours":    ["King on g1", "Queen on d1", "Rook on a1", "Knight on f3", "Pawn on e4", "…"],
    "opponent": ["King on g8", "…"]
  },
  "recent_moves": "8. Bd3 Nbd7 9. O-O Re8 10. …",   // last ~10 plies, numbered SAN
  "fen": "…"                                         // only when setup.includeFen
}
```

### Raw setup: notation restated, no analysis
Choice criteria map each **SAN label** to a plain restatement of that move and nothing more:
`"Nxe5+": "Knight from f3 captures on e5, giving check"`, `"O-O": "Castle kingside"`,
`"e8=Q": "Pawn from e7 advances to e8 and promotes to a queen"`.

### Assisted setup: one-ply rules facts computed by `chess.js`
Each move's description is a small object that **lists only the facts that apply**. Built in
M1; the exact wording and edge cases are documented at the top of `server/position.js`.
- `move`: the raw restatement (always present)
- `captures`: the piece taken, in words ("a knight")
- `promotes_to`
- `checkmate` (no further facts are listed: the game ends) / `stalemate` / `check`
- `lands_on`: present only when the opponent can legally capture the moved piece:
  `{ attacked_by, defended_by, hanging? }`. `hanging: true` when it is undefended, or attacked
  by a lower-value piece.
- `exchange_on_square`: SEE on the destination square using legal moves, **in words**
  ("wins material worth a minor piece", "even trade", "loses material worth a rook")
- `leaves_hanging`: your other pieces that are hanging after the move
- `answers_threat`: for each of your pieces hanging before the move that isn't afterwards, how:
  it moves it, captures the attacker, stops the attack (a block or pin), or defends it
- After a **checking move**, `leaves_hanging` and `answers_threat` judge threats by the
  opponent's attacks ignoring the check, because a check only delays a capture by one move.

Position-level state additions: pieces currently hanging on each side (`hanging.yours`,
`hanging.opponent`, each only when non-empty), and `material` in words, giving the value
balance and the actual imbalance ("you are ahead in material by the value of two pawns: you
have a knight against a pawn").

**Fairness rules:** Stockfish output never enters Jev's state or criteria. Assisted facts are
rules facts limited to one ply plus a single-square SEE, with no search. Document every fact in
`position.js` and cover each one with a unit test. The one exception is the opt-in lesson levels
below, which the user asked for on 2026-09-19.

### Foresight levels (`setup.foresight`, assisted only; added 2026-09-18)
A separate, opt-in dimension. Level 0 is the assisted setup above, unchanged. Each level adds
one fact about the opponent's reply, on top of the level below, so level N against N − 1
measures that one fact. The facts are still rules facts from chess.js: they look at the
opponent's single reply and never at Stockfish.
1. `after_their_best_capture`: what the move wins, minus the opponent's best capture anywhere
   in reply (SEE per square), in words, only when it isn't even.
2. `allows_mate`: the opponent can checkmate in reply, naming the move.
3. `allows_fork`: a reply that attacks two of your pieces at once (or gives check and attacks
   one), with a forking piece you can't simply take, and costing you at least a minor piece.
   Counting pawn-only forks doubled how often it fired, with fewer of the flagged moves being
   blunders (23% against 33%).
- **Why these, in this order:** a first pass over assisted Jev's logged blunders (63 unique).
  Level 1's number ranked the best move above Jev's pick in 28 of them and never below. Level 2
  is rare but almost always a blunder. Level 3 is noisier. Pins and skewers were pure noise, and
  "threatens" facts never explained a blunder, so they aren't levels.
- **Setup names** carry the level (`public/setups.js`): `assisted-choice` is level 0 (the M5
  name), `assisted-choice-f2` is level 2. Raw has no levels. The dashboard and bench report
  never pool levels. Bench: `--setups assisted-choice-f1,assisted-noul-f3`.
- **Cost:** one analysis takes up to about 180 ms at level 3 on a 48-move position (65 ms at
  level 0), after reading reply positions from their FEN instead of chess.js `move()`.
- **Result on the suite (FINDINGS.md §7):** level 1 cut undecided cp loss by 9 (choice) and 17
  (noul) and blunders by about a third. Levels 2 and 3 were heeded but added nothing
  measurable. Games are next.

### Lessons: the feedback loop (`setup.lessons`, assisted only; added 2026-09-19)
Jev's graded failures become **lessons**, and a setup can show Jev what they say. This is the
one place where Stockfish's grades reach Jev's input. The user chose it on 2026-09-19, with
exact-position memory included, knowing that memory passes Stockfish's verdict on a specific
move straight to Jev. It's opt-in and named in the setup, so stats never pool it with the setups
above. TypeSafe has no fine-tuning or feedback API, so the only lever is the input.
- **Live by default (the user's call, 2026-09-19): no script step, and the logs are the
  reference.**
  - Each Jev decision and its grade are appended to `runs/*.jsonl` as they happen: by the UI
    through `POST /api/log`, and by the bench directly.
  - Before every ask with live lessons, the learner (`server/learner.js`) reads what was
    appended since the last ask. It joins decisions with their grades, runs the pattern
    detectors on new positions (cached in `lessons/cache/`), and folds the records into the
    miner (`server/mine.js`).
  - A blunder graded a second ago is remembered on the next ask in that position. In mock, the
    next ask after Qxd6?? was graded already showed "remembered here: Qxd6".
  - The server reads all the logs at startup: 59 MB and 14k graded decisions in about 2 s once
    the cache exists. Each process (the server, a bench run) has its own learner, and they agree
    because they read the same logs.
  - A mock server learns only from mock decisions, and a live one only from real ones.
- **Setup names:** `assisted-noul-f1-L2live` is foresight 1 with lessons level 2, live.
  `…-L2b1` uses **frozen book 1** instead: a copy of the lessons that doesn't change, for runs
  that need a fixed setup.
  - `npm run lessons` writes a report on the live lessons (`lessons/live.md`), and `--freeze`
    saves them as the next frozen book.
  - Book 1 was mined and accepted before the switch to live.
  - Live decisions log `lesson_rev` (how many graded decisions the lessons had learned from),
    so a learning curve can be plotted.
  - A live setup pools decisions made with different lessons: that's what learning means. For
    a before/after comparison, freeze.
- **Levels** (`server/lessons.js` documents the exact wording). Each level adds one fact on top of
  the level below, after all other facts. Level 0 sends exactly the request without lessons
  (unit-tested).
  1. `lesson`: the promoted patterns that match the move, as one statement plus what happened
     before: "This move leaves you behind in material after the opponent's best capture and
     passes up another move that comes out further ahead in material. In your past games,
     moves like that were usually mistakes." The patterns are chess.js facts: the assisted and
     foresight facts as predicates, plus `passes_up_material` (another move comes out a minor
     piece or more further ahead). They're detected at the foresight level they need, and the
     setup still shows only its own foresight facts.
  2. `last_time_here`: Jev picked this move in this exact position before (same pieces, side,
     castling and en passant), and it was graded a mistake or blunder.
- **Learning rules** (`server/mine.js`, the same live and frozen):
  - **Held out:** the suite's positions (`bench/positions.json`, `bench/suite-sampled.json`) are
    never learned from, not even by memory. Otherwise a suite run would teach itself the answers
    across its 5 option orders. The report measures every pattern on them separately. Keep
    suite runs at `--sample 100` or less, because a bigger sample draws positions that weren't
    held out. The UI's test-position menu reads the same file, so asks there don't teach
    anything either; the decision panel says so.
  - **Failures:** a failure is a pick graded mistake or blunder. Pattern statistics use
    undecided positions only (±500 cp, as for the Elo curve). In decided positions nothing is a
    failure, and on the first run that made every pattern look like noise.
  - **Pick statistics** use assisted setups only, because those are the only setups a lesson can
    reach. The memory takes every failed pick in any setup.
  - **Promotion:** a pattern is promoted when it explains at least 10 training failures (it
    matches the pick and no best move). Assisted picks with it must also fail at least 2× as
    often as assisted picks overall, and at least 50% of all legal moves with it must be
    failures. The lesson says "usually" when at least 75% are failures, else "often". Live
    promotions can change as data comes in.
- **First results (book 1 and the live lessons on 2026-09-19, about 14,000 graded decisions):**
  - **Promoted:** `passes_up_material` ("usually") and `behind_after_reply` ("often").
    - `passes_up_material`: 80% of the legal moves with it are failures in training (90% held
      out), and 74% of assisted picks with it failed (100% of 48 held out). The base rate is 9%.
    - `behind_after_reply`: 67% and 70% of moves with it are failures, and 28% of picks failed.
  - **Not promoted:**
    - `lands_hanging`: assisted Jev's picks with it fail only 1.1× as often as its other picks.
      It already heeds that fact.
    - `allows_fork`: fewer than half of the moves with it are failures.
    - `allows_mate` and `exchange_loses`: too few training failures.
  - **No pattern explains 58%** of assisted failures. Most are deep tactics, where the best move
    is a quiet one that one-ply facts even mark as losing.
  - **Memory:** about 394 failed moves in 390 positions. Replaying the logs in order, only 20
    decisions came in a remembered position, and 7 repeated a remembered failure (all made
    without memory).
- **Cost:** with the first lessons at foresight 1, lessons match about 60% of legal moves, and
  the request is about 35% larger. The Jev docs warn that extra state can hurt, so measure
  tokens as well as loss. A live ask also waits for the catch-up: one pattern analysis (up to
  about 0.2 s) per newly graded position.
- **Reading results:** the suite measures level 1 on positions the lessons never saw. Memory only
  matters where positions repeat, which means games. A `-L2` setup's performance Elo is Jev
  plus a record of Stockfish's verdicts on positions it has played before, not Jev alone.
- **In the app:** the top bar has a "lessons 0 1 2" control and a picker for live or a frozen
  book (both disabled for raw). The decision panel shows how many moves were warned, what was
  remembered, and how many graded decisions the live lessons had learned from. Decision lines
  log `lesson_hits`. `LESSONS_DIR` points the server at another lessons folder.

### Questions
- **Strategy A, Choice (default).** One Choice over all legal moves:
  ```js
  best_move: choice(
    { task: `You are playing ${side}. Choose the move to play in this chess position.`,
      goal: "The strongest move: the one a strong player would choose." },
    criteriaBySan)   // shuffled order when setup.shuffle; record the order used
  ```
- **Strategy B, Noul per move** (the rerank-cookbook pattern). One request with one Noul per
  legal move. Its instructions are an object with the same shape for raw and assisted, so the two
  can be compared: `{ question: "You are playing ${side}. Is ${san} one of the best moves in this
  position?", move: <raw string or assisted object> }`. Rank by P(yes). The UI shows P(yes)
  normalized to sum to 1. The limit is tokens, not question count, so no chunking is needed
  (verified in M0).
- **Strategy C (later, optional): Score per move.** Uses a 5-level rubric whose levels describe
  concrete situations: "loses decisive material or allows mate", "clearly worsens the
  position", "playable, keeps the balance", "good, improves the position or wins a pawn",
  "wins significant material or forces mate".
- **Speculative extra question, sent with every request:**
  `position_eval: score("How is the game going for you (${side}) right now?", ["losing decisively", "clearly worse", "roughly equal", "clearly better", "winning decisively"])`.
  It's compared against Stockfish's eval, bucketed at ±100 and ±300 centipawns, to test Jev's
  judgment of positions as well as its choice of moves.
- Don't gate moves on confidence. **Log** confidence so the data can show whether it predicts
  move quality.

---

## 4. Grading with Stockfish (browser worker; the same code runs in Node for the bench)
- Before each Jev decision, analyse the position with `MultiPV = number of legal moves` at a
  configurable `depth` (default 12). That gives an eval for every legal move from the mover's
  point of view. Convert mate scores to ±(10000 − plies), and cap evals at ±1000 before taking
  differences.
- Per decision:
  - `cp_loss = best − eval(pick)`
  - `win% = 50 + 50·(2/(1+e^(−0.00368208·cp)) − 1)`
  - per-move accuracy `= 103.1668·e^(−0.04354·Δwin%) − 3.1669`, clamped to 0–100
  - labels (lichess-style, by win% drop): inaccuracy ≥ 10, mistake ≥ 20, blunder ≥ 30
- **Distribution metrics** (these use Jev's full answer, not just its pick):
  - P(the engine's best move)
  - rank of the engine's best move in Jev's ordering
  - probability mass on "good" moves (within 50 cp of best)
  - **expected cp loss** = Σ pᵢ·lossᵢ
  - Spearman correlation between Jev's probabilities and engine evals (average ranks for ties:
    Choice probabilities come in steps of 0.01, and many are exactly 0)
  - **Noul:** the normalized P(yes) is much flatter than a Choice distribution (for example,
    a mate-in-1 got 11% after normalizing, from P(yes) 0.68–0.77). So P(best) and expected cp
    loss aren't comparable between the Choice and Noul strategies. Compare them by rank,
    Spearman and cp loss of the pick, and log the raw P(yes) values.
- Position-eval calibration: a confusion matrix of Jev's `position_eval` bucket against the
  Stockfish bucket.
- Opponent Stockfish in autoplay: `UCI_LimitStrength true` + `UCI_Elo` (1320–3190 in the lite
  build), `Skill Level 0–20`, full strength, or full strength to a fixed depth.
  - **Changed in M4:** the limit is a **node budget** (`go nodes`, default 150,000), not a
    `movetime`. With a time limit, strength depended on CPU load and core type (this Mac has
    performance and efficiency cores), so calibrated ratings wouldn't carry over. Measured:
    about 700k nodes/s in Node and 650–750k in the browser, so 150k nodes ≈ 200 ms.

### Grading as built (M3, 2026-09-18)
- **Dedicated grader workers** (`public/grader.js`) run separately from Stockfish as a player:
  a pool of cores − 2, at most 4. They share a priority queue (grade > deeper check > timeline
  eval, oldest first within a priority) and a cache keyed by FEN, depth and MultiPV. The hash
  is cleared (`ucinewgame`) before each analysis, so a grade doesn't depend on which worker ran
  it or what it analysed earlier (checked: identical lines from a fresh and a used engine).
- **When grading happens:** every Jev decision is graded after it arrives (Ask → Grade →
  Play). Step never waits for grading. Auto holds a computer move while more grades are queued
  than there are workers (the hint says so, and Play moves anyway), so the queue can't outgrow
  the grader. Every position in the game also gets a single-PV eval for the timeline.
- **Why a pool and a hold (2026-09-18):** with one worker, the queue in Auto grew for good.
  - At full speed Auto asks Jev every 0.2–0.5 s, but a grade takes a median 0.9 s (mean 2.4 s).
  - Lost positions (best capped at −1000) can take 10–120 s. Full MultiPV works out exact
    mates for hopeless moves: one position took 1.6 s at MultiPV 16 and 40 s at MultiPV 22
    (all its moves), against 12 ms single-PV. In the UI log, 11% of grades took 63% of the
    grading time.
  - Games started back to back added to the backlog, and a reload dropped it: 30 decisions of
    one game were never graded.
  - Replaying the logged sessions, 4 workers cut the mean decision → grade lag from 74–97 s
    to 2–4 s. The hold then cost 0–19 s over sessions of 2–35 minutes. One slow grade still
    takes as long, but it no longer blocks the others.
- **Best moves** are all moves whose *capped* eval equals the top one. After the ±1000 cap,
  a mate in 1 and a mate in 3 tie, so neither counts as a loss. P(best) sums p over that set.
  The rank of the best move reports ties, because Jev's probabilities come in steps of 0.01.
- **Loss is graded on Jev's argmax pick.** When the pick policy samples, the move actually
  played is also graded (`chosen_loss`).
- **Stats use one decision per position:** the one whose move was played, else the latest
  attempt. Overridden decisions are left out. The stats are grouped as **Jev as White**,
  **Jev as Black**, and **Jev asked at other turns** (analysis asks, and asks at your turn or
  Stockfish's).
- **Deeper check:** a button re-grades a decision at depth +4 and shows whether the best move
  and the pick's loss change. It can be stopped. Very deep checks belong in the bench.
- **Timeline:** Stockfish's eval as White's win%. Jev's `position_eval` is plotted on the same
  axis by mapping its levels to representative cp (−600, −200, 0, 200, 600, interpolated).
  Jev's cp-loss bars are colored by label.
- **Estimated Elo:** the move-quality tile shows "—" until `bench/elo-calibration.json` exists
  (M4). It also refuses to use a calibration made at a different grading depth.

### Elo as built (M4, 2026-09-18)
- **Calibration** (`npm run bench -- --calibrate`, `bench/calibrate.js`):
  - **Rungs:** random mover, greedy capture, Stockfish skill 0 at depth 1, skill 0 at 1k
    nodes, full strength at depth 1, skill 0 at 150k nodes, and UCI_Elo 1320, 1500 … 2900,
    3190 at 150k nodes, plus full strength at 150k and 750k nodes.
  - **Games:** each rung plays the next two up, 12 games per pair, from 12 short openings
    with both colors, run in parallel. Games stop at 300 plies (a draw). The raw file keeps
    every game's moves.
  - **Ratings:** one Bradley–Terry maximum-likelihood fit over all games, with one virtual
    draw per pair. The result is shifted so the UCI_Elo rungs average their nominal values.
  - **Bounds** (added after the first run): a rung that no competitive pair (score 5–95%)
    links to the UCI_Elo rungs is reported as a **bound** (≤ or ≥), not a rating. Its fitted
    number would come from the prior, not the games. In the first run, random and greedy
    only drew each other (mostly by stalemate) and scored 0.5/12 against everything above,
    so their "≈1240" was prior-driven.
  - **The curve:** cp loss counts **undecided positions only** (best eval within ±500 cp,
    `UNDECIDED_CP`). In the first run, random mover's plain average loss was 41.8, below
    Elo 1320's 71.8: once a position is lost, every move is capped at −1000 and "loses"
    nothing. Each rung's positions are prefiltered with a depth-8 eval, then 120 are graded
    at depth 12 and kept if still undecided. Only rated rungs with at least 20 undecided
    moves place a point on the curve, which is forced monotone (pool-adjacent-violators).
  - The same rule applies to Jev: move-quality Elo uses Jev's cp loss in undecided positions,
    and refuses a calibration with a different depth or band.
  - Output: `bench/elo-calibration.json` (with `band` and per-rung `bound`), plus raw games
    and grades in `runs/calibration-*.jsonl` (the dashboard doesn't read these).
- **Opponent ratings** (`public/ratings.js`):
  - **calibrated:** an exact rung.
  - **interpolated:** UCI_Elo between calibrated UCI_Elo rungs at the same node budget.
  - **nominal:** Stockfish's own UCI_Elo number.
  - Settings with no rating from any of these are left unrated. Every game logs the rating
    and its source.
- **Ladder** (Stockfish dialog, with an option to swap Jev's color each game):
  - It uses the calibrated rungs, or UCI_Elo in steps of 100 before calibration. It starts
    in the middle with 400-point steps and snaps to the nearest rung.
  - Only games that count toward performance Elo move it. In Auto, the next game starts
    after 2 s.
- **Performance Elo** (dashboard):
  - **Eligible games:** standard start, no overrides, no cuts, no player change mid-game,
    one setup for all of Jev's own decisions, not mock, and an opponent with a real rating
    (not a bound).
  - Games against you use the rating you enter and get their own column.

### Jev's estimated Elo
Two estimates, each kept **per setup** and always shown with a 95% interval and the number
of games or moves behind it. The UI labels it "estimated Elo" and says what it's measured
against: our Stockfish ladder, not FIDE or lichess ratings.

- **Performance Elo, from game results.** The maximum-likelihood rating R that solves
  Σ 1/(1 + 10^((oppᵢ − R)/400)) = score over games against opponents with a known rating,
  with the interval taken from the likelihood. The opponents are Stockfish at a set `UCI_Elo`
  (or a rated anchor below the floor), or you in Play vs. Jev if you enter your own rating
  (kept as a separate row). An all-win or all-loss record has no finite estimate, so show
  "above X" or "below X" instead.
  - **Counted games:** they start from the standard position, have no human overrides and
    were never cut off by a rewind. Other games still count toward the move stats.
  - **Adaptive ladder** (autoplay option): after each game, move the opponent up after a
    Jev win and down after a loss, so games cluster near Jev's 50% point, where each result
    says the most. Start in the middle of the full ladder with 400-Elo steps, and halve the
    step after each change of direction (minimum 50). Large early steps mean the starting
    point doesn't bias the result.
- **Move-quality Elo, from cp loss.** Works after one game and in every mode. It maps Jev's
  average cp loss to Elo through a curve **we fit ourselves**: `bench/run.js --calibrate`
  plays and grades opponents across the whole ladder through the same pipeline (same depth,
  same ±1000 cap) and writes `bench/elo-calibration.json`. Show "uncalibrated" until that
  file exists. Don't use published ACPL→Elo formulas, because they were fit on human games at
  other depths.
- **No assumed range.** Nobody knows how strong Jev is; that's what the app measures. The
  ladder must be able to rate any result, from the bottom to the top of the scale:
  - **Top:** above `UCI_Elo` 3190, full-strength Stockfish (no `UCI_LimitStrength`) at
    increasing `movetime`.
  - **Middle:** `UCI_Elo` 1320–3190 (verify the lite build's range in M0).
  - **Bottom:** below 1320, `Skill Level` 0–20 plus two scripted baselines (a random legal
    move, and "capture the most valuable piece, otherwise random").
  - `--calibrate` rates every rung at our actual `movetime` in a headless round-robin
    chained to the `UCI_Elo` settings, and stores the ratings in
    `bench/elo-calibration.json`.
  - If Jev beats or loses to every rung, report "above" or "below" that rung instead of
    making up a number.

---

## 5. UI
Agreed with the user on 2026-09-17. **Layout:** the board sits on the left, with step controls
and editor buttons under it. Jev's decision panel and this game's stats are on the right. The
timeline and move list run across the bottom. A top bar holds the mode, setup chips (info,
strategy, pick policy, shuffle, include FEN), the model id and the MOCK badge. Settings that
don't need to be seen all the time (Stockfish opponent Elo or skill, grading depth, ladder on
or off, your own rating) go in a settings drawer.

### Players (changed 2026-09-18, replaces the mode picker)
- The top bar has a **White** and a **Black** picker, each **Me, Jev or Stockfish**. Me vs Me
  is the old Analysis mode. Changing a player mid-game is logged (`players` event).
- **Stockfish settings** (a dialog, used when Stockfish plays a side): Elo 1320–3190, skill
  level 0–20, or full strength, plus think time per move (50–60000 ms). The default is Elo
  2250 and 200 ms, the middle of the rated range. Every Stockfish move logs its settings.
- Stockfish runs as a Web Worker (`public/engine.js`). As a player it's an opponent, not a
  grader: its moves never enter Jev's state.

### Board
- chessground: drag to move, with legal destinations from chess.js. A button flips the board.
- Arrows: Jev's top 5 moves in purple, with width and opacity scaled by p. Stockfish's move
  as a player is green. The grader's best move (M3) needs its own color, distinct from both.

### Stepping through a computer's turn
- **Computer moves: Step | Auto** (turn card), for both Jev and Stockfish:
  - **Step:** at a computer's turn, Jev is asked (or Stockfish searches) by itself, and the
    move waits for **Play**. This is the Ask → Play flow.
  - **Auto:** the move is played after a delay (instantly, 0.5, 1 or 2 s), so games between
    computers run by themselves. Switching to Step pauses the game; switching back resumes it.
- Jev's turn shows **Ask Jev** (arrows and the distribution appear) → **Play**. M3 adds a
  **Grade** step between them. Stockfish's intended move shows as a green arrow.
- **Ask again** re-runs Jev on the same position, with a new shuffle when shuffle is on. Every
  attempt is logged with an `attempt` number. **Ask Jev** works at any position, including
  your turn or Stockfish's, to see what Jev would play there.
- **Override:** while Jev's move hasn't been played, you can drag a different move for Jev.
  The move is tagged `override` and shown as such in the move list. It's left out of Jev's
  move stats, and the game stops counting toward performance Elo. (This is a human choice,
  not the confidence gating ruled out in §3.)
- Errors stop the game and are shown in full. Nothing retries by itself.

### Browsing and rewinding
- The |< < > >| buttons and the ← → keys browse the game. Browsing never changes it.
- Browsing to one of Jev's moves brings back that move's decision panel and arrows as they
  were at the time.
- Making a move from an earlier position **cuts off the rest of the game**; there are no
  variation trees. The cut line is saved to the log first, tagged with `cut_at` (the ply).

### Position editor
- Works like lichess: drag pieces on and off the board, add pieces from a spare-piece tray,
  clear the board or reset to the start position, and set the side to move, castling rights
  and the en-passant square.
- **Done** validates the position with chess.js: both kings are present, the side not to move
  isn't in check, no pawns are on the back ranks, and the castling rights are consistent. If
  something is wrong, say what, and stay in the editor.
- Also load a FEN, paste a PGN, or pick from a **test positions** menu that reads
  `bench/positions.json`.
- Games that start from an edited or loaded position are tagged `start: "custom"`. Their moves
  count toward move stats but not toward performance Elo.

### Decision panel
Every legal move sorted by Jev's p (as bars), with the engine eval, cp loss and label. Also:
confidence, the rank of the engine's best move, expected cp loss, latency, tokens and a link
to the inspector.

### This game's stats (live)
Tiles that update as grading finishes: **estimated Elo** (move quality, with an interval),
accuracy, average cp loss, counts of ?? / ? / ?!, top-1 match rate, average P(best), and the
correlation between confidence and cp loss. Overridden moves are left out.

### Move list and timeline
- Move list: each of Jev's moves is colored by its label (?!, ?, ??) and overrides are marked.
  Click a move to jump to it.
- Timeline: Stockfish's eval as a line, Jev's `position_eval` as dots and Jev's cp loss as
  bars. Click to jump. This replaces the separate eval chart.

### Session dashboard (M4, `/dashboard.html`, `public/sessions.js`)
Built from all `runs/*.jsonl` (UI and bench), with filters for mock, Compare/shadow decisions
and grading depth, and a JSONL download. **Per setup:** performance Elo and move-quality
Elo with intervals, W/D/L, average and expected cp loss, accuracy, blunder rate, P(best),
latency, tokens and cost. Also the ladder's history, the position-eval calibration (a
confusion matrix) and a confidence-vs-loss chart.

### A/B
- A "Compare setups" button runs all four setups (raw/assisted × choice/noul) on the current
  position in parallel and shows a table graded against the same analysis (one cached search).
- An option in the turn card **shadow-runs** the non-playing setups on every Jev turn, which
  builds an A/B dataset on identical positions. Those decisions are logged with
  `compare: true` or `shadow: true`, graded, and never change the game.

### Inspector
The exact `state` and `questions` sent and the raw answers, for debugging (per the TypeSafe
skill: inspect state, questions, candidates and answers when something fails).

### Logging and export
- The UI posts an **event log** to `runs/ui-YYYY-MM-DD.jsonl` (`POST /api/log`). Every line
  has a `type` and a `game_id`, and the lines join on `decision_id`. Built in M2:
  - `game`: start (`"standard"` only for New game; loaded, imported and edited positions are
    `"custom"`), `start_fen`, `mode`, `human_color`
  - `decision`: one per ask, including every Ask again (`attempt`). Fields: `ply`, `fen`,
    `setup`, `policy`, `order` sent, `moves` (san, uci, p, and noul for the Noul strategy),
    `pick`, `chosen`/`chosen_how` (argmax or sample), `confidence`, `position_eval`, `model`,
    `usage`, `latency_ms`, `mock`. A late answer for a position that has since changed is
    logged with `discarded: true` and never shown.
  - `move`: `ply`, `san`, `uci`, `by` (`jev`, `human`, `override` or `import`),
    `decision_id`, `matches_jev` for human moves where a decision existed, and `engine`
    settings with `think_ms` for Stockfish moves
  - `cut` (the removed line and its decision ids), `restore` (the cut was undone), `players`
    (a player changed mid-game) and `game_end` (`result`, `reason`, `players`, Stockfish
    settings, `overrides`, `cuts`)
  - `grade` (M3): one line per grade, keyed by `decision_id`. Fields: `depth`, `ms`,
    `engine_best`, `best_ucis`, `best_cp`, `evals` (uci → cp or mate), `pick_*` (loss,
    win% drop, accuracy, label), `chosen_loss`, `p_best`, `best_rank`/`best_rank_ties`,
    `good_mass`, `expected_loss`, `spearman`, `sf_bucket`/`jev_bucket`, `confidence`. Deeper
    re-grades have `check: true`. M4 adds the opponent rating to `game_end`.
- PGN export (the "Export PGN" button on the Moves card) with per-move comments:
  `{jev p=0.42 conf=0.61 loss=35 label=inaccuracy setup=assisted/choice depth=12}` for Jev,
  `{stockfish Elo 2250, 150k nodes}` for Stockfish, and `override` for overridden moves.
- **Also logged in M4:** `ladder` lines (Jev's score, the next target and opponent), plus
  `opponent`, `jev_color` and `setup` on `game` and `game_end`.

---

## 6. Milestones
- **M0 — Setup and smoke test.**
  - `npm init`; install `@typesafe-ai/sdk`, `chess.js` and `@lichess-org/chessground`.
  - Download the Stockfish lite files and write the key loader.
  - Make one live call with a trivial Choice plus `client.models.list()` to confirm auth, and
    record the model id.
  - **Check that SAN labels containing `+`, `#` and `=` work as Choice keys.** If they don't,
    key by UCI (`g1f3`) and move SAN into the description.
  - Find the per-request question limit.
  - Load the Stockfish lite build under Node and check its `UCI_Elo` range and whether
    `Skill Level` works.
  - Record the answers in CLAUDE.md under "Verified live".
- **M1 — Position and questions.**
  - Write `position.js` and `questions.js` with `node --test` coverage on known FENs: mate in
    1, a hanging piece, a fork, a pinned piece, en passant, promotion, castling.
  - Make live calls on the start position and a mate-in-1, and look at the distributions for
    raw vs. assisted.
- **M2 — Board, stepping and editing.**
  - Analysis and Play vs. Jev modes.
  - The three-step Jev turn with pause, ask again and override.
  - Browsing and cut-off.
  - The position editor, FEN/PGN load and the test-position menu.
  - Arrows, the decision panel (Jev's p only for now) and the inspector.
  - `POST /api/log`.
- **M3 — Grading and game stats.** Done 2026-09-18 (see "Grading as built" in §4).
  - The Stockfish worker and the metrics above.
  - The green arrow and engine columns in the decision panel.
  - The live game-stat tiles, move-list labels, timeline and position-eval calibration.
  - `elo.js` with unit tests. Move-quality Elo shows "uncalibrated" until M4.
- **M4 — Elo, ladder and A/B.** Done 2026-09-18 (see "Elo as built" in §4).
  - (Done early, 2026-09-18: Me/Jev/Stockfish per color, Step/Auto, and the Stockfish
    player settings.)
  - The adaptive ladder for Jev vs Stockfish.
  - `bench/run.js --calibrate`: the cp loss → Elo curve and the rating chain for sub-1320
    anchors.
  - Performance Elo.
  - The Noul strategy, Compare setups and shadow runs.
  - The session dashboard and export.
- **M5 — Headless bench and findings.** Done 2026-09-18. The bench is `bench/games.js`,
  `suite.js`, `check.js` and `report.js`, run through `npm run bench -- --all`; results are in
  FINDINGS.md. The deeper check was stopped before it ran.
  - `bench/run.js --games 20 --setups raw-choice,assisted-choice,assisted-noul --ladder --depth 12`
    and `--suite bench/positions.json`, writing `runs/*.jsonl` plus a summary table.
  - Write up the results with real numbers in `FINDINGS.md`: which setup plays best, whether
    confidence predicts quality, order-bias effects, latency and cost.

## 7. Things to watch for
- **Don't predict how Jev or any setup will do.** Measure it. Don't make any setup weaker
  or stronger to fit an expectation, and never let code choose moves for Jev.
- **The grader has to be stronger than the player.** If Jev plays at or above
  depth-12 Stockfish, depth 12 grading will underrate it. Periodically re-grade a sample of
  decisions at a much greater depth. If the deeper grader often prefers Jev's pick to the
  depth-12 best move, raise the grading depth.
- Order bias: compare shuffled and fixed option order on the same positions.
- State size: an assisted description of 40 moves can get long. Measure `input_tokens` and
  trim facts that don't carry signal.
- Positions change during autoplay, so check that a response still matches the current FEN
  before applying it. The same goes for browsing, rewinding and editing: a late answer must
  never land on a different position.
- Move-quality Elo is only as good as the grader. The strongest rungs play at or above a
  depth-12 grader, so their measured cp loss is partly grader error, and the curve flattens at
  the top. Above the flat part, report "above X".
- Elo intervals are wide with few games (roughly ±200 after 10 games). Show the interval
  every time and never a bare number. Stockfish's `UCI_Elo` was calibrated at longer time
  controls than our 200 ms `movetime`, so ratings are only meaningful relative to our own
  ladder.
