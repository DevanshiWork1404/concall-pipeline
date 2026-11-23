const pad = (n) => String(n).padStart(2, "0");
export const yyyymmdd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
export const ddmmyyyy = (d) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;

// Handles BSE "2026-11-10T16:30:00" and NSE "10-Nov-2026 16:30:00"
export function parseExchangeDate(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  const m = String(s).match(/(\d{2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):?(\d{2})?)?/);
  if (!m) return 0;
  return Date.parse(`${m[2]} ${m[1]} ${m[3]} ${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}`) || 0;
}

export const isTranscript = (...parts) => /transcript/i.test(parts.filter(Boolean).join(" "));
export const safeId = (id) => id.replace(/[^a-z0-9._-]/gi, "_");
