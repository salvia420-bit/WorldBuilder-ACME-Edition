# WS14 — Cast-state UI feedback (combat bar / spellbook / toasts)

Owner charter: the **UI honesty layer** for spellcasting. Grey/cooldown-sweep the
combat-bar + spellbook rows during the cast-busy window; clear armed-state affordance;
rejection-feedback coverage (peace-mode click, no-target, out-of-range presentation,
mana/components pre-check messaging); wire cast lifecycle events into
`window.__pluginClient.events`.

Baseline read this session: `external/holtburger` (tree as handed off), foundation doc
`docs/HANDOFF-spellcasting-foundation-2026-07-12.md`. Every cite below was opened live
2026-07-12; decomp cross-checked via a dedicated `rg -a` pass; cast-timing grounded in
real DAT bytes via the WB.Terminal oracle.

**Scope discipline:** this is an *improvement* pass. The server-side rejection toast
path already works (see §1.4); most of my deliverable is *additive UI state* on the
combat bar (HUD-only, no flags) plus *optional* flag-gated client pre-checks. No wire
or wasm behavior change is required for the primary deliverable, and **no wasm rebuild
is needed** for the HUD-only core (the two optional Rust-adjacent notes are called out).

---

## 0. TL;DR — what's broken, what I'll build

| # | Symptom (charter) | Status today | Fix altitude |
|---|---|---|---|
| A | No grey/cooldown affordance while a cast is in flight | **Missing** — `_castBusyUntilMs` exists per-entity but nothing renders it | HUD-only (no flag) |
| B | Armed spell doesn't show *which stance* it can fire in | Partial — `.armed` highlights the row; no stance cue; wrong-stance click only *reactively* rejected | HUD-only (no flag) |
| C | Peace-mode armed-spell click = silent no-op | **Missing** — F11-5 only covers melee/missile stance; pure PEACE falls through to `useObject` | HUD-only (no flag) |
| D | No-target targeted cast shows a *name-label*, not a toast | Partial — `castCurrent()` sets the strip name to "(no target selected)"; not the retail string, not a toast | HUD-only (no flag) |
| E | Server-side cast rejects (fizzle/mana/components/range/indoor/air) | **Already works** via the transient-chat toast path — verified §1.4 | none (keep) |
| F | Client-side PRE-check (components retail / mana non-retail) | **Missing** | Flag-gated (`?castPrecheck`, default-off) |
| G | Cast lifecycle events for plugins (`spellCastResolved`/`spellCastRejected`) | **Missing** — only `spellCastInitiated` exists, and only on the picking path | HUD-only (event add; names → WS16) |

---

## 1. VERIFIED FINDINGS

### 1.1 The cast-busy window is real, per-entity, and already maintained — but nothing renders it

`EntityManager.playCastSequence(guid, spellId)` sets a per-instance busy window sized to
the gesture chain:

> `scene3d/entities.js:6764-6772`
> ```js
> if (CAST_STATE_MACHINE) {
>   const nowMs = performance.now();
>   if (inst._castBusyUntilMs && nowMs < inst._castBusyUntilMs) {
>     return; // already casting — ignore the recast
>   }
>   let estMs = 0;
>   for (const gz of (seq.windupGestures || [])) estMs += (+gz.durationS || 0.6) * 1000;
>   if (seq.castGesture) estMs += (+seq.castGesture.durationS || 0.6) * 1000;
>   inst._castBusyUntilMs = nowMs + Math.min(12000, estMs / CAST_SPEED);
> }
> ```

Cleared on: chain completion (`entities.js:6911` `inst._castBusyUntilMs = 0;`), fizzle /
cancel (`cancelCastSequence` `entities.js:6931`), and UseDone
(`clearCastBusy` `entities.js:6917-6920`, called from `index.html:7857-7859` on kind=14).

**Confirmed fact:** the busy window is a live, correct signal on the LOCAL player's
`EntityInstance` (`entityMap.get(localGuid)._castBusyUntilMs`). **Nothing in the combat
bar or spellbook reads it** — grep for `_castBusyUntilMs` outside `entities.js`/`index.html`
returns nothing. This is the mechanism gap for symptom A.

`?castStateMachine` is **default-ON** (`docs/url-flags.md:253`), and that row literally
names my follow-ons:

> `docs/url-flags.md:253` — "…(UI-grey of spell rows + peace-mode rejection feedback are
> noted follow-ons.)…"

### 1.2 Cast durations are DAT-grounded (busy window ≈ real windup times)

`data/spell-cast-sequence.json` (`{ _spell_count: 6266, …, sequences: {id: {…}} }`) — each
entry carries `windupGestures[].durationS`, `castGesture.durationS`, and `totalDurationS`.
Sampled live:

- Spell **57** (war Bolt, targeted): windup `MagicPowerUp10/4.4407897` + cast
  `MagicRecoilMissile/2.0416667`, `totalDurationS: 6.4825`.
- Spell **59**: `MagicPowerUp02/1.0795455` + cast, `totalDurationS: 3.1212`.
- Spell **1708** (Wedding Bliss, 3-windup self chain used for slideCast validation):
  `PowerUp08 3.676 + PowerUp10 4.441 + PowerUp10 4.441 + MagicSelfHeart 1.792`,
  `totalDurationS: 14.3497`.

**DAT ground truth (oracle):** parsing the SpellComponentTable directly —
```
echo '{"command":"chorizite-parse-dat-record","datPath":"/home/wbterminal/ac_base_dats/client_portal.dat","idHex":"0x0E00000F","typeName":"SpellComponentTable"}' | DOTNET_ROLL_FORWARD=LatestMajor dotnet …/WorldBuilder.Terminal.dll --stdin
```
returned component `time` bytes: `1.0795455` (Iron Scarab, gesture `0x10000070`
MagicPowerUp02), `2.0192308` (PowerUp04), `2.875` (PowerUp06), `3.6764705` (PowerUp08),
`4.4407897` (PowerUp10). These match the JSON `durationS` values **exactly** — so the
busy window is grounded in real DAT windup times, and any UI cooldown-sweep driven off
`totalDurationS` (÷ `CAST_SPEED`, default 2.0) will track the actual cast. Verified
finding, not hypothesis.

Practical effective busy windows (÷2.0): war bolts ≈ **1.5–3.3 s**; Wedding Bliss ≈ 7.2 s;
capped at 12 s raw / then ÷ speed.

### 1.3 Every local cast passes through a small set of chokepoints

- **World-click armed cast** (Magic stance): `scene3d/picking.js:602-719` → emits
  `spellCastInitiated` (`picking.js:654-664`) → `sessionHandle.castTargetedSpell(guid, spellId)`
  **directly** (NOT via api.js) → `em.playCastSequence(localGuid, spellId)` (`picking.js:695-700`).
- **Combat-bar rows / strip / Cast button / hotkeys**: all call `castSpellViaHandle(id, tgt)`
  (`plugins/combat-bar.js:734, 989, 999, 1013, 1020, 2128`) →
  `ui/ac_cast_spell.js:48-79` → `window.__pluginClient.player.castSpell` (`plugins/api.js:451-489`)
  → `playCastSequence(localGuid, spellId)` (`api.js:482-488`). **No `spellCastInitiated`
  emitted on this path.**
- **Hotbar armed-spell-on-item bridge**: `plugins/hotbar.js:644-670` → `castTargetedSpell`
  or `client.player.castSpell`.

So **`playCastSequence` (entities.js) is the one function every local cast reaches**, and
**api.js `castSpell` is the choke for everything except the picking world-click**. This
matters for where to emit lifecycle events without double-firing (§3.3).

`spellCastInitiated` is consumed today by `scene3d/spell_shape_preview.js:657`
(projectile-shape preview). Because the combat-bar/hotbar paths don't emit it, those casts
get **no** shape preview today either — adding the emit at the api.js choke fixes that as a
bonus (§3.3).

