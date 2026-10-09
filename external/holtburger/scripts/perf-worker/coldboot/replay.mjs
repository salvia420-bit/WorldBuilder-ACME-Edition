// replay.mjs <port> <conns> <urls.txt> — fetch every URL path over N keep-alive connections to 127.0.0.1:<port>; req/s + p50/p90.
import http from "node:http"; import { readFileSync } from "node:fs";
const [port, conns, file] = [+process.argv[2], +process.argv[3], process.argv[4]];
const urls = readFileSync(file, "utf8").split("\n").filter(Boolean);
const agent = new http.Agent({ keepAlive: true, maxSockets: conns });
const lat = []; let i = 0, bytes = 0; const t0 = performance.now();
async function worker() { while (i < urls.length) { const u = urls[i++]; const s = performance.now();
  await new Promise((res, rej) => http.get({ host: "127.0.0.1", port, path: u, agent }, (r) => { r.on("data", (b) => { bytes += b.length; }); r.on("end", res); }).on("error", rej));
  lat.push(performance.now() - s); } }
await Promise.all(Array.from({ length: conns }, worker));
const ms = performance.now() - t0; lat.sort((a, b) => a - b);
console.log(`port ${port} conns ${conns}: ${urls.length} req in ${(ms / 1000).toFixed(2)} s = ${(urls.length / ms * 1000).toFixed(0)} req/s, ${(bytes / 1e6).toFixed(1)} MB, p50 ${lat[lat.length >> 1].toFixed(1)} ms p90 ${lat[Math.floor(lat.length * 0.9)].toFixed(1)} ms`);
agent.destroy();
