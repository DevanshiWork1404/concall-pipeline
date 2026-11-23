// Stage 3: Gemini summariser. Assignment schema + verbatim-evidence verification.
// Long transcripts use map-reduce (chunk -> extract per chunk -> merge); short ones use one pass.
//   $env:GEMINI_API_KEY="..."
//   node src/summarize.js --models | --only=TCS | --force | (no flags = all transcripts)
// Env: GEMINI_MODEL (gemini-3.5-flash), SINGLE_PASS_MAX (60000), CHUNK_CHARS (40000)
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bus } from "./bus.js";
import { safeId } from "./util.js";

const DATA = path.resolve("data");
const API = "https://generativelanguage.googleapis.com/v1beta";
const model = () => process.env.GEMINI_MODEL || "gemini-3.5-flash";
const fallbackModel = () => process.env.GEMINI_FALLBACK_MODEL || "gemini-4-hydrogen";
let usedModel = null;
const apiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const SINGLE_MAX = Number(process.env.SINGLE_PASS_MAX) || 60_000;
const CHUNK_CHARS = Number(process.env.CHUNK_CHARS) || 40_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// section -> text fields (every item also carries "evidence")
const FIELDS = {
  tldr: ["text"],
  management_commentary: ["text"],
  guidance: ["text"],
  segment_performance: ["segment", "notes"],
  key_metrics: ["metric", "value", "context"],
  notable_qa: ["question", "answer", "asked_by"],
  risks: ["text"],
};

// ---------- prompts ----------
const SHAPE = `{
  "quarter": string or null (e.g. "Q2 FY27", only if stated or clearly implied),
  "call_date": string or null (YYYY-MM-DD, only if stated),
  "tldr": [{"text": string, "evidence": string}]                 (3-5 items),
  "management_commentary": [{"text": string, "evidence": string}] (highlights and tone),
  "guidance": [{"text": string, "evidence": string}]             (forward-looking statements, targets),
  "segment_performance": [{"segment": string, "notes": string, "evidence": string}],
  "key_metrics": [{"metric": string, "value": string, "context": string, "evidence": string}],
  "notable_qa": [{"question": string, "answer": string, "asked_by": string or null, "evidence": string}],
  "risks": [{"text": string, "evidence": string}],
  "tone": {"label": "positive"|"neutral"|"cautious"|"negative", "rationale": string, "evidence": string}
}`;

const RULES = `RULES
1. Use ONLY the text provided. No outside knowledge, no estimates.
2. Every item needs "evidence": an EXACT contiguous excerpt (20-300 chars) copied character-for-character. To cite two separate passages (e.g. a question and its answer) join them with " ... ". Never paraphrase inside evidence.
3. Any number in an item must also appear in its evidence. Keep units as stated (crore, Rs, %).
4. Use an empty array if a topic was not discussed and null if unknown. Never guess or pad.
5. At most 6 items per section. Respond with ONLY a JSON object, no markdown.
6. Inside string values never use double quote characters (use single quotes instead; punctuation differences in evidence are ignored) and never put raw line breaks in a string.`;

const SYSTEM_FULL = `You summarise an Indian listed company's earnings conference call transcript for analysts.\n${RULES}\nJSON shape:\n${SHAPE}`;
const systemMap = (i, n) =>
  `You extract facts from PART ${i} OF ${n} of an earnings call transcript. Extract only what appears in this part. Leave "tldr" empty and "tone" null.\n${RULES}\nJSON shape:\n${SHAPE}`;
const SYSTEM_REDUCE = `You merge facts extracted from several parts of one earnings call into the final summary. The input is JSON of already-verified items.
- Merge duplicates, keep the most informative items, and write 3-5 "tldr" items and the "tone".
- Do NOT add any fact that is not in the input.
- Every output item's "evidence" must be copied EXACTLY from the "evidence" of an input item that supports it (no new quotes).
${RULES}\nJSON shape:\n${SHAPE}`;