### 1.4 Server-side cast-rejection toasts ALREADY render (do not rebuild)

The wasm re-emits spell WeenieErrors with the **verbatim retail strings** and routes them
to the transient-chat toast surface:

> `src/lib.rs:20783-20804` `spellcast_error_text(code)` →
> `0x0400 "You don't have all the components for this spell."`,
> `0x0401 "You don't have enough Mana to cast this spell."`,
> `0x0402 "Your spell fizzled."`, `0x0407 "…cast outside."`, `0x0408 "…cast inside."`,
> `0x0498 "You have moved too far!"`, `0x0550 "Out of range!"`,
> `0x04EB "You can't do that while in the air!"`.

Emitted from two arms — `UseDone(error != None)` (`lib.rs:42402-42419`) and
`WeenieError` (`lib.rs:42486-42500`) — both pushing a `kind=2 ChatReceived` with
`u32_payload_2 = CHAT_CATEGORY_TRANSIENT (9)` plus a `kind=13 UseFailed` (for the fizzle
hook). On the JS side, `plugins/rejection_feedback.js:305-310` renders every transient
(category 9) chat line as a toast:

> `plugins/rejection_feedback.js:304-310`
> ```js
> const CHAT_CATEGORY_TRANSIENT = 9;
> function _onChatReceived(evt) {
>   const payload = evt?.detail ?? evt ?? {};
>   if (((payload.u32Payload2 >>> 0) || 0) !== CHAT_CATEGORY_TRANSIENT) return;
>   const msg = payload.stringPayload;
>   if (msg) _renderToast(msg);
> }
> ```

**Important subtlety (not a bug, but load-bearing):** `rejection_feedback.js`'s
`kind:13` handler is gated to `INVENTORY_RELATED_CODES` (`:234-246`) which does **NOT**
include the cast codes — so cast errors are **not** double-toasted through the kind:13
path; they render exactly once via the transient-chat path. Confirmed by reading both
handlers. → **Symptom E is already covered. My job is the *pre-send* / *client-side*
gaps, not the server-reject toast.**

### 1.5 Retail ground truth for the client-side pre-checks (decomp)

`ClientMagicSystem::CastSpell(spellID)` — full function read at `acclient.c:404671-404783`:

- **Component pre-check (client-side, BEFORE send):**
  `acclient.c:404710` `if ( !ComponentTracker::ComponentIsOwned(...) )` →
  `acclient.c:404719` message `L"You do not have all of this spell's components"`.
  (Note: this is the *client pre-check* string; the *server-reject* string 0x400 is the
  different `"You don't have all the components for this spell."` at `acclient.c:415990`.)
- **No-target pre-check (client-side):** requires `ACCWeenieObject::selectedID` +
  `ObjectCompatibleWithSpell` (`acclient.c:404756-404759`); failure →
  `acclient.c:404772` `L"You must select a suitable target before casting this spell"`.
- **No client-side MANA check.** Reading the whole function + `FreeHandsAndCastSpell`
  (`acclient.c:403775-403793`), the only client gate before the send is components +
  target. Mana (0x401) is **server-only**. → a client mana pre-check is a *non-retail
  improvement* and must be flag-gated + off by default.

Retail cast-busy is a UI **busy counter**, not a greyed bar:
`ClientUISystem::IncrementBusyCount` (`acclient.c:401885-401893`, bumps `m_cBusy`, calls
`UpdateCursorState` on 0→1) / `DecrementBusyCount` (`:401896-401903`, on 1→0), incremented
in `FreeHandsAndCastSpell` (`:403785/403791`) and decremented on `Handle_Item__UseDone`
(`:401924-401933`). Retail greyed the **cursor**, not a combat bar (retail had no combat
bar). So our grey/cooldown-sweep is a *holtburger* UX affordance — keep the AC look, but
it has no 1:1 retail pixel to match; the *timing* (busy window = cast duration) is the
authentic part.

Range formula (WS05 owns the math; I only present it):
`SpellExamineUI::DetermineSpellRange` (`acclient.c:228504-228581`):
`range = _base_range_mod * skillLevel + _base_range_constant`
(`:228574`), clamped to `RADAR_OUTDOOR_RADIUS = 75.0` (`:228576-228577`; const at
`:40037`); skill = spell's skill or `max(Creature/Item/Life/War Enchantment, Arcane Lore)`.
Server rejects out-of-range with 0x550 → renders as "Out of range!" today (§1.4).

### 1.6 Existing rejection/affordance surfaces I will reuse (not rebuild)

- `emitActionRejected(message)` → emits `clientActionRejected` on the plugin bus
  (`scene3d/picking.js:182-186`); rendered as a toast by
  `rejection_feedback.js:273-276` `_onClientActionRejected`. This is the exact surface for
  peace-mode / no-target messages.
- `.armed` row highlight CSS (`plugins/combat-bar.js:331-346`, purple) + `setArmed`
  (`:1939-1946`) + per-render armed class (`:2044-2046`) + strip-slot `.armed`
  (`:1173, :828`).
- The strip's 500 ms poll already reads stance and hides the strip when not in Magic
  (`plugins/combat-bar.js:1205-1233`, `STANCE_MAGIC = 0x49`) — the natural place to also
  compute the wrong-stance armed cue.
- Magic stance constant confirmed: `0x0049` is the only magic stance
  (`index.html:2855-2857`, `plugins/combat-bar.js:780, 1207`).

---

## 2. ROOT CAUSES

- **A (no cast-grey):** the busy-window state (`_castBusyUntilMs`) lives on the
  `EntityInstance` and is never surfaced to the UI layer. There is no cast-lifecycle event
  the combat bar can subscribe to (only `spellCastInitiated`, emitted on ONE path and
  carrying no duration/end signal). Mechanism proven by code trace §1.1 + §1.3.
- **B (armed-stance ambiguity):** `.armed` reflects *which* spell is armed but not the
  precondition (Magic stance) for it to fire. The precondition is only enforced
  *reactively* at click time (F11-5), so a player who armed a spell then left Magic stance
  sees a purple "armed" row that silently won't fire on click. Proven §1.6 + §1.3.
- **C (peace-mode silence):** `picking.js` dispatch is `if (magic) {cast} else if
  (melee||ranged) {target + F11-5 armed reject} else {useObject}`. The F11-5 armed-spell
  reject lives **inside the melee/ranged branch** (`picking.js:717-719`); the pure-PEACE
  branch (`:720+`) has no armed-spell guard, so an armed spell + peace-mode click falls to
  `useObject`/lifestone with no feedback. Proven by reading the full dispatch
  `picking.js:602-756`.
- **D (no-target UX):** `castCurrent()`/`fireSlot()` write a strip *name label*
  ("(no target selected)") instead of surfacing the retail string on the shared toast
  surface (`combat-bar.js:995-998, 1022-1024`). Proven §1.3.
- **F (no pre-check):** retail checked components client-side before the send
  (`acclient.c:404710-404719`) but we always send and rely on the server 0x400 reject.
  Not wrong, just less responsive; and mana was never a client gate (so a client mana
  pre-check is a deliberate non-retail add). Proven §1.5.

---

## 3. PATCH PLAN

Ordering note for integration (§6): all **HUD-only** hunks (A/B/C/D/G) are independent of
the wasm and of each other except that A/B/G share the combat-bar CSS block and the
combat-bar subscription site. F is opt-in and isolated behind a flag.

### 3.1 (A) Combat-bar + spellbook cast-busy grey / cooldown-sweep — HUD-only, no flag

Driven by the lifecycle events from §3.3 (G). Self-expiring CSS animation (safety net:
even if `spellCastResolved` is dropped, the sweep ends when the animation completes).

