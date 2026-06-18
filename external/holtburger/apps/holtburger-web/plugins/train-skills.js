// Wave 4.A (2026-05-28) — Train Skills panel.
//
// Surfaces the two progression GameActions that ACE already understands
// but the browser client had no UI for:
//   - Train Skill (Untrained → Trained) — spend AvailableSkillCredits
//     (PropertyInt 24). ACE: GameActionTrainSkill.cs.
//   - Raise Skill (ranks within Trained / Specialized) — spend
//     AvailableExperience (PropertyInt64 1). ACE: GameActionRaiseSkill.cs.
//
// The retail UI surface is `gmSkillUI` (gmStatManagementUI subclass) at
// `external/chorizite/ACBindings/Generated/UI/Elements/gmSkillUI.cs`
// (288 LOC; methods: TrainSkill(playerDesc), RaiseSelectedSkill (via
// RaiseSelection), TrainSkillDialogCallback, DisplaySelectionFooter_Untrained,
// DisplaySelectionFooter_Trained, GetCostToRaise, GetCostToRaise10,
// ExperiencePointsToRaiseSkillTenLevels). retail also embedded this
// inside a tabbed CharacterInfo dialog rather than a standalone window;
// this plugin keeps a dedicated panel so the wave-4.A scope is
// self-contained and doesn't fight `character-info.js` for control of
// the gmCharacterInfoUI tab strip (which today only renders skills
// read-only at lines 17, 397, 609-634 of `plugins/character-info.js`).
//
// **Wire layer (already shipped — see audit-refresh-2026-05-28.md §"Wave 4.A"):**
//   - `crates/holtburger-protocol/src/opcodes.rs:528-530` —
//     `RaiseSkill 0x0046`, `TrainSkill 0x0047`.
//   - `crates/holtburger-protocol/src/messages/player/actions.rs:67-125`
//     — `RaiseSkillActionData { skill_type, xp_spent }` and
//     `TrainSkillActionData { skill_type, credits_spent: i32 }` with full
//     pack/unpack + parity tests.
//   - `crates/holtburger-core/src/client/commands.rs:862-877` —
//     `ClientCommand::RaiseSkill` + `ClientCommand::TrainSkill` route via
//     `send_game_action` (used by `apps/holtburger-cli/src/pages/game/
//     domains/progression.rs:22-34`).
//   - `apps/holtburger-web/src/lib.rs` — wave-4.A exports
//     `raiseSkill(skill_id, xp_spent)`, `trainSkill(skill_id, credits)`,
//     `playerSkillCredits` getter; SessionCommand arms forward into the
//     same `session.send_action(GameAction::*)` path as the existing
//     `RemoveSpellFromBook` arm.
//
// **Cost-preview math (Wave C, shipped):**
// `computeSkillBase` and `computeSkillCurrent` wasm exports
// (`pkg/holtburger_web.d.ts:5163-5182`) wrap the C# `SkillInfo.cs:79-107`
// port in `crates/holtburger-core/src/client/skill_info.rs`. They predict
// the skill's value AFTER a raise without round-tripping ACE — useful
// for the per-row "next rank: X → Y" preview. The current panel uses
// the simpler `SkillTable.trainedCost / specializedCost` for credit cost,
// and ACE's "next rank XP" (already broadcast as part of
// `Qualities_PrivateUpdateSkillLevel`) for the XP cost — that arrives
// as part of every `playerStatsUpdated` drain via `skills[i*6+5]`
// (the per-skill MARGINAL next-rank-cost field — stride 6).
//
// **Trigger / discoverability:** F11 hotkey, with explicit
// PLUGIN_HOTKEY_DISPATCH bridge that calls `window.__mainPanel?.toggleView("train-skills")`.
// Registered as a `mainPanel.registerView("train-skills", view)` so it
// shares the right-side pane with Inventory / Spellbook / Character —
// mirrors the spellbook + character-info pattern (no separate floating
// overlay). The view is reachable from any in-world state without
// requiring NPC-interact (ACE's RaiseSkill is always-available, not
// NPC-gated; TrainSkill is the same — see GameActionTrainSkill.cs which
// has no proximity check).
//
// **Skill data:** `data/skill-table.json` (already shipped — see
// character-info.js:9-12). Each entry has `name`, `iconIdHex`,
// `trainedCost`, `specializedCost`, `category`, `learnMod`, etc.
//
// **Acceptance tests:** see `test_train_skill.mjs` for the pure helpers
// (`computeNextRaiseCost`, `decideTrainAction`, `nextStateForAction`).

