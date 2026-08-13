// =============================================================================
// CHORIZITE EVENT-TAXONOMY COVERAGE (audit 2026-05-19, Task 2A — HEAD 9c35cf0)
// =============================================================================
// Source: external/chorizite/ACPlugin/API/*EventArgs.cs (11 *EventArgs classes)
//         + Game.cs / World.cs / WorldObjects/Character.cs / PatchProgress.cs
//         event registrations (18 total event surfaces — some use EventArgs.Empty).
// Target: this file's `client.events` bus + ClientEvent kinds drained by
//         index.html::drainEvents (apps/holtburger-web/src/lib.rs ClientEvent).
//
// Status:
//   IMPLEMENTED — bus-emitted with equivalent payload (notes if fields differ)
//   PARTIAL     — fires but missing semantic fields (e.g. no old-value, JSON-only)
//   MISSING     — not wired on bus or in poll_events()
//   N/A         — not applicable to the browser session model
//
// | # | Chorizite (Source)                  | EventArgs Payload                              | api.js / kind=N           | Status      | Note                                                                 |
// |---|-------------------------------------|------------------------------------------------|---------------------------|-------------|----------------------------------------------------------------------|
// | 1 | World.OnWeenieCreated               | WorldObject Object                             | EntityUpdate kind=1 SPAWN + bus "objectCreated" | IMPLEMENTED | PR-2 2026-05-27: bus event now fires via plugins/world-state.js     |
// | 2 | World.OnWeenieReleased              | WorldObject Object                             | EntityUpdate kind=2 REMOVE+ bus "objectReleased" | IMPLEMENTED | PR-2 2026-05-27: bus event + recursive child release ported          |
// | 3 | World.OnContainerOpened             | Container Container                            | kind=12 vendorOpened + kind=21 containerOpened | IMPLEMENTED | PR-2 2026-05-27: child-wait gate per World.cs:212-249 now correct    |
// | 4 | World.OnContainerClosed             | Container Container                            | kind=31 + bus "containerClosed" | IMPLEMENTED | PR-2 2026-05-27: NEW wasm kind=31 ContainerClosed + JS dispatcher    |
// | 5 | World.OnSelectionChanged            | WorldObject? Object                            | "selectionChanged" bus    | IMPLEMENTED | Q1b (2026-05-26): scene3d/picking.js emits {guid, prevGuid} on every change |
// | 6 | Game.OnStateChanged                 | ClientState NewState, OldState                 | kinds {1,4,5,6,7} partial | PARTIAL     | no single "stateChanged" with old→new; spread across kinds (TODO)    |
// | 7 | Game.OnCharactersChanged            | EventArgs.Empty (re-fire roster)               | kind=0 CharacterListRecv  | IMPLEMENTED | renderCharacterList drains kind=0 each fire                          |
// | 8 | Game.OnWorldInfo                    | EventArgs.Empty (ServerName/Max/Cur)           | —                         | MISSING     | Login_WorldInfo parsed but not surfaced as ClientEvent (TODO)        |
// | 9 | Character.OnVitaeChanged            | float Vitae, OldVitae                          | kind=8 "playerStatsUpdated"| PARTIAL    | coalesced; no vitae-specific channel + no oldVitae delta (TODO)      |
// |10 | Character.OnVitalChanged            | VitalId Type, int Value, int OldValue          | kinds 42/43/44 "vitalChangedHealth/Stamina/Mana" | IMPLEMENTED | Wave 3.C (2026-05-28): per-vital granular events emit current+buffedMax. Wave 6 polish (2026-05-28) added oldValue: holtburger-world handlers snapshot pre-mutation, wasm threads through f32_payload, drainEvents surfaces as `oldValue` on the bus payload. Coalesced kind=8 still fires alongside for non-HUD subs. |
// |11 | Character.OnEnchantmentChanged      | AddRemove Type, LayeredSpellId, Enchantment    | kind=8 + bus enchantmentAdded/Removed | PARTIAL | PR-2 2026-05-27: JS-side snapshot diff emits Added/Removed delta events; wire-level wrapper events (target_guid + sequence) deferred to Wave E for remote-creature buffs |
// |12 | Character.OnSharedCooldownChanged   | AddRemove Type, SharedCooldown                 | —                         | MISSING     | shared-cooldown bus not wired (TODO)                                 |
// |13 | Character.OnPortalSpaceEntered      | EventArgs.Empty                                | —                         | MISSING     | portal-space (loading screen) entered/exited not exposed (TODO)      |
// |14 | Character.OnPortalSpaceExited       | EventArgs.Empty                                | kind=7 ENTERED_WORLD (~)  | PARTIAL     | EnteredWorld covers the post-portal arrival; entry edge missing (TODO)|
// |15 | Character.OnDeath                   | string Text, uint KillerId                     | kind=29 "death"           | IMPLEMENTED | Q1a (2026-05-26): emits {victimGuid, killerGuid, message} on PlayerKilled; combat-hud overlays self-deaths |
// |16 | PatchProgress.OnProgressChanged     | EventArgs.Empty (aggregated)                   | —                         | N/A         | retail-client patch flow; browser ships pre-built DATs               |
// |17 | PatchProgress.OnConnectProgress     | EventArgs.Empty                                | —                         | N/A         | retail-client connect handshake; browser uses WebSocket/UDP-relay    |
// |18 | PatchProgress.OnPatchProgress       | EventArgs.Empty                                | —                         | N/A         | retail-client DAT patcher; browser bake pipeline owns content        |
//
// ---- ClientEvent kinds with no Chorizite analogue (browser-specific) ----
// kind=2  ChatReceived           — bus-relayed via chat appender (DOM only, no events.on hook); maps to ACE wire ChatMessage variants
// kind=11 InventoryUpdated       — coalesced inventory-refresh signal; Chorizite uses per-item Item_* events instead
// kind=13 UseFailed              — WeenieError; would be Character.OnUseFailed (not in current Chorizite surface)
// kind=14 UseDone                — server-ack success; ditto
// kind=15 DoorStateChanged       — door swing for 3D scene; would be a Door.OnStateChanged (typed-class event not in Chorizite)
// kind=16 SoundTriggered         — ambient/triggered audio; Chorizite has no audio event surface
// kind=17 EntityVisibilityChanged— PhysicsState draw-gate; would be WorldObject.OnVisibilityChanged
// kind=18 EntityAirborneChanged  — jump arc visual; would be Character.OnAirborneChanged (not in Chorizite)
// kind=19 CombatEvent            — emits "damageDealt"/"damageTaken"/"evadedTarget"/"evadedAttacker"/"attackDone" on bus; ACE-side semantic event family
// kind=29 Death                  — emits "death" {victimGuid, killerGuid, message}; combat-hud subscribes for self-death overlay
//
// ---- Bus-emitted events (canonical list — subscribe via client.events.on) ----
//   "playerStatsUpdated"   (kind=8)         — vitals/skills/attrs refreshed (coalesced)
//   "vitalChangedHealth"   (kind=42)        — {current, buffedMax, oldValue?} (Wave 3.C 2026-05-28; oldValue added Wave 6 polish 2026-05-28)
//   "vitalChangedStamina"  (kind=43)        — {current, buffedMax, oldValue?} (Wave 3.C; oldValue Wave 6 polish)
//   "vitalChangedMana"     (kind=44)        — {current, buffedMax, oldValue?} (Wave 3.C; oldValue Wave 6 polish)
//   "landblockChanged"     (zone-cross)     — {prevLb, lbId} from local player move
//   "vendorOpened"         (kind=12)        — {stringPayload, u32Payload, u32Payload2}
//   "damageDealt"          (kind=19 JSON)   — {defenderName, damage, damageType, ...}
//   "damageTaken"          (kind=19 JSON)   — {attackerName, damage, damageType, ...}
//   "evadedTarget"         (kind=19 JSON)   — {defenderName} (you missed)
//   "evadedAttacker"       (kind=19 JSON)   — {attackerName} (they missed)
//   "attackDone"           (kind=19 JSON)   — {error}        ("None" on success)
//   "death"                (kind=29)        — {victimGuid, killerGuid, message} (Q1a)
//   "selectionChanged"     (client-only)    — {guid, prevGuid} emitted from scene3d/picking.js on every target change (Q1b)
//   "houseStatusUpdated"   (client-only)    — {} emitted from plugins/house-panel.js when its diffed snapshot signature changes
//                                              (rec #182). Dedicated event so house-aware subscribers don't have to diff
//                                              the wasm-side house snapshots themselves on every playerStatsUpdated tick.
//
// Counts post-PR-2 (2026-05-27): 6 IMPLEMENTED, 6 PARTIAL, 3 MISSING, 3 N/A — total 18.
// Pre-PR-2 baseline: 3 IMPLEMENTED, 6 PARTIAL, 6 MISSING, 3 N/A.
// Remaining backlog (in order): #6 StateChanged (unified), #8 WorldInfo,
// #12 SharedCooldown, #13 PortalSpaceEntered. See CHORIZITE_PORTING_PLAN.md §3.4.
//
// ---- Window-global helpers (rec #95, 2026-06-16) ----
//   window.__getCurrentStanceLow()   — () => uint, the local player's
//     low-32 MotionStance bits. Set up in index.html (around L2652) as
//     part of the recv-loop's motion-state mirror; cited here for the
//     audit trail. Read by combat-bar, spell-research-panel,
//     scene3d/picking.js, the k1 / probe headless harnesses.
//   window.__getComponentTracker()   — () => Record<compId, count>,
//     synchronous summary of how many of each spell component (per
//     spell-components.json id) the player carries in their inventory.
//     Catalog loads lazily on first call; pre-load callers see {}
//     until the JSON resolves and the next call returns counts.
// =============================================================================

