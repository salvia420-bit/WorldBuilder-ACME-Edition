// tools/rust_parity/fixture_util.mjs — shared helpers for the JS → Rust parity
// fixtures (docs/2026-10-26-rust-scene-core.md, "Parity fixtures").
//
// A fixture records what the JS reference computed so the Rust port
// (crates/holtburger-scene, `cargo test -p holtburger-scene`) can be pinned to
// it. Floats are stored as IEEE-754 bit patterns in hex, never as decimal
// JSON numbers: a decimal round trip is not guaranteed exact through
// serde_json's default parser, and these tests compare bits.
//
//   f64hex(x)  → "3ff0000000000000"      (Rust: f64::from_bits)
//   f32hex(x)  → "3f800000"              (the value a Float32Array would store)
//   recordRng(n?) → { rng, values }      a Math.random() stand-in that records
//                                        every draw, for Rng::scripted
//   writeFixture(name, obj)              → crates/holtburger-scene/tests/fixtures/<name>.json

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, "..", "..", "..", "..", "crates", "holtburger-scene", "tests", "fixtures");

const _dv = new DataView(new ArrayBuffer(8));

export function f64hex(x) {
  _dv.setFloat64(0, x);
  return _dv.getBigUint64(0).toString(16).padStart(16, "0");
}

export function f32hex(x) {
  _dv.setFloat32(0, x);
  return _dv.getUint32(0).toString(16).padStart(8, "0");
}

export function f64arr(a) { return Array.from(a, f64hex); }
export function f32arr(a) { return Array.from(a, f32hex); }

/** Deterministic PRNG (mulberry32) for generating fixture INPUTS. */
export function inputRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A recording random source: install `rng` where the JS reference reads
 * Math.random()/time_rng `rng()`; afterwards `values` holds every draw in
 * order (feed them to Rust's `Rng::scripted`).
 */
export function recordRng(seed = 7) {
  const src = inputRng(seed);
  const values = [];
  return { rng: () => { const v = src(); values.push(v); return v; }, values };
}

export function writeFixture(name, obj) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = join(FIXTURE_DIR, `${name}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
