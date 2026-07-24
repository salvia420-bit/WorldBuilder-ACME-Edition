// Regression test for two rynth item-awareness fixes (2026-07-23):
//   1. observe_ext.js inventory line surfaces REAL item properties (usable
//      kind + attuned/bonded tags) so the director reasons from properties,
//      not name guesses.
//   2. tools/world.js drop_item action GUARDS against discarding a usable tool
//      (gem/key/portal/…) or an attuned/bonded item unless force:true — the
//      "wanted to use its portal gem but dropped it first" bug.
//
// Run: cd apps/holtburger-web/ && node tests/test_drop_guard_item_tags.mjs
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const worldUrl = "file://" + resolvePath(__dirname, "..", "rynth/ai/tools/world.js");
const obsUrl = "file://" + resolvePath(__dirname, "..", "rynth/ai/observe_ext.js");
const { dropItemAction } = await import(worldUrl);
const { enrichObservation } = await import(obsUrl);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); } };

// ItemType bits (ACE.Entity.Enum.ItemType)
const T = { Misc: 0x80, Jewelry: 0x8, Gem: 0x800, Key: 0x4000, Portal: 0x10000 };
const INV = [
  { name: "Facility Hub Portal Gem", guid: 0x1001, equipMask: 0, itemType: T.Gem, attuned: 0, bonded: 0, stackSize: 1 },
  { name: "Bound Ring",              guid: 0x1002, equipMask: 0, itemType: T.Jewelry, attuned: 1, bonded: 0, stackSize: 1 },
  { name: "Quest Token",             guid: 0x1003, equipMask: 0, itemType: T.Misc, attuned: 0, bonded: 1, stackSize: 1 },
  { name: "Rusty Junk",              guid: 0x1004, equipMask: 0, itemType: T.Misc, attuned: 0, bonded: 0, stackSize: 1 },
  { name: "Prison Key",              guid: 0x1005, equipMask: 0, itemType: T.Key, attuned: 0, bonded: 0, stackSize: 1 },
];

// ── Item 1: inventory observation carries real property tags ──────────────
{
  const bot = { host: { TryGetPlayerInventory: () => INV } };
  const out = enrichObservation(bot, { text: "BASE", data: {} }, {});
  const text = out && out.text ? out.text : "";
  ok(text.includes("Facility Hub Portal Gem [gem]"), "gem item tagged [gem]");
  ok(text.includes("Prison Key [key]"), "key item tagged [key]");
  ok(text.includes("Bound Ring [attuned]"), "attuned item tagged [attuned]");
  ok(text.includes("Quest Token [bonded]"), "bonded item tagged [bonded]");
  ok(text.includes("Rusty Junk;") || /Rusty Junk( |$)/.test(text), "plain item has no tag");
  ok(!/Rusty Junk \[/.test(text), "plain item is NOT tagged");
}

// ── Item 2: drop_item planning guard ──────────────────────────────────────
const drop = dropItemAction();
async function tryDrop(item, force) {
  const dropped = [];
  const host = { TryGetPlayerInventory: () => INV, DropItem: (g) => { dropped.push(g >>> 0); return true; } };
  const args = force ? { type: "drop_item", item, force: true } : { type: "drop_item", item };
  const res = await drop.apply({ host }, args, { log: () => {} });
  return { res, dropped };
}
{
  const g = await tryDrop("Portal Gem");
  ok(g.res.ok === false && g.dropped.length === 0, "gem refused without force");
  ok(/usable tool/i.test(g.res.error || ""), "gem refusal mentions usable tool");

  const k = await tryDrop("Prison Key");
  ok(k.res.ok === false && k.dropped.length === 0, "key refused without force");

  const a = await tryDrop("Bound Ring");
  ok(a.res.ok === false && a.dropped.length === 0, "attuned refused without force");
  ok(/attuned/i.test(a.res.error || ""), "attuned refusal mentions attuned");

  const b = await tryDrop("Quest Token");
  ok(b.res.ok === false && b.dropped.length === 0, "bonded refused without force");
  ok(/bonded/i.test(b.res.error || ""), "bonded refusal mentions bonded");

  const p = await tryDrop("Rusty Junk");
  ok(p.res.ok === true && p.dropped.includes(0x1004), "plain junk drops normally");

  const f = await tryDrop("Portal Gem", true);
  ok(f.res.ok === true && f.dropped.includes(0x1001), "gem drops WITH force:true");
}

console.log(`\ndrop-guard + item-tags: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