// =============================================================================
// Chorizite/ACPlugin enum + EventArgs factory ports (ACPlugin PR-1, 2026-05-27)
// =============================================================================
// Direct 1:1 ports of:
//   - external/chorizite/ACPlugin/API/ClientState.cs           (8-state enum)
//   - external/chorizite/ACPlugin/API/AddRemoveEventType.cs    (2-member enum)
//   - external/chorizite/ACPlugin/API/*EventArgs.cs            (11 DTOs)
//
// Per ACPlugin §9 first-PR sketch — the 11 EventArgs shapes are exposed
// as plain JS object factories. Their field names match the upstream C#
// property casing (camelCase preferred per JS convention, but each
// factory documents the C# property it maps to).
//
// "Eatable" event semantics: WorldObjectSelected derives from C#'s
// EatableEventArgs (per Chorizite.Common/EatableEventArgs.cs). We port
// the .eaten convention — when a handler sets `event.eaten = true`, the
// dispatcher MUST skip remaining handlers and report eaten=true to the
// upstream system event (mirrors the retail behavior the combat bar
// uses to swallow LMB clicks before the pick-target handler sees them).
// See handoff §5.5 item 6. Not all events make sense as eatable — only
// input-derived events (selectionChanged is the canonical example).

/**
 * Client lifecycle state. Direct port of `ClientState.cs:5-45`.
 * Numeric values match the upstream C# enum exactly.
 */
// ─── Rec #95 — componentTracker helper ───────────────────────────
// Synchronous summary of carried spell components keyed by id from
// spell-components.json. First call kicks off a fire-and-forget
// fetch of the catalog (cached `force-cache`); until it resolves
// `getComponentTracker` returns `{}`. Once the catalog lands, calls
// walk `window.__sessionHandle.playerInventory()`, match item.name
// against component records, and sum stackSize per matching id.
//
// The name match mirrors plugins/spellbook.js#refreshComponentPouch
// (rec #46) so a single canonical mapping owns the heuristic. Plugins
// that need component data should prefer this helper over rolling
// their own inventory scan.
import { selfTargetGuidFor } from "../ui/ac_cast_spell.js";
import { noteCombatModeRequest } from "../ui/ac_combat_mode_intent.js";
import { getCastSequence } from "../ui/ac_spell_cast_sequence.js";
// P6.1 (2026-07-27): the two retail chat hooks (eatable buses backed by
// the loader's createEatableBus — its first real consumers). Exposed as
// client.chat.hooks below; index.html emits into them at the two retail
// plumbing points (kind=2 drain / chat-form submit).
import { getInputFunnel, inputFunnelV2On } from "../ui/input-funnel.js";
import { chatHooks } from "./chat-hooks.js";
// P6.1 promotion (2026-07-28): the ONE facade substrate. `createClient`
// constructs exactly one RynthWebHost and expresses every namespace below
// as a delegate over its capability table — one capability resolution, one
// degrade-not-throw rule, one owner of the raw SessionHandle. See
// plugins/webhost.js for why the implementation lives under rynth/.
import { RynthWebHost } from "./webhost.js";

