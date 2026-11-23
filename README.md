# Concall Pipeline

Real-time pipeline that watches NSE and BSE for earnings-call transcripts, extracts the text, produces a
**verified** structured AI summary, and streams it over a WebSocket to a UI and any downstream service.

```
[1 WATCH & INGEST] -> [2 EXTRACT] -> [3 SUMMARIZE] -> [4 SERVE & STREAM]
 NSE + BSE pollers     PDF -> text     Gemini, quote-     Express + WebSocket
 dedup, download       clean, speakers  verified, JSON+MD   + minimal UI
```

Watchlist (7 companies): HDFC Bank, Maruti Suzuki, Sun Pharma, TCS, Hindustan Unilever, Reliance, L&T
(`src/watchlist.js`).

## Setup

Requires Node 18+.

```
npm install
```

Create an API key at https://aistudio.google.com/apikey (free tier) and set it. **Never commit it.**

```
PowerShell:  $env:GEMINI_API_KEY="your-key"
bash:        export GEMINI_API_KEY="your-key"
```

## Run

One command starts the watcher, summarizer, UI and WebSocket:

```
npm start
```

UI: http://localhost:3000   WebSocket: ws://localhost:3000/ws   REST: `/summaries`, `/summaries?company=TCS`, `/documents`
(Default port is 3000. If it is busy, set `PORT`, e.g. PowerShell `$env:PORT=3001; npm start`.)

Other commands:

| Command | What it does |
|---|---|
| `npm run backfill` | Fetch the latest transcript for each watchlist company (`DAYS=200` to look further back) |
| `node src/summarize.js [--only=TCS] [--force]` | Summarize saved transcripts (also runs automatically in `npm start`) |
| `node src/summarize.js --models` | List models your key can use |
| `node src/make-samples.js 3` | Write `samples/<company>/{transcript.txt,summary.json,summary.md}` |
| `POST /replay/TCS` | Demo: re-run a saved transcript through the live pipeline as if just filed |

Environment: `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3.5-flash`), `GEMINI_FALLBACK_MODEL`,
`POLL_MS` (45000), `SINGLE_PASS_MAX` (60000), `CHUNK_CHARS` (40000), `MIN_CHARS` (8000), `ALL=1` (ignore watchlist).

Subscribe from any service:

```js
const ws = new WebSocket("ws://localhost:3000/ws");
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "summary") console.log(m.data.summary.tldr); };
```
Messages: `snapshot` (all summaries, on connect), `filing` (new filing detected), `summary` (new summary ready).

## Design decisions

- **Faithfulness over fluency.** Every item in the summary carries an `evidence` quote copied from the
  transcript. Code checks each quote against the transcript (letters and digits only, so PDF line breaks
  don't matter). Items whose quote is not found are **dropped** and recorded in `dropped_claims`.
  Numbers in an item must also appear in its evidence, otherwise the item is flagged `numbersVerified: false`.
- **Long transcripts.** Up to 60k characters: one call. Longer: map-reduce. The transcript is split at
  speaker turns into ~40k-character chunks (last 2 turns repeated so Q&A is not cut), each chunk is extracted
  and verified against that chunk, the results are merged by a second call that may only reuse verified
  evidence, and the final output is verified again against the full transcript.
- **Schema.** The assignment schema plus: `evidence` on every item (grounding), `tone` (sentiment bonus),
  `numbersVerified`, a `verification` summary and `dropped_claims`. Items are objects (`{text, evidence}`)
  instead of bare strings so a consumer can show or audit the source of any claim.
- **Detection.** Poll NSE and BSE every 45s, filter on "transcript" in the subject/attachment, keep only
  watchlist companies. Dedup uses three keys (announcement id, company+day, PDF filename), persisted in
  `data/seen.json`, so a transcript on both exchanges, or after a restart, is processed once.
- **Robustness.** HTTP/1.1 client (NSE resets HTTP/2 from Node), cookie sessions, retry with exponential
  backoff on network errors/429/5xx, per-source polling backoff, retry when the model returns invalid JSON,
  a minimum-text check that rejects one-page cover letters and falls back to the next candidate filing,
  Gemini retry plus automatic fallback model, cached downloads/extractions/summaries (skip work already done).
- **Node, not Python.** The assignment says use what you are fastest in.

## Limitations / known issues

- **BSE returned HTTP 403** from my machine, so NSE was the effective source in my runs. The BSE code
  (session warm-up, header set, paging) is written but unverified against the live site.
- Unofficial NSE/BSE endpoints can change without notice; field names were confirmed against live NSE data only.
- L&T and Maruti Suzuki produced no summary: their latest filings were one-page cover letters, so the
  minimum-text check rejected them (5 of the 7 watchlist companies have summaries).
- XBRL is not parsed; metadata comes from the announcement feed fields.
- No OCR: scanned PDFs are flagged `needsOcr` and skipped. Multi-column layouts are only handled as well as the
  PDF text order allows.
- Verification proves a quote exists in the transcript, not that the model read it fairly; number checks are
  heuristic (numbers written in words are not matched).
- The event bus is in-process memory; a restart loses in-flight work (completed work is cached on disk).
- Gemini free tier is slow and sometimes returns 503; a full run of 7 companies can take 10+ minutes.
- Polling is not true push: a filing is detected within one polling interval.
- Cross-exchange dedup is heuristic (same company + same day).

## What I would do with more time

- Verify and harden the BSE feed; parse XBRL for quarter/call date; OCR fallback (Tesseract).
- Replace the in-memory bus with a queue (Redis Streams/BullMQ) and a database instead of JSON files.
- Webhook subscribers with HMAC signatures and retries; auth on the WebSocket.
- Semantic faithfulness check (second-pass model entailment), and an evaluation set of hand-checked summaries.
- Detect audio-only filings and re-check later for the transcript.
- Tests and CI.