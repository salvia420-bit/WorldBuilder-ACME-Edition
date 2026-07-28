// plugins/webhost.js — the plugin-tree path for the ONE facade substrate.
//
// P6.1 / CORE-07 (2026-07-28). `RynthWebHost` is the substrate of the one
// versioned `client` facade: `plugins/api.js::createClient` constructs
// exactly one of them, hangs it on `client.host`, and expresses every
// plugin-facing namespace as a delegate over its capability table.
//
// WHY THIS FILE IS THE ALIAS AND NOT THE IMPLEMENTATION. The P6.1 design
// doc called for moving the implementation here and leaving
// `rynth/webhost.js` as the re-export. The alias points the other way
// instead, for one hard reason verified in the tree: two anti-drift node
// harnesses — `rynth_host_contract_test.cjs` and
// `rynth_combatparity_test.cjs` — read `rynth/webhost.js`'s BYTES, write
// them to a temp `.mjs`, and import that standalone. They work only because
// the file has ZERO top-level imports. A re-export stub there would resolve
// `../plugins/webhost.js` against the temp directory and break both guards
// (and with them the ExplorePressure ladder + combat-parity contracts).
//
// The invariant the tier actually asks for is "one implementation, the
// other facades alias it" — which direction the alias points is an
// implementation detail. So: implementation stays in `rynth/webhost.js`
// (import-free, standalone-loadable), and this is the canonical path for
// plugin-side consumers.
//
// Anything page-side that the host needs (chat hooks, the chat-bar router,
// the 3D selection seam, the bar's panel API) is read off `window.*` lazily
// by the host for the same reason.

export {
  RynthWebHost,
  CAPABILITY_NAMES,
  ENV_CAPABILITY_NAMES,
  probeCapabilities,
  default,
} from "../rynth/webhost.js";