import { setAcText } from "../ui/ac_font.js";

const STYLE_ID = "hb-trainskills-style";

// ─── Pure helpers ─────────────────────────────────────────────────
// Exported so test_train_skill.mjs can drive them without booting wasm
// or the DOM. Mirrors the pattern in plugins/lifestone-popup.js.

/**
 * AC skill `training` enum (TrainingLevel in holtburger_common::stats):
 *   0 = Unusable      — class can't train (e.g. magic for some heritages)
 *   1 = Untrained     — eligible to train; costs `trainedCost` credits
 *   2 = Trained       — can be raised with XP; can also specialize
 *                       (costs `specializedCost` credits + augmentation
 *                       for some skills per AUG_SPEC_SKILLS list)
 *   3 = Specialized   — can be raised at the higher-ceiling specialized
 *                       rate
 */
export const TRAINING = Object.freeze({
  UNUSABLE: 0,
  UNTRAINED: 1,
  TRAINED: 2,
  SPECIALIZED: 3,
});

/**
 * Returns the next-rank XP cost for a skill given the latest snapshot
 * row from `playerStats().skills` (a 6-tuple `[id, current, base,
 * ranks, training, next_rank_cost]`). `snap.xp` is the index-5
 * MARGINAL next-rank cost (next_rank_xp − spent_xp, computed Rust-side)
 * — directly usable as the raise-cost preview, no client-side curve.
 *
 * Returns `null` when the skill is at max rank, not yet hydrated, or
 * the snapshot row is malformed.
 *
 * @param {{ training: number, xp: number }} snap
 * @returns {number|null}
 */
export function computeNextRaiseCost(snap) {
  if (!snap || typeof snap.xp !== "number" || snap.xp <= 0) return null;
  if (snap.training !== TRAINING.TRAINED && snap.training !== TRAINING.SPECIALIZED) {
    return null;
  }
  return snap.xp >>> 0;
}

/**
 * Pure dispatch helper — given a UI action (`raise`/`train`/`cancel`),
 * a player snapshot row, and a client facade, compute the method name +
 * args the plugin will invoke. Returns `{called: null, args: []}` for
 * no-op actions so test assertions stay deterministic.
 *
 * @param {{ kind: "train"|"raise"|"cancel", skillId: number,
 *           cost: number, availableXp: number, availableCredits: number }} action
 * @param {{ player?: { raiseSkill?: Function, trainSkill?: Function } }} client
 * @returns {{ called: string|null, args: any[], reason?: string }}
 */
export function decideTrainAction(action, client) {
  if (action.kind === "train") {
    if (action.cost > action.availableCredits) {
      return { called: null, args: [], reason: "insufficient-credits" };
    }
    if (typeof client?.player?.trainSkill !== "function") {
      return { called: null, args: [], reason: "no-facade" };
    }
    return { called: "trainSkill", args: [action.skillId >>> 0, action.cost >>> 0] };
  }
  if (action.kind === "raise") {
    if (action.cost > action.availableXp) {
      return { called: null, args: [], reason: "insufficient-xp" };
    }
    if (typeof client?.player?.raiseSkill !== "function") {
      return { called: null, args: [], reason: "no-facade" };
    }
    return { called: "raiseSkill", args: [action.skillId >>> 0, action.cost >>> 0] };
  }
  return { called: null, args: [], reason: "noop" };
}

// ─── Manifest (Wave 6.B pattern — also dropped at *.manifest.json sidecar) ─
export const manifest = {
  id: "train-skills",
  name: "Train Skills",
  icon: "📜",
  iconHidden: true,
  version: "0.1.0",
  description: "Train + raise skills (Wave 4.A) — spend credits / XP.",
};

// ─── Helpers ──────────────────────────────────────────────────────
// Wasm flat-array snapshots come back as `Uint32Array` (real array) or
// as an object-shaped accessor. tupleArrayAt unifies both for the
// renderer's strided reads.
function tupleArrayAt(arr, i) {
  if (Array.isArray(arr)) return arr[i];
  if (arr && typeof arr === "object") {
    if (typeof arr.length === "number") return arr[i];
    return arr[i];
  }
  return undefined;
}

