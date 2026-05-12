// Workstream Sky-J P4 (2026-05-12) — particle runtime barrel.
//
// Re-exports the ParticleManager, ParticleType enum, ParticleEmitterInfo
// wrapper (around the wasm `ParticleEmitterJs`), and the deterministic-
// test hooks `setCurrentTime` / `setRng`. The runtime is a literal port
// of `external/ACE/Source/ACE.Server/Physics/Particles/*.cs` — see the
// per-file headers for the C#→JS line-mapping.
//
// **Test seam.** Tests call `setCurrentTime(() => fakeSeconds)` and
// `setRng(() => fakeRng)` to drive the per-particle math deterministically.
// Default `currentTime()` is `performance.now() / 1000.0`; default
// `rng()` is `Math.random()` (uniform [0,1)).

import { ParticleType } from "./particle.js";
import { ParticleManager } from "./particle_manager.js";
import { ParticleEmitterInfo } from "./particle_emitter_info.js";
import { ParticleEmitter } from "./particle_emitter.js";
import {
  currentTime,
  setCurrentTime,
  rng,
  setRng,
  __resetTimeHook,
  __resetRngHook,
} from "./time_rng.js";

export {
  ParticleManager,
  ParticleEmitter,
  ParticleEmitterInfo,
  ParticleType,
  currentTime,
  setCurrentTime,
  rng,
  setRng,
  __resetTimeHook,
  __resetRngHook,
};