/**
 * P6.1 — version of the plugin-facing client facade. Semver; additive
 * changes bump minor, capability renames/re-semantics or snapshot-shape
 * changes bump major. Plugins declare a `clientApi` range in their
 * manifest (schemas/plugin-manifest.json).
 */
export const API_VERSION = "1.0.0";

let _componentCatalog = null;
let _componentCatalogPromise = null;
let _componentNameToId = null;

function _ensureComponentCatalog() {
  if (_componentCatalog) return _componentCatalog;
  if (_componentCatalogPromise) return null;
  if (typeof fetch !== "function") return null;
  _componentCatalogPromise = fetch("./data/spell-components.json", { cache: "force-cache" })
    .then((r) => r.json())
    .then((j) => {
      _componentCatalog = j?.components || {};
      _componentNameToId = new Map();
      for (const [id, rec] of Object.entries(_componentCatalog)) {
        if (rec && typeof rec.name === "string") {
          _componentNameToId.set(rec.name, id);
        }
      }
      return _componentCatalog;
    })
    .catch((e) => {
      console.warn("[api] component-catalog load failed:", e);
      _componentCatalog = {};
      _componentNameToId = new Map();
      return _componentCatalog;
    });
  return null;
}

/**
 * Returns a `{[componentId: string]: count: number}` summary of the
 * local player's spell-component inventory. Empty object pre-catalog
 * load (catalog is fetched lazily on first call); subsequent calls
 * after the JSON lands return populated counts. The componentId keys
 * are the string ids from spell-components.json (e.g. `"1"` for Lead
 * Scarab); a `Comp_<id>` value or numeric form is the same.
 *
 * @returns {Record<string, number>}
 */
export function getComponentTracker() {
  const catalog = _componentCatalog ?? _ensureComponentCatalog();
  if (!catalog || !_componentNameToId) return {};
  const out = {};
  try {
    const handle = (typeof window !== "undefined") ? window.__sessionHandle : null;
    const inv = (typeof handle?.playerInventory === "function") ? handle.playerInventory() : null;
    if (!inv) return out;
    const items = Array.isArray(inv) ? inv : Array.from(inv);
    for (const it of items) {
      if (typeof it?.name !== "string") continue;
      const id = _componentNameToId.get(it.name);
      if (!id) continue;
      const stack = (it.stackSize >>> 0) || 1;
      out[id] = (out[id] || 0) + stack;
    }
  } catch (_) {}
  return out;
}

if (typeof window !== "undefined") {
  window.__getComponentTracker = getComponentTracker;
}

export const ClientState = Object.freeze({
  Initial: 0,            // ClientState.cs:9
  GameStarted: 1,        // ClientState.cs:14 — "Client is done initializing"
  CharacterSelect: 2,    // ClientState.cs:19
  CreatingCharacter: 3,  // ClientState.cs:24
  EnteringGame: 4,       // ClientState.cs:29
  InGame: 5,             // ClientState.cs:34 — "Fully logged in to the game"
  LoggingOut: 6,         // ClientState.cs:39
  Disconnected: 7,       // ClientState.cs:44
});

/**
 * Add-or-remove discriminator for enchantment/cooldown events. Direct
 * port of `AddRemoveEventType.cs:2-5`.
 */
export const AddRemoveEventType = Object.freeze({
  Added: 0,    // AddRemoveEventType.cs:3
  Removed: 1,  // AddRemoveEventType.cs:4
});

/**
 * Base shape for "eatable" events (mirror of Chorizite.Common/
 * EatableEventArgs.cs). Handlers can set `.eaten = true` to swallow
 * the event and prevent downstream propagation. See handoff §3 last
 * quote and §5.5 item 6.
 *
 * Per the Chorizite convention, only INPUT-derived events should be
 * eatable (mouse/key/selection). Skill/vital/death events are
 * broadcast-only and should not derive from this shape.
 */
function makeEatable(payload) {
  return {
    ...payload,
    eaten: false,
    /** Convenience method — equivalent to `event.eaten = true`. */
    eat() { this.eaten = true; },
  };
}

// ─── 11 EventArgs factories (per ACPlugin/API/*EventArgs.cs) ───

/**
 * Port of `ObjectCreatedEventArgs.cs:7-19`.
 * Fired by `World.OnWeenieCreated` (`World.cs:41-44`) when a new
 * WorldObject enters the cache. Payload is the typed-class instance.
 * @param {object} wobject WorldObject (or subclass) instance
 */
export function makeObjectCreated(wobject) {
  return { object: wobject };
}

/**
 * Port of `ObjectReleasedEventArgs.cs:7-19`.
 * Fired by `World.OnWeenieReleased` (`World.cs:50-53`) when a
 * WorldObject leaves the cache. Payload is the typed-class instance
 * that was just removed.
 * @param {object} wobject WorldObject (or subclass) instance
 */
export function makeObjectReleased(wobject) {
  return { object: wobject };
}

/**
 * Port of `ContainerOpenedEventArgs.cs:7-19`.
 * Fired by `World.OnContainerOpened` (`World.cs:59-62`) AFTER all
 * listed children's `Item_CreateObject` have arrived (per
 * `World.cs:212-249` container-open watcher — load-bearing per
 * handoff §3 first quote).
 * @param {object} container Container instance
 */
export function makeContainerOpened(container) {
  return { container };
}

/**
 * Port of `ContainerClosedEventArgs.cs:7-19`.
 * Fired by `World.OnContainerClosed` (`World.cs:68-71`).
 * @param {object} container Container instance
 */
export function makeContainerClosed(container) {
  return { container };
}

/**
 * Port of `WorldObjectSelectedEventArgs.cs:7-15`.
 * Fired by `World.OnSelectionChanged` (`World.cs:77-80`). Derives
 * from EatableEventArgs — handlers can set `.eaten = true` to
 * prevent the next handler from seeing the change (used by the
 * combat bar to swallow LMB before the pick-target handler).
 *
 * @param {object|null} wobject Selected WorldObject, or null on deselect
 */
export function makeWorldObjectSelected(wobject) {
  return makeEatable({ object: wobject });
}

/**
 * Port of `GameStateChangedEventArgs.cs:11-31`.
 * Fired by `Game.OnStateChanged` (per `Game.cs` state machine at
 * lines 117-123 in ACPlugin).
 * @param {number} newState ClientState
 * @param {number} oldState ClientState
 */