// ---------- chunking ----------
// Split at speaker-turn paragraphs; overlap the last 2 paragraphs so Q&A isn't cut in half.
export function chunkText(text, max = CHUNK_CHARS, singleMax = SINGLE_MAX) {
  if (text.length <= singleMax) return [text];
  const paras = text.split("\n\n");
  const chunks = [];
  let cur = [], len = 0;
  for (const p of paras) {
    if (len + p.length > max && cur.length > 2) {
      chunks.push(cur.join("\n\n"));
      cur = cur.slice(-2);
      len = cur.join("\n\n").length;
    }
    cur.push(p);
    len += p.length + 2;
  }
  if (cur.length) chunks.push(cur.join("\n\n"));
  return chunks;
}

// ---------- verification ----------
// Compare letters+digits only (lower-cased) so PDF line breaks/quotes/spacing don't cause
// false mismatches, but words and numbers must still match in order.
const squash = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function quoteInText(quote, hay) {
  const parts = String(quote).split(/\.\.\.|…/).map(squash).filter((p) => p.length >= 12);
  return parts.length > 0 && parts.every((p) => hay.includes(p));
}

// 2+ digit numbers not glued to letters (skips Q2, FY27, H1)
const numbersIn = (s) =>
  (String(s).match(/(?<![A-Za-z])\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/\D/g, "")).filter((n) => n.length >= 2);

export function verifyResult(result, transcript) {
  const hay = squash(transcript);
  const sections = {}, dropped = [];
  let claims = 0, verified = 0, numbersFlagged = 0;
  for (const [sec, fields] of Object.entries(FIELDS)) {
    sections[sec] = [];
    for (const it of Array.isArray(result?.[sec]) ? result[sec] : []) {
      claims++;
      if (!it || typeof it.evidence !== "string" || typeof it[fields[0]] !== "string") {
        dropped.push({ section: sec, item: it, reason: "malformed" });
        continue;
      }
      if (!quoteInText(it.evidence, hay)) {
        dropped.push({ section: sec, item: it, reason: "evidence not found in transcript" });
        continue;
      }
      const ev = squash(it.evidence);
      const numbersVerified = numbersIn(fields.map((f) => it[f]).filter(Boolean).join(" ")).every((n) => ev.includes(n));
      verified++;
      if (!numbersVerified) numbersFlagged++;
      sections[sec].push({ ...it, numbersVerified });
    }
  }
  const t = result?.tone;
  const tone = t && typeof t === "object"
    ? { label: t.label ?? null, rationale: t.rationale ?? "", evidence: t.evidence ?? null,
        verified: typeof t.evidence === "string" && quoteInText(t.evidence, hay) }
    : null;
  return { sections, tone, dropped, stats: { claims, verified, dropped: dropped.length, numbersFlagged } };
}

// ---------- Gemini ----------
let callGemini = async (system, userText) => {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.1, responseMimeType: "application/json", maxOutputTokens: 16384 },
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    // after 2 overloaded attempts on the primary model, switch to the fallback model
    const m = attempt >= 2 && fallbackModel() !== model() ? fallbackModel() : model();
    const url = `${API}/models/${m}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey() },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 503) {
      const wait = 5000 * 2 ** attempt;
      console.log(`[summarize] ${m} returned ${res.status} (rate limit/overload), retrying in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const hint = res.status === 404 ? ` - model "${model()}" not available; run: node src/summarize.js --models` : "";
      throw new Error(`Gemini HTTP ${res.status}: ${json?.error?.message || "unknown error"}${hint}`);
    }
    const cand = json.candidates?.[0];
    if (cand?.finishReason === "MAX_TOKENS") throw new Error("Gemini output was cut off (MAX_TOKENS)");
    const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
    if (!text) throw new Error(`Gemini returned no text (finishReason: ${cand?.finishReason || json?.promptFeedback?.blockReason})`);
    usedModel = m;
    return text;
  }
  throw new Error("Gemini kept returning 429/503; try again in a minute (free-tier limits)");
};
export const _setCaller = (fn) => { callGemini = fn; }; // for tests

