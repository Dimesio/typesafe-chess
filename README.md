# TypeSafe Chess

A local app for testing **TypeSafe Jev** (a System One model) as a chess decision-maker. Jev
never generates a move: the code lists the legal moves, Jev picks from them, and Stockfish
grades every pick. The point is to find out how well Jev chooses, so nothing here is tuned to
make it look good or bad.

- **chess.js owns the rules.** Jev only chooses.
- **Stockfish only grades.** Its evaluations never reach Jev's state, with one deliberate
  exception: the opt-in lesson levels, which feed Jev's own graded mistakes back to it.
- Everything runs on your machine. The API key stays in the Node server and never reaches the
  browser.

Design and milestones: [PLAN.md](PLAN.md). Results so far: [FINDINGS.md](FINDINGS.md).

## Run it

You need **Node 20 or newer**. There is no build step and no bundler.

```bash
npm install
npm start
```

Open **http://localhost:5173**.

Without an API key the app starts in **mock mode** with a fake Jev, and shows an amber `MOCK`
badge. Everything works except the answers, so this is the way to look around first.

To use a different port:

```bash
PORT=5174 npm start
```

## Use the real Jev

Get a TypeSafe API key, then give it to the server in one of two ways.

**A file in the repo root** (gitignored). This avoids putting the key in your shell history:

```bash
printf 'Paste your TypeSafe key: ' && read -rs K && printf '%s' "$K" > .typesafe-api-key && unset K && echo ' saved'
```

Paste the key, press Enter, and it lands in `.typesafe-api-key` as one line.

**Or an environment variable**, which wins over the file:

```bash
TYPESAFE_API_KEY=... npm start
```

Restart the server and the badge turns into a purple `LIVE`. Live decisions cost about
$0.00007 each, so a full game is well under a cent.

Two rules worth keeping: never commit or print the key, and if a call fails the app shows the
error instead of quietly falling back to the mock.

To force the mock while a key is present:

```bash
TYPESAFE_MOCK=1 npm start
```

## Your first game

1. In the top bar, set **White** and **Black**. Each can be **Me**, **Jev** or **Stockfish**.
   Jev vs Stockfish is the interesting one.
2. The **Stockfish: …** button sets how strong Stockfish plays, how deep it grades, and the
   ladder (see below).
3. The chips next to it are **Jev's setup**, and they change what Jev is told and asked:
   - **raw / assisted** — raw gives Jev bare move labels; assisted adds facts about each move.
   - **choice / noul** — one question over all moves, or one yes/no-style question per move.
   - **foresight 0–3** — how far into the opponent's reply the facts look (assisted only).
   - **lessons 0–2** — whether Jev is told about its own past graded mistakes (assisted only),
     learned live or from a frozen book.
   - **argmax / sample** — take Jev's top move, or sample from its distribution.
4. On Jev's turn: **Ask Jev** → Stockfish **Grade**s every legal move → **Play**. In the
   **Computer moves** row, switch **Step** to **Auto** to let the computer players play on
   their own.
5. The decision panel on the right shows Jev's probability for each move next to Stockfish's
   evaluation and the centipawn loss. Blue arrow: Stockfish's best move. Other arrows: Jev's.

Other things in the UI:

- **Ask again** re-asks the same position. Answers vary a little between identical requests.
- **Compare setups** asks all four setups about the current position and grades them together.
- **Shadow-run the other setups** does that on every Jev turn while a game runs.
- **Edit** opens a position editor, **Load** takes a FEN, a PGN or one of the test positions.
- You can play a move for a computer player yourself. It is tagged as an override and left out
  of Jev's statistics.
- Going back and then playing cuts the game there, and the app says so.
- **Session dashboard ↗** (http://localhost:5173/dashboard.html) has per-setup statistics,
  estimated Elo, confidence against loss, and the ladder history.

## The ladder

In the **Stockfish: …** dialog you can turn on the ladder for Jev vs Stockfish games: after
each game Stockfish goes up if Jev won and down if Jev lost, so games cluster where the result
says the most. It moves one setting of the mode you chose and never changes the mode — Elo
1320–3190, or skill level 0–20. When Jev beats the top of a range or loses at the bottom, the
app tells you which setting reaches further rather than switching for you.

Ratings come from a calibration run of Stockfish against itself
(`bench/elo-calibration.json`), not from FIDE or lichess. Settings the calibration doesn't
cover are shown as unrated, and their games are left out of performance Elo.

## Commands

```bash
npm start                   # the app on http://localhost:5173
npm test                    # unit tests (node --test)
```

```bash
node scripts/ask.js --fen "<fen>" --setups assisted-choice,assisted-noul
```

Asks Jev about one position and prints each setup's distribution. Add `--history "e4 e5"` for
the moves so far, `--json` for machine-readable output. Live when a key exists.

```bash
node scripts/verify-live.js   # re-runs the checks against the live API (model, SAN keys, limits)
npm run lessons               # report on the live lessons → lessons/live.md
npm run lessons -- --freeze   # freeze them as the next book, for a run that must not change
npm run lessons -- --list     # list the frozen books
```

The bench runs headless experiments against the live API:

```bash
npm run bench -- --mock       # offline smoke test (move its files out of runs/ afterwards)
npm run bench -- --all        # the full M5 run: ~5–6k decisions, well under $1
npm run bench -- --games 20   # ladder games only
npm run bench -- --suite bench/positions.json --sample 100
```

`npm run bench -- --calibrate` re-rates the Stockfish ladder. It takes about an hour on 10
workers, so you only need it if you change how grading works.

## What it writes

- `runs/*.jsonl` — one line per decision, grade, move and game. The dashboard, the bench
  reports and the live lessons all read these.
- `lessons/` — frozen lesson books. `lessons/live.md` and `lessons/cache/` are gitignored.
- `bench/elo-calibration.json` — the rating scale for the ladder and for estimated Elo.

Nothing is sent anywhere except the TypeSafe API calls the server makes for you.

## Layout

```
server/     Node server: TypeSafe calls, position facts, questions, lessons
public/     the browser app (plain ES modules, no bundler) and vendored Stockfish
bench/      headless experiments, calibration, reports
scripts/    ask.js, verify-live.js, lessons.js
test/       node --test unit tests
```
