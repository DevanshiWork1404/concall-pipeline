import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// Group text items into lines by Y position, per page.
async function pageLines(page) {
  const { items } = await page.getTextContent();
  const lines = [];
  let line = "", lastY = null;
  for (const it of items) {
    if (!it.str) continue;
    const y = it.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > 2) {
      lines.push(line.trim());
      line = "";
    }
    line += (line && !line.endsWith(" ") && !it.str.startsWith(" ") ? " " : "") + it.str;
    lastY = y;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.filter(Boolean);
}

const norm = (l) => l.toLowerCase().replace(/\d+/g, "#");

// Speaker lines look like "Moderator:" or "Rahul Sharma - ICICI Securities:"
const SPEAKER = /^(Moderator|[A-Z][A-Za-z.'’ -]{2,40}(?:\s[-–—]\s[^:]{2,60})?)\s*:\s*/;

export async function extractPdfText(buffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push(await pageLines(await doc.getPage(i)));

  const rawChars = pages.flat().join("").length;
  if (rawChars / Math.max(doc.numPages, 1) < 200) {
    return { text: "", pages: doc.numPages, needsOcr: true };
  }

  // Drop running headers/footers: lines repeated (digits normalised) on >=40% of pages.
  const counts = new Map();
  for (const p of pages) for (const l of new Set(p.map(norm))) counts.set(l, (counts.get(l) || 0) + 1);
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4));
  // Only short lines can be running headers/footers; never drop real speech.
  const isBoiler = (l) =>
    (pages.length >= 4 && l.length <= 80 && !SPEAKER.test(l) && counts.get(norm(l)) >= threshold) ||
    /^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(l);

  // Rebuild paragraphs: a new paragraph starts at each speaker label.
  const paras = [];
  let cur = "";
  for (const l of pages.flat().filter((l) => !isBoiler(l))) {
    if (SPEAKER.test(l) && cur) {
      paras.push(cur);
      cur = l;
    } else {
      cur += (cur ? " " : "") + l;
    }
  }
  if (cur) paras.push(cur);

  return { text: paras.join("\n\n"), pages: doc.numPages, needsOcr: false };
}