function parseJson(text) {
  const t = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); }
  catch {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("Model did not return valid JSON");
  }
}

// Gemini occasionally returns malformed JSON; ask again instead of failing the whole filing.
async function callJson(system, userText, tries = 3) {
  for (let i = 1; ; i++) {
    const raw = await callGemini(system, userText);
    try { return parseJson(raw); }
    catch (e) {
      if (i >= tries) throw e;
      console.log(`[summarize] model returned invalid JSON (${e.message}); retrying ${i}/${tries - 1}`);
    }
  }
}

// ---------- markdown ----------
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cell = (s) => oneLine(s).replace(/\|/g, "\\|");
const flag = (it) => (it.numbersVerified === false ? " ⚠ check numbers" : "");

export function toMarkdown(s) {
  const L = [`# ${s.company} - ${s.quarter || "Earnings call"}`, ""];
  L.push(`*${s.source || ""} · call date: ${s.call_date || "not stated"} · ${s.nse_symbol || ""} ${s.scrip_code || ""} · [source PDF](${s.source_url})*`, "");
  const bullets = (title, items) => {
    if (!items?.length) return;
    L.push(`## ${title}`, "");
    for (const it of items) L.push(`- ${oneLine(it.text)}${flag(it)}`, `  > ${oneLine(it.evidence)}`);
    L.push("");
  };
  bullets("TL;DR", s.tldr);
  bullets("Management commentary", s.management_commentary);
  if (s.tone) L.push(`**Tone: ${s.tone.label}** - ${oneLine(s.tone.rationale)}`, "");
  bullets("Guidance / outlook", s.guidance);
  if (s.segment_performance?.length) {
    L.push("## Segment performance", "");
    for (const it of s.segment_performance) L.push(`- **${oneLine(it.segment)}:** ${oneLine(it.notes)}${flag(it)}`, `  > ${oneLine(it.evidence)}`);
    L.push("");
  }
  if (s.key_metrics?.length) {
    L.push("## Key numbers", "", "| Metric | Value | Context |", "|---|---|---|");
    for (const it of s.key_metrics) L.push(`| ${cell(it.metric)} | ${cell(it.value)}${flag(it)} | ${cell(it.context)} |`);
    L.push("");
  }
  if (s.notable_qa?.length) {
    L.push("## Notable Q&A", "");
    for (const it of s.notable_qa) L.push(`- **Q${it.asked_by ? ` (${oneLine(it.asked_by)})` : ""}:** ${oneLine(it.question)}`, `  **A:** ${oneLine(it.answer)}${flag(it)}`, `  > ${oneLine(it.evidence)}`);
    L.push("");
  }
  bullets("Risks / concerns", s.risks);
  const v = s.verification || {};
  L.push("---", `*${v.verified}/${v.claims} claims verified verbatim against the transcript; ${v.dropped} removed; ${v.chunks} chunk(s).*`);
  return L.join("\n");
}