function getStats() {
  const s = window.__pluginClient?.player?.stats;
  if (!s) return null;
  try {
    return {
      name: s.name,
      // Rust src/lib.rs:16183 / 16191 — actual 4/5-tuple layouts:
      attributes: s.attributes,   // [type, current, base, ranks] × 6
      skills: s.skills,           // [type, current, base, ranks, training] × N
      levelInfo: s.levelInfo,     // [level, xp_lo, xp_hi, unspent_lo, unspent_hi, lum_lo, lum_hi]
    };
  } catch (_) { return null; }
}

function getAvailableCredits() {
  try { return window.__pluginClient?.player?.skillCredits >>> 0; }
  catch (_) { return 0; }
}

function getAvailableXp(stats) {
  // level_info is [level, current_xp_lo, current_xp_hi,
  //                unspent_xp_lo, unspent_xp_hi, lum_lo, lum_hi].
  // `unspent_xp` is the spendable-on-stats pool (= player_available_experience
  // from holtburger-world; see src/lib.rs:23474-23475).
  const lv = stats?.levelInfo;
  if (!lv) return 0;
  const lo = tupleArrayAt(lv, 3) ?? 0;
  const hi = tupleArrayAt(lv, 4) ?? 0;
  // Combine into a JS number — safe up to 2^53; AC caps unspent XP well
  // below that.
  return (hi >>> 0) * 0x1_0000_0000 + (lo >>> 0);
}

/**
 * Build a per-skill snapshot map keyed by skillId, merging the wasm
 * stats vector with the skill-table-driven catalog row. Each value is
 * `{ id, name, iconIdHex, training, base, current, xp, trainedCost,
 * specializedCost, category }`. Missing-from-server skills get
 * `training: 0` so the renderer can still surface them.
 */
function mergeSkillRows(stats, skillTable) {
  const out = new Map();
  const cat = skillTable?.skills || [];
  for (const sk of cat) {
    out.set(sk.skillIdInt, {
      id: sk.skillIdInt,
      name: sk.name,
      iconIdHex: sk.iconIdHex,
      training: TRAINING.UNUSABLE,
      base: 0,
      current: 0,
      xp: 0,
      trainedCost: sk.trainedCost ?? 0,
      specializedCost: sk.specializedCost ?? 0,
      category: sk.category,
    });
  }
  const playerSkills = stats?.skills;
  if (playerSkills) {
    const len = playerSkills.length ?? 0;
    for (let i = 0; i + 5 < len; i += 6) {
      // Rust src/lib.rs publish_player_stats_snapshot layout is the stride-6
      // `[type, current, base, ranks, training, next_rank_cost]`. `ranks` is
      // the XP-derived rank counter (1..10); `training` is the
      // `SkillAdvancementClass` enum (Inactive=0..Specialized=3); index 5 is
      // the MARGINAL xp to advance one rank (0 = max/unraisable).
      const id = tupleArrayAt(playerSkills, i);
      const cur = tupleArrayAt(playerSkills, i + 1);
      const base = tupleArrayAt(playerSkills, i + 2);
      const ranks = tupleArrayAt(playerSkills, i + 3);
      const trained = tupleArrayAt(playerSkills, i + 4);
      const entry = out.get(id);
      if (!entry) continue;
      entry.training = trained ?? 0;
      entry.base = base ?? 0;
      entry.current = cur ?? 0;
      entry.ranks = ranks ?? 0;
      // index 5 is the MARGINAL next-rank cost (computeNextRaiseCost treats
      // snap.xp as already-marginal).
      entry.xp = tupleArrayAt(playerSkills, i + 5) ?? 0;
    }
  }
  return out;
}

