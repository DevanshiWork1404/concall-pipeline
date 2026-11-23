// node src/make-samples.js [count]  -> samples/<symbol>/{transcript.txt, summary.json, summary.md}
import fs from "node:fs/promises";
import path from "node:path";

const want = Number(process.argv[2]) || 3;
let done = 0;
for (const f of (await fs.readdir("data/summaries")).filter((f) => f.endsWith(".json"))) {
  if (done >= want) break;
  const rec = JSON.parse(await fs.readFile(`data/summaries/${f}`, "utf8"));
  if (!rec.summary?.tldr) continue;
  let doc;
  try { doc = JSON.parse(await fs.readFile(`data/text/${f}`, "utf8")); } catch { continue; }
  const id = f.replace(/\.json$/, "");
  const dir = path.join("samples", (rec.summary.nse_symbol || id).toLowerCase());
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "transcript.txt"), doc.text);
  await fs.writeFile(path.join(dir, "summary.json"), JSON.stringify(rec.summary, null, 2));
  await fs.copyFile(`data/summaries/${id}.md`, path.join(dir, "summary.md"));
  console.log("sample written:", dir);
  done++;
}
if (done < want) console.log(`only ${done} sample(s) available; run: node src/summarize.js`);