**CSS — insert after the `.armed` rules (`plugins/combat-bar.js:346`):**
```diff
     .hb-cb-spell.armed .hb-cb-spell-action {
       color: #fff;
     }
+    /* WS14 — cast-busy grey + cooldown sweep. HUD-only; no flag.
+       --hb-cast-ms is set inline from the spell's totalDurationS/CAST_SPEED. */
+    .hb-cb-spell.casting,
+    .hb-ss-slot.casting {
+      pointer-events: none;
+      filter: grayscale(0.7) brightness(0.7);
+      position: relative;
+      overflow: hidden;
+    }
+    .hb-cb-spell.casting::after,
+    .hb-ss-slot.casting::after {
+      content: "";
+      position: absolute; inset: 0;
+      transform-origin: left center;
+      background: rgba(160, 110, 255, 0.28);
+      animation: hb-cast-cooldown var(--hb-cast-ms, 2000ms) linear 1 forwards;
+      pointer-events: none;
+    }
+    @keyframes hb-cast-cooldown {
+      from { transform: scaleX(1); }
+      to   { transform: scaleX(0); }
+    }
```

**JS — subscribe in the combat-bar activate() event-wiring block. New helper +
subscription (added near `client.events.on("landblockChanged", …)` at
`plugins/combat-bar.js:613`):**
```diff
     client.events.on("landblockChanged", onZoneChange);
     client.events.on("playerStatsUpdated", onStatsUpdated);
+    // WS14 — cast-busy cooldown sweep. Grey the armed/selected spell rows +
+    // strip slots for the duration of the local player's cast. Self-expiring
+    // (the CSS animation ends on its own); resolved/rejected clear early.
+    const _castDurationMs = (spellId) => {
+      try {
+        const seq = window.__getCastSequence?.(spellId >>> 0)
+          ?? getCastSequenceSafe?.(spellId >>> 0);
+        const total = seq && Number.isFinite(+seq.totalDurationS) ? +seq.totalDurationS : 0;
+        const speed = Number(window.__castSpeed) || 2.0;
+        return total > 0 ? Math.max(400, Math.round((total * 1000) / speed)) : 2000;
+      } catch (_) { return 2000; }
+    };
+    const _setCasting = (on, ms) => {
+      const nodes = root.querySelectorAll(".hb-cb-spell, .hb-ss-slot");
+      for (const n of nodes) {
+        if (on) { n.style.setProperty("--hb-cast-ms", `${ms}ms`); n.classList.add("casting"); }
+        else { n.classList.remove("casting"); n.style.removeProperty("--hb-cast-ms"); }
+      }
+    };
+    client.events.on("spellCastInitiated", (e) => {
+      const d = e?.detail ?? e ?? {};
+      // Only react to the LOCAL caster's begin.
+      const lg = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
+      if (d.attackerGuid != null && (d.attackerGuid >>> 0) !== lg) return;
+      const ms = Number.isFinite(+d.estDurationMs) ? +d.estDurationMs : _castDurationMs(d.spellId);
+      _setCasting(true, ms);
+    });
+    client.events.on("spellCastResolved", () => _setCasting(false));
+    client.events.on("spellCastRejected", () => _setCasting(false));
```
> Uses `window.__getCastSequence` if the cast-sequence helper exposes a global; otherwise a
> local import of `getCastSequence` from `ui/ac_spell_cast_sequence.js`
> (`getCastSequenceSafe`). Integration wave: pick whichever is cleaner — a 1-line import at
> the top of `combat-bar.js` is fine. `window.__castSpeed` is read defensively (falls back
> to 2.0 = the `CAST_SPEED` default, `entities.js:896-910`).

The spellbook *panel* rows (the `hb-cb-spell` list) and the *strip* slots (`hb-ss-slot`)
are both under `root`, so one query greys both. **No default-behavior change**: absent the
events (e.g. plugin bus not wired) nothing greys — identical to today.

### 3.2 (B) Armed-state affordance — which spell, in which stance — HUD-only, no flag

**CSS — insert after the `.casting` rules:**
```diff
+    /* WS14 — armed but NOT in Magic stance: amber cue instead of the
+       ready-purple, so the player sees the spell won't fire until they
+       enter Magic mode. */
+    .hb-cb-spell.armed.wrong-stance {
+      background: rgba(200, 140, 40, 0.28);
+      border-color: rgba(220, 160, 60, 0.7);
+    }
+    .hb-cb-spell.armed.wrong-stance .hb-cb-spell-action { color: #ffd98a; }
```

**JS — in `renderRows()` where the armed class is applied
(`plugins/combat-bar.js:2044-2046`):**
```diff
       const isUntargeted = meta?.untargeted ?? true;
       if (state.armedSpellId === spellId && !isUntargeted) {
         row.classList.add("armed");
+        // WS14 — surface the firing precondition. A targeted armed spell only
+        // fires from Magic stance (picking.js dispatch); flag the mismatch.
+        let inMagic = false;
+        try { inMagic = window.__getCurrentStanceLow?.() === 0x0049; } catch (_) {}
+        if (!inMagic) {
+          row.classList.add("wrong-stance");
+          row.title = `${row.title} — enter Magic mode to cast`;
+        }
       }
```

**JS — keep the cue fresh on stance change.** The spellbook *panel* is not necessarily
open in Magic stance, so add a stance diff to the existing 500 ms poll (which today only
runs strip logic when `on`). Minimal: re-render the panel rows when magic-stance state
flips. In the poll at `plugins/combat-bar.js:1205-1216`:
```diff
     let lastVisible = false;
+    let lastPanelMagic = null;
     let lastArmed = -1;
     ...
     setInterval(() => {
       let on = false;
       try { on = window.__getCurrentStanceLow?.() === STANCE_MAGIC; } catch (_) {}
+      // WS14 — refresh the open spellbook PANEL's armed/wrong-stance cue on any
+      // magic-stance transition (the strip visibility handling below is separate).
+      if (on !== lastPanelMagic) {
+        lastPanelMagic = on;
+        try { window.__combatBarPanelRerender?.(); } catch (_) {}
+      }
```
> `window.__combatBarPanelRerender` is a tiny hook the panel's `activate()` should set to
> its `renderRows` (the panel and strip are separate closures; expose the panel's
> `renderRows` on window at panel init — one line — so the module-load poll can call it).
> If the integration wave prefers, fold this into the panel's own poll instead; the point
> is *the wrong-stance cue must update on stance change, not only on next open*.

Also strengthen the strip's Cast button hint when armed-but-wrong-stance (optional, same
idea) — `castBtn.title` is static today (`combat-bar.js:1108`); leaving it is fine since
the strip is hidden outside Magic stance anyway.

### 3.3 (G) Cast lifecycle events — names to coordinate with WS16 — HUD-only

**Proposed event vocabulary (for WS16 sign-off):**

| event | payload | emitted where | consumers |
|---|---|---|---|
| `spellCastInitiated` *(exists)* | `{spellId, targetGuid?, attackerGuid, school, shape, level, estDurationMs?}` | picking (exists) **+ add api.js choke** | `spell_shape_preview` (exists), combat-bar sweep (new) |
| `spellCastResolved` *(new)* | `{spellId, casterGuid}` | `entities.js` chain-complete + `index.html` kind=14 UseDone | combat-bar sweep-end (new) |
| `spellCastRejected` *(new)* | `{spellId?, casterGuid, reason, code?}` | `entities.js` cancelCastSequence + client pre-check sites + (optional) kind=13 cast codes | combat-bar sweep-end (new), telemetry |

**Add `spellCastInitiated` at the api.js choke** so combat-bar/hotbar casts also drive the
sweep (and gain shape preview). This does **not** double-fire the picking path (picking
casts via `sessionHandle` directly, never through `api.js` — §1.3).