// ─── Styles ───────────────────────────────────────────────────────
function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    .hb-ts-root {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      background: rgba(0, 0, 0, 0.35);
      color: var(--hb-text-cream, #e8d8b0);
    }
    .hb-ts-head {
      flex: 0 0 auto;
      padding: 6px 10px;
      border-bottom: 1px solid var(--hb-border-brass-dim, rgba(176, 138, 74, 0.4));
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--hb-text-gold, #d4af37);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .hb-ts-head-balance {
      font-size: 10px;
      color: var(--hb-text-numeric-green, #8aef6d);
      font-variant-numeric: tabular-nums;
    }
    .hb-ts-body {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 4px 0;
    }
    .hb-ts-section {
      font-size: 9px;
      color: #6acaca;
      background: rgba(0, 60, 70, 0.35);
      padding: 3px 8px;
      margin: 4px 0 2px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border-bottom: 1px solid rgba(106, 202, 202, 0.4);
    }
    .hb-ts-row {
      display: grid;
      grid-template-columns: 22px 1fr auto auto;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      font-size: 10px;
      line-height: 18px;
    }
    .hb-ts-row:hover { background: rgba(60, 44, 24, 0.5); }
    .hb-ts-row.selected { background: rgba(80, 60, 30, 0.65); }
    .hb-ts-icon {
      width: 20px;
      height: 20px;
      background-repeat: no-repeat;
      background-size: contain;
      background-position: center;
      image-rendering: pixelated;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.7));
    }
    .hb-ts-name { color: var(--hb-text-cream, #e8d8b0); }
    .hb-ts-value {
      font-variant-numeric: tabular-nums;
      color: var(--hb-text-numeric-green, #8aef6d);
      min-width: 36px;
      text-align: right;
    }
    .hb-ts-btn {
      padding: 1px 8px;
      font-family: var(--hb-font-serif, serif);
      font-size: 10px;
      color: var(--hb-text-cream, #e8d8b0);
      background: linear-gradient(180deg,
        rgba(60, 44, 24, 0.9) 0%,
        rgba(40, 28, 16, 0.9) 100%);
      border: 1px solid var(--hb-border-brass, #b08a4a);
      cursor: pointer;
      min-width: 60px;
      text-align: center;
    }
    .hb-ts-btn:hover {
      background: linear-gradient(180deg,
        rgba(80, 60, 30, 0.95) 0%,
        rgba(55, 40, 22, 0.95) 100%);
      color: var(--hb-text-gold, #d4af37);
    }
    .hb-ts-dot {
      width: 13px; height: 13px;
      flex: 0 0 13px;
      background: center/contain no-repeat;
      image-rendering: pixelated;
    }
    .hb-ts-btn[disabled], .hb-ts-btn[disabled]:hover {
      opacity: 0.4;
      cursor: not-allowed;
      color: var(--hb-text-muted-3, #a08868);
      background: rgba(30, 22, 12, 0.5);
    }
    .hb-ts-cost {
      font-size: 9px;
      color: var(--hb-text-muted-3, #a08868);
      margin-top: -2px;
    }
    .hb-ts-empty {
      padding: 14px 12px;
      color: var(--hb-text-muted, #a8a090);
      font-style: italic;
      text-align: center;
      font-size: 10px;
    }
    .hb-ts-footer {
      flex: 0 0 auto;
      padding: 4px 8px;
      border-top: 1px solid var(--hb-border-brass-dim, rgba(176, 138, 74, 0.4));
      font-size: 9px;
      color: var(--hb-text-muted, #a8a090);
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
  `;
  document.head.appendChild(s);
}

// ─── Skill-table loader ───────────────────────────────────────────
let skillTablePromise = null;
function loadSkillTable() {
  if (!skillTablePromise) {
    skillTablePromise = fetch("./data/skill-table.json")
      .then((r) => r.json())
      .catch((e) => { console.warn("[train-skills] skill-table load failed", e); return { skills: [] }; });
  }
  return skillTablePromise;
}

// ─── Rendering ───────────────────────────────────────────────────
function makeIconUrl(iconIdHex) {
  if (!iconIdHex) return null;
  return `./data/ui-sprites/${iconIdHex}.png`;
}

function renderSection(label) {
  const el = document.createElement("div");
  el.className = "hb-ts-section";
  setAcText(el, label, { color: "#6acaca" });
  return el;
}

function renderRow(opts) {
  // opts: { skill, snap, availableCredits, availableXp, onTrain, onRaise }
  const { skill, snap, availableCredits, availableXp, onTrain, onRaise } = opts;
  const iconUrl = makeIconUrl(skill.iconIdHex);
  const row = document.createElement("div");
  row.className = "hb-ts-row";
  row.dataset.skillId = String(skill.id);

  const icon = document.createElement("div");
  icon.className = "hb-ts-icon";
  if (iconUrl) icon.style.backgroundImage = `url("${iconUrl}")`;
  row.appendChild(icon);

  const name = document.createElement("div");
  name.className = "hb-ts-name";
  setAcText(name, skill.name, { color: "#f0d8a0" });
  row.appendChild(name);

  const value = document.createElement("div");
  value.className = "hb-ts-value";
  // Display "base" — what `character-info.js` shows; mirrors the
  // retail skill-list rendering.
  setAcText(value, String(snap.base ?? "—"), { color: "#8aef6d" });
  row.appendChild(value);

  // Eligibility dot (gmStatManagementUI 0x06004D17 green / 0x06004D19 red)
  // — visualizes "can afford" status alongside the existing Train/Raise
  // text button. Same convention as the Attributes raise rows so the two
  // tabs read the same way.
  const dot = document.createElement("div");
  dot.className = "hb-ts-dot";
  let canAfford = false;
  if (snap.training === TRAINING.UNTRAINED) {
    canAfford = (skill.trainedCost ?? 0) > 0 && (skill.trainedCost ?? 0) <= availableCredits;
  } else if (snap.training === TRAINING.TRAINED || snap.training === TRAINING.SPECIALIZED) {
    const xc = computeNextRaiseCost(snap);
    canAfford = xc != null && xc <= availableXp;
  }
  dot.style.backgroundImage = `url("./data/ui-sprites/${canAfford ? "0x06004D17" : "0x06004D19"}.png")`;
  row.appendChild(dot);

  const action = document.createElement("button");
  action.type = "button";
  action.className = "hb-ts-btn";

  if (snap.training === TRAINING.UNTRAINED) {
    const cost = skill.trainedCost ?? 0;
    setAcText(action, `Train (${cost})`, { color: "#e8d8b0" });
    action.title = `Train this skill for ${cost} skill credits`;
    if (cost === 0 || cost > availableCredits) action.disabled = true;
    action.addEventListener("click", () => onTrain(skill.id, cost));
  } else if (snap.training === TRAINING.TRAINED || snap.training === TRAINING.SPECIALIZED) {
    const xpCost = computeNextRaiseCost(snap);
    if (xpCost == null) {
      setAcText(action, "Max", { color: "#a08868" });
      action.disabled = true;
    } else {
      setAcText(action, `Raise (${xpCost})`, { color: "#e8d8b0" });
      action.title = `Spend ${xpCost} XP to raise this skill`;
      if (xpCost > availableXp) action.disabled = true;
      action.addEventListener("click", () => onRaise(skill.id, xpCost));
    }
  } else {
    // Unusable.
    setAcText(action, "—", { color: "#a08868" });
    action.disabled = true;
  }
  row.appendChild(action);
  return row;
}

function renderBody(bodyEl, stats, skillTable, availableCredits, availableXp, hooks) {
  bodyEl.innerHTML = "";
  if (!skillTable?.skills?.length) {
    const e = document.createElement("div");
    e.className = "hb-ts-empty";
    setAcText(e, "Skill table not loaded.", { color: "#a8a090" });
    bodyEl.appendChild(e);
    return;
  }
  const merged = mergeSkillRows(stats, skillTable);
  // Sort tiers like character-info: Specialized → Trained → Untrained → Unusable.
  const tiers = {
    [TRAINING.SPECIALIZED]: { label: "Specialized", items: [] },
    [TRAINING.TRAINED]:     { label: "Trained",     items: [] },
    [TRAINING.UNTRAINED]:   { label: "Available to Train", items: [] },
    [TRAINING.UNUSABLE]:    { label: "Unusable",    items: [] },
  };
  for (const sk of skillTable.skills) {
    const snap = merged.get(sk.skillIdInt) ?? {
      training: TRAINING.UNUSABLE, base: 0, current: 0, xp: 0,
    };
    const tier = tiers[snap.training] ?? tiers[TRAINING.UNUSABLE];
    tier.items.push({ skill: sk, snap });
  }
  for (const key of [TRAINING.UNTRAINED, TRAINING.TRAINED, TRAINING.SPECIALIZED, TRAINING.UNUSABLE]) {
    const tier = tiers[key];
    if (!tier.items.length) continue;
    bodyEl.appendChild(renderSection(tier.label));
    for (const { skill, snap } of tier.items) {
      // Normalise the skill row to the merged catalog entry (the
      // skill-table.json shape uses skillIdInt; the merged entry adds
      // the snap fields). renderRow expects the merged entry's `.id`,
      // `.iconIdHex`, etc.
      const sk = {
        id: skill.skillIdInt,
        name: skill.name,
        iconIdHex: skill.iconIdHex,
        trainedCost: skill.trainedCost ?? 0,
        specializedCost: skill.specializedCost ?? 0,
      };
      bodyEl.appendChild(renderRow({
        skill: sk,
        snap,
        availableCredits,
        availableXp,
        onTrain: hooks.onTrain,
        onRaise: hooks.onRaise,
      }));
    }
  }
}

// ─── View ────────────────────────────────────────────────────────
function doMount(parentEl, _ctx) {
  ensureStyles();

  const root = document.createElement("div");
  root.className = "hb-ts-root";

  const headEl = document.createElement("div");
  headEl.className = "hb-ts-head";
  const headTitle = document.createElement("span");
  setAcText(headTitle, "Train Skills", { color: "#d4af37" });
  const headBalance = document.createElement("span");
  headBalance.className = "hb-ts-head-balance";
  headEl.appendChild(headTitle);
  headEl.appendChild(headBalance);
  root.appendChild(headEl);

  const bodyEl = document.createElement("div");
  bodyEl.className = "hb-ts-body";
  root.appendChild(bodyEl);

  const footerEl = document.createElement("div");
  footerEl.className = "hb-ts-footer";
  const footL = document.createElement("span");
  const footR = document.createElement("span");
  setAcText(footL, "—", { color: "#a8a090" });
  setAcText(footR, "", { color: "#a8a090" });
  footerEl.appendChild(footL);
  footerEl.appendChild(footR);
  root.appendChild(footerEl);

  parentEl.appendChild(root);

  // Action dispatchers — delegate to the pure decideTrainAction helper
  // so the wire dispatch is testable + reproducible. On insufficient
  // credits / xp the button is already disabled in renderRow, but a
  // defensive check here ensures replays via console don't bypass the
  // gate.
  const client = window.__pluginClient ?? null;
  function dispatch(action) {
    const decision = decideTrainAction(action, client);
    if (decision.called === "trainSkill") {
      try { client.player.trainSkill(...decision.args); }
      catch (e) { console.warn("[train-skills] trainSkill failed:", e); }
    } else if (decision.called === "raiseSkill") {
      try { client.player.raiseSkill(...decision.args); }
      catch (e) { console.warn("[train-skills] raiseSkill failed:", e); }
    } else if (decision.reason) {
      console.log(`[train-skills] no-op (${decision.reason})`);
    }
  }

  let skillTable = null;
  function rerender() {
    const stats = getStats();
    const availableCredits = getAvailableCredits();
    const availableXp = getAvailableXp(stats);
    setAcText(
      headBalance,
      `Credits: ${availableCredits}   XP: ${availableXp.toLocaleString()}`,
      { color: "#8aef6d" },
    );
    renderBody(bodyEl, stats, skillTable, availableCredits, availableXp, {
      onTrain: (skillId, cost) => dispatch({
        kind: "train",
        skillId,
        cost,
        availableXp,
        availableCredits,
      }),
      onRaise: (skillId, cost) => dispatch({
        kind: "raise",
        skillId,
        cost,
        availableXp,
        availableCredits,
      }),
    });
    const lv = stats?.levelInfo;
    setAcText(
      footL,
      lv ? `Level ${tupleArrayAt(lv, 0) ?? 1}` : "—",
      { color: "#a8a090" },
    );
    setAcText(footR, "Server is authoritative", { color: "#a8a090" });
  }

  // Load skill table then render.
  loadSkillTable().then((st) => { skillTable = st; rerender(); });
  rerender();

  // Subscribe to playerStatsUpdated for live re-render after
  // RaiseSkill / TrainSkill round-trips. ACE echoes back with a
  // PrivateUpdateSkill that already drives a stats publish.
  let off = null;
  if (client?.events?.on) {
    const onStats = () => rerender();
    client.events.on("playerStatsUpdated", onStats);
    off = () => { try { client.events.off("playerStatsUpdated", onStats); } catch (_) {} };
  }

  return () => {
    if (off) off();
    root.remove();
  };
}

// ─── Plugin view export (Wave 2 PR-Z / main-panel.registerView pattern) ─
// Same shape as plugins/spellbook.js's `view` export — mounts under
// `mainPanelPlugin.registerView("train-skills", view)` and is toggled via
// F11 (PLUGIN_HOTKEY_DISPATCH bridge in index.html — see Wave 4.A
// integration). The retail equivalent (gmSkillUI in
// gmCharacterInfoUI) inlines this into the Character tab strip; our
// dedicated panel keeps the wave-4.A scope self-contained and lets
// character-info.js stay read-only without arbitration.
export const view = {
  name: "Train Skills",
  nameFor: () => "Train Skills",
  mount: (parentEl, ctx) => doMount(parentEl, ctx),
};
