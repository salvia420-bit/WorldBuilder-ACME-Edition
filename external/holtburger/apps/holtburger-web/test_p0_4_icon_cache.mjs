// P0.4 / LEAK-03 — headless unit test for `ui/ac_icon_cache.js`.
//
// Pins the two behaviours the finding asked for
// (docs/acclient-deep-dive-mining/wave3-G-leaks-indextooling.md §LEAK-03):
//
//   1. The success cache is CAPPED at insertion (retail `FreelistAdd`
//      parity, `acclient.c:83194-83200`, `m_nMaxSize = 400`) and evicts
//      least-recently-used, so the ~30 MB unbounded ceiling is gone.
//   2. A failure is NEVER latched permanently — it goes into a separate
//      TTL'd negative map, so a later request genuinely retries. This is the
//      RQ-32 symptom ("icons fail to load and stay broken for the session").
//
// The module reads its two numeric flags at module-eval time, so each case
// re-imports it with a cache-busting query and its own `window.location`.
//
// Run:  node test_p0_4_icon_cache.mjs

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

// ---- minimal browser stubs the module touches ------------------------------
// `document.createElement("canvas")` → the decode path; the returned data URL
// length is what the byte tally sums, so make it deterministic.
const FAKE_URL = "data:image/png;base64," + "A".repeat(1000);
function installStubs(search, { wasm = true } = {}) {
  globalThis.window = {
    location: { search },
    __hbWasm: wasm
      ? {
          fetch_icon_pixels: async (id) => ({
            width: 2, height: 2, pixels: new Uint8ClampedArray(2 * 2 * 4).fill(id & 0xff),
          }),
        }
      : null,
    __wasm: null,
  };
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
      }),
      toDataURL: () => FAKE_URL,
    }),
  };
}

let importSeq = 0;
async function freshModule(search, opts) {
  installStubs(search, opts);
  importSeq += 1;
  return import(`./ui/ac_icon_cache.js?p04=${importSeq}`);
}

async function main() {
  // ---- 1. cap + LRU eviction ---------------------------------------------
  {
    const m = await freshModule("?iconCacheMax=8");
    for (let i = 1; i <= 20; i += 1) await m.fetchIconDataUrl(0x06000000 + i);
    const s = m.iconCacheStats();
    check("cache is capped at insertion", s.resident === 8,
      `resident=${s.resident} expected 8`);
    check("eviction counter records the drops", s.evictions === 12,
      `evictions=${s.evictions} expected 12`);
    check("byte tally tracks residency, not total fetches",
      s.bytes === 8 * FAKE_URL.length, `bytes=${s.bytes}`);
    check("the LRU victim is the OLDEST id",
      m.getIconImmediate(0x06000001) === null &&
      typeof m.getIconImmediate(0x06000000 + 20) === "string",
      "oldest should be gone, newest resident");

    // Touch an old-but-resident id, then push one more in: the touched id
    // must survive and the next-oldest must go.
    const survivor = 0x0600000d; // resident (ids 13..20 remain)
    m.getIconImmediate(survivor);
    await m.fetchIconDataUrl(0x06000021);
    check("getIconImmediate refreshes LRU recency",
      typeof m.getIconImmediate(survivor) === "string" &&
      m.getIconImmediate(0x0600000e) === null,
      "touched id evicted instead of the next-oldest");
  }

  // ---- 2. defaults match retail's ceiling ---------------------------------
  {
    const m = await freshModule("");
    check("default cap is retail's 400", m.iconCacheStats().cap === 400,
      String(m.iconCacheStats().cap));
    check("default negative TTL is finite and non-zero",
      m.iconCacheStats().negTtlMs === 10_000, String(m.iconCacheStats().negTtlMs));
  }

  // ---- 3. failures are TTL'd, not latched ---------------------------------
  {
    // wasm absent → the transient boot-order failure from RQ-32.
    const m = await freshModule("?iconNegTtlMs=0", { wasm: false });
    const first = await m.fetchIconDataUrl(0x06001234);
    check("missing wasm still returns false (API shape unchanged)", first === false,
      String(first));
    let s = m.iconCacheStats();
    check("failure lands in the negative map, NOT the success cache",
      s.negative === 1 && s.resident === 0, JSON.stringify(s));

    // wasm arrives; with TTL 0 the very next request must retry.
    globalThis.window.__hbWasm = {
      fetch_icon_pixels: async () => ({
        width: 2, height: 2, pixels: new Uint8ClampedArray(16),
      }),
    };
    const second = await m.fetchIconDataUrl(0x06001234);
    check("a later request RETRIES instead of latching false",
      typeof second === "string", String(second));
    s = m.iconCacheStats();
    check("retry counter fires (was structurally impossible before P0.4)",
      s.retries >= 1, `retries=${s.retries}`);
    check("the retried icon is now resident", s.resident === 1, JSON.stringify(s));
  }

  // ---- 4. an unexpired failure is still suppressed (no fetch storm) -------
  {
    const m = await freshModule("?iconNegTtlMs=60000", { wasm: false });
    await m.fetchIconDataUrl(0x06005555);
    let calls = 0;
    globalThis.window.__hbWasm = {
      fetch_icon_pixels: async () => {
        calls += 1;
        return { width: 2, height: 2, pixels: new Uint8ClampedArray(16) };
      },
    };
    const again = await m.fetchIconDataUrl(0x06005555);
    check("within the TTL the failure is still honoured",
      again === false && calls === 0, `again=${again} calls=${calls}`);
  }

  // ---- 5. in-flight dedupe + retirement ----------------------------------
  {
    const m = await freshModule("?iconCacheMax=400");
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    globalThis.window.__hbWasm = {
      fetch_icon_pixels: async () => {
        calls += 1;
        await gate;
        return { width: 2, height: 2, pixels: new Uint8ClampedArray(16) };
      },
    };
    const a = m.fetchIconDataUrl(0x06009999);
    const b = m.fetchIconDataUrl(0x06009999);
    await Promise.resolve();
    check("concurrent requests are deduped to one fetch", calls === 1,
      `calls=${calls}`);
    release();
    await Promise.all([a, b]);
    const s = m.iconCacheStats();
    check("the in-flight entry retires on settle", s.inflight === 0,
      JSON.stringify(s));
    check("iconCacheSize() still counts all three maps",
      m.iconCacheSize() === s.resident + s.inflight + s.negative,
      String(m.iconCacheSize()));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
