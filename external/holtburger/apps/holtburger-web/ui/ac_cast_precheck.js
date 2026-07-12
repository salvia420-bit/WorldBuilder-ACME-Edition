// =============================================================================
// WS14 (2026-07-12) — client-side pre-cast checks (?castPrecheck, default-OFF)
// =============================================================================
//
// Retail's ClientMagicSystem::CastSpell (acclient.c:404671-404783) checked the
// spell's COMPONENTS client-side BEFORE the send (acclient.c:404710
// ComponentIsOwned → 404719 "You do not have all of this spell's components").
// It never checked mana client-side — mana (0x401) was server-only. So:
//   ?castPrecheck=components  → retail-authentic component-ownership pre-check
//   ?castPrecheck=on          → components + a NON-retail mana pre-check
//   ?castPrecheck=off (default)→ send is authoritative; server rejects; the
//                                transient-chat toast renders (unchanged).
//
// FAIL-OPEN is load-bearing (foundation §4.8, packet R5): if any datum needed
// to run a check is missing (spell record not loaded, component table not
// fetched, inventory unavailable), the check returns null → the cast SENDS.
// We never block a cast on missing data — only on a POSITIVELY-determined miss.
//
// Strict opt-in per the flag footgun: only the exact strings "components" /
// "on" enable; the param being absent, "off", or anything else = off.

// Retail pre-check strings (the CLIENT strings, distinct from the server-reject
// 0x400/0x401 strings that already toast via the transient-chat path §1.4).
export const MSG_MISSING_COMPONENTS =
  "You do not have all of this spell's components";
export const MSG_NOT_ENOUGH_MANA =
  "You don't have enough Mana to cast this spell.";

/**
 * Parse the ?castPrecheck flag value (strict opt-in).
 * @param {string|null|undefined} raw
 * @returns {"off"|"components"|"on"}
 */
export function parsePrecheckMode(raw) {
  const v = (raw == null ? "" : String(raw)).toLowerCase();
  if (v === "components") return "components";
  if (v === "on") return "on";
  return "off";
}

/** Read ?castPrecheck from the current URL. Returns "off" when unavailable. */
export function castPrecheckMode() {
  try {
    if (typeof window === "undefined" || !window.location) return "off";
    return parsePrecheckMode(
      new URLSearchParams(window.location.search).get("castPrecheck"),
    );
  } catch (_) {
    return "off";
  }
}

/**
 * Pure component decision. Given the spell's required component NAMES and the
 * set of owned item names (lowercased), return true (REJECT) only when at least
 * one required component is DEFINITELY not owned. Fail-open: empty required or
 * empty owned → false (allow the send — we couldn't positively determine a
 * miss). Ownership is name-substring (retail components are distinct named
 * items — Iron Scarab, Prismatic Taper, …).
 *
 * @param {string[]} requiredNames
 * @param {Set<string>|string[]} ownedNamesLower
 * @returns {boolean} true → missing a component (reject)
 */
export function evalComponentPrecheck(requiredNames, ownedNamesLower) {
  if (!Array.isArray(requiredNames) || requiredNames.length === 0) return false;
  const owned = ownedNamesLower instanceof Set
    ? ownedNamesLower
    : new Set(Array.isArray(ownedNamesLower) ? ownedNamesLower : []);
  if (owned.size === 0) return false; // fail-open: no inventory snapshot
  for (const raw of requiredNames) {
    const name = String(raw || "").toLowerCase().trim();
    if (!name) continue; // unresolved component id → don't reject on it
    let found = false;
    for (const it of owned) {
      if (it === name || it.includes(name) || name.includes(it)) { found = true; break; }
    }
    if (!found) return true;
  }
  return false;
}

/**
 * Pure mana decision (NON-retail). Reject only when the base cost strictly
 * exceeds current mana AND both are finite positives. Mana Conversion can
 * reduce the real cost server-side, so this over-rejects near threshold — the
 * caveat is documented and this arm is gated to ?castPrecheck=on only.
 *
 * @param {number} baseMana
 * @param {number} currentMana
 * @returns {boolean} true → not enough mana (reject)
 */
