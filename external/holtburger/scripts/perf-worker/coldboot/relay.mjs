// relay.mjs — counting (optionally throttling) TCP relay for cold-boot measurements.
//   node relay.mjs --listen 7090 --target 7080 [--kbps 666] [--delay 40] --log bytes.tsv
// Every byte the 1070's browser pulls (HTTP from page AND workers, plus the game WebSocket)
// crosses this relay, so the per-second downstream log is the ground truth for "what a
// first-time player downloads". --kbps: one shared token bucket for the DOWNSTREAM
// direction across all connections (the server's upload pipe); --delay: one-way latency
// added to every downstream chunk.
import net from "node:net";
import { appendFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const LISTEN = +opt("--listen", 7090), TARGET = +opt("--target", 7080), HOST = opt("--host", "127.0.0.1");
const KBPS = +opt("--kbps", 0), DELAY = +opt("--delay", 0), LOG = opt("--log", "bytes.tsv");
const BPS = KBPS > 0 ? (KBPS * 1000) / 8 : 0;
writeFileSync(LOG, "wall_ms\tdown_bytes\tup_bytes\tconns_open\tconns_total\n");
const t0 = Date.now();
let down = 0, up = 0, open = 0, total = 0;
// shared downstream pipe: token bucket at BPS bytes/s (10 ms ticks), served ROUND-ROBIN across
// connections in 1460-byte quanta (approximates TCP fair share; a FIFO would let one big file
// starve the game WebSocket, which a real link does not).
const conns = new Set(); let tokens = 0;
function pump() {
  if (BPS) tokens = Math.min(tokens + BPS / 100, BPS / 10);
  const now = Date.now();
  let progress = true;
  while (progress) {
    progress = false;
    for (const st of conns) {
      if (st.c.destroyed) { conns.delete(st); continue; }
      const it = st.q[0];
      if (!it || it.due > now) continue;
      if (BPS && tokens <= 0) return;
      const n = BPS ? Math.min(it.buf.length, 1460, Math.max(1, Math.floor(tokens))) : it.buf.length;
      st.c.write(it.buf.subarray(0, n)); it.buf = it.buf.subarray(n); down += n; if (BPS) tokens -= n;
      if (it.buf.length === 0) st.q.shift();
      progress = true;
    }
  }
}
setInterval(pump, 10);
setInterval(() => { appendFileSync(LOG, `${Date.now()}\t${down}\t${up}\t${open}\t${total}\n`); down = 0; up = 0; }, 1000);
net.createServer((c) => {
  open++; total++;
  const s = net.connect(TARGET, "127.0.0.1");
  c.setNoDelay(true); s.setNoDelay(true);
  const st = { c, q: [], paused: false }; conns.add(st);
  // upstream (browser -> server): unthrottled, counted
  c.on("data", (d) => { up += d.length; s.write(d); });
  s.on("data", (d) => {
    if (!BPS && !DELAY) { down += d.length; c.write(d); return; }
    st.q.push({ buf: Buffer.from(d), due: Date.now() + DELAY });
    // backpressure: pause the server side while this connection's queue is deep
    if (st.q.length > 64 && !st.paused) { st.paused = true; s.pause(); const t = setInterval(() => { if (st.q.length < 16 || c.destroyed) { st.paused = false; s.resume(); clearInterval(t); } }, 20); }
  });
  const end = () => { if (!c.destroyed) c.destroy(); if (!s.destroyed) s.destroy(); };
  c.on("close", () => { open--; conns.delete(st); end(); }); s.on("close", () => { if (!st.q.length) end(); else { const t = setInterval(() => { if (!st.q.length || c.destroyed) { clearInterval(t); end(); } }, 50); } });
  c.on("error", end); s.on("error", end);
}).listen(LISTEN, HOST, () => console.log(`relay ${HOST}:${LISTEN} -> :${TARGET} kbps=${KBPS || "inf"} delay=${DELAY}ms log=${LOG}`));
