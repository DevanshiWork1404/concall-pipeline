// The 7 companies in scope. Verify scrip codes on bseindia.com if a lookup returns nothing.
export const WATCHLIST = [
  { name: "HDFC Bank",          symbol: "HDFCBANK",   scrip: "500180", sector: "Bank" },
  { name: "Maruti Suzuki",      symbol: "MARUTI",     scrip: "532500", sector: "Auto" },
  { name: "Sun Pharma",         symbol: "SUNPHARMA",  scrip: "524715", sector: "Pharma" },
  { name: "TCS",                symbol: "TCS",        scrip: "532540", sector: "IT" },
  { name: "Hindustan Unilever", symbol: "HINDUNILVR", scrip: "500696", sector: "FMCG" },
  { name: "Reliance",           symbol: "RELIANCE",   scrip: "500325", sector: "Energy" },
  { name: "L&T",                symbol: "LT",         scrip: "500510", sector: "Infra" },
];

export function matchWatchlist(f) {
  return (
    WATCHLIST.find(
      (c) =>
        (f.symbol && f.symbol.toUpperCase() === c.symbol) ||
        (f.scripCode && String(f.scripCode) === c.scrip)
    ) || null
  );
}
