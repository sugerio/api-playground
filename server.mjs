// Serves the demo page and forwards /api/<env>/* to the Suger API of that environment.
//
// The API's CORS allowlist does not admit a page served from here, so the browser talks to
// this server and this server talks to the API. Only the hosts in API_HOSTS are reachable.
// The Authorization header the page sends is passed through untouched; nothing is stored.
//
//   node server.mjs            -> http://localhost:8787
//   GET /api/dev/org           -> https://api.dev.suger.cloud/org
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API_HOSTS = {
  dev: "https://api.dev.suger.cloud",
  prod: "https://api.suger.cloud",
};
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
    const apiMatch = req.url.match(/^\/api\/([a-z]+)(\/.*)$/);
    if (apiMatch) {
      const host = API_HOSTS[apiMatch[1]];
      if (!host) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ proxyError: `unknown environment "${apiMatch[1]}"` }));
      }
      const target = host + apiMatch[2];
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
}).listen(PORT, () => console.log(`API playground: http://localhost:${PORT}  (dev -> ${API_HOSTS.dev}, prod -> ${API_HOSTS.prod})`));