`plugins/api.js:470-488`:
```diff
       if (resolvedTarget == null) {
         sessionHandle.castUntargetedSpell(spellId);
       } else {
         sessionHandle.castTargetedSpell(resolvedTarget, spellId);
       }
+      // WS14 — cast-lifecycle begin for non-picking paths (combat-bar / hotbar /
+      // research). Mirrors picking.js:654's payload so spell_shape_preview + the
+      // combat-bar cast-busy sweep get one uniform signal. estDurationMs lets the
+      // UI size its cooldown without importing the cast-sequence table.
+      try {
+        const bus = window.__pluginClient?.events;
+        if (bus?.emit) {
+          const lg = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
+          const seq = window.__getCastSequence?.(spellId >>> 0) ?? null;
+          const speed = Number(window.__castSpeed) || 2.0;
+          const estDurationMs = seq && Number.isFinite(+seq.totalDurationS)
+            ? Math.max(400, Math.round((+seq.totalDurationS * 1000) / speed)) : undefined;
+          bus.emit("spellCastInitiated", {
+            spellId: spellId >>> 0,
+            targetGuid: resolvedTarget == null ? null : (resolvedTarget >>> 0),
+            attackerGuid: lg,
+            school: seq?.school ?? null,
+            shape: seq?.shape ?? null,
+            level: seq?.level ?? null,
+            estDurationMs,
+          });
+        }
+      } catch (_) { /* events never block the cast */ }
       // F8-3 — play the local cast gesture ...
```

