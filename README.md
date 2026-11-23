# Concall pipeline: step 1 (detector)

    npm install
    npm start
    curl -N http://localhost:3000/stream     # live feed
    curl http://localhost:3000/filings        # recent filings

Env: PORT (3000), POLL_MS (45000)

NOTE: the NSE/BSE endpoints are unofficial. If a source returns 4xx or no rows,
open the exchange's announcements page in DevTools > Network and compare the
URL, headers and field names with src/sources/*.js.

## Step 2: watchlist, backfill, extraction

    npm run backfill        # latest-quarter transcript for each of the 7 companies
    curl localhost:3000/documents

Outputs: data/pdfs/*.pdf and data/text/*.json (cleaned text with speaker-separated paragraphs).
`needsOcr: true` in a JSON file means the PDF is scanned (OCR fallback not built yet).
Set ALL=1 to make the live poller ignore the watchlist while testing.