export function evalManaPrecheck(baseMana, currentMana) {
  const base = +baseMana;
  const cur = +currentMana;
  if (!Number.isFinite(base) || base <= 0) return false; // fail-open
  if (!Number.isFinite(cur)) return false;               // fail-open
  return base > cur;
}

// ---------------------------------------------------------------------------
// Live wiring (the impure part). Reads the component table lazily and the
// wasm SpellTable / inventory / stats via window.__sessionHandle. Every
// accessor is guarded — any throw / missing datum yields null (fail-open).
// ---------------------------------------------------------------------------

let _componentTable = null;      // { "1": {name,...}, ... } once loaded
let _componentFetchInFlight = false;

function _kickComponentTableLoad() {
  if (_componentTable !== null || _componentFetchInFlight) return;
  if (typeof fetch !== "function") return;
  _componentFetchInFlight = true;
  fetch("data/spell-components.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { _componentTable = (j && j.components) ? j.components : {}; })
    .catch(() => { /* leave null; a later cast retries */ })
    .finally(() => { _componentFetchInFlight = false; });
}

/** Test seam: inject a component table so the wiring can be unit-tested. */
export function _setComponentTableForTest(table) {
  _componentTable = table;
}

function _recField(rec, key) {
  if (!rec) return undefined;
  return (rec instanceof Map) ? rec.get(key) : rec[key];
}

/**
 * Run the configured pre-checks for `spellId`. Returns a retail failure string
 * (do NOT send) or null (send is fine / couldn't determine → fail-open).
 *
 * @param {number} spellId
 * @param {"off"|"components"|"on"} mode
 * @returns {string|null}
 */
export function preCheckSpell(spellId, mode) {
  if (mode === "off") return null;
  const sid = (spellId >>> 0) || 0;
  if (!sid) return null;
  let rec = null;
  try {
    const handle = (typeof window !== "undefined") ? window.__sessionHandle : null;
    rec = handle?.getSpellRecord?.(sid) ?? null;
  } catch (_) {
    rec = null; // SpellTable not loaded yet → fail-open
  }

  // ── components (retail-authentic; both "components" and "on") ──────────
  {
    const compIds = _recField(rec, "components");
    if (Array.isArray(compIds) && compIds.length > 0) {
      if (_componentTable === null) {
        _kickComponentTableLoad(); // fail-open this cast; ready for the next
      } else {
        const requiredNames = compIds
          .map((id) => _componentTable[String(id)]?.name)
          .filter((n) => typeof n === "string" && n.length > 0);
        let ownedLower = null;
        try {
          const handle = (typeof window !== "undefined") ? window.__sessionHandle : null;
          const inv = (typeof handle?.playerInventory === "function") ? handle.playerInventory() : null;
          if (Array.isArray(inv)) {
            ownedLower = new Set();
            for (const it of inv) {
              const nm = (it && typeof it.name === "string") ? it.name.toLowerCase().trim() : "";
              if (nm) ownedLower.add(nm);
            }
          }
        } catch (_) { ownedLower = null; }
        if (ownedLower && evalComponentPrecheck(requiredNames, ownedLower)) {
          return MSG_MISSING_COMPONENTS;
        }
      }
    }
  }

  // ── mana (NON-retail; only when mode === "on") ────────────────────────
  if (mode === "on") {
    const baseMana = +(_recField(rec, "baseMana"));
    let curMana = NaN;
    try {
      const handle = (typeof window !== "undefined") ? window.__sessionHandle : null;
      const stats = (typeof handle?.playerStats === "function") ? handle.playerStats() : null;
      curMana = +(stats?.currentMana);
    } catch (_) { curMana = NaN; }
    if (evalManaPrecheck(baseMana, curMana)) {
      return MSG_NOT_ENOUGH_MANA;
    }
  }

  return null;
}
