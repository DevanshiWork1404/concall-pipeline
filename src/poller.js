import fs from "node:fs";
import path from "node:path";
import { fetchBse } from "./sources/bse.js";
import { fetchNse } from "./sources/nse.js";
import { matchWatchlist } from "./watchlist.js";
import { parseExchangeDate } from "./util.js";
import { bus } from "./bus.js";

const BASE_MS = Number(process.env.POLL_MS) || 45_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const ALL = !!process.env.ALL; // ALL=1 disables the watchlist filter (testing)
const SEEN_FILE = path.resolve("data/seen.json");

// "seen" survives restarts. Each filing is recorded under 3 keys so the same transcript
// is caught whether it reappears on the other exchange, under a new id, or after a restart.
const seen = new Set();
const dayOf = (s) => { const t = parseExchangeDate(s); return t ? new Date(t).toISOString().slice(0, 10) : ""; };
const keysFor = (f, watch) => [f.id, `${watch?.symbol || f.company}|${dayOf(f.filedAt)}`, f.pdfUrl.split("/").pop()];

function loadSeen() {
  try { JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")).forEach((k) => seen.add(k)); } catch {}
  try { // also treat everything already extracted as seen
    for (const f of fs.readdirSync("data/text").filter((f) => f.endsWith(".json"))) {
      const d = JSON.parse(fs.readFileSync(path.join("data/text", f), "utf8"));
      keysFor(d, d.watch).forEach((k) => seen.add(k));
    }
  } catch {}
}
function saveSeen() {
  try {
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen].slice(-5000)));
  } catch {}
}

function handle(name, f) {
  const watch = matchWatchlist(f);
  if (!watch && !ALL) return;
  const keys = keysFor(f, watch);
  if (keys.some((k) => seen.has(k))) return;
  keys.forEach((k) => seen.add(k));
  saveSeen();
  f.watch = watch;
  console.log(`[${name}] NEW ${f.company} | ${f.subject}`);
  bus.emit("filing", f);
}

const sources = {
  NSE: { fn: () => fetchNse(), fails: 0, next: 0, busy: false },
  BSE: { fn: () => fetchBse(), fails: 0, next: 0, busy: false },
};

async function pollSource(name, s) {
  try {
    const filings = await s.fn();
    if (s.fails) console.log(`[${name}] recovered after ${s.fails} failure(s)`);
    s.fails = 0;
    s.next = Date.now() + BASE_MS;
    for (const f of filings) handle(name, f);
  } catch (e) {
    s.fails++;
    const wait = Math.min(BASE_MS * 2 ** s.fails, MAX_BACKOFF_MS); // exponential backoff per source
    s.next = Date.now() + wait;
    if (s.fails === 1 || s.fails % 10 === 0)
      console.error(`[${name}] poll failed (${s.fails}x): ${e.message}; backing off ${Math.round(wait / 1000)}s`);
  }
}

export function startPoller() {
  loadSeen();
  const tick = () => {
    for (const [name, s] of Object.entries(sources)) {
      if (Date.now() >= s.next && !s.busy) {
        s.busy = true;
        pollSource(name, s).finally(() => { s.busy = false; });
      }
    }
  };
  tick();
  setInterval(tick, 5000);
}