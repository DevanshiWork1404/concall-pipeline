// Diagnostics:  node src/debug.js
// Shows WHY NSE fails and what BSE really returns (no transcript filter).
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first"); // fixes some IPv6-related "fetch failed" errors

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";

async function tryFetch(label, url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
    const text = await res.text();
    console.log(`OK   ${label}: HTTP ${res.status}, ${text.length} bytes`);
    return { res, text };
  } catch (e) {
    const c = e.cause;
    console.log(`FAIL ${label}: ${e.message} | cause: ${c?.code || ""} ${c?.message || c || ""}`);
    return null;
  }
}

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

console.log("--- 1. General internet");
await tryFetch("google.com", "https://www.google.com");

console.log("\n--- 2. NSE");
const home = await tryFetch("NSE homepage", "https://www.nseindia.com", { Accept: "text/html" });
if (home) {
  const cookie = (home.res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  console.log(`     cookies received: ${cookie ? "yes" : "NO"}`);
  const api = await tryFetch(
    "NSE announcements API",
    "https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=TCS",
    {
      Cookie: cookie,
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.nseindia.com/companies-listing/corporate-filings-announcements",
    }
  );
  if (api) {
    try {
      const rows = JSON.parse(api.text);
      console.log(`     rows: ${rows.length}`);
      for (const r of rows.slice(0, 5)) console.log("    ", r.desc, "|", r.attchmntText?.slice(0, 80), "|", r.attchmntFile);
    } catch {
      console.log("     not JSON, first 200 chars:", api.text.slice(0, 200));
    }
  }
}

console.log("\n--- 3. BSE (TCS, last 120 days, NO transcript filter)");
const to = new Date();
const from = new Date(Date.now() - 120 * 864e5);
const bseUrl =
  `https://api.bseindia.com/BseIndiaAPI/api/AnnGetData/w?strCat=-1&strPrevDate=${ymd(from)}` +
  `&strScrip=532540&strSearch=P&strToDate=${ymd(to)}&strType=C`;
const bse = await tryFetch("BSE announcements API", bseUrl, {
  Origin: "https://www.bseindia.com",
  Referer: "https://www.bseindia.com/",
  Accept: "application/json",
});
if (bse) {
  try {
    const json = JSON.parse(bse.text);
    const rows = json.Table || [];
    console.log(`     top-level keys: ${Object.keys(json).join(", ")}`);
    console.log(`     rows: ${rows.length}`);
    if (rows[0]) console.log("     fields of first row:", Object.keys(rows[0]).join(", "));
    const cats = new Set(rows.map((r) => `${r.CATEGORYNAME} / ${r.SUBCATNAME}`));
    console.log("     categories seen:\n       " + [...cats].join("\n       "));
    console.log("     rows that look like calls/transcripts:");
    for (const r of rows.filter((r) => /call|transcript|conference|analyst/i.test(JSON.stringify(r))).slice(0, 8)) {
      console.log("      ", r.NEWS_DT, "|", r.SUBCATNAME, "|", (r.HEADLINE || "").slice(0, 90), "|", r.ATTACHMENTNAME);
    }
  } catch {
    console.log("     not JSON, first 300 chars:", bse.text.slice(0, 300));
  }
}
