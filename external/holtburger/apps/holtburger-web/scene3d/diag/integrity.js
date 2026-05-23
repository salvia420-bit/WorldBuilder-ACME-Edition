// scene3d/diag/integrity.js — boot-time bake-artifact integrity diagnostic slice
//
// Catches the "client loaded different DATs than the bake assumed" silent drift
// failure mode. At any time after boot, devtools (or a harness) can call
//   await window.__diag.integrity.verifyManifests()
// to hash the live bytes of dist/boot.hba and compare against the sha256
// embedded in dist/manifest.json (the bake's contract). Bake-source lineage
// files (scenery/events/spawns) are surfaced as INFO rows — we can't verify
// them locally because we don't ship the source DATs — but they still tell an
// operator which DAT hashes the bake was run against.
//
// Per-LB JSONL sidecars (e.g. 0xA9B4.scenery.jsonl.sha256) DON'T exist today;
// the bake CLIs need to emit them (Wave 4.B follow-on). For now this surface
// only verifies boot_pack and shows lineage info.
//
// Cheating discipline:
//   - Hash the BYTES actually fetched (cache:"reload") — never trust a
//     server-reported sha.
//   - Trust manifest.boot_pack.sha256 as the EXPECTED value (it IS the
//     contract), but VERIFY by recomputing over the fetched boot.hba bytes.
//   - Don't fabricate match=true for lineage rows we can't actually verify.
//
// Devtools entry points exposed on `__diag.integrity`:
//   lastResult      — { ok, results, ts, durationMs } from last verifyManifests
//   cache           — { url → { sha256Hex, sizeBytes, ts } } per-instance
//   verifyManifests(opts)   — full sweep; returns lastResult
//   verifyOne(source, url, expectedSha)   — single-URL verify
//   digestUrl(url)  — fetch + sha256 + size (cached)
//   summary()       — { lastOk, lastTs, perSource: { name → status } }
//   reset()         — clear cache + lastResult

export function attachIntegrity(diag) {
  diag.integrity = {
    lastResult: null,
    cache: {},

    async digestUrl(url) {
      if (typeof crypto?.subtle?.digest !== "function" || typeof fetch !== "function") {
        return { error: "crypto.subtle.digest or fetch not available" };
      }
      if (this.cache[url]) return { ...this.cache[url], fromCache: true };
      try {
        const resp = await fetch(url, { cache: "reload" });
        if (!resp.ok) return { error: `fetch ${url}: ${resp.status}` };
        const buf = await resp.arrayBuffer();
        const hashBuf = await crypto.subtle.digest("SHA-256", buf);
        const sha256Hex = Array.from(new Uint8Array(hashBuf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const sizeBytes = buf.byteLength;
        this.cache[url] = { sha256Hex, sizeBytes, ts: performance.now() };
        return { sha256Hex, sizeBytes, fromCache: false };
      } catch (e) {
        return { error: String(e?.message ?? e) };
      }
    },

    async verifyOne(source, url, expectedSha) {
      const r = {
        source,
        url,
        expectedSha: String(expectedSha || ""),
        computedSha: null,
        match: null,
      };
      const d = await this.digestUrl(url);
      if (d.error) {
        r.error = d.error;
        r.match = false;
        return r;
      }
      r.computedSha = d.sha256Hex;
      r.sizeBytes = d.sizeBytes;
      r.match = !!(
        r.expectedSha &&
        r.computedSha &&
        r.expectedSha.toLowerCase() === r.computedSha.toLowerCase()
      );
      return r;
    },

    async verifyManifests(opts = {}) {
      const t0 = performance.now();
      const distBase = opts.distBase ?? "../../dist/";
      const results = [];

      // 1. Manifest + boot_pack (the one row we can actually verify today)
      let manifest = null;
      try {
        const resp = await fetch(distBase + "manifest.json", { cache: "reload" });
        if (resp.ok) {
          manifest = await resp.json();
        } else {
          results.push({
            source: "manifest",
            url: distBase + "manifest.json",
            error: `fetch ${resp.status}`,
            match: false,
          });
        }
      } catch (e) {
        results.push({
          source: "manifest",
          url: distBase + "manifest.json",
          error: String(e?.message ?? e),
          match: false,
        });
      }

      if (manifest?.boot_pack?.url && manifest.boot_pack.sha256) {
        // boot_pack.url may be relative ("boot.hba"), absolute ("/dist/boot.hba"),
        // or "dist/boot.hba" — normalize by stripping any leading dist/ prefix.
        const bootRel = String(manifest.boot_pack.url).replace(/^\/?dist\/?/, "");
        const bootUrl = distBase + bootRel;
        results.push(await this.verifyOne("boot_pack", bootUrl, manifest.boot_pack.sha256));
      } else if (manifest) {
        results.push({
          source: "boot_pack",
          error: "manifest missing boot_pack.{url,sha256}",
          match: false,
        });
      }

      // 2-4. Bake-source lineage files — INFO only (no source DATs client-side)
      const lineageSources = [
        ["scenery-bake-source", "scenery/bake-source.sha256"],
        ["events-bake-source", "events/event-bake-source.sha256"],
        ["spawns-bake-source", "spawns/source.sha256"],
      ];
      for (const [source, path] of lineageSources) {
        const url = distBase + path;
        try {
          const resp = await fetch(url, { cache: "reload" });
          if (!resp.ok) {
            results.push({
              source,
              url,
              error: `fetch ${resp.status}`,
              match: null,
              info: "lineage file unavailable",
            });
            continue;
          }
          const text = (await resp.text()).trim();
          results.push({
            source,
            url,
            lineage: text.split("\n").slice(0, 10),
            match: null,
            info: "lineage info only (input-DAT hashes for the bake). For per-LB byte verification, pass opts.landblocks=[\"0xA9B4\", ...] — Wave 4.B sidecars are emitted by scenery-bake-cli / event-bake-cli / stage-ring-spawns.py.",
          });
        } catch (e) {
          results.push({ source, url, error: String(e?.message ?? e), match: false });
        }
      }

      // 5. Wave-4.B per-LB JSONL verification. Caller passes
      //    `opts.landblocks: ["0xA9B4", "0xA9B3", ...]` (16-bit form, hex
      //    string OR number). For each LB and each of the three bake
      //    types (scenery / events / spawns) we fetch
      //    `<distBase>/<type>/<lbHex>.<type>.jsonl.sha256` to get the
      //    expected sha, then verifyOne the JSONL itself. Missing files
      //    surface as info (no error) — empty LBs are legitimate.
      if (Array.isArray(opts.landblocks)) {
        for (const lbInput of opts.landblocks) {
          let lbHex;
          if (typeof lbInput === "number") {
            // Accept either full 32-bit (0xA9B40000) or 16-bit (0xA9B4)
            const high16 = (lbInput >>> 16) ? (lbInput >>> 16) : lbInput;
            lbHex = "0x" + (high16 & 0xffff).toString(16).toUpperCase().padStart(4, "0");
          } else {
            lbHex = String(lbInput).toUpperCase().replace(/^0X/, "0x");
            if (!lbHex.startsWith("0x")) lbHex = "0x" + lbHex;
            // If caller passed full 8-digit form, trim to high-16
            if (lbHex.length === 10) lbHex = lbHex.slice(0, 6);
          }

          for (const t of ["scenery", "events", "spawns"]) {
            const jsonlUrl = `${distBase}${t}/${lbHex}.${t}.jsonl`;
            const sidecarUrl = `${jsonlUrl}.sha256`;
            let expectedSha = null;
            let sidecarMissing = false;
            try {
              const r = await fetch(sidecarUrl, { cache: "reload" });
              if (r.ok) {
                expectedSha = (await r.text()).trim().split(/\s+/)[0];
              } else if (r.status === 404) {
                sidecarMissing = true;
              } else {
                results.push({
                  source: `${t}:${lbHex}`,
                  url: sidecarUrl,
                  error: `sidecar fetch ${r.status}`,
                  match: false,
                });
                continue;
              }
            } catch (e) {
              results.push({
                source: `${t}:${lbHex}`,
                url: sidecarUrl,
                error: String(e?.message ?? e),
                match: false,
              });
              continue;
            }
            if (sidecarMissing) {
              results.push({
                source: `${t}:${lbHex}`,
                url: sidecarUrl,
                match: null,
                info: "sidecar 404 — LB likely not baked for this type (legitimate empty)",
              });
              continue;
            }
            results.push(await this.verifyOne(`${t}:${lbHex}`, jsonlUrl, expectedSha));
          }
        }
      }

      // 6. Optional ad-hoc verifications passed by caller
      if (Array.isArray(opts.extraVerifications)) {
        for (const v of opts.extraVerifications) {
          results.push(await this.verifyOne(v.source, v.url, v.expectedSha));
        }
      }

      const durationMs = performance.now() - t0;
      // Top-level ok: nothing returned match=false. Lineage rows (match=null) are info-only.
      const fatalProblem = results.some((r) => r.match === false);
      this.lastResult = {
        ok: !fatalProblem,
        results,
        ts: performance.now(),
        durationMs,
      };
      return this.lastResult;
    },

    summary() {
      const out = {
        lastOk: this.lastResult ? this.lastResult.ok : null,
        lastTs: this.lastResult ? this.lastResult.ts : null,
        perSource: {},
      };
      if (!this.lastResult) return out;
      for (const r of this.lastResult.results) {
        let status;
        if (r.error) status = "error";
        else if (r.match === true) status = "match";
        else if (r.match === false) status = "mismatch";
        else status = "unchecked"; // lineage info-only rows
        out.perSource[r.source] = status;
      }
      return out;
    },

    reset() {
      this.cache = {};
      this.lastResult = null;
    },
  };
}