export function makeGameStateChanged(newState, oldState) {
  return { newState, oldState };
}

/**
 * Port of `VitaeChangedEventArgs.cs:4-21`.
 * Fired by `Character.OnVitaeChanged` (`Character.cs:116-120`).
 * Vitae is `1.0 = no vitae, 0.95 = 5% vitae` — counter-intuitive.
 * Don't invert. Per handoff §3 fourth quote.
 *
 * @param {number} vitae current vitae multiplier (1.0..0.5 ish)
 * @param {number} oldVitae previous vitae multiplier
 */
export function makeVitaeChanged(vitae, oldVitae) {
  return { vitae, oldVitae };
}

/**
 * Port of `VitalChangedEventArgs.cs:13-35`.
 * Fired by `Character.OnVitalChanged` (`Character.cs:125-129`).
 * @param {number} type    VitalId (Health=1, Stamina=3, Mana=5 per ACE)
 * @param {number} value   new current value
 * @param {number} oldValue previous current value
 */
export function makeVitalChanged(type, value, oldValue) {
  return { type, value, oldValue };
}

/**
 * Port of `EnchantmentsChangedEventArgs.cs:9-36`.
 * Fired by `Character.OnEnchantmentChanged` (`Character.cs:134-138`).
 * `spellId` is derived from `layeredSpellId.id` (per C# property at
 * EnchantmentsChangedEventArgs.cs:24).
 *
 * @param {number} type            AddRemoveEventType
 * @param {object} enchantment     Enchantment record (LayeredId/SpellId/Layer/Power/StartTime/Duration/CasterId/Type/StatKey/StatValue)
 */
export function makeEnchantmentsChanged(type, enchantment) {
  return {
    type,
    layeredSpellId: enchantment.layeredId ?? enchantment.LayeredId ?? null,
    spellId: enchantment.spellId ?? enchantment.SpellId ?? enchantment.layeredId?.id ?? 0,
    enchantment,
  };
}

/**
 * Port of `SharedCooldownsChangedEventArgs.cs:11-26`.
 * Fired by `Character.OnSharedCooldownChanged` (`Character.cs:143-147`).
 * @param {number} type        AddRemoveEventType
 * @param {object} cooldown    SharedCooldown record
 */
export function makeSharedCooldownsChanged(type, cooldown) {
  return { type, cooldown };
}

/**
 * Port of `DeathEventArgs.cs:5-19`.
 * Fired by `Character.OnDeath` (`Character.cs:171-175`).
 * @param {string} text     server-formatted death message
 * @param {number} killerId GUID of killer (0 if environment/falling)
 */
export function makeDeath(text, killerId) {
  return { text, killerId };
}

// ─── Aggregate export so tests / consumers can iterate ───
/**
 * Map of factory-name → factory function. Used by tests and
 * future PR-2 (S2C dispatch) to verify all 11 shapes have factories.
 */
export const eventArgsFactories = Object.freeze({
  objectCreated: makeObjectCreated,
  objectReleased: makeObjectReleased,
  containerOpened: makeContainerOpened,
  containerClosed: makeContainerClosed,
  worldObjectSelected: makeWorldObjectSelected,
  gameStateChanged: makeGameStateChanged,
  vitaeChanged: makeVitaeChanged,
  vitalChanged: makeVitalChanged,
  enchantmentsChanged: makeEnchantmentsChanged,
  sharedCooldownsChanged: makeSharedCooldownsChanged,
  death: makeDeath,
});

// =============================================================================

// PR-2 (2026-05-27): the new `WorldState` instance (port of `World.cs`).
// Surfaced on the client as `client.world` per ACPlugin §4 (`Game.World`
// row). See `plugins/world-state.js` for the dispatch table + load-bearing
// container-open child-wait gate (`World.cs:212-249`).
import { WorldState, bindWorldStateToClient } from './world-state.js';
export { WorldState, bindWorldStateToClient } from './world-state.js';

/**
 * Build the plugin-facing `client` facade over a wasm SessionHandle.
 *
 * P6.1 SHAPE (design §2.1) — one object graph, three views:
 *   client.host           the flat retail-named surface (= RynthWebHost);
 *                         what rynth code targets, and the substrate every
 *                         namespace below delegates through.
 *   client.player/.chat/… the namespaced view plugins already write against.
 *   client._unsafeHandle  the raw SessionHandle, renamed to declare intent —
 *                         the ONLY sanctioned raw access, for the accessor
 *                         PROPERTIES that cannot be capabilities.
 *
 * SNAPSHOT SEMANTICS — deliberate v1 deviation from the design doc. The
 * doc proposed re-pointing per-tick reads (`client.player.pose`) at the
 * host's frozen per-tick snapshot. We do NOT, in v1: the heartbeat is a
 * dedicated Worker that only bot pages start, so with it stopped every
 * snapshot read would answer its zero-fallback and `client.player.pose`
 * would go null for the ~100 plugin call sites that read it per frame. So:
 *   - `client.player.pose` / `.stats` / `.inventory` stay LIVE reads (the
 *     retail-client "read it now" semantics they have always had),
 *   - `client.host.TryGetPlayerPose()` is the frozen per-tick read, exact
 *     as designed, available to anyone who calls `client.startHostTick()`.
 * Both are honest and neither is a hole; the frozen-view flip is a v2
 * decision that wants its own migration of the per-frame readers.
 *
 * @param {object} sessionHandle wasm SessionHandle
 * @param {{host?: object}} [opts] `opts.host` is forwarded to RynthWebHost
 *   (e.g. `{noEventTap: true}` in tests).
 */