**Emit `spellCastResolved` on chain completion** — `entities.js:6909-6912` (after the busy
window clears). Guard: local guid only need not apply — casters other than local also
resolve, but the combat-bar consumer filters on `casterGuid === localGuid`, so emit for
all and let consumers filter (mirrors `spellCastInitiated`'s attackerGuid contract):
```diff
     // F8-4 — chain completed: clear the cast-busy window so the next cast
     // isn't gated.
     if (inst) inst._castBusyUntilMs = 0;
+    // WS14 — cast-lifecycle resolved (chain reached the cast gesture end).
+    try {
+      window.__pluginClient?.events?.emit?.("spellCastResolved", {
+        spellId: spellId >>> 0, casterGuid: g >>> 0,
+      });
+    } catch (_) {}
   }
```

**Emit `spellCastRejected` on cancel/fizzle** — `entities.js:6930-6938` (cancelCastSequence):
```diff
     inst._castSequenceToken = ((inst._castSequenceToken | 0) + 1) | 0;
     inst._castBusyUntilMs = 0; // F8-4 — cancelled cast frees the busy window
+    try {
+      window.__pluginClient?.events?.emit?.("spellCastRejected", {
+        casterGuid: guid >>> 0, reason: "cancelled",
+      });
+    } catch (_) {}
```
> The server-side WeenieError codes already have their toast (§1.4). Emitting
> `spellCastRejected` additionally from the `index.html` kind=13 cast-code hook
> (`index.html:7832`) is OPTIONAL and only worth it if a WS16/telemetry consumer wants a
> structured `code`. I recommend the minimal set above; note it for WS16.

**Also emit `spellCastResolved` on UseDone** so the sweep clears even for fast/instant
casts whose chain the server outran — `index.html:7857-7859`:
```diff
       if (em && lg && typeof em.clearCastBusy === "function") {
         em.clearCastBusy(lg);
       }
+      try {
+        window.__pluginClient?.events?.emit?.("spellCastResolved", { casterGuid: lg });
+      } catch (_) {}
```

### 3.4 (C) Peace-mode armed-spell rejection — HUD-only, no flag

`scene3d/picking.js` — the pure-PEACE branch (`:720`) currently falls straight into
`useObject`. Add the same armed-spell guard the melee/ranged branch has, so an armed
spell isn't silently eaten in peace mode:
```diff
       } else if (typeof sessionHandle.useObject === "function") {
+        // WS14 / F11-5 extension — an armed targeted spell in PEACE mode (no
+        // combat stance) also can't fire (only the Magic-stance branch casts).
+        // The melee/ranged branch already rejects this; peace mode fell through
+        // to useObject silently. Tell the player instead of eating the click.
+        const cbPeace = window.__combatBarState;
+        if (cbPeace && typeof cbPeace.armedSpellId === "number" && cbPeace.armedSpellId > 0) {
+          emitActionRejected("Enter magic mode to cast that spell.");
+          return;
+        }
```
> Placed at the top of the branch and `return`s so the world `useObject` (portal/door/
> vendor) isn't also fired on the same click. Matches the melee/ranged wording verbatim
> (`picking.js:718`) for consistency.

### 3.5 (D) No-target retail string on the shared toast surface — HUD-only, no flag

`plugins/combat-bar.js` `castCurrent()` (`:995-998`) and `fireSlot()` (`:1022-1024`)
currently write only a strip *name label*. Surface the retail string as a toast too. The
combat-bar `activate()` closure has `client` in scope; add a tiny local rejecter and use
it:
```diff
     const tgt =
       (window.liveScene3d?.entityManager?.getSelectedTarget?.() >>> 0) || 0;
     if (!tgt) {
       setName("(no target selected)");
+      // WS14 — retail client string (acclient.c:404772) on the shared toast surface.
+      try {
+        (window.__pluginClient ?? client)?.events?.emit?.("clientActionRejected", {
+          message: "You must select a suitable target before casting this spell.",
+        });
+      } catch (_) {}
       return;
     }
```
> Same insertion in `fireSlot()`'s armed-but-no-target branch is optional — that path
> intentionally *arms* for the click-to-cast flow and already sets an informative name
> ("… — armed, click a target"), which is arguably better than a rejection toast there.
> Recommend applying the toast only to `castCurrent()` (the End-key / Cast-button path,
> where no click-to-cast follow-up is implied). Coordinate the exact string casing with the
> other rejection strings if WS16 wants a shared constants module.

### 3.6 (F) Client-side pre-cast checks — FLAG-GATED, default-OFF

New flag **`?castPrecheck`** — values `off` (default) | `components` | `on`
(= components + mana). Gate lives in `ui/ac_cast_spell.js` (the single dispatcher all
non-picking casts use) and/or `plugins/api.js` so it covers every cast path uniformly.
When ON and a check fails, emit `clientActionRejected` with the **retail** string and
**do not send** — when OFF, behavior is byte-identical to today (send goes out, server
rejects, transient toast renders).

- **components** (retail-authentic, `acclient.c:404710-404719`): needs the spell's required
  component list (SpellFormula, 8 comps) → present via `sessionHandle.getSpellRecord(id)`
  (wasm SpellTable) or `data/spells-catalog.json`; map each component id →
  `data/spell-components.json` (name/type) → check `sessionHandle.playerInventory()` for
  ownership. Message: `"You do not have all of this spell's components"` (the retail
  *pre-check* string, distinct from the 0x400 server string).
- **mana** (NON-retail; explicit improvement): `meta.mana` (catalog base) vs
  `sessionHandle.playerStats().currentMana` (`src/lib.rs:24418` exposes `currentMana` /
  `:24412` `maxMana`). Message: `"You don't have enough Mana to cast this spell."`
  (matches the server 0x401 string). **Caveat:** Mana Conversion can reduce the actual
  cost server-side (`combat-bar.js:2103-2117` already notes this), so a naive
  `base > current` pre-check will produce *false rejections* for near-threshold casts —
  only reject when `base > current` by a safe margin, or better, gate mana behind `=on`
  only and document the imprecision. **Recommend shipping `components` first; `mana` is
  the aggressive opt-in.**

Sketch (in `castSpellViaHandle`, before dispatch — `ui/ac_cast_spell.js:52`):
```js
// WS14 — optional client pre-check (?castPrecheck). Retail checked components
// client-side before the send (acclient.c:404710); mana was server-only, so the
// mana arm is a deliberate non-retail add gated to =on.
const pc = _castPrecheckMode(); // "off" | "components" | "on"
if (pc !== "off") {
  const fail = _preCheckSpell(sid, pc); // returns a retail string or null
  if (fail) {
    window.__pluginClient?.events?.emit?.("clientActionRejected", { message: fail });
    window.__pluginClient?.events?.emit?.("spellCastRejected", { spellId: sid, reason: fail });
    return false; // do NOT send — send stays authoritative only when flag is off
  }
}
```

**url-flags.md row (draft):**
```
| `castPrecheck` | off | off | WS14: client-side pre-cast checks that suppress the send + toast the retail string instead of round-tripping the server reject. `components` = retail-authentic component-ownership pre-check (ClientMagicSystem::CastSpell acclient.c:404710-404719, "You do not have all of this spell's components"); `on` = components + a NON-retail mana pre-check (base cost vs currentMana; retail never gated mana client-side, and Mana Conversion can reduce cost so this may false-reject near threshold). `off` (default) = send is authoritative, server rejects, transient toast renders (unchanged). HUD-adjacent but changes send behavior → flagged. No wasm rebuild. | ui/ac_cast_spell.js + plugins/api.js | In Magic stance with a component-consuming war spell: (a) drop all Iron Scarabs, `?castPrecheck=components`, click-cast — expect the pre-check toast and NO wire send (check `__diag.wire.summary()`); (b) same with scarabs present — cast fires; (c) `?castPrecheck=on` at <base mana — expect mana toast; (d) `?castPrecheck=off` — send goes out, server 0x400/0x401 toast (unchanged) |
```

### 3.7 (out of lane, note only) out-of-range preview

WS05 owns the range math (`DetermineSpellRange`, §1.5). If they expose a
`spellRangeFor(spellId)` + `distanceToSelected()`, I can add a flag-gated pre-cast range
preview (dim the row / append "(out of range)" to the armed cue) behind
`?castRangePreview` (default-OFF). **Do not** hard-gate the send (retail didn't — §2.4 of
the foundation). Deferred to a WS05↔WS14 handshake; listed in §6 interactions.

---

## 4. TESTS

### 4.1 New pure-JS unit test — cast-busy duration mapping (`test_ws14_cast_cooldown.mjs`)

Mirrors the `test_ac_spell_cast_sequence.mjs` pattern (file:// import + synthetic table).
Locks the duration math the sweep relies on (busy window = `totalDurationS*1000 / CAST_SPEED`,
floored at 400 ms), independent of the DOM:

```js
// node test_ws14_cast_cooldown.mjs  (from apps/holtburger-web/)
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const { _loadSequenceSync, getCastSequence, _resetSequenceTable } =
  await import("file://" + resolvePath(__dirname, "ui/ac_spell_cast_sequence.js"));

// Pure duration helper mirrored from the combat-bar patch (keep in sync).
const castMs = (seq, speed = 2.0) =>
  seq && +seq.totalDurationS > 0 ? Math.max(400, Math.round((+seq.totalDurationS * 1000) / speed)) : 2000;

_resetSequenceTable();
_loadSequenceSync({
  "57":  { totalDurationS: 6.4825, windupGestures: [{durationS:4.4407897}], castGesture:{durationS:2.0416667} },
  "59":  { totalDurationS: 3.1212, windupGestures: [{durationS:1.0795455}], castGesture:{durationS:2.0416667} },
  "1708":{ totalDurationS: 14.3497, windupGestures: [], castGesture:{durationS:1.79} },
  "999": {}, // no duration → fallback
});
const cases = [
  ["57 @2.0", castMs(getCastSequence(57)),        3241],
  ["59 @2.0", castMs(getCastSequence(59)),        1561],
  ["1708 @2", castMs(getCastSequence(1708)),      7175],
  ["57 @1.0", castMs(getCastSequence(57), 1.0),   6483],
  ["missing", castMs(getCastSequence(999)),       2000],
];
let fail = 0;
for (const [n, got, want] of cases) {
  const ok = Math.abs(got - want) <= 1;
  if (!ok) { fail++; console.error(`FAIL ${n}: got ${got} want ${want}`); }
  else console.log(`ok   ${n}: ${got}ms`);
}
process.exit(fail ? 1 : 0);
```
(Expected values are the DAT-grounded §1.2 durations; the ±1 ms tolerance absorbs
rounding.) **Run:** `node test_ws14_cast_cooldown.mjs`.

### 4.2 New pure-JS unit test — event/rejection reducers (`test_ws14_ui_feedback.cjs`)

Because the combat-bar patches are DOM-coupled, factor the *pure* pieces into testable
helpers and unit them with a jsdom-free stub (mirrors `tests/*.cjs` style):
- `wrongStanceForArmed(armedSpellId, isUntargeted, stanceLow)` → boolean (true only when a
  targeted spell is armed and `stanceLow !== 0x0049`).
- `castSweepReducer(event)` — given `{type:'spellCastInitiated'|'spellCastResolved'|
  'spellCastRejected', attackerGuid, localGuid, estDurationMs}` → `{casting:boolean, ms}`.
Assert: initiated(local) → casting; initiated(remote) → ignored; resolved/rejected → clear;
missing estDurationMs → fallback 2000.

### 4.3 Existing tests to re-run (touch-adjacent)

- `node test_ac_spell_cast_sequence.mjs` — the schema shape (`totalDurationS`,
  `windupGestures`) my duration helper consumes.
- `node test_ac_spell_shape.mjs` — `spellCastInitiated` payload feeds `spell_shape_preview`;
  confirm the api.js-side emit uses the same `{school,shape,level}` shape.
- Any `tests/*.cjs` that import `plugins/api.js` or `ui/ac_cast_spell.js` (grep before the
  integration commit).

### 4.4 TODO-FOR-LAPTOP — headless validation recipe (no live wire capture on this box)

This box has no browser + no reachable ACE, so the behavioral pass is a laptop TODO.

1. **Serve:** `python3 external/holtburger/scripts/serve.py` → `:8765`.
2. **Bot URL (HUD-only, no cast flags needed — they're default-on/HUD skips flags):**
   `http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&account=X&password=X&autoSpawn=first&kickDance=1&agent=1`
3. Poll `window.__bootState==='in-world'`. Use a war-trained test char; arm a low-mana war
   bolt via the combat bar.
4. **A (cooldown grey):** in console, subscribe first:
   ```js
   const seen=[]; ['spellCastInitiated','spellCastResolved','spellCastRejected']
     .forEach(n=>window.__pluginClient.events.on(n,e=>seen.push([n,performance.now(),e])));
   ```
   then `window.__sessionHandle.castTargetedSpell(<mobGuid>, <warBoltId>)`. **Expect:**
   `spellCastInitiated` immediately, the armed row + strip slot gain `.casting` (grey +
   left-collapsing purple sweep), `spellCastResolved` at ≈ `totalDurationS/CAST_SPEED`
   later, `.casting` cleared. Repeat via the combat-bar row click (api.js path) — same
   result (this proves the api.js emit).
5. **B (armed-stance cue):** arm a targeted spell in Magic stance (row purple), then
   `window.__sessionHandle.setCombatMode(0)` / leave Magic — the open spellbook panel row
   should flip to amber `.wrong-stance` within ≤500 ms, tooltip "— enter Magic mode to
   cast". Re-enter Magic → back to purple.
6. **C (peace-mode reject):** in peace mode with a spell still armed, click a creature —
   expect the "Enter magic mode to cast that spell." toast and NO `useObject` fire
   (confirm no door/portal/vendor action).
7. **D (no-target):** in Magic stance, deselect target, press End (CombatCastCurrentSpell) /
   click the strip Cast button — expect the "You must select a suitable target…" toast.
8. **E (regression — server rejects still toast):** cast a spell you lack components for
   (or out of range) with `?castPrecheck` unset — expect the existing transient toast
   ("You don't have all the components…" / "Out of range!"). Confirms §1.4 is untouched.
9. **F (opt-in pre-check):** `&castPrecheck=components`, drop the required scarabs, cast —
   expect the pre-check toast and, in `__diag.wire.summary()`, **no** CastTargetedSpell
   send for that click; with `=off`, the send appears and the server toast renders.
10. **Acceptance bar (per foundation §5):** bare-default URL loads, spawns, casts, **0
    console errors**; flag-off (`?castPrecheck=off` and no HUD regression) byte-identical to
    baseline for the wire.

---

## 5. EYE-TEST QUEUE (1070 GPU box — batched, do not run here)

The HUD-only pieces are pixel-cosmetic, not GPU-timing, but queue a visual pass for feel:

| flag combo | expected visual |
|---|---|
| bare default, Magic stance, cast a 3-windup war spell | armed row + strip slot go grey with a smooth left-collapsing purple cooldown sweep lasting the cast; snaps back to armed-purple on completion; no flicker on rapid re-cast (busy-window ignores the spam per `entities.js:6766`) |
| bare default, arm targeted spell then drop to peace/melee | row turns amber (`wrong-stance`); re-entering Magic restores purple — no jitter during the 500 ms poll |
| bare default, fizzle a cast (`?castFizzle` on = default) | `.casting` clears immediately on the fizzle (via `spellCastRejected` from `cancelCastSequence`), no lingering grey, and the existing "Your spell fizzled." toast still shows |
| `?castPrecheck=components` vs `=off` | with scarabs missing: `=components` shows the pre-check toast + no send; `=off` shows the server toast after the round-trip — confirm the strings differ (pre-check vs 0x400) and both look at home in the AC toast style |

No new default-ON render surface → nothing gated on a 1070 flip. `?castPrecheck` stays
default-OFF regardless of the eye-test (it changes send behavior).

---

## 6. RISKS + cross-workstream interactions

**Files I would touch (for integration ordering):**
- `plugins/combat-bar.js` — CSS block (A/B), `activate()` event subscriptions (A/G),
  `renderRows()` armed/wrong-stance (B), poll re-render hook (B), `castCurrent()` no-target
  toast (D). **Highest-contention file** — WS08 (recast feel) and any combat-bar owner
  must serialize here.
- `scene3d/picking.js` — peace-mode armed reject (C). Small, localized.
- `plugins/api.js` — `spellCastInitiated` emit at the cast choke (G).
- `scene3d/entities.js` — `spellCastResolved`/`spellCastRejected` emits in
  `playCastSequence` completion + `cancelCastSequence` (G). Touches the cast chain — WS
  owning animation (S1/S2) also edits this function; coordinate the exact lines.
- `index.html` — `spellCastResolved` on kind=14 UseDone (G). The kind=13/14 block is
  shared with WS on server-echo handling — serialize.
- `ui/ac_cast_spell.js` — the `?castPrecheck` gate (F).
- `data/`-nothing (read-only); no wasm/Rust edits for the primary deliverable.
- New: `test_ws14_cast_cooldown.mjs`, `tests/test_ws14_ui_feedback.cjs`; `docs/url-flags.md`
  row for `castPrecheck`.

**Risks:**
- **R1 — event-name collision (WS16).** `spellCastResolved`/`spellCastRejected` are my
  proposals; WS16 owns the event vocabulary. If WS16 picks different names (e.g.
  `spellCastCompleted`/`spellCastFailed`), rename in the 4 emit sites + 3 combat-bar
  subscriptions. **Blocker until WS16 signs off the names.** Payload contract
  (`casterGuid` + local-filter, mirroring `spellCastInitiated.attackerGuid`) should also be
  ratified.
- **R2 — double-emit / shape-preview.** Adding `spellCastInitiated` at the api.js choke is
  safe *only because* picking casts don't route through api.js (§1.3). If a future refactor
  routes picking through `client.player.castSpell`, `spell_shape_preview` would fire twice.
  Guard/note for that refactor.
- **R3 — `window.__isBusy()` semantics (rejection_feedback.js:149-160).** It returns busy
  whenever `armedSpellId !== 0` — i.e. *armed*, not *casting*. That keeps radial-menu
  Drop/Give/Split disabled the entire time a spell is armed, which is arguably too broad now
  that I'm introducing a real cast-busy signal. **I did not change it** (radial-menu is out
  of lane), but a cleaner `__isBusy` could key on the cast-busy window / `spellCastInitiated`
  state instead. Flagged for whoever owns radial-menu; changing it affects that plugin.
- **R4 — mana pre-check false-rejections.** Mana Conversion reduces cost server-side
  (`combat-bar.js:2103-2117`); a strict `base > current` client gate can reject casts the
  server would allow. Mitigated by keeping mana behind `?castPrecheck=on` (opt-in) + the
  documented caveat. Components pre-check has no such imprecision (ownership is binary).
- **R5 — components data plumbing.** The per-spell required-component list comes from the
  SpellFormula (via `getSpellRecord`/catalog), *not* from `data/spell-components.json`
  (which is the 163-entry component *table*). If `getSpellRecord` returns null pre-bootstrap
  the pre-check must fail *open* (allow the send) — never block a cast on missing data.
- **R6 — WS05 range math dependency.** The out-of-range *preview* (§3.7) needs WS05's
  `spellRangeFor`/distance API; without it I only present the *server* 0x550 toast (already
  works). No hard dependency for the primary deliverable.
- **R7 — poll cadence for the wrong-stance cue.** The 500 ms poll means up to a half-second
  lag on the amber flip when the spellbook panel is open. Acceptable (matches combat-hud
  cadence); if a stance-change *event* exists post-WS-integration, subscribe to it instead
  of polling.
- **R8 — CSS `::after` overlay vs existing row content.** The `.casting::after` overlay sits
  above the row's text; `position:relative`/`overflow:hidden` are added on the row. Verify
  no clipping of the shape badge / tag on the 1070 pass (cosmetic only).

**Non-interactions (safe):** no wasm rebuild for A/B/C/D/G; `data/` read-only; the
server-reject toast path (§1.4) is untouched; flag-off arm for F is byte-identical (the
`clientActionRejected`/`spellCastInitiated` emits are additive and no-op without a bus).

---

## 7. Confidence

**High** on the mechanism findings (busy window, event chokepoints, existing toast path,
retail strings, DAT-grounded durations — all triple-checked across decomp / our code /
DAT oracle). **Medium** on the exact combat-bar patch line-anchors surviving to
integration (that file is high-churn and other workstreams edit it) and on the WS16 event
names (proposed, not ratified). The `?castPrecheck` components-data plumbing is the least
certain implementation detail (R5) and is intentionally the opt-in, fail-open piece.

## VERDICT (WS14-verify)

**Verdict: PARTIAL — apply:false as-written.** The *analysis* (§1 findings, §2 root causes,
§5 decomp ground truth) is excellent and almost entirely re-verified against live files
today (2026-07-12). But the **flagship deliverable — patch A (§3.1), the combat-bar/
spellbook cast-busy grey/sweep — does not work as written**: it throws a `ReferenceError`
and rests on a false DOM-architecture claim. Two supporting helpers reference
non-existent globals. The fixes are small and well-understood, so this is PARTIAL (fix →
apply), not REFUTED. Several other hunks (C, D, the entities.js/index.html G-emits, F) are
sound and apply cleanly.

### What I re-verified as CONFIRMED (opened every cited file/line live)

- **§1.1 busy window** — `entities.js:6764-6772` matches byte-for-byte; clear sites
  confirmed: chain-complete `6911` (`if (inst) inst._castBusyUntilMs = 0;`), `clearCastBusy`
  `6917-6920`, `cancelCastSequence` `6930-6931`. `rg _castBusyUntilMs` outside
  `entities.js`(6)/`index.html`(4) → only packet docs. **Nothing in the UI reads it.** ✓
- **§1.2 DAT-grounded durations** — `data/spell-cast-sequence.json`: spell 57 `total=6.4825`
  (PowerUp10/4.4407897 + cast/2.0416667), 59 `total=3.1212`, 1708 `total=14.3497`
  (PowerUp08 3.676 + PowerUp10 4.441 ×2 + MagicSelfHeart 1.79) — all match the packet. The
  test §4.1 expected values (3241/1561/7175/6483/2000) are internally consistent with these. ✓
- **§1.3 chokepoints** — `castSpellViaHandle` sites `734/989/999/1013/1020/2128` ✓;
  `api.js castSpell` 451-489 with local `playCastSequence` at 482-488 ✓; picking emits
  `spellCastInitiated` at `picking.js:654` ✓; `spell_shape_preview.js:657` consumes it ✓.
  **Nuance (noted, not fatal):** `castSpellViaHandle` (`ac_cast_spell.js:48`) *prefers*
  `client.player.castSpell` (the api.js choke) but has a **fallback that calls
  `window.__sessionHandle` directly**, bypassing api.js — so "api.js is the choke for
  everything except picking" holds only on the normal path (api ready). The fallback path
  emits neither `spellCastInitiated` nor `playCastSequence` today (pre-existing gap, not a
  WS14 regression). Picking casts via `sessionHandle` directly (`picking.js:674`), so the
  api.js emit does **not** double-fire — R2 is correct. ✓
- **§1.4 "already works, don't rebuild"** — SOLID. `spellcast_error_text` `lib.rs:20783`
  (0x0400/0x0401/0x0402/0x0498 strings verbatim), `CHAT_CATEGORY_TRANSIENT=9` `lib.rs:20452`,
  emit arms `~42403` (UseDone) + `~42486` (WeenieError) both set `u32_payload_2=TRANSIENT`;
  `rejection_feedback.js:305 _onChatReceived` gates on TRANSIENT → `_renderToast`;
  `INVENTORY_RELATED_CODES` `234-246` excludes cast codes (no double-toast). ✓
- **§1.5 retail decomp** — SOLID. `ClientMagicSystem::CastSpell` `acclient.c:404671`;
  component loop + `ComponentIsOwned` `404710`; **string `L"You do not have all of this
  spell's components"` verbatim at `404719`**; no-target path (`_bitfield&8` self →
  `InqTargetType` → `selectedID` + `ObjectCompatibleWithSpell`) with **string `L"You must
  select a suitable target before casting this spell"` verbatim at `404772`**;
  `DetermineSpellRange` `228504`; `IncrementBusyCount` symbol present. **No mana pre-check
  anywhere in the function** — confirms components=authentic / mana=non-retail. ✓
- **§1.6 surfaces** — `emitActionRejected` `picking.js:182` (already used at 718/847/1179,
  so in scope for patch C) ✓; `STANCE_MAGIC=0x49` `combat-bar.js:780`, `index.html:2856` ✓.
- **url-flags.md:253** `castStateMachine` row (default `on`) literally reads "(UI-grey of
  spell rows + peace-mode rejection feedback are noted follow-ons.)" ✓.
- **Patch anchors that apply cleanly:** C (peace-branch `picking.js:720`, `emitActionRejected`
  in scope, string matches melee branch verbatim) ✓; D (`castCurrent` no-target `995-998`,
  retail string correct, apply-only-to-castCurrent recommendation sound) ✓; G-emit
  `spellCastResolved` at chain-complete `entities.js:6909-6911` ✓; G-emit `spellCastRejected`
  in `cancelCastSequence` `6930-6931` ✓; G-emit `spellCastResolved` on `index.html` UseDone
  (context `em.clearCastBusy(lg)` matches; actual line ≈7855, cited 7857 — minor drift) ✓;
  api.js `spellCastInitiated` insertion at `api.js:470-475` (context matches) ✓; F precheck
  sketch (`ac_cast_spell.js:52` choke, retail strings correct, fail-open design) sound ✓.

### REQUIRED CORRECTIONS (must-fix before applying)

**MF1 — patch A (§3.1) is broken on THREE counts; this is the primary deliverable.**
  1. **`root` is out of scope at the anchor.** Line 613 (`client.events.on("landblockChanged"…)`)
     is inside `installAutoDisarmHooks()` → `tryHook()` (defs at `combat-bar.js:586/589`),
     **not** `activate()` (which is at `2222`). The `_setCasting` helper does
     `root.querySelectorAll(...)`, but the **only** `root` in the file is `857`, *local to
     `installSpellStrip()`*. `tryHook` has `client` in scope but **not `root`** → the
     `spellCastInitiated` handler throws `ReferenceError: root is not defined`. The sweep
     never runs.
  2. **The "both under `root`" premise is FALSE.** §3.1 states "The spellbook panel rows
     (`hb-cb-spell`) and the strip slots (`hb-ss-slot`) are both under `root`, so one query
     greys both." They are not. `root` (=`STRIP_ID`) contains **only** `.hb-ss-slot`; the
     panel `.hb-cb-spell` rows are appended to `list` under `bodyEl` in `renderSpellPicker`/
     `renderRows` (`combat-bar.js:1948+`) — a **separate DOM subtree**. A single
     `root.querySelectorAll(".hb-cb-spell, .hb-ss-slot")` would match the strip slots only
     (zero panel rows). This is exactly the "hallucinated architecture premise" the charter
     warns about.
  3. **FIX:** (a) query the *document*, not a `root`: `document.querySelectorAll(
     ".hb-cb-spell, .hb-ss-slot")` (both live in the document DOM regardless of closure);
     (b) place the subscription+helper in a scope that actually has `client` and survives —
     either a new module-level `install*()` (matching the `installSpellStrip`/
     `installAutoDisarmHooks` pattern) or the main `activate()` (`2222`, which sets
     `const client = ctx?.client ?? window.__pluginClient`); **do not** anchor at 613 with a
     `root` reference. Also correct the §1/§3.1 prose ("both under root").

**MF2 — patch A + G duration resolution references a non-existent global and a wrong export
  name.** Both `_castDurationMs` (A) and the api.js emit (G) call
  `window.__getCastSequence?.(spellId)` — **that global does not exist** (`rg __getCastSequence`
  → empty). Patch A's fallback `?? getCastSequenceSafe?.(...)` names **`getCastSequenceSafe`,
  which is not an export** of `ui/ac_spell_cast_sequence.js` (real exports:
  `getCastSequence`@237, `_loadSequenceSync`@151, `_resetSequenceTable`@168,
  `isCastSequenceLoaded`@181). **As written: patch A always hits `?? 2000` (sweep is a flat
  2000 ms, discarding the DAT-grounded durations that are §1.2's entire point); patch G
  always emits `estDurationMs: undefined`.** The packet *flags* the combat-bar side ("a
  1-line import … is fine") but ships the broken literal; the api.js side has no fallback at
  all. **FIX:** add `import { getCastSequence } from "../ui/ac_spell_cast_sequence.js";` to
  `combat-bar.js` (and `import { getCastSequence } from "./…/ui/ac_spell_cast_sequence.js";`
  or reuse the existing ac_cast_spell import in `api.js`), and call `getCastSequence(...)`
  directly.

**MF4 — patch B stance-refresh depends on `window.__combatBarPanelRerender`, which is never
  created.** The poll patch calls `window.__combatBarPanelRerender?.()` (safe no-op via
  optional-chaining) but the delivered patch **omits the one line that defines the hook**, so
  the amber `wrong-stance` cue will **not** refresh on stance change while the panel is open —
  the precise thing patch B's poll hunk exists to fix. The packet flags it in prose ("expose
  the panel's `renderRows` on window … one line") but the hunk set is incomplete. **FIX:** add
  the hook assignment (e.g. `window.__combatBarPanelRerender = renderRows;`) inside
  `renderSpellPicker`/`activate` where `renderRows` is defined.

### MINOR (fix opportunistically; not blockers)

- **MN1 — patch B tooltip is clobbered.** `row.title = \`${row.title} — enter Magic mode to
  cast\`` is inserted at ~2046, but `renderRows` **re-assigns `row.title` at 2120/2122**
  (`\`${baseName}${manaSuffix}${casterSuffix}\``), overwriting the hint. The `.wrong-stance`
  **class survives** (className set once at 2040; only `.title` is clobbered), so the amber
  visual cue still works — **only the hover tooltip text is lost**. FIX: append the hint after
  2122, or fold it into the baseName template.
- **MN3 — `window.__castSpeed` does not exist** (`rg` → empty), so `Number(window.__castSpeed)
  || 2.0` always yields 2.0. Correct at the default, but a non-default `?castSpeed` run (a real
  url-flag) leaves the sweep mistimed. FIX: export `__castSpeed` from the `CAST_SPEED` site
  (`entities.js:896-910`) or document the default-only assumption.
- **MN4 — patch C uses `window.__combatBarState` directly** instead of the local `cb`
  already resolved in the same dispatch; both work (`__combatBarState` is set at
  `combat-bar.js:111` and `spellbook.js:343`). Cosmetic consistency only.
- **Scope guard:** the `spellCastResolved/Rejected` event *names* remain WS16's to ratify
  (packet R1) — the four emit sites are correct wherever the names land.

### Net

The research is trustworthy (no stale/hallucinated *cites* — all line numbers verified
within small drift; the one false statement is the §3.1 "both under root" *architecture*
claim, not a cite). Symptoms A/B/C/D/E/F/G and their root-cause mechanisms are correctly
diagnosed. But **the #1 patch (A) will not render a single grey pixel as written** (MF1
ReferenceError), and even after fixing the scope it would show a flat 2 s sweep, not the
DAT-tracked one it advertises (MF2), and patch B's cue won't refresh (MF4). Apply the sound
hunks (C, D, G-emits, F, the CSS) but **do not apply patch A/B until MF1/MF2/MF4 are
corrected.** All fixes are small and mechanical.

```json
{"workstream":"WS14","title":"Cast-state UI feedback (combat bar / spellbook / toasts)","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS14-ui-feedback.md","confidence":"high","keyFindings":["Cast-busy window (_castBusyUntilMs, entities.js:6764-6772) is a live per-entity signal but NOTHING in the combat-bar/spellbook renders it — the grey/cooldown affordance is simply unbuilt (castStateMachine url-flags row names it as the follow-on)","Server-side cast-reject toasts (fizzle/mana/components/range/indoor/air) ALREADY render via the transient-chat path (lib.rs:20783-20804 spellcast_error_text -> kind=2 category 9 -> rejection_feedback.js:305 _onChatReceived); do NOT rebuild — my gaps are pre-send/client-side","Cast durations are DAT-grounded: JSON windup durationS match SpellComponentTable time bytes exactly via the WB.Terminal oracle (PowerUp02=1.0795455, PowerUp10=4.4407897); busy window = totalDurationS/CAST_SPEED tracks the real cast","Retail checked COMPONENTS client-side before send (acclient.c:404710-404719 'You do not have all of this spell's components') but NEVER mana (server-only) — so a components pre-check is authentic, a mana pre-check is a non-retail add; both must be flag-gated","Peace-mode armed-spell click is a silent no-op: F11-5 reject (picking.js:717-719) lives inside the melee/ranged branch only; the pure-PEACE branch falls through to useObject with no feedback","Only spellCastInitiated exists and only on the picking path; combat-bar/hotbar casts (api.js choke) emit nothing, so they lack shape-preview AND can't drive a cooldown UI — need spellCastResolved/spellCastRejected (names -> WS16)"],"filesToChange":["plugins/combat-bar.js","scene3d/picking.js","plugins/api.js","scene3d/entities.js","index.html","ui/ac_cast_spell.js","docs/url-flags.md","test_ws14_cast_cooldown.mjs","tests/test_ws14_ui_feedback.cjs"],"needsWasmRebuild":false,"newFlags":["castPrecheck"],"risks":["Event names spellCastResolved/spellCastRejected must be ratified by WS16 before wiring (blocker on naming only)","combat-bar.js is high-churn and edited by other combat workstreams — serialize the CSS/subscription/renderRows hunks","spellCastInitiated added at api.js choke is safe only because picking casts bypass api.js; a future refactor routing picking through client.player.castSpell would double-fire spell_shape_preview","Mana pre-check can false-reject due to server-side Mana Conversion cost reduction — keep mana behind ?castPrecheck=on and fail-open on missing data","window.__isBusy() keys on armedSpellId!=0 (armed, not casting) — arguably too broad now; left unchanged (radial-menu out of lane) but flagged","Out-of-range PREVIEW depends on WS05 exposing range/distance math; without it only the existing server 0x550 toast is presented (no hard dependency)"]}
```

## INTEGRATION DISPOSITION (2026-07-12)

Verdict was PARTIAL / apply:false-as-written. Integrated the endorsed subset with
the verdict's required corrections applied (MF1/MF2/MF4 + MN1/MN3/MN4). No `.rs`
touched → no wasm rebuild. Re-verified every cite live (files had moved under the
packet's line numbers — re-anchored by symbol).

APPLIED:
- **A (cast-busy grey/sweep)** — new module-level `installCastBusySweep()` in
  `plugins/combat-bar.js` (mirrors `installSpellStrip`), injects its own `<style>`
  at module-load, subscribes via a `tryHook` poll. **MF1 fix:** queries
  `document.querySelectorAll(".hb-cb-spell, .hb-ss-slot")` (the panel rows and the
  strip slots are separate DOM subtrees — the packet's "both under `root`" premise
  was false; no `root` reference). **MF2 fix:** duration via imported
  `getCastSequence` + `castCooldownMs` (the broken `window.__getCastSequence` /
  `getCastSequenceSafe` are gone). **MN3 fix:** `window.__castSpeed` now exported
  from the `CAST_SPEED` site in `entities.js`.
- **B (armed wrong-stance cue)** — amber `.wrong-stance` in `renderRows` via the
  pure `wrongStanceForArmed`. **MF4 fix:** `window.__combatBarPanelRerender` is now
  actually defined (= `renderRows`) and nulled on dispose; the strip's 500 ms poll
  refreshes the open panel on any Magic-stance transition. **MN1 fix:** the tooltip
  hint is folded into the later `row.title` assignment (not clobbered).
- **C (peace-mode armed reject)** — `scene3d/picking.js`, uses the local `cb` (MN4).
- **D (no-target retail toast)** — `castCurrent()` only (fireSlot keeps its name hint).
- **G (cast lifecycle)** — `spellCastInitiated` at the api.js choke (imported
  `getCastSequence`); `spellCastResolved` at chain-complete + on kind=14 UseDone;
  `spellCastRejected` in `cancelCastSequence`. Event *names* used as proposed —
  WS16 consumes only `spellCastInitiated`, so no collision; a future WS16 rename is
  a mechanical 4-emit / 3-subscribe swap (R1).
- **F (`?castPrecheck`)** — new `ui/ac_cast_precheck.js` (strict `=== "components"` /
  `=== "on"` opt-in; **fail-open** on any missing datum), gated in
  `castSpellViaHandle`. Components = retail-authentic; mana = non-retail (`=on` only,
  documented over-reject caveat). `docs/url-flags.md` row added.

Decision logic factored into pure `ui/ac_cast_ui_logic.js` (used by combat-bar AND
the tests, not a mirror). **Tests:** `tests/test_ws14_cast_cooldown.test.mjs` (6/6),
`tests/test_ws14_ui_feedback.test.cjs` (26/26); adjacent `test_ac_spell_cast_sequence.mjs`
(39/39) + `test_ac_spell_shape.mjs` (30/30) still green.

DEFERRED (not endorsed / out of lane): §3.7 out-of-range preview (`castRangePreview`,
WS05 handshake); the OPTIONAL kind=13 structured-`code` `spellCastRejected` emit
(packet recommended the minimal set); R3 `__isBusy()` semantics (radial-menu owner).
