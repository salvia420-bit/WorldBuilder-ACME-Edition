// A8-M3 (2026-06-11 unification survey, S4 spec) — kind-17
// EntityVisibilityChanged re-home out of the 2D drain, behind
// `?unifiedClientEvent=on` (renamed from the spec's
// `?unifiedEntityDispatch` per the SQ3 §3 flag ruling).
//
// Standalone node ESM test (no live ACE session, no browser). Two parts:
//   PART 1 — behavioral: import scene3d/client_event_dispatch.js directly
//            (pure / dependency-free by construction) and exercise the
//            hook contract against a recording EntityManager stub.
//   PART 2 — static: read index.html + scene3d/loop.js + docs/url-flags.md
//            as text and assert the delegation, the retained legacy body
//            (rollback path), the hook install, and the flag doc are
//            actually wired into the shipped source.
//
// Run:
//   cd apps/holtburger-web/
//   node test_a8_m3_kind17_dispatch.mjs

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// =====================================================================
// PART 1 — behavioral: the dispatcher contract.
// =====================================================================
console.log("PART 1 — behavioral dispatcher contract");

// (6) first: importing the module must have NO module-scope side effects
// (in particular it must not define window.* — in 2D sessions the hook
// stays undefined because installSharedDrainHook never runs).
const hadWindowBefore = typeof globalThis.window !== "undefined";
const mod = await import("./scene3d/client_event_dispatch.js");
const { createClientEventDispatcher, CLIENT_EVENT_KIND_ENTITY_VISIBILITY_CHANGED } = mod;
check(
  "import has no module-scope side effects (no window.* defined)",
  (typeof globalThis.window !== "undefined") === hadWindowBefore
  && (hadWindowBefore ? true : typeof globalThis.window === "undefined"),
);
check(
  "kind constant mirrors wasm CLIENT_EVENT_KIND_ENTITY_VISIBILITY_CHANGED = 17",
  CLIENT_EVENT_KIND_ENTITY_VISIBILITY_CHANGED === 17,
);

function makeStub() {
  const calls = [];
  return {
    calls,
    em: {
      setVisibility(guid, visible) {
        calls.push([guid, visible]);
      },
    },
  };
}

// (1) kind-17, u32Payload2 = 1 → setVisibility(guid, true), returns true.
{
  const { calls, em } = makeStub();
  const hook = createClientEventDispatcher({ getEntityManager: () => em });
  const consumed = hook({ kind: 17, u32Payload: 0x50000123, u32Payload2: 1 });
  check("kind-17 visible=1 consumed", consumed === true);
  check(
    "setVisibility called once with (guid>>>0, true)",
    calls.length === 1 && calls[0][0] === 0x50000123 && calls[0][1] === true,
    JSON.stringify(calls),
  );
}

// (2) u32Payload2 = 0 → false; u32Payload2 = 2 → false (the `=== 1`
// contract, mirroring lib.rs's 1/0 emit).
{
  const { calls, em } = makeStub();
  const hook = createClientEventDispatcher({ getEntityManager: () => em });
  const c0 = hook({ kind: 17, u32Payload: 0x50000001, u32Payload2: 0 });
  const c2 = hook({ kind: 17, u32Payload: 0x50000002, u32Payload2: 2 });
  check("u32Payload2=0 → visible=false, consumed", c0 === true && calls[0][1] === false);
  check("u32Payload2=2 → visible=false (=== 1 contract), consumed", c2 === true && calls[1][1] === false);
}

// (3) guid coercion: 0xDEADBEEF as signed-negative JS number → >>> 0.
{
  const { calls, em } = makeStub();
  const hook = createClientEventDispatcher({ getEntityManager: () => em });
  hook({ kind: 17, u32Payload: 0xDEADBEEF | 0, u32Payload2: 1 }); // -559038737
  check(
    "signed-negative payload round-trips via >>> 0",
    calls.length === 1 && calls[0][0] === 0xDEADBEEF,
    `got ${calls[0] && calls[0][0]}`,
  );
}

// (4) non-17 kinds → returns false, stub never called (legacy arm keeps
// ownership of kinds 0/15/30/55).
{
  const { calls, em } = makeStub();
  const hook = createClientEventDispatcher({ getEntityManager: () => em });
  const results = [0, 15, 30, 55].map((k) => hook({ kind: k, u32Payload: 1, u32Payload2: 1 }));
  check(
    "kinds 0/15/30/55 not consumed, setVisibility never called",
    results.every((r) => r === false) && calls.length === 0,
  );
  check("null evt not consumed, no throw", hook(null) === false);
}

// (5) getEntityManager() → null: consumed (true), no throw — matches the
// legacy index.html guard no-op.
{
  const hook = createClientEventDispatcher({ getEntityManager: () => null });
  let threw = false;
  let consumed = false;
  try {
    consumed = hook({ kind: 17, u32Payload: 5, u32Payload2: 1 });
  } catch (_) {
    threw = true;
  }
  check("null manager → consumed no-op, no throw", consumed === true && !threw);
  // Manager without setVisibility: same consumed no-op.
  const hook2 = createClientEventDispatcher({ getEntityManager: () => ({}) });
  check("manager without setVisibility → consumed no-op", hook2({ kind: 17, u32Payload: 5, u32Payload2: 1 }) === true);
}

// =====================================================================
// PART 2 — static: shipped source wiring.
// =====================================================================
console.log("PART 2 — static source wiring");

const indexHtml = readFileSync(joinPath(__dirname, "index.html"), "utf8");
const loopJs = readFileSync(joinPath(__dirname, "scene3d", "loop.js"), "utf8");
const urlFlags = readFileSync(joinPath(__dirname, "docs", "url-flags.md"), "utf8");

// (2.1) kind-17 arm: consumed-hook delegation gated on unifiedClientEvent
// AND the retained legacy body (rollback path) as its else.
const armStart = indexHtml.indexOf("evt.kind === 17");
const armSlice = armStart >= 0 ? indexHtml.slice(armStart, armStart + 4000) : "";
check("index.html still has the evt.kind === 17 arm", armStart >= 0);
check(
  "arm delegates via __unifiedClientEventOn && __scene3dClientEventHook",
  /__unifiedClientEventOn\s*&&\s*window\.__scene3dClientEventHook\?\.\(evt\)/.test(armSlice),
);
check(
  "legacy setVisibility(visGuid, visible) body retained (rollback path)",
  armSlice.includes("setVisibility(visGuid, visible)"),
);
check(
  "flag reader reads ?unifiedClientEvent",
  indexHtml.includes('.get("unifiedClientEvent")'),
);

// (2.2) loop.js installSharedDrainHook assigns the hook via the factory.
const installStart = loopJs.indexOf("export function installSharedDrainHook");
const installSlice = installStart >= 0 ? loopJs.slice(installStart) : "";
check("loop.js exports installSharedDrainHook", installStart >= 0);
check(
  "installSharedDrainHook assigns window.__scene3dClientEventHook via createClientEventDispatcher",
  /window\.__scene3dClientEventHook\s*=\s*createClientEventDispatcher\(/.test(installSlice),
);
check(
  "loop.js imports from ./client_event_dispatch.js",
  loopJs.includes('from "./client_event_dispatch.js"'),
);

// (2.3) url-flags.md documents the flag.
check("docs/url-flags.md documents unifiedClientEvent", urlFlags.includes("`unifiedClientEvent`"));

// =====================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
