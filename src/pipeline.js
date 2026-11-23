import fs from "node:fs/promises";
import path from "node:path";
import { bus } from "./bus.js";
import { extractPdfText } from "./extract.js";
import { safeId } from "./util.js";
import { get } from "./http.js";

const DATA = path.resolve("data");
const HEADERS = { Referer: "https://www.nseindia.com/", Accept: "application/pdf,*/*" };
// Real concall transcripts are tens of thousands of characters; cover letters are ~1,000.
const MIN_CHARS = Number(process.env.MIN_CHARS) || 8000;

// Returns the extracted doc, or null if the filing isn't a full transcript.
export async function processFiling(f) {
  const id = safeId(f.id);
  const jsonPath = path.join(DATA, "text", `${id}.json`);
  try {
    const cached = JSON.parse(await fs.readFile(jsonPath, "utf8"));
    if (cached.chars >= MIN_CHARS || cached.needsOcr) return cached;
    await fs.unlink(jsonPath); // stale short extraction from an earlier run
  } catch {}

  await fs.mkdir(path.join(DATA, "pdfs"), { recursive: true });
  await fs.mkdir(path.join(DATA, "text"), { recursive: true });

  const r = await get(f.pdfUrl, HEADERS);
  if (r.status !== 200) throw new Error(`PDF download HTTP ${r.status} for ${f.pdfUrl}`);
  const buf = r.buf;

  const { text, pages, needsOcr } = await extractPdfText(buf);
  if (!needsOcr && text.length < MIN_CHARS) {
    console.log(`[extract] SKIP ${f.company}: ${pages} page(s), ${text.length} chars (cover letter, not a transcript?) ${f.pdfUrl}`);
    return null;
  }

  await fs.writeFile(path.join(DATA, "pdfs", `${id}.pdf`), buf);
  const doc = { ...f, pages, needsOcr, chars: text.length, text };
  await fs.writeFile(jsonPath, JSON.stringify(doc, null, 2));
  console.log(`[extract] ${f.company}: ${pages} pages, ${text.length} chars${needsOcr ? " (NEEDS OCR)" : ""}`);
  bus.emit("extracted", doc);
  return doc;
}

let chain = Promise.resolve();
bus.on("filing", (f) => {
  chain = chain.then(() => processFiling(f)).catch((e) => console.error("[pipeline]", e.message));
});