// ---------- main ----------
export async function summarizeDoc(doc, { force = false } = {}) {
  const id = safeId(doc.id);
  const outPath = path.join(DATA, "summaries", `${id}.json`);
  if (!force) {
    try {
      const cached = JSON.parse(await fs.readFile(outPath, "utf8"));
      if (cached.summary?.tldr) return cached; // old-format summaries are regenerated
    } catch {}
  }
  if (doc.needsOcr || !doc.text) throw new Error(`${doc.company}: no extractable text (needs OCR)`);

  const text = doc.text;
  const header = `Company: ${doc.company}\nFiled: ${doc.filedAt}\n\nTRANSCRIPT:\n`;
  const chunks = chunkText(text);
  console.log(`[summarize] ${doc.company}: ${model()}, ${text.length} chars, ${chunks.length} chunk(s)`);

  let final, quarter, callDate, mapDropped = 0;
  if (chunks.length === 1) {
    final = await callJson(SYSTEM_FULL, header + text);
    quarter = final.quarter; callDate = final.call_date;
  } else {
    const merged = Object.fromEntries(Object.keys(FIELDS).map((k) => [k, []]));
    for (let i = 0; i < chunks.length; i++) {
      const raw = await callJson(systemMap(i + 1, chunks.length), header + chunks[i]);
      const v = verifyResult(raw, chunks[i]); // each chunk's claims must exist in that chunk
      mapDropped += v.stats.dropped;
      for (const k of Object.keys(FIELDS)) merged[k].push(...v.sections[k].map(({ numbersVerified, ...r }) => r));
      quarter ||= raw.quarter; callDate ||= raw.call_date;
      console.log(`[summarize]   part ${i + 1}/${chunks.length} done`);
      await sleep(3000);
    }
    final = await callJson(SYSTEM_REDUCE, JSON.stringify(merged));
    quarter = final.quarter || quarter; callDate = final.call_date || callDate;
  }

  const v = verifyResult(final, text); // final check against the FULL transcript
  const summary = {
    company: doc.company,
    scrip_code: doc.scripCode || doc.watch?.scrip || null,
    nse_symbol: doc.symbol || doc.watch?.symbol || null,
    quarter: quarter || null,
    call_date: callDate || null,
    source: doc.exchange,
    source_url: doc.pdfUrl,
    ...v.sections,
    tone: v.tone,
    verification: { ...v.stats, chunks: chunks.length, droppedDuringExtraction: mapDropped },
    dropped_claims: v.dropped,
  };
  const record = {
    meta: { id: doc.id, company: doc.company, exchange: doc.exchange, filedAt: doc.filedAt, pdfUrl: doc.pdfUrl,
            pages: doc.pages, model: usedModel || model(), generatedAt: new Date().toISOString() },
    summary,
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(record, null, 2));
  await fs.writeFile(outPath.replace(/\.json$/, ".md"), toMarkdown(summary));
  console.log(`[summarize] ${doc.company}: ${v.stats.verified}/${v.stats.claims} claims verified, ${v.stats.dropped} dropped, ${v.stats.numbersFlagged} number flags`);
  bus.emit("summary", record);
  return record;
}

let chain = Promise.resolve();
export function startSummarizer() {
  if (!apiKey()) { console.warn("[summarize] GEMINI_API_KEY not set: summaries disabled"); return; }
  bus.on("extracted", (doc) => {
    chain = chain.then(() => summarizeDoc(doc)).catch((e) => console.error("[summarize]", e.message));
  });
}

async function main() {
  if (!apiKey()) {
    console.error('Set your key first:  $env:GEMINI_API_KEY="your-key"');
    process.exit(1);
  }
  if (process.argv.includes("--models")) {
    const res = await fetch(`${API}/models?pageSize=100`, { headers: { "x-goog-api-key": apiKey() } });
    const json = await res.json();
    if (!res.ok) { console.error(json?.error?.message || res.status); process.exit(1); }
    for (const m of json.models || []) if ((m.supportedGenerationMethods || []).includes("generateContent")) console.log(m.name.replace("models/", ""));
    return;
  }
  const force = process.argv.includes("--force");
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).toLowerCase();
  let files = [];
  try { files = await fs.readdir(path.join(DATA, "text")); } catch {}
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    const doc = JSON.parse(await fs.readFile(path.join(DATA, "text", f), "utf8"));
    const label = `${doc.company} ${doc.watch?.symbol || ""} ${doc.watch?.name || ""}`.toLowerCase();
    if (only && !label.includes(only)) continue;
    try { await summarizeDoc(doc, { force }); }
    catch (e) { console.error(`[summarize] ${doc.company} failed: ${e.message}`); }
    await sleep(4000);
  }
  console.log("[summarize] done. See data/summaries/");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();