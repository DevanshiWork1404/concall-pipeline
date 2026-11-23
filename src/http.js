// HTTP/1.1 GET via node:https. Node's built-in fetch uses HTTP/2, which NSE's bot
// protection resets (ERR_HTTP2_STREAM_ERROR). Includes retry with exponential backoff
// on network errors, 429 and 5xx. 403 is NOT retried here: callers refresh cookies instead.
import https from "node:https";
import zlib from "node:zlib";
import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");
const agent = new https.Agent({ keepAlive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function getOnce(url, headers = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { agent, timeout: 45_000, headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate, br", ...headers } },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(getOnce(new URL(res.headers.location, url).toString(), headers, redirects - 1));
        }
        let stream = res;
        const enc = res.headers["content-encoding"];
        if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        stream.on("data", (c) => chunks.push(c));
        stream.on("error", reject);
        stream.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            cookies: (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]),
            buf,
            text: buf.toString("utf8"),
          });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
  });
}

export async function get(url, headers = {}, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await getOnce(url, headers);
      if ([429, 500, 502, 503, 504].includes(r.status) && attempt < retries) {
        await sleep(1500 * 3 ** attempt);
        continue;
      }
      return r;
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(1500 * 3 ** attempt);
    }
  }
}