export function createClient(sessionHandle, opts = {}) {
  const bus = new EventTarget();

  // P-unification (2026-07-28) — the ONE gameplay keyboard funnel, exposed on
  // the facade so plugins register actions instead of installing their own
  // listener + their own gate (the structural cause of "WASD works but Delete
  // is dead"). See ui/input-funnel.js.
  const funnel = getInputFunnel();
  const input = Object.freeze({
    bindAction: (labelHash, defaultBinding, handler, o) =>
      funnel.bindAction(labelHash, defaultBinding, handler, o),
    bindRaw: (name, handler, o) => funnel.bindRaw(name, handler, o),
    bindRawUp: (name, handler, o) => funnel.bindRawUp(name, handler, o),
    /** The ONE gate — true iff gameplay keys are live right now. */
    gateOpen: () => funnel.gateOpen(),
    /** `__diag.input()` payload: gate, counts, last dispatch, per-action. */
    snapshot: () => funnel.snapshot(),
    /** True when the funnel owns dispatch (`?inputFunnelV2=off` → false). */
    get enabled() {
      return inputFunnelV2On();
    },
  });

  // The one facade substrate. Capability probing happens here, once.
  const host = new RynthWebHost(sessionHandle, opts.host || {});

  // Events fed externally by drainEvents loop in index.html — do not poll from here.
  // Coverage table above documents which Chorizite EventArgs each bus name maps to.
  const events = {
    on(name, handler) {
      bus.addEventListener(name, handler);
    },
    off(name, handler) {
      bus.removeEventListener(name, handler);
    },
    once(name, handler) {
      bus.addEventListener(name, handler, { once: true });
    },
    emit(name, payload) {
      bus.dispatchEvent(new CustomEvent(name, { detail: payload }));
    },
  };
  // TODO(coverage-table row 1):  add "objectCreated"  bus event (World.OnWeenieCreated)
  // TODO(coverage-table row 2):  add "objectReleased" bus event (World.OnWeenieReleased)
  // row 3: DONE (PR-HH 2026-05-23) — kind=21 containerOpened fires for
  // non-vendor containers (chest/corpse/salvage bag); vendor still on kind=12.
  // TODO(coverage-table row 4):  add "containerClosed" (StopViewingObjectContents → new ClientEvent kind)
  // row 5: DONE (Q1b 2026-05-26) — scene3d/picking.js emits "selectionChanged" {guid, prevGuid} on every change.
  // TODO(coverage-table row 6):  add unified "stateChanged" {oldState,newState} bus event
  // TODO(coverage-table row 8):  add "worldInfo" bus event (ServerName/MaxConnections/CurrentConnections)
  // TODO(coverage-table row 9):  split kind=8 into per-vital "vitaeChanged" with old/new
  // row 10: DONE (Wave 3.C + Wave 6 polish 2026-05-28) — per-vital "vitalChangedHealth/Stamina/Mana" {current,buffedMax,oldValue?} via kinds 42/43/44. oldValue threaded through f32_payload from holtburger-world handlers (`update_vital_current` / `update_vital` / `update_health_fraction`) which snapshot pre-mutation; `undefined` when the handler couldn't capture (initial spawn hydrate).
  // TODO(coverage-table row 11): add "enchantmentChanged" {type,layeredSpellId,enchantment} bus event
  // TODO(coverage-table row 12): add "sharedCooldownChanged" {type,cooldown} bus event
  // TODO(coverage-table row 13): add "portalSpaceEntered" bus event
  // TODO(coverage-table row 14): add "portalSpaceExited" bus event (kind=7 covers exit-equivalent only)
  // row 15: DONE (Q1a 2026-05-26) — kind=29 "death" {victimGuid,killerGuid,message}; combat-hud overlays self-deaths.

  // P6.1 — every member below delegates through `host`. Where a host member
  // exists it is called by its retail name; where only the capability table
  // is needed (raw wasm return shapes plugins already depend on) the
  // `host.call(cap, …)` seam is used so resolution + degrade-not-throw
  // still happen in exactly one place.
  const player = Object.freeze({
    jump(power) {
      host.Jump(power);
    },
    useObject(guid) {
      host.UseObject(guid);
    },
    // === Wave 5.C / Agent 5.C — Tradeskill drag-and-drop dispatch (2026-05-28) ===
    // Wraps Wave 5.A's `sessionHandle.useWithTarget(item, target)` wasm
    // export. Mirrors `useObject` shape. If Wave 5.A's export is missing
    // (stale wasm pkg), the call is a no-op — plugins/tradeskill.js
    // surfaces a one-time console.warn so the user sees the staleness.
    useWithTarget(itemGuid, targetGuid) {
      // Capability-gated by the host (returns false on a stale pkg/ instead
      // of throwing) — plugins/tradeskill.js surfaces the staleness warn.
      host.UseItemOnTarget(itemGuid >>> 0, targetGuid >>> 0);
    },
    // === Wave 6.B / Agent 6.B — Lifestone bind/recall UI (2026-05-28) ===
    // Bind == `useObject(lifestoneGuid)` (server-decided by WeenieType).
    // Recall == `recallToLifestone()` — no payload, ACE owns cooldown.
    recallToLifestone() {
      host.RecallToLifestone();
    },
    toggleCombatMode() {
      // C8 — untyped toggle: the resulting mode is the server's
      // (`get_suggested_combat_mode`), so record "unknown" = fail-open in the
      // cast gate. See ui/ac_combat_mode_intent.js.
      noteCombatModeRequest(null);
      host.ToggleCombatMode();
    },
    attack(targetGuid, attackHeight = 2, powerLevel = 1.0) {
      host.MeleeAttack(targetGuid, attackHeight, powerLevel);
    },
    missileAttack(targetGuid, attackHeight = 2, accuracyLevel = 1.0) {
      host.MissileAttack(targetGuid, attackHeight, accuracyLevel);
    },
    castSpell(spellId, targetGuid) {
      // null/undefined targetGuid → untargeted (recall / dispel /
      // portal-summon spells) — EXCEPT SelfTargeted spells, which are
      // promoted to a targeted cast at our own guid. ACE's untargeted
      // handler threads target=null into DoSpellEffects, so a
      // self-buff cast on 0x0048 lands its enchantment but never
      // broadcasts the TargetEffect PlayScript (the buff glow).
      // Retail cast self-spells targeted at the player's own object —
      // ACE's TargetCategory.Self path (see
      // ui/ac_cast_spell.js::selfTargetGuidFor for the full trace;
      // live-verified 2026-07-01).
      let resolvedTarget = targetGuid;
      if (resolvedTarget == null) {
        try {
          resolvedTarget = selfTargetGuidFor(spellId >>> 0);
        } catch (_) {
          resolvedTarget = null;
        }
      }
      // P6.1: only the WIRE half moves to the host — the JS value-add above
      // and below (self-target promotion, bus emit, local cast gesture) is
      // this wrapper's own and is deliberately NOT pushed down into
      // host.CastSpell, which rynth's loops call for the bare wire action.
      if (resolvedTarget == null) {
        host.CastUntargetedSpell(spellId);
      } else {
        host.CastSpell(resolvedTarget, spellId);
      }
      // WS14 — cast-lifecycle begin for the non-picking paths (combat-bar /
      // hotbar / spell-research). Mirrors picking.js's spellCastInitiated
      // payload so spell_shape_preview + the combat-bar cast-busy sweep get one
      // uniform signal (combat-bar/hotbar casts get shape-preview as a bonus).
      // Does NOT double-fire the picking path — picking casts via sessionHandle
      // directly, never through here (§1.3). estDurationMs lets the UI size its
      // cooldown without importing the cast-sequence table. Never blocks the cast.
      try {
        const bus = window.__pluginClient?.events;
        if (bus?.emit) {
          const lg = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
          const seq = getCastSequence((spellId >>> 0)) ?? null;
          const speed = Number(window.__castSpeed) || 2.0;
          const estDurationMs = seq && Number.isFinite(+seq.totalDurationS) && +seq.totalDurationS > 0
            ? Math.max(400, Math.round((+seq.totalDurationS * 1000) / speed))
            : undefined;
          bus.emit("spellCastInitiated", {
            spellId: spellId >>> 0,
            targetGuid: resolvedTarget == null ? null : (resolvedTarget >>> 0),
            attackerGuid: lg,
            school: seq?.school ?? null,
            shape: seq?.shape ?? null,
            level: seq?.level ?? null,
            estDurationMs,
          });
        }
      } catch (_) { /* events never block the cast */ }
      // F8-3 — play the local cast gesture for ALL non-picking cast paths
      // (untargeted self-buffs/heals/recalls + hotbar / spell-research /
      // combat-bar targeted casts). The picking.js armed-targeted path
      // drives its own playCastSequence; everything else routed through here
      // stood frozen in Magic stance while buff icons silently appeared,
      // because the local-guid skip eats the class-0x40 gesture echo. Reuses
      // the same local-prediction chain the targeted path already uses.
      try {
        const em = window.liveScene3d?.entityManager;
        const localGuid = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
        if (em && localGuid && typeof em.playCastSequence === "function") {
          em.playCastSequence(localGuid, (spellId >>> 0));
        }
      } catch (_) { /* never block the cast on the local animation */ }
    },
    forgetSpell(spellId) {
      host.ForgetSpell(spellId);
    },
    /**
     * LIVE pose read (see createClient's SNAPSHOT SEMANTICS note): this
     * getter answers now, every time. `client.host.TryGetPlayerPose()` is
     * the frozen per-tick read.
     */
    get pose() {
      return host.TryGetPlayerPoseLive();
    },
    get stats() {
      // Raw PlayerStatsSnapshot (stride arrays) — the shape plugins parse.
      // `host.TryGetPlayerStats()` is the normalized projection.
      return host.call("GetPlayerStats") ?? null;
    },
    get inventory() {
      // Raw InventoryItem rows; `host.TryGetPlayerInventory()` projects.
      return host.call("GetPlayerInventory") ?? null;
    },
    knownSpells() {
      return host.call("GetKnownSpells") ?? null;
    },
    /**
     * PR-2 surface — local player's active enchantment snapshot. Returns
     * `[{spellId, spellCategory, layer, powerLevel, startTime, duration,
     * casterGuid}, ...]` per `PlayerEnchantmentJs` (`src/lib.rs:14705-14745`).
     * Snapshot is refreshed by the wasm side on every kind=8
     * `playerStatsUpdated` drain (piggybacks the stats refresh).
     * @returns {Array<object>}
     */
    enchantments() {
      return host.TryGetEnchantments();
    },
    // === Wave 4.A — Train Skills (2026-05-28) ===
    // Surface the two progression GameActions next to combat / cast /
    // useObject. Both no-op-return (Result<(), JsValue> on the wasm side);
    // ACE owns validation and echoes the resulting stats via
    // `PrivateUpdateSkill` → `playerStatsUpdated` bus event, which the
    // `plugins/train-skills.js` plugin subscribes to for live re-render.
    raiseSkill(skillId, xpSpent) {
      host.RaiseSkill(skillId, xpSpent);
    },
    trainSkill(skillId, credits) {
      host.TrainSkill(skillId, credits);
    },
    /**
     * Current `AvailableSkillCredits` (PropertyInt 24) for the local
     * player. Drives the train-skills panel's "credits available" footer
     * and Train-button enabled gate. Returns `0` pre-spawn / before the
     * property has landed; refreshed by the recv loop on every
     * `playerStatsUpdated` drain (same trigger as `stats`/`inventory`).
     * @returns {number}
     */
    get skillCredits() {
      // Accessor PROPERTY, not a method — cannot be a capability, so this
      // is one of the documented `_unsafeHandle` reads.
      try {
        return host.unsafeHandle.playerSkillCredits >>> 0;
      } catch (_) {
        return 0;
      }
    },
  });

  const AttackHeight = Object.freeze({ HIGH: 1, MEDIUM: 2, LOW: 3 });
  const CombatMode = Object.freeze({
    UNDEF: 0,
    NON_COMBAT: 1,
    MELEE: 2,
    MISSILE: 4,
    MAGIC: 8,
  });

  const movement = Object.freeze({
    setInput(forward, strafe, turn, run) {
      host.SetMovementInput(forward, strafe, turn, run);
    },
    tick() {
      host.TickMovement();
    },
    /** Retail `StopCompletely` / `SetAutoRun` / `TurnToHeading`. */
    stop() {
      return host.StopCompletely();
    },
    setAutoRun(on) {
      return host.SetAutoRun(on);
    },
    turnToHeading(headingRad) {
      return host.TurnToHeading(headingRad);
    },
  });

  const chat = Object.freeze({
    send(message) {
      host.WriteToChat(message);
    },
    /**
     * P6.1 — retail `IssueChatBarCommand` (an E_FAIL stub in retail; real
     * here). Runs `text` through the SAME slash/`@` router the chat bar
     * uses, then falls through to a plain say. This is the re-injection
     * half of "eat + rewrite": a plugin that eats `chat.hooks.outgoing`
     * calls this with its rewritten line. Does not re-enter the hook.
     * @returns {boolean}
     */
    parse(text) {
      return host.InvokeChatParser(text);
    },
    on(eventName, handler) {
      events.on(eventName, handler);
    },
    // P6.1 — the two retail chat hooks (see plugins/chat-hooks.js for
    // exact retail semantics and event shapes):
    //   hooks.incoming.on("chatIncoming", (ev) => { ... ev.eat(); })
    //     — pre-display inbound line {text, chatType, category};
    //       eat = never displayed (game state untouched).
    //   hooks.outgoing.on("chatOutgoing", (ev) => { ... ev.eat(); })
    //     — pre-parse chat-bar line {text}; eat = no route/send/echo.
    hooks: chatHooks,
    /** Retail `OnChatWindowText` — subscribe inbound. Returns unsubscribe. */
    onIncoming(fn) {
      return host.OnChatWindowText(fn);
    },
    /** Retail `OnChatBarEnter` — subscribe outbound. Returns unsubscribe. */
    onOutgoing(fn) {
      return host.OnChatBarEnter(fn);
    },
  });

  const characters = Object.freeze({
    list() {
      return host.TryGetCharacterList();
    },
    select(guid) {
      host.SelectCharacter(guid);
    },
    createTest(name) {
      host.CreateTestCharacter(name);
    },
    // Wave D.2 (2026-05-27) — rich char-gen wizard surface; mirrors
    // `gmCharGenMainUI` (external/chorizite/ACBindings/Generated/Game/
    // CharGen/gmCharGenMainUI.cs:48-79). The wizard plugin
    // (plugins/character-creation.js) consumes both:
    //   - `getCatalog()` returns the heritages/genders/templates/skills
    //     dump loaded from CharGen DAT (0x0E000002) + SkillTable
    //     (0x0E000004) at start_session — see src/lib.rs
    //     `get_character_gen_catalog`. Null until canCreateCharacter
    //     flips true.
    //   - `skillCostsFor(heritageId, skillId)` returns the
    //     heritage-corrected (trainedCost, specializedCost) tuple for
    //     a given skill — wizard re-reads as user picks heritage.
    //   - `createCharacter(build)` is the rich submit path. `build` is
    //     a plain JS object mirroring CharacterGenBuildJs (heritage,
    //     gender, templateOption, attribute fields, appearance,
    //     skillAdvancementClasses [N×u32 per SkillAdvancementClass
    //     enum 0..=3], name, startArea). Throws JsValue strings on
    //     validation failure (`CharacterGenBuilder` errors); success
    //     dispatches a CharacterCreate wire packet and resolves
    //     immediately. Outcome later via kind=5 / kind=6 events.
    getCatalog() {
      return host.TryGetCharacterGenCatalog();
    },
    skillCostsFor(heritageId, skillId) {
      return host.TryGetSkillCostsForHeritage(heritageId, skillId);
    },
    // Wave J4.B (2026-05-27) — per-(heritage, gender) appearance icon
    // strips so the wizard's swatch picker can render thumbnails. See
    // `apps/holtburger-web/src/lib.rs` `get_character_gen_appearance_strips`.
    appearanceStrips(heritageId, genderId) {
      return host.TryGetCharacterGenAppearanceStrips(heritageId, genderId);
    },
    createCharacter(build) {
      // Throws on wasm-side validation failure — the wizard renders the
      // message, so this is the one documented non-degrading member.
      host.CreateCharacter(build);
    },
  });

  // PR-2 (2026-05-27): `client.world` is now the WorldState instance (port
  // of `World.cs`). Existing scene-query helpers (currentCell / isIndoor /
  // renderSet / terrainHeightAt / doorPart) live on `client.scene` AND
  // grafted onto `client.world` for back-compat — no existing callers were
  // found in the codebase at the time of PR-2, but we preserve the
  // attribute names defensively in case unbundled plugins reach for them.
  const sceneQueries = Object.freeze({
    currentCell() {
      return host.GetCurrentCellIdLive();
    },
    isIndoor() {
      return host.IsIndoors();
    },
    /** Retail slot `GetIsOutdoors` (E_NOTIMPL in retail). */
    isOutdoor() {
      return host.GetIsOutdoors();
    },
    renderSet(depth = 1) {
      return host.GetRenderSet(depth);
    },
    terrainHeightAt(x, y) {
      return host.TerrainHeightAt(x, y);
    },
    doorPart(guid) {
      return host.GetBuildingPartForDoor(guid);
    },
  });
  const scene = sceneQueries;

  // PR-2 (2026-05-27): construct a WorldState instance. Manager is wired
  // by the host (index.html bootstrap will inject the typed
  // WorldObjectManager once it's `load()`-ed); pre-attach we accept a
  // null manager so unit tests can instantiate without DAT round-trips.
  const world = new WorldState({ manager: null, client: null });
  // Graft the existing scene-query methods so legacy `client.world.currentCell()`
  // calls still resolve. Each is a plain delegate (the WorldState's own
  // methods don't collide).
  for (const [k, fn] of Object.entries(sceneQueries)) {
    if (typeof fn === 'function' && !(k in world)) {
      world[k] = fn;
    }
  }

  const collision = Object.freeze({
    sweep(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId) {
      return host.SweepCollision(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId);
    },
    sweepBuilding(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId) {
      return host.SweepBuildingMesh(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId);
    },
    sweepCells(fromX, fromY, fromZ, toX, toY, toZ, radius, cellIds) {
      return host.SweepCellMesh(fromX, fromY, fromZ, toX, toY, toZ, radius, cellIds);
    },
    sweepStatics(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId) {
      return host.SweepStatics(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId);
    },
  });

  const sky = Object.freeze({
    state() {
      return host.GetSkyState();
    },
    objects() {
      return host.GetSkyObjectStates();
    },
    hasDesc() {
      return host.HasSkyDesc();
    },
    setTimeOverride(t) {
      return host.SetSkyTimeOverride(t);
    },
    setDayOverride(d, y) {
      return host.SetGameDayOverride(d, y);
    },
  });

  // P6.1 — retail slots Select / GetSelected / GetPreviousSelected. Backed
  // by the 3D entity manager (an ENVIRONMENT capability: it attaches long
  // after login, so `client.has("SelectObject")` is probed live).
  const selection = Object.freeze({
    select(guid) {
      return host.SelectObject(guid);
    },
    /** Selected guid, or 0 when nothing is selected / no 3D scene. */
    get id() {
      return host.GetSelectedId();
    },
  });

  // P6.1 (2026-07-27): client.ui made real (was three no-op stubs with
  // zero callers). openPanel/closePanel/openPanelId delegate to the
  // mounted bar (window.__barInstance — index.html stores mountBar()'s
  // return there; ui/bar.js grew these members in the same change).
  // registerBarSlot stays DEFERRED in v1: the bar builds its icon row
  // once at mount, so dynamic slot injection is real work, not
  // scaffolding — it warns once and returns false; ship a manifest
  // under plugins/ instead. writeToChat is retail
  // IAsheronsCall::WriteToChat (display echo only; deliberately does
  // NOT traverse chat.hooks.incoming — retail's sendToAPI=false rule,
  // which keeps plugin chat filtering loop-free). screenDimensions is
  // retail slot 49 (GetScreenDimensions).
  let warnedRegisterBarSlot = false;
  const ui = Object.freeze({
    registerBarSlot(_manifest, _module) {
      if (!warnedRegisterBarSlot) {
        warnedRegisterBarSlot = true;
        console.warn(
          "[client.ui] registerBarSlot is deferred in API v1 — add a manifest under plugins/ instead",
        );
      }
      return false;
    },
    openPanel(pluginId) {
      return host.OpenPanel(pluginId);
    },
    closePanel(pluginId) {
      return host.ClosePanel(pluginId);
    },
    openPanelId() {
      return host.GetOpenPanelId();
    },
    /** Toggle: open when closed (or when another plugin's panel is open),
     *  close when this plugin's panel is the open one. Mirrors what an icon
     *  click does, which is what a hotkey-driven plugin actually wants. */
    togglePanel(pluginId) {
      if (host.GetOpenPanelId() === pluginId) return host.ClosePanel(pluginId);
      return host.OpenPanel(pluginId);
    },
    writeToChat(text, category = null) {
      return host.WriteToChatWindow(text, category);
    },
    screenDimensions() {
      return host.GetScreenDimensions() ?? { width: 0, height: 0 };
    },
  });

  const client = {
    // P6.1 — facade version (see API_VERSION doc above).
    apiVersion: API_VERSION,
    /**
     * The ONE facade substrate — the flat retail-named surface
     * (RynthWebHost). Everything else on this object delegates through it.
     */
    host,
    /**
     * Capability probe (design §2.3). `true` iff the backing exists; an
     * absent capability's member returns its documented fallback and never
     * throws. Environment capabilities (selection / chat / bar seams) are
     * probed live because their backing attaches late.
     */
    has(cap) {
      return host.has(cap);
    },
    /** Sorted capability names currently backed. */
    get capabilities() {
      return host.capabilities;
    },
    /**
     * The raw SessionHandle. Named to declare intent: this is the ONLY
     * sanctioned raw access, for the accessor PROPERTIES that cannot be
     * capabilities. Reaching past the facade for anything a namespace or
     * `host.call(cap, …)` already covers is the deprecated bypass
     * (design §6) — `window.__sessionHandle` goes debug-only in v1.1.
     *
     * A GETTER, not a captured reference: a reconnect swaps the wasm
     * session, and the pre-P6.1 facade captured the first handle for the
     * page's lifetime — so after a kick/reconnect every `client.*` call
     * went to a dead session (live-observed under `?kickDance=1`).
     */
    get _unsafeHandle() {
      return host.unsafeHandle;
    },
    /**
     * Rebind the whole facade to a new wasm session and re-probe
     * capabilities. index.html calls this the moment a new handle is
     * installed, so ONE call keeps every namespace, the host, and
     * `_unsafeHandle` pointing at the live session.
     */
    attachHandle(newHandle) {
      host.attach(newHandle);
      return client;
    },
    /**
     * Start the host's frozen-per-tick heartbeat (a dedicated Worker, so a
     * backgrounded tab keeps ticking). Off by default — only callers that
     * want the snapshot reads (`host.TryGetPlayerPose()`, `host.snap`)
     * need it. Idempotent-ish: re-calling restarts at the new rate.
     */
    startHostTick(hz = 15) {
      host.start(hz);
      return host;
    },
    stopHostTick() {
      host.stop();
    },
    player,
    movement,
    chat,
    characters,
    world,   // WorldState instance (PR-2); scene-query helpers grafted on.
    scene,   // Pure scene-query surface (preferred for renderer plugins).
    collision,
    sky,
    selection,
    ui,
    // P-unification (2026-07-28) — the ONE gameplay-input registration
    // surface. Plugins REGISTER actions/raw subscribers here instead of
    // adding their own `keydown` listener with their own gate; the funnel
    // owns the single document-capture listener, the single in-world gate,
    // and the single keymap resolution (user rebinds included).
    //
    //   client.input.bindAction(labelHash, defaultCode, fn, { when, priority })
    //   client.input.bindRaw(name, fn)          // every gated keydown
    //   client.input.bindRawUp(name, fn)        // every keyup (ungated)
    //
    // All three return an `unbind()` to call from the plugin's cleanup.
    input,
    events: Object.freeze(events),
    AttackHeight,
    CombatMode,
    // ACPlugin PR-1: enums + EventArgs factories surfaced on client so
    // plugin authors don't need to import the module directly.
    ClientState,
    AddRemoveEventType,
    eventArgsFactories,
    // Accessor PROPERTIES on the handle — not methods, so not capabilities;
    // these are the documented `_unsafeHandle` reads.
    get account() {
      return host.unsafeHandle.accountName;
    },
    get canCreateCharacter() {
      return host.unsafeHandle.canCreateCharacter;
    },
    // PR 4 (2026-05-27): `client.character` — typed `Character` instance
    // for the local player. Null pre-spawn / pre-PLAYER_SPAWNED. Once
    // `world.setLocalPlayerGuid(guid)` lands + the kind=10 ObjectCreate
    // for that GUID is dispatched into `world.dispatchItemCreateObject`,
    // this getter returns the typed Character with vitae / enchantment /
    // cooldown state ready for HUD consumption. Also available as
    // `client.world.character` for plugins that already hold a `world`
    // reference.
    get character() {
      return world.character;
    },
  };

  // PR-2 — bind the new WorldState onto the client's event-bus surface so
  // `containerOpened` / `containerClosed` / `objectAppraised` /
  // `playerStatsUpdated` / `selectionChanged` flow into typed dispatch.
  // Idempotent: re-binding is harmless (the bus uses addEventListener
  // with our own bridging callbacks; tests bypass this and dispatch
  // directly on the WorldState instance).
  bindWorldStateToClient(world, client);

  return Object.freeze(client);
}
