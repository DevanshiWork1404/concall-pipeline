// BSE announcements (paged). Warms up a session cookie first; on 403 refreshes it once.
import { get } from "../http.js";
import { yyyymmdd, isTranscript } from "../util.js";

const HOME = "https://www.bseindia.com/";
const BASE = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";
const HEADERS = {
  Origin: "https://www.bseindia.com",
  Referer: "https://www.bseindia.com/corporates/ann.html",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};

let cookie = "";
async function refreshCookie() {
  const r = await get(HOME, { Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" });
  cookie = r.cookies.join("; ");
}

export function bseUrl({ scrip = "", from, to, page = 1, cat = "-1", sub = "-1" }) {
  return (
    `${BASE}?pageno=${page}&strCat=${encodeURIComponent(cat)}&strPrevDate=${yyyymmdd(from)}` +
    `&strScrip=${scrip}&strSearch=P&strToDate=${yyyymmdd(to)}&strType=C&subcategory=${encodeURIComponent(sub)}`
  );
}
export const bseHeaders = HEADERS;

async function fetchPage(url) {
  if (!cookie) await refreshCookie().catch(() => {});
  let r = await get(url, { ...HEADERS, Cookie: cookie });
  if (r.status === 403) {
    await refreshCookie().catch(() => {});
    r = await get(url, { ...HEADERS, Cookie: cookie });
  }
  if (r.status === 403) throw new Error("BSE HTTP 403 (blocked); NSE remains the primary source");
  if (r.status !== 200) throw new Error(`BSE HTTP ${r.status}`);
  try { return JSON.parse(r.text); } catch { throw new Error(`BSE returned non-JSON: ${r.text.slice(0, 80)}`); }
}

export async function fetchBse({ scrip = "", from = new Date(), to = new Date(), maxPages = 6 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const json = await fetchPage(bseUrl({ scrip, from, to, page }));
    const rows = Array.isArray(json?.Table) ? json.Table : [];
    if (!rows.length) break;
    for (const x of rows) {
      if (!x.ATTACHMENTNAME || !isTranscript(x.HEADLINE, x.NEWSSUB, x.SUBCATNAME)) continue;
      out.push({
        id: `bse:${x.NEWSID}`,
        exchange: "BSE",
        company: x.SLONGNAME,
        scripCode: String(x.SCRIP_CD),
        subject: x.HEADLINE || x.NEWSSUB,
        filedAt: x.NEWS_DT,
        pdfUrl: `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${x.ATTACHMENTNAME}`,
      });
    }
    if (rows.length < 40) break;
  }
  return out;
}