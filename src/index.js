import express from "express";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { bus } from "./bus.js";
import { startPoller } from "./poller.js";
import { startSummarizer, summarizeDoc } from "./summarize.js";
import "./pipeline.js";
import { safeId } from "./util.js";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const recent = [];

async function readJsonDir(dir) {
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { out.push(JSON.parse(await fsp.readFile(path.join(dir, f), "utf8"))); }
    catch (e) { console.warn(`[server] skipping unreadable ${dir}/${f}: ${e.message}`); }
  }
  return out;
}

// ---- WebSocket: snapshot on connect, then live events ----
const broadcast = (msg) => {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};
wss.on("connection", async (ws) => {
  ws.send(JSON.stringify({ type: "snapshot", data: await readJsonDir("data/summaries") }));
});
bus.on("filing", (f) => { recent.unshift(f); recent.length = Math.min(recent.length, 100); broadcast({ type: "filing", data: f }); });
bus.on("summary", (r) => broadcast({ type: "summary", data: r }));

// Also push summaries written by `node src/summarize.js` running in another terminal.
fs.mkdirSync("data/summaries", { recursive: true });
let timer;
fs.watch("data/summaries", (_ev, name) => {
  if (!name?.endsWith(".json")) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try { broadcast({ type: "summary", data: JSON.parse(await fsp.readFile(path.join("data/summaries", name), "utf8")) }); } catch {}
  }, 400);
});

// ---- REST ----
app.get("/filings", (_req, res) => res.json(recent));
app.get("/summaries", async (req, res) => {
  const all = await readJsonDir("data/summaries");
  const q = String(req.query.company || "").toLowerCase();
  res.json(q ? all.filter((r) => r.meta.company.toLowerCase().includes(q)) : all);
});
app.get("/documents", async (req, res) => {
  const docs = await readJsonDir("data/text");
  res.json(req.query.full ? docs : docs.map(({ text, ...meta }) => meta));
});
// Demo helper: re-run a saved transcript through the live pipeline as if it had just been filed.
//   Invoke-RestMethod -Method Post http://localhost:3000/replay/TCS
app.post("/replay/:name", async (req, res) => {
  const q = req.params.name.toLowerCase();
  const doc = (await readJsonDir("data/text")).find((d) => `${d.company} ${d.watch?.symbol || ""}`.toLowerCase().includes(q));
  if (!doc) return res.status(404).json({ error: "no such transcript in data/text" });
  bus.emit("filing", doc); // UI ticker shows "processing..."
  res.json({ replaying: doc.company });
  // regenerate in the background; the existing summary stays until the new one is written
  summarizeDoc(doc, { force: true }).catch((e) => console.error("[replay]", e.message));
});
app.use(express.static(path.resolve("public")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UI: http://localhost:${PORT}   WebSocket: ws://localhost:${PORT}/ws`);
  startSummarizer();
  startPoller();
});