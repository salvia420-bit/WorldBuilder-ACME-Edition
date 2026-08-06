// harness/lib/moving_rig.mjs — the IN-PAGE half of the moving benchmark.
//
// `movingRigSource()` returns a function that is `page.evaluate`d into the
// client. It installs `window.__mbench`, which owns exactly one job: apply pose
// row k, advance one frame, record what that frame cost and what workload it
// carried. It contains NO path arithmetic — the table is computed in node
// (`moving_path.mjs`) and shipped in — so there is nothing here that can drift
// between two arms.
//
// The same exported function is what `test_moving_bench.mjs` drives against a
// stub `window`, so the tested code and the shipped code are one object.
//
// WHAT IT MEASURES, AND WHY NOT SOMETHING ELSE
// --------------------------------------------
// * `cpuMs` — `window.__diag.vfxGauge.tCpuMs`, the performance.now() pair the
//   client already wraps `tickPerFrame -> renderer.render -> recordRenderDiag`
//   with (`scene3d/index.js` vfxGaugeBeginFrame/EndFrame). Needs `?vfxGauge=on`.
//   This is the number to believe: it is the CPU cost of the frame, it is
//   immune to vsync, and — the reason it is preferred over timing
//   `__renderOnce()` from outside — it is stamped INSIDE the tick, so it stays
//   correct when `?syncPhysicsTick=on` makes `tick` async and `__renderOnce()`
//   returns before the frame has finished (index.js :2618-2622).
// * `rafMs` — successive rAF deltas. Wall-clock cadence, vsync-capped, kept as
//   the cross-check. If the two disagree in DIRECTION between arms, believe
//   neither and say so.
// * draws / triangles — read cumulatively with `renderer.info.autoReset = false`
//   and DIFFERENCED per frame. `autoReset` defaults TRUE, which zeroes the
//   counters every frame; a previous session measured the wrong thing that way.
// * the resident landblock set — hashed per frame. This is the variance source
//   that ruined the old moving rig, so it is not summarised, it is CHECKED: any
//   frame whose set differs from the previous frame's is counted as churn, and
//   the driver rejects a run whose churn exceeds the mode's budget.
//
// SCALE DISCIPLINE. `instances` is a RESIDENT count (every slot in every
// bucket). `drawsPerFrame` is SUBMITTED. They differ by ~an order of magnitude
// and pricing one as the other has produced six 2x+ overestimates on this
// workload — so both are reported, each labelled, and neither is summed.

/**
 * The function to `page.evaluate`. Returns true once `window.__mbench` exists.
 *
 * Deliberately self-contained (no imports, no closure): `page.evaluate` ships
 * the source text, so anything it referenced from this module would be
 * `undefined` in the page.
 */
export function movingRigSource() {
  return function installMovingRig() {
    const W = typeof window !== "undefined" ? window : globalThis;
    const now = () => (W.performance && W.performance.now ? W.performance.now() : Date.now());
    const sleepRaf = () => new Promise((res) => {
      if (typeof W.requestAnimationFrame === "function") W.requestAnimationFrame(() => res());
      else setTimeout(res, 16);
    });

    // three -> AC world metres. `acToThree(ax,ay,az) = [ax, az, -ay]`
    // (scene3d/adapter.js :1772), so the inverse is [tx, -tz, ty].
    const threeToAc = (p) => ({ x: p.x, y: -p.z, z: p.y });

    // FNV-1a, quantised to 1 mm — byte-identical to `moving_path.mjs`
    // `tableChecksum` so the realised hash is directly comparable to the
    // intended one. Any divergence here is the camera not going where it was
    // told, which is precisely the failure the old rig could not see.
    function mkHash() {
      let h = 0x811c9dc5 >>> 0;
      return {
        mix(x) {
          h ^= x & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
          h ^= (x >>> 8) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
          h ^= (x >>> 16) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
          h ^= (x >>> 24) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
        },
        mixF(v) { this.mix(Math.round(v * 1000) | 0); },
        mixS(s) { for (let i = 0; i < s.length; i++) this.mix(s.charCodeAt(i)); },
        get value() { return (h >>> 0).toString(16).padStart(8, "0"); },
      };
    }

    function residentLbHash() {
      const s3 = W.liveScene3d;
      const set = s3 && s3.terrainBakedLbs;
      if (!set || typeof set.forEach !== "function") return { hash: "n/a", count: -1 };
      const keys = [];
      set.forEach((_v, k) => keys.push(typeof k === "number" ? k : String(k)));
      keys.sort();
      const h = mkHash();
      for (const k of keys) h.mixS(String(k));
      return { hash: h.value, count: keys.length };
    }

    function batchCensus() {
      const s3 = W.liveScene3d;
      let batched = 0, staticBatchC = 0;
      try {
        s3.scene.traverse((o) => {
          if (o.isBatchedMesh) { batched += 1; if (o.name && o.name.indexOf("static-batch-c-") === 0) staticBatchC += 1; }
        });
      } catch (_) { /* census only */ }
      // RESIDENT instance slots, not submitted ones — see the header.
      let instances = -1;
      try { instances = W.__statBatchXStats().walk.slots.all; } catch (_) { /* not armed */ }
      return { batched, staticBatchC, instances };
    }

    function walkStats() {
      try { return JSON.parse(JSON.stringify(W.__statBatchXStats().walk)); } catch (_) { return null; }
    }

    W.__mbench = {
      spec: null,
      rows: null,
      events: null,
      _errors: [],

      /** Payload comes from `moving_path.mjs` — rows, events, spec, checksum. */
      install(payload) {
        this.spec = payload.spec;
        this.rows = payload.rows;
        this.events = payload.events || [];
        this.warmFrames = payload.warmFrames == null ? payload.rows.length : payload.warmFrames;
        this.drive = payload.drive || "ondemand";
        this._errors = [];
        // renderer.info.autoReset defaults TRUE, which zeroes the counters
        // every frame — read them cumulatively and difference (2026-07-01
        // measurement trap (a)).
        try { W.liveScene3d.renderer.info.autoReset = false; } catch (e) { this._errors.push("autoReset: " + e.message); }
        return { installed: true, frames: this.rows.length, warmFrames: this.warmFrames, drive: this.drive };
      },

      /** Apply row k. Parks the camera (`__cam.set` implies park) so nothing
       *  re-derives it from the player between here and the render. */
      applyPose(k) {
        const r = this.rows[k];
        W.__cam.set(r[0], r[1], r[2], r[3], r[4], r[5]);
      },

      /** Where the camera ACTUALLY is, in AC world metres. */
      realisedEye() {
        const s3 = W.liveScene3d;
        const cam = (s3.cameraSwitcher && s3.cameraSwitcher.activeCamera) || s3.camera;
        return threeToAc(cam.position);
      },

      /**
       * Advance exactly one frame.
       *
       * `ondemand` (needs `?renderOnDemand=1`) is the deterministic driver: one
       * `__renderOnce()` per pose, no rAF re-arm of the app's own, so frame
       * index and pose index cannot desynchronise. We then yield one rAF so the
       * compositor drains and the GPU queue cannot back up into render().
       *
       * `raf` lets the app schedule itself and simply applies the pose at the
       * top of each frame. Realistic cadence, but the pose/frame pairing is only
       * as tight as the rAF ordering — use it as a cross-check, not as the
       * primary arm.
       */
      async step() {
        const g0 = this._gaugeFrames();
        if (this.drive === "ondemand") {
          if (typeof W.__renderOnce !== "function") throw new Error("__renderOnce missing — pass ?renderOnDemand=1");
          W.__renderOnce();
        }
        await sleepRaf();
        // Under ?syncPhysicsTick=on the tick continues in a trailing microtask,
        // so the gauge may stamp just after the rAF. Give it a bounded number of
        // extra yields rather than assuming.
        for (let i = 0; i < 3 && this._gaugeFrames() === g0; i++) await sleepRaf();
      },

      _gaugeFrames() {
        try { return W.__diag.vfxGauge.frames | 0; } catch (_) { return -1; }
      },
      _gaugeCpuMs() {
        try { const v = W.__diag.vfxGauge; return v && v.armed ? v.tCpuMs : null; } catch (_) { return null; }
      },

      /**
       * Warm pass then measure pass over the SAME closed path.
       *
       * The warm pass exists so the measure pass is not paying for streaming,
       * shader compiles and first-touch decode — it walks the whole lap once and
       * its numbers are DISCARDED. Splitting them is not politeness; a single
       * pass would price a cold cache as if it were the steady state, and the
       * moving case is exactly where that error is largest.
       */
      async run() {
        const rows = this.rows;
        const n = rows.length;
        const out = {
          cpuMs: [], rafMs: [], draws: [], ktris: [],
          lbChurnFrames: 0, lbCounts: [], lbHashFirst: null, lbHashLast: null,
          realised: mkHash(), missedGauge: 0, warm: { cpuMs: [], frames: 0 },
        };
        let renderer = null;
        try { renderer = W.liveScene3d.renderer; } catch (_) { /* reported below */ }

        // ---- warm pass — one full lap, discarded -------------------------
        for (let k = 0; k < this.warmFrames; k++) {
          const idx = k % n;
          await this._maybeEvent(idx);
          this.applyPose(idx);
          await this.step();
          const c = this._gaugeCpuMs();
          if (c != null) out.warm.cpuMs.push(c);
          out.warm.frames += 1;
        }

        // ---- measure pass — the identical lap ----------------------------
        const walk0 = walkStats();
        let prevLb = residentLbHash();
        out.lbHashFirst = prevLb.hash;
        let lastRaf = now();
        let c0 = 0, t0 = 0;
        if (renderer) { c0 = renderer.info.render.calls; t0 = renderer.info.render.triangles; }
        for (let k = 0; k < n; k++) {
          await this._maybeEvent(k);
          this.applyPose(k);
          const gPrev = this._gaugeFrames();
          await this.step();
          const tNow = now();
          out.rafMs.push(tNow - lastRaf);
          lastRaf = tNow;
          const c = this._gaugeCpuMs();
          if (c != null && this._gaugeFrames() !== gPrev) out.cpuMs.push(c); else out.missedGauge += 1;
          if (renderer) {
            const c1 = renderer.info.render.calls, t1 = renderer.info.render.triangles;
            out.draws.push(c1 - c0); out.ktris.push((t1 - t0) / 1000);
            c0 = c1; t0 = t1;
          }
          // Realised pose — hashed with the table's quantisation.
          const e = this.realisedEye();
          const r = rows[k];
          out.realised.mixF(e.x); out.realised.mixF(e.y); out.realised.mixF(e.z);
          out.realised.mixF(r[3]); out.realised.mixF(r[4]); out.realised.mixF(r[5]);
          const ev = this.events[k];
          if (ev) out.realised.mixS(ev);
          const lb = residentLbHash();
          out.lbCounts.push(lb.count);
          if (lb.hash !== prevLb.hash) out.lbChurnFrames += 1;
          prevLb = lb;
        }
        out.lbHashLast = prevLb.hash;
        const walk1 = walkStats();

        return {
          frames: n,
          warmFrames: out.warm.frames,
          realisedChecksum: out.realised.value,
          cpuMs: out.cpuMs,
          rafMs: out.rafMs,
          draws: out.draws,
          ktris: out.ktris,
          missedGauge: out.missedGauge,
          lb: { churnFrames: out.lbChurnFrames, counts: out.lbCounts, hashFirst: out.lbHashFirst, hashLast: out.lbHashLast },
          census: batchCensus(),
          walk0, walk1,
          errors: this._errors.slice(0, 12),
        };
      },

      async _maybeEvent(k) {
        const ev = this.events[k];
        if (!ev) return;
        try { W.__sessionHandle.sendChat(ev); } catch (e) { this._errors.push("event: " + e.message); }
        // A teleport needs the server round-trip and the streaming that follows
        // it; the dwell is what absorbs that, but give the first frame a beat so
        // the hop is not issued and rendered in the same tick.
        await sleepRaf();
      },
    };
    return true;
  };
}
