// npm run backfill        (DAYS=200 to look further back)
import { WATCHLIST } from "./watchlist.js";
import { fetchNse } from "./sources/nse.js";
import { fetchBse } from "./sources/bse.js";
import { parseExchangeDate } from "./util.js";
import { processFiling } from "./pipeline.js";

const days = Number(process.env.DAYS) || 120;
const to = new Date();
const from = new Date(Date.now() - days * 864e5);

for (const c of WATCHLIST) {
  const found = [];
  for (const [name, fn] of [
    ["NSE", () => fetchNse({ symbol: c.symbol, from, to })],
    ["BSE", () => fetchBse({ scrip: c.scrip, from, to })],
  ]) {
    try { found.push(...(await fn())); }
    catch (e) { console.error(`[backfill] ${c.name} ${name}: ${e.message}`); }
  }
  if (!found.length) { console.log(`[backfill] ${c.name}: no transcript filings in last ${days} days`); continue; }

  // Newest first (NSE wins ties); drop duplicate URLs.
  found.sort((a, b) =>
    parseExchangeDate(b.filedAt) - parseExchangeDate(a.filedAt) || (a.exchange === "NSE" ? -1 : 1));
  const seen = new Set();
  const candidates = found.filter((f) => !seen.has(f.pdfUrl) && seen.add(f.pdfUrl)).slice(0, 6);

  let done = null;
  for (const cand of candidates) {
    console.log(`[backfill] ${c.name}: trying ${cand.exchange} ${cand.filedAt} ${cand.pdfUrl}`);
    try { done = await processFiling({ ...cand, watch: c }); }
    catch (e) { console.error(`[backfill] ${c.name} failed: ${e.message}`); }
    if (done) break;
  }
  if (!done) console.log(`[backfill] ${c.name}: none of ${candidates.length} candidates was a full transcript`);
}
console.log("[backfill] done. See data/text/*.json");
process.exit(0);