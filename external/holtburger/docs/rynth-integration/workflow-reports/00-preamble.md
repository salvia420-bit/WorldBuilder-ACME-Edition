You are one of 16 research agents in a fan-out workflow scoping the integration of RynthSuite (a C# Asheron's Call bot) with holtburger-web (our browser-based AC client: JS/three.js frontend + Rust/wasm core). RynthSuite today drives the retail Windows acclient.exe; the USER'S DECISION is that the integration target is holtburger-WEB — the browser client — so design for that (a prior analysis recommended the native path; the user overrode it; treat native only as a comparison point where a task asks).

You run on a build box with full source checkouts. READ REAL FILES — never answer from prior knowledge. Cite file:line for every claim and verify counts yourself.

Paths:
- RynthSuite (bot):      /home/wbterminal/ac-refs/rynthsuite  — RynthAi plugin at Plugins/RynthCore.Plugin.RynthAi/ (75 files, ~51.5k lines)
- RynthCore (host SDK):  /home/wbterminal/ac-refs/rynthcore   — the seam: src/RynthCore.PluginSdk/RynthCoreHost.cs (1,449 lines, ABI v66) + RynthCoreApiNative.cs; plugin base in src/RynthCore.PluginCore/
- holtburger:            /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
  - apps/holtburger-web/       — THE TARGET. index.html (boot, login, __diag globals), scene3d/*.js (three.js render + entities), src/lib.rs (the wasm crate: #[wasm_bindgen] SessionHandle with ~188 methods + ~147 free functions — READ THE SOURCE; pkg/ is a gitignored build artifact and is NOT on this box)
  - apps/holtburger-web/k1_drive_combat.cjs — an existing crude Playwright/CDP bot (logs in, teleports, polls entityMap, toggles combat, attacks). Prior art; read it.
  - apps/holtburger-wsbridge/  — WebSocket<->UDP bridge (browsers cannot do UDP; every web session rides this)
  - crates/holtburger-session/ — session/protocol state machine (compiled INTO the wasm for web)
  - crates/holtburger-protocol/ — opcodes + message defs
  - crates/holtburger-scripting/ — a deno_core JS bot runtime with 65 ops, NATIVE-ONLY (deno_core cannot target wasm32; NOT available in the browser). Useful as a DESIGN REFERENCE for what a bot API surface looks like, nothing more.
  - apps/holtburger-web/docs/url-flags.md — every ?flag; the bot-relevant ones: ?nullRender=1 (pure-protocol bot mode, render skipped, sim+net drain run), ?renderOnDemand=1, ?netDrainHz=N, ?autoLogin=1&account=..&password=..&autoSpawn=first, ?agent=1 (CSS-only, hides login form), ?nosw=1 (bypass service worker cache).

Established facts (verified in a prior session; you may rely on them, still cite when you touch them):
- 100% of RynthAi's client access flows through the RynthCoreHost struct; the raw RynthCoreApiNative table is never used outside PluginExports.cs:17. Reimplementing that one class's contract makes the 51.5k-line brain portable.
- RynthAi has 344 `Has*` capability-guard call sites — it already tolerates a partially-implemented host.
- RynthCoreHost is poll-style: TryGet* reads + fire-and-forget actions, driven by a synchronous host-pumped tick that drains event queues (rynthsuite EntryPoint.cs:868-874, EngineFrameController.cs:430). The browser is async: event loop, rAF, message-drain cadence. This poll-vs-async inversion is the deepest structural risk.
- Known unportable islands (~508 lines): Combat/FellowshipTracker.cs (hardcoded acclient memory addresses), Meta/ExpressionEngine.cs:2971 (Marshal.ReadInt64 game clock), Maps/DungeonMapTexture.cs:232-235 (D3D9 vtable), plus a registry read (Combat/ComponentDatabase.cs:266) and GetModuleHandleA (RynthAiPlugin.cs:2274).
- The wasm boundary is poll-only from JS's perspective for most state; the web client exposes state via SessionHandle methods and JS-side globals (entityMap, window.__diag, window.__sessionHandle, window.__bootState).

Rules:
- ripgrep (rg) is installed; use it.
- Your STDOUT is the deliverable. Emit ONLY a self-contained markdown report — no preamble chatter, no narration of what you are about to do.
- Start your report with a single H1: `# <two-digit-id> — <title>` matching your task id.
- Be precise and dense. Use tables for enumerable facts. Every file:line citation must be real — reports get spot-checked; a fabricated citation invalidates the report.
- If you run low on time, emit what you have plus a `## MISSING` section listing what you did not cover.

YOUR TASK:
