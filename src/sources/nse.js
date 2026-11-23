import { get } from "../http.js";
import { ddmmyyyy, isTranscript } from "../util.js";

const HOME = "https://www.nseindia.com";
const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: `${HOME}/companies-listing/corporate-filings-announcements`,
};

let cookie = "";
async function refreshCookie() {
  const r = await get(HOME, { Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" });
  cookie = r.cookies.join("; ");
}

export async function fetchNse({ symbol, from, to } = {}) {
  const params = new URLSearchParams({ index: "equities" });
  if (symbol) params.set("symbol", symbol);
  if (from) params.set("from_date", ddmmyyyy(from));
  if (to) params.set("to_date", ddmmyyyy(to));
  const url = `${HOME}/api/corporate-announcements?${params}`;

  if (!cookie) await refreshCookie();
  let r = await get(url, { ...HEADERS, Cookie: cookie });
  if (r.status === 401 || r.status === 403) {
    await refreshCookie();
    r = await get(url, { ...HEADERS, Cookie: cookie });
  }
  if (r.status !== 200) throw new Error(`NSE HTTP ${r.status}`);
  let rows;
  try { rows = JSON.parse(r.text); } catch { throw new Error(`NSE returned non-JSON: ${r.text.slice(0, 80)}`); }
  if (!Array.isArray(rows)) rows = rows.data || [];

  return rows
    .filter((x) => x.attchmntFile && isTranscript(x.desc, x.attchmntText))
    .map((x) => ({
      id: `nse:${x.seq_id ?? x.attchmntFile}`,
      exchange: "NSE",
      company: x.sm_name,
      symbol: x.symbol,
      subject: x.desc,
      filedAt: x.an_dt,
      pdfUrl: x.attchmntFile,
    }));
}