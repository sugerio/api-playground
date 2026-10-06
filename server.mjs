// Serves the demo page and forwards /api/* to the Suger dev API.
//
// The dev API's CORS allowlist only admits http://localhost:3000 (taken by web-react), so the
// browser talks to this server and this server talks to the API. The Authorization header the
// page sends is passed through untouched; nothing is stored.
//
//   node server.mjs            -> http://localhost:8787
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API_HOST = "https://api.dev.suger.cloud";
const PORT = Number(process.env.PORT || 8787);
const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      const target = API_HOST + req.url.slice("/api".length);
      const headers = {};
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;
      if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req),
      });
      const text = await upstream.text();
      console.log(`${req.method} ${target} -> ${upstream.status}`);
      res.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "X-Correlation-Id": upstream.headers.get("x-correlation-id") || "",
      });
      return res.end(text);
    }
    const file = req.url === "/" ? "index.html" : req.url.slice(1).split("?")[0];
    if (!["index.html", "builders.js"].includes(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] });
    res.end(await readFile(join(ROOT, file)));
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ proxyError: String(err) }));
  }
}).listen(PORT, () => console.log(`GCP offer demo: http://localhost:${PORT}  (proxying ${API_HOST})`));
