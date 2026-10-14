// tests/film_sites.test.mjs — film mode site gazetteer: source loaders, merged/teleport-ready sites, BM25 + lexicon search.
//
// WHY: film mode (`?filmMode=on`, flag filmMode, DEFAULT OFF) has a Claude Code director that matches lyric imagery
// to places in Dereth and teleports the hidden player there before each take (≈10 s per teleport). The gazetteer
// (tools/film/sites/{sources,build,search}.mjs + tools/film/data/concept_lexicon.json) is that place list: every
// site must carry a working teleport (exact @teleloc when the position is known, @telepoi for ACE points of
// interest, @teledungeon / @tele otherwise), duplicates across the eight sources must merge (Holtburg once), the
// noisy acpedia wikitext must be stripped, and lyric search must favour the right KIND of place ("lonely snowy
// mountain" → wilderness, not a town). This suite builds the REAL code from small VERBATIM excerpts of the real
// data files (tests/fixtures/film/sites_*), writes only to os.tmpdir(), and — when the real files exist on this
// machine — also builds the full gazetteer once and checks its size, town coverage and build time.
//
// Run from apps/holtburger-web/: node tests/film_sites.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadLocations,
  loadPoiDestinations,
  loadAtlas,
  loadTowns,
  loadPoiGazetteer,
  loadAcpedia,
  parseLocationsText,
  stripWikitext,
  cleanLoreText,
  compactKey,
  isBogusPosition,
  spawnCellOf,
  streamSpawns,
  landmarkTypeOf,
  mapFromWorld,
} from "../tools/film/sites/sources.mjs";
import {
  buildGazetteer,
  writeGazetteer,
  telelocCmd,
  teleMapCmd,
  teledungeonCmd,
  headingQuatDeg,
  telelocForSite,
  featureTags,
  leadSentence,
  SITE_KINDS,
  DEFAULT_PATHS,
  DEFAULT_GAZETTEER_PATH,
} from "../tools/film/sites/build.mjs";
import {
  searchSites,
  expandQuery,
  explainSite,
  siteWords,
  loadGazetteer,
  loadLexicon,
  tokenize,
  stemToken,
  DEFAULT_LEXICON_PATH,
} from "../tools/film/sites/search.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures", "film");
const FIXTURE_PATHS = {
  locations: path.join(FIX, "sites_locations.txt"),
  poiDestinations: path.join(FIX, "sites_poi_destinations.json"),
  towns: path.join(FIX, "sites_towns.mjs"),
  townGazetteer: path.join(FIX, "sites_town_gazetteer.json"),
  regionGazetteer: path.join(FIX, "sites_region_gazetteer.json"),
  poiGazetteer: path.join(FIX, "sites_poi_gazetteer.json"),
  atlas: path.join(FIX, "sites_atlas.jsonl"),
  acpedia: path.join(FIX, "sites_acpedia.json"),
  spawns: path.join(FIX, "sites_spawns.jsonl"),
  weenieIndex: path.join(FIX, "sites_weenie_index.jsonl"),
  objectTags: path.join(FIX, "sites_object_tags.json"),
};

// SPEC §2.12 technique catalog (ids are API) — hard-coded so the lexicon cannot drift from the frozen contract.
const SPEC_TECHNIQUES = new Set([
  ...["static", "pan", "tilt", "roll", "zoom", "dolly-in", "dolly-out", "truck", "pedestal", "crane", "arc", "orbit",
    "tracking-follow", "tracking-lead", "tracking-side", "push-in", "pull-out-reveal", "dolly-zoom", "whip-pan",
    "rack-focus", "over-the-shoulder", "pov", "two-shot", "establishing", "high-angle", "low-angle", "birds-eye",
    "worms-eye", "handheld", "steadicam", "snorricam", "reveal-from-occluder", "time-lapse", "hyperlapse"].map((t) => `classic.${t}`),
  ...["flyover", "flythrough", "orbit-poi", "helix", "dronie", "boom-rise", "rising-reveal", "tilt-reveal", "top-down",
    "top-down-rise", "top-down-track", "pass-over", "parallax-slide", "terrain-skim", "canyon-run", "chase", "lead",
    "side-track", "boomerang", "fly-by", "spiral-descent", "pano-360", "hyperlapse-orbit", "vertigo-drone"].map((t) => `drone.${t}`),
  ...["fpv-dive", "fpv-proximity", "fpv-gap", "fpv-flip", "fpv-corridor"].map((t) => `fpv.${t}`),
]);
const TIMES_OF_DAY = new Set(["dawn", "morning", "noon", "golden", "dusk", "night"]);
const FOGS = new Set(["none", "white", "red", "blue", "green", "black"]);
const GRADES = new Set(["neutral", "warm", "cool", "bleach", "night"]);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e && e.message ? e.message : e}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e && e.message ? e.message : e}`);
  }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const one = (sites, pred, what) => {
  const l = sites.filter(pred);
  assert.equal(l.length, 1, `${what}: expected exactly one site, got ${l.length} (${l.map((s) => s.id).join(", ")})`);
  return l[0];
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "film-sites-"));
let FX = null; // fixture build without spawns
let FXS = null; // fixture build with spawns (+ weenie index + object tags)
let buildError = null;
try {
  FX = await buildGazetteer({ paths: { ...FIXTURE_PATHS, spawns: undefined }, log: () => {} });
  FXS = await buildGazetteer({ paths: FIXTURE_PATHS, includeSpawns: true, log: () => {} });
} catch (e) {
  buildError = e;
}
const sites = FX ? FX.sites : [];
const byName = (n) => sites.filter((s) => s.name === n);

// ── sources.mjs ──────────────────────────────────────────────────────────────────────────────────────
check("fixture builds ran without throwing", () => {
  assert.equal(buildError, null, buildError && buildError.stack);
  assert.ok(sites.length > 40, `only ${sites.length} sites`);
});

check("Locations.txt parser: bracketed and bracket-less rows, exact numbers, indoor flag", () => {
  const rows = loadLocations(FIXTURE_PATHS.locations);
  assert.equal(rows.length, 44);
  const h = rows.find((r) => r.name === "Holtburg" && r.type === "Town");
  assert.equal(h.cell, 0xa9b40019);
  assert.deepEqual(h.local, { x: 84, y: 7.1, z: 94 });
  assert.deepEqual(h.quat, [0.996917, 0, 0, -0.078459]);
  assert.equal(h.indoor, false);
  const c = rows.find((r) => r.name === "Crater Lake Village");
  assert.deepEqual(c.local, { x: 95.521004, y: 84, z: 277.204987 }, "the one real row without brackets");
  assert.equal(rows.find((r) => r.name === "Holtburg Dungeon").indoor, true);
  const bad = parseLocationsText("﻿garbage line\nA Cave | Dungeon | 0x018B0191 [50 -10 0] -0.003491 0 0 -0.999994\n");
  assert.equal(bad.length, 1, "BOM stripped, garbage skipped");
});

check("loaders tolerate a missing file and a BOM (warn, skip — never throw)", () => {
  const log = [];
  assert.deepEqual(loadLocations(path.join(TMP, "nope.txt"), { log: (m) => log.push(m) }), []);
  assert.equal(loadAtlas(path.join(TMP, "nope.jsonl"), { log: (m) => log.push(m) }).size, 0);
  assert.deepEqual(loadPoiDestinations(undefined, { log: (m) => log.push(m) }), []);
  assert.ok(log.length >= 3 && log.every((m) => m.startsWith("[sites]")), log.join(" | "));
  const bomFile = path.join(TMP, "bom.json");
  fs.writeFileSync(bomFile, "﻿" + fs.readFileSync(FIXTURE_PATHS.poiDestinations, "utf8"));
  assert.equal(loadPoiDestinations(bomFile).length, 3);
});

await checkAsync("towns.js excerpt is parsed as text (5 rows); an array input works too", async () => {
  const t = await loadTowns(FIXTURE_PATHS.towns);
  assert.equal(t.length, 5);
  assert.deepEqual(t.find((x) => x.name === "Holtburg"), { source: "towns.js", name: "Holtburg", ns: 42.1, ew: 33.6 });
  assert.equal((await loadTowns([{ name: "X", ns: 1, ew: 2 }, { name: "" }])).length, 1);
});

check("POI gazetteer: place categories only, deduped by title, title coordinates win, wikitext stripped", () => {
  const p = loadPoiGazetteer(FIXTURE_PATHS.poiGazetteer);
  assert.ok(!p.some((r) => r.name === "Acid Emerald" || r.name === "50-100 Contracts Quest"), "spell gem / quest rows dropped");
  assert.equal(p.filter((r) => r.name === "Blackmire Swamp").length, 1, "three rows → one");
  const z = p.find((r) => r.name === "Zefir Tower");
  assert.equal(z.coordSource, "title");
  assert.ok(near(z.ns, 72.2, 1e-9) && near(z.ew, -36.1, 1e-9), "title prefix 72.2N, 36.1W beats the field lat/lng");
  assert.ok(p.some((r) => r.name === "Tou-Tou"), "Tou-Tou/Archive → Tou-Tou");
  for (const r of p) {
    for (const bad of ["===", "<br", "{{", "}}", "[[", "{|", "__TOC__"]) assert.ok(!r.description.includes(bad), `${r.name}: ${bad} in "${r.description}"`);
  }
  assert.equal(stripWikitext("}} === Description === The largest volcano in Dereth. [[File:x.png|thumb|cap]] ''bold''"), "The largest volcano in Dereth. bold");
  assert.equal(stripWikitext("=== Route === : or"), "", "nothing readable left → empty");
});

check("acpedia loader: entity rows flagged, LB aliases + coordinate hints split from name aliases, lore cleaned", () => {
  const a = loadAcpedia(FIXTURE_PATHS.acpedia);
  assert.equal(a.find((r) => r.title === "Odvik the Inn Keeper").entity, true);
  assert.equal(a.find((r) => r.title === "Storage").entity, true, "a 'Loot Tier:' item row is not a place");
  const hd = a.find((r) => r.title === "Holtburg Dungeon");
  assert.deepEqual(hd.lbAliases, [0x01f6]);
  assert.deepEqual(hd.coords, { ns: 43.6, ew: 33.0 });
  assert.ok(hd.text.startsWith("Route: Short run north"), hd.text);
  const me = a.find((r) => r.title === "Mount Esper");
  assert.deepEqual(me.aliases, ["Crater"]);
  assert.equal(me.coordHints.length, 2, "coordinate-titled aliases become hints");
  assert.equal(cleanLoreText("Coordinates: N/A | Location: Landscape | Route: Mountain Cavern.. (Rumor) A door."), "Route: Mountain Cavern. (Rumor) A door.");
});

check("spawn cell rebuild (cell == 0) and bogus-position guard", () => {
  // Holtburg life stone: landblockId 43444 (0xA9B4), cell 0, x 81.3304 y 11.7974 → outdoor cell 0x19
  assert.equal(spawnCellOf(0xa9b4, 0, 81.3304, 11.7974), 0xa9b40019);
  assert.equal(spawnCellOf(0x0111, 265, 6.3, -20.8), 0x01110109, "indoor cell kept");
  assert.equal(isBogusPosition(0xe53f0026, { x: 0, y: 0, z: 0 }), true, "JumpShaft placeholder");
  assert.equal(isBogusPosition(0x9f440012, { x: 90, y: 24.553, z: 31.885 }), false, "mismatched cell index is kept (ACE accepts it)");
});

await checkAsync("spawn stream: landmarks only (life stones, named portals, statues, fountains), creatures and generic portals skipped", async () => {
  const r = await streamSpawns(FIXTURE_PATHS.spawns);
  const names = r.landmarks.map((l) => l.name).sort();
  assert.deepEqual(names, ["Destroyed Portal to Redspire", "Fountain", "Holtburg Meeting Hall Portal", "Life Stone", "Life Stone", "Nullified Statue of a Drudge"]);
  assert.equal(r.lines, 9);
  assert.ok(r.elevation.get(0xa9b4).n >= 2, "outdoor elevation stats per landblock");
  assert.equal(await streamSpawns(path.join(TMP, "missing.jsonl"), { log: () => {} }), null);
});

// ── build.mjs ────────────────────────────────────────────────────────────────────────────────────────
check("teleport command formats (SPEC §2.8 order; source precision kept)", () => {
  assert.equal(telelocCmd(0xa9b40019, { x: 84, y: 7.1, z: 94 }, [0.996917, 0, 0, -0.078459]), "@teleloc 0xA9B40019 84 7.1 94 0.996917 0 0 -0.078459");
  assert.equal(telelocCmd("0x90D00107", { x: 95.521004, y: 84, z: 277.204987 }, null), "@teleloc 0x90D00107 95.521004 84 277.204987 1 0 0 0");
  assert.equal(teleMapCmd(42.0796, 33.6), "@tele 42.08N 33.60E");
  assert.equal(teleMapCmd(-74.59, -2.5), "@tele 74.59S 2.50W");
  assert.equal(teledungeonCmd(0x01f6), "@teledungeon 01F6");
  const q = headingQuatDeg(90);
  assert.ok(near(q[0], Math.SQRT1_2, 1e-12) && near(q[3], -Math.SQRT1_2, 1e-12) && q[1] === 0 && q[2] === 0, "qw=cos θ/2, qz=−sin θ/2");
});

check("Holtburg appears ONCE: merged from 6 sources, @telepoi best + exact @teleloc, LB 0xA9B4, ≈ 42.1N 33.6E", () => {
  const h = one(sites, (s) => s.name === "Holtburg", "Holtburg");
  assert.equal(h.id, "holtburg");
  assert.equal(h.kind, "town");
  assert.equal(h.lb, "0xA9B4");
  assert.equal(h.cell, "0xA9B40019");
  assert.equal(h.indoor, false);
  assert.equal(h.teleport.telepoi, "@telepoi Holtburg");
  assert.equal(h.teleport.best, "@telepoi Holtburg");
  assert.equal(h.teleport.teleloc, "@teleloc 0xA9B40019 84 7.1 94 0.996917 0 0 -0.078459");
  assert.ok(near(h.map.ns, 42.1, 0.05) && near(h.map.ew, 33.6, 0.05), JSON.stringify(h.map));
  assert.deepEqual(h.pos, [169 * 192 + 84, 180 * 192 + 7.1, 94]);
  assert.deepEqual(h.local, { x: 84, y: 7.1, z: 94 });
  for (const s of ["locations", "poi-destinations", "towns.js", "town-gazetteer", "poi-gazetteer", "acpedia"]) assert.ok(h.sources.includes(s), `source ${s}`);
  assert.equal(h.culture, "Aluvian");
  assert.equal(h.region, "Aluvian Heartlands");
  assert.equal(h.notes, "starter town");
  assert.ok(h.lore.includes("River Prosper") && !h.lore.startsWith("Location:"), h.lore);
  assert.ok(h.tags.includes("town") && h.tags.includes("river"), h.tags.join(","));
  assert.ok(!h.tags.includes("olthoi"), "lore past the first sentence does not leak tags");
  assert.ok(!sites.some((s) => s.name === "Holtburg Portal" || /^Exit to|^Destroyed Portal to/.test(s.name)), "portal/exit destination names merge, never create");
});

check("a Locations.txt dungeon is indoor with an exact @teleloc; acpedia adds the entrance + @teledungeon", () => {
  const d = one(sites, (s) => s.name === "Holtburg Dungeon", "Holtburg Dungeon");
  assert.equal(d.kind, "dungeon");
  assert.equal(d.indoor, true);
  assert.equal(d.lb, "0x01F6");
  assert.equal(d.teleport.best, "@teleloc 0x01F60289 96.7 -10 0 -0.719279 0 0 -0.694721");
  assert.equal(d.teleport.teledungeon, "@teledungeon 01F6");
  assert.deepEqual(d.map, { ns: 43.6, ew: 33 }, "map = the outdoor entrance (acpedia Coordinates)");
  assert.equal(d.teleport.tele, "@tele 43.60N 33.00E");
  assert.ok(!/Coordinates:|Location:/.test(d.lore), d.lore);
  const mine = one(sites, (s) => s.name === "Abandoned Mine", "Abandoned Mine");
  assert.deepEqual(mine.aliases.sort(), ["Sub", "Subway"]);
  const nests = sites.filter((s) => s.name === "A Drudge Nest");
  assert.deepEqual(nests.map((s) => s.id).sort(), ["a-drudge-nest-01d8", "a-drudge-nest-01dc"], "same name, two dungeons → ids carry the landblock");
});

check("acpedia-only dungeons fall back to @teledungeon; @telepoi beats @teleloc for ACE POIs", () => {
  const f = one(sites, (s) => s.name === "Lost City of Frore", "Frore");
  assert.equal(f.teleport.best, "@teledungeon 0138");
  assert.equal(f.indoor, true);
  const t = one(sites, (s) => s.name === "Tusker Tunnels", "Tusker Tunnels");
  assert.equal(t.teleport.best, "@teledungeon 5D45");
  assert.equal(t.teleport.tele, "@tele 0.30N 86.40E");
  const hs = one(sites, (s) => s.name === "Hotel Swank", "Hotel Swank");
  assert.equal(hs.teleport.best, "@telepoi Hotel Swank");
  assert.ok(hs.teleport.teleloc.startsWith("@teleloc 0x018A024F "));
});

check("junk / generic / placeholder destinations are skipped; '<X> Portal' names become places", () => {
  for (const n of ["Surface", "Exit portal", "JumpShaft6 Portal", "Icecliff Cottages Portal", "Icecliff Cottages", "Emote Test Portal", "Emote Test"]) {
    assert.ok(!sites.some((s) => s.name === n), `${n} must not be a site`);
  }
  const w = one(sites, (s) => s.name === "Cragstone Waterfall", "Cragstone Waterfall");
  assert.ok(w.tags.includes("waterfall"), w.tags.join(","));
  assert.ok(w.aliases.includes("Cragstone Waterfall Portal"));
  assert.equal(byName("Cragstone").length, 1, "both 'Cragstone Portal' rows merged into the town");
  assert.equal(byName("Al-Arqas").length, 1);
});

check("Mount Esper: tied POI coordinates resolved with acpedia hints; volcano tags from the lead sentence", () => {
  const m = one(sites, (s) => s.name === "Mount Esper", "Mount Esper");
  assert.deepEqual(m.map, { ns: 60.6, ew: 15.7 });
  assert.equal(m.teleport.best, "@tele 60.60N 15.70E");
  assert.ok(m.tags.includes("volcano") && m.tags.includes("fire"), m.tags.join(","));
  assert.ok(m.lore.startsWith("The largest volcano in Dereth"), m.lore);
});

check("wikitext stripped everywhere (no ===, <br>, {{, [[, __TOC__, Category:)", () => {
  for (const s of sites) {
    if (!s.lore) continue;
    for (const bad of ["===", "<br", "{{", "}}", "[[", "]]", "__TOC__", "Category:", "{|", "Click image"]) assert.ok(!s.lore.includes(bad), `${s.id}: "${bad}" in lore`);
  }
  assert.equal(leadSentence("Route: From X.. The tower stands on Mount Esper. More."), "The tower stands on  .");
  assert.ok(featureTags("The Frozen Tomb of the Lich").has("tomb") && featureTags("The Frozen Tomb of the Lich").has("undead"));
});

check("every site: valid kind, unique slug id, LB hex, teleport.best, exact ⇒ teleloc + local + quat", () => {
  const ids = new Set();
  for (const s of sites) {
    assert.ok(SITE_KINDS.includes(s.kind), s.kind);
    assert.match(s.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.match(s.lb, /^0x[0-9A-F]{4}$/);
    assert.ok(typeof s.teleport.best === "string" && s.teleport.best.startsWith("@"), `${s.id} best`);
    assert.ok(Object.values(s.teleport).includes(s.teleport.best));
    if (s.teleport.teleloc) {
      assert.ok(s.local && s.quat && s.pos && s.cell, `${s.id} exact fields`);
      assert.ok(s.teleport.teleloc.startsWith(`@teleloc ${s.cell} `));
    }
    if (s.cell) assert.ok(s.cell.startsWith(s.lb), `${s.id}: cell ${s.cell} outside lb ${s.lb}`);
    assert.ok(Array.isArray(s.tags) && Array.isArray(s.aliases) && Array.isArray(s.sources));
    if (s.map) assert.ok(Number.isFinite(s.map.ns) && Number.isFinite(s.map.ew));
  }
});

check("wilderness representatives: clustered, named 'Landform near/of/in X', water-only landblocks skipped; regions present", () => {
  const w = sites.filter((s) => s.kind === "wilderness");
  assert.ok(w.length >= 10 && w.length <= 400, `${w.length}`);
  for (const s of w) {
    assert.match(s.name, /^[A-Z][A-Za-z' -]+ (?:near|(?:\d+ km )?(?:north|south|east|west|northeast|northwest|southeast|southwest) of|in) [A-Z]/);
    assert.ok(s.teleport.best.startsWith("@tele "), s.teleport.best);
    assert.ok(s.tags.includes("wilderness") && s.terrain && s.terrain.length);
    assert.ok(!["0x00A3", "0x0177"].includes(s.lb), "deep-sea landblocks (0,163) and (1,119) are never representatives");
  }
  assert.ok(w.some((s) => /^(Snow|Snowy|Icy|Ice|Frozen)/.test(s.name) && s.near && s.near.town === "Kryst"), "a snowy representative near Kryst");
  assert.deepEqual(sites.filter((s) => s.kind === "region").map((s) => s.name).sort(), ["Aluvian Heartlands", "Direlands", "Sho Heartlands"]);
  const dire = one(sites, (s) => s.name === "Direlands", "Direlands region");
  assert.ok(dire.lore.includes("Harsh, barren"), "region description + acpedia lore");
});

await checkAsync("maxWilderness caps the representatives", async () => {
  const { sites: s5, stats } = await buildGazetteer({ paths: { ...FIXTURE_PATHS, spawns: undefined }, maxWilderness: 5, log: () => {} });
  assert.ok(s5.filter((s) => s.kind === "wilderness").length <= 5);
  assert.equal(stats.wilderness, s5.filter((s) => s.kind === "wilderness").length);
  const { sites: s0 } = await buildGazetteer({ paths: { ...FIXTURE_PATHS, spawns: undefined }, maxWilderness: 0, log: () => {} });
  assert.equal(s0.filter((s) => s.kind === "wilderness").length, 0);
});

check("--spawns: life stones / statues / portals become exact-teleloc landmarks; object-tags joined via weenie index", () => {
  assert.ok(FXS, "spawn build ran");
  const ls = FXS.sites;
  const life = one(ls, (s) => s.name === "Life Stone near Holtburg", "Holtburg life stone");
  assert.equal(life.kind, "landmark");
  assert.equal(life.teleport.best, "@teleloc 0xA9B40019 81.3304 11.7974 94.005 0.839091 0 0 -0.543991");
  assert.ok(life.tags.includes("lifestone") && life.tags.includes("crystal"), life.tags.join(","));
  assert.equal(life.near.town, "Holtburg");
  const inner = one(ls, (s) => s.name === "Life Stone in Storage", "life stone inside Storage");
  assert.equal(inner.indoor, true);
  assert.ok(one(ls, (s) => s.name === "Nullified Statue of a Drudge", "statue").tags.includes("statue"));
  assert.ok(ls.some((s) => s.name === "Fountain (dungeon 004A)"));
  assert.ok(!ls.some((s) => /Wailing Statue|Surface|Generator/.test(s.name)), "creature statue / generic portal / generator skipped");
  const hall = one(ls, (s) => s.name === "Holtburg Meeting Hall", "meeting hall dungeon");
  assert.deepEqual(hall.map, { ns: 42.21, ew: 33.91 }, "the 'Holtburg Meeting Hall Portal' object marks the dungeon's entrance");
  assert.equal(FXS.stats.entrancesFromPortals, 1);
  assert.equal(landmarkTypeOf({ name: "Saving Asheron's Statue Gen", weenieType: 1, category: "Object" }), null, "spawn generators are not landmarks");
  assert.equal(landmarkTypeOf({ name: "Statue of Asheron", weenieType: 1, category: "Object" }), "statue");
  assert.equal(landmarkTypeOf({ name: "Surface", weenieType: 7 }), null);
  assert.equal(FXS.stats.includeSpawns, true);
  assert.equal(FX.stats.landmarks, 0, "no landmarks without --spawns");
});

check("telelocForSite re-aims an exact site (qw=cos θ/2, qz=−sin θ/2); null without an exact position", () => {
  const h = sites.find((s) => s.name === "Holtburg");
  assert.equal(telelocForSite(h, { headingDeg: 90 }), "@teleloc 0xA9B40019 84 7.1 94 0.707107 0 0 -0.707107");
  assert.equal(telelocForSite(h), h.teleport.teleloc);
  assert.equal(telelocForSite(sites.find((s) => s.name === "Mount Esper")), null);
});

check("writeGazetteer (JSONL, atomic, under os.tmpdir) → loadGazetteer round trip", () => {
  const out = path.join(TMP, "g", "film_gazetteer.jsonl");
  const r = writeGazetteer(sites, out, { meta: FX.stats });
  assert.equal(r.count, sites.length);
  assert.equal(fs.readFileSync(out, "utf8").trim().split("\n").length, sites.length);
  assert.ok(fs.existsSync(`${out}.meta.json`));
  const back = loadGazetteer(out);
  assert.deepEqual(back, JSON.parse(JSON.stringify(sites)));
  assert.equal(DEFAULT_GAZETTEER_PATH, "/mnt/wbterminal2/film-projects/_gazetteer/film_gazetteer.jsonl", "owner-approved default home");
});

// ── search.mjs ───────────────────────────────────────────────────────────────────────────────────────
check("tokenizer: folded, stemmed plurals, stop words dropped", () => {
  assert.deepEqual(tokenize("The Towers of the SKIES, ruins & Ashes"), ["tower", "sky", "ruin", "ash"]);
  assert.equal(stemToken("glass"), "glass");
  assert.equal(stemToken("cities"), "city");
});

check("'lonely snowy mountain at dawn' → snow/mountain wilderness ranks above every town; dawn look suggested", () => {
  const res = searchSites(sites, "lonely snowy mountain at dawn", { limit: 50 });
  assert.ok(res.length >= 5);
  assert.notEqual(res[0].site.kind, "town", `top hit ${res[0].site.name}`);
  const firstSnowWild = res.findIndex((r) => r.site.kind === "wilderness" && r.site.tags.some((t) => ["snow", "ice", "mountain", "highlands"].includes(t)));
  const firstTown = res.findIndex((r) => r.site.kind === "town");
  assert.ok(firstSnowWild >= 0, "a snowy/mountain wilderness site is found");
  assert.ok(firstTown === -1 || firstSnowWild < firstTown, `wilderness #${firstSnowWild} vs town #${firstTown}`);
  assert.ok(res[0].why.some((w) => w.includes("←snow") || w === "snowy"), res[0].why.join(" "));
  const { concepts } = expandQuery("lonely snowy mountain at dawn");
  const ids = concepts.map((c) => c.id);
  for (const c of ["alone", "snow", "mountain", "dawn"]) assert.ok(ids.includes(c), `concept ${c} in ${ids}`);
  assert.equal(concepts.find((c) => c.id === "dawn").look.timeOfDay, "dawn");
});

check("'burning city' → towns AND fire-concept sites", () => {
  const res = searchSites(sites, "burning city", { limit: 10 });
  assert.ok(res.some((r) => r.site.kind === "town"), "a town in the top 10");
  assert.ok(res.some((r) => r.why.some((w) => w.endsWith("←fire"))), "a fire-concept match in the top 10");
  assert.ok(res.some((r) => ["Eternal Flame", "Mount Esper"].includes(r.site.name) || r.site.tags.includes("volcano")));
});

check("search filters: kind, indoor, near (km), culture; exact name wins; empty query lists", () => {
  const d = searchSites(sites, "cave tunnel", { kind: "dungeon", indoor: true });
  assert.ok(d.length > 0 && d.every((r) => r.site.kind === "dungeon" && r.site.indoor));
  const n = searchSites(sites, "town river", { near: { ns: 42.1, ew: 33.6, radiusKm: 1 } });
  assert.ok(n.length > 0 && n.every((r) => Math.hypot(r.site.map.ns - 42.1, r.site.map.ew - 33.6) * 0.24 <= 1), "within 1 km of Holtburg");
  const c = searchSites(sites, "town", { culture: "Aluvian" });
  assert.ok(c.length > 0 && c.every((r) => r.site.culture === "Aluvian"));
  assert.equal(searchSites(sites, "Holtburg")[0].site.id, "holtburg");
  assert.ok(searchSites(sites, "Holtburg")[0].why.includes("exact name"));
  const list = searchSites(sites, "", { kind: ["town"], limit: 3 });
  assert.equal(list.length, 3);
  assert.ok(list.every((r) => r.site.kind === "town" && r.score === 0));
  assert.deepEqual(searchSites(sites, "zzzz qqqq"), []);
  assert.ok(searchSites(sites, "snow", { lexicon: null }).every((r) => r.why.every((w) => !w.includes("←"))), "lexicon:null disables expansion");
});

check("explainSite / siteWords: one paragraph with place, look, lore and the teleport", () => {
  const h = sites.find((s) => s.name === "Holtburg");
  const p = explainSite(h);
  for (const want of ["Holtburg is a town (outdoors)", "42.08N 33.60E", "0xA9B4", "Aluvian culture", "Lore:", "Teleport: @telepoi Holtburg", "@teleloc 0xA9B40019"]) {
    assert.ok(p.includes(want), `missing "${want}" in: ${p}`);
  }
  const d = explainSite(sites.find((s) => s.name === "Holtburg Dungeon"));
  assert.ok(d.includes("(entrance)") && d.includes("dungeon (indoors)"), d);
  const w = siteWords(h);
  assert.ok(w.includes("town") && w.includes("Aluvian") && w.includes("river"), w.join(","));
  assert.equal(explainSite(null), "");
});

// ── concept_lexicon.json ─────────────────────────────────────────────────────────────────────────────
const LEX = loadLexicon(DEFAULT_LEXICON_PATH);
check("lexicon schema: version 1, ≥ 60 concepts, typed fields, known kinds/looks, SPEC §2.12 technique ids", () => {
  assert.equal(LEX.version, 1);
  const entries = Object.entries(LEX.concepts);
  assert.ok(entries.length >= 60, `${entries.length} concepts`);
  for (const [id, c] of entries) {
    assert.match(id, /^[a-z][a-z0-9-]*$/, id);
    for (const f of ["words", "terrain", "biome", "tags", "kinds", "techniques"]) {
      assert.ok(Array.isArray(c[f]) && c[f].every((x) => typeof x === "string" && x.trim() === x && x.length), `${id}.${f}`);
    }
    assert.ok(c.words.length >= 3, `${id} has too few trigger words`);
    assert.ok(c.techniques.length >= 1, `${id} suggests no technique`);
    for (const k of c.kinds) assert.ok(SITE_KINDS.includes(k), `${id}: unknown kind ${k}`);
    for (const t of c.techniques) assert.ok(SPEC_TECHNIQUES.has(t), `${id}: technique "${t}" is not in SPEC §2.12`);
    assert.ok(c.look && typeof c.look === "object" && !Array.isArray(c.look), `${id}.look`);
    for (const k of Object.keys(c.look)) assert.ok(["timeOfDay", "fog", "grade"].includes(k), `${id}.look.${k}`);
    if (c.look.timeOfDay !== undefined) assert.ok(TIMES_OF_DAY.has(c.look.timeOfDay), `${id} timeOfDay ${c.look.timeOfDay}`);
    if (c.look.fog !== undefined) assert.ok(FOGS.has(c.look.fog), `${id} fog ${c.look.fog}`);
    if (c.look.grade !== undefined) assert.ok(GRADES.has(c.look.grade), `${id} grade ${c.look.grade}`);
  }
});

check("lexicon coverage: every brief lyric image triggers a concept (expandQuery executes the phrase index)", () => {
  const words = ("ocean sea waves shore river lake rain storm snow ice winter cold desert sand sun heat forest trees woods " +
    "mountain peak climb height valley canyon cave underground dark abyss deep fire flame burn ember light hope dawn " +
    "sunrise night stars moon sunset dusk golden city town crowd home alone lonely empty wander ruins ancient forgotten " +
    "lost memory tower spire high castle fortress king throne crown temple shrine prayer god grave death ghost undead " +
    "tomb war battle blood fight magic spell arcane portal gateway travel bridge crossing road journey path miles island " +
    "swamp marsh flower garden spring falling drown sinking flying sky wings freedom chains prison trapped gold treasure " +
    "wealth love heart rage anger peace calm mist fog haze crystal volcano lava ash statue monument ship boat sail wind " +
    "lightning shadow maze labyrinth door gate mirror reflection").split(" ");
  const missing = words.filter((w) => expandQuery(w, LEX).concepts.length === 0);
  assert.deepEqual(missing, []);
  assert.ok(expandQuery("an ice palace", LEX).concepts.some((c) => c.id === "crystal"), "multi-word phrase 'ice palace'");
  assert.ok(expandQuery("by myself", LEX).concepts.some((c) => c.id === "alone"), "phrase made of stop words");
});

// ── the real data (only where the files exist) ──────────────────────────────────────────────────────
await checkAsync("FULL DATA: > 3,000 sites, ≥ 55 towns, every site teleport-ready, built < 60 s (no spawns)", async () => {
  const need = ["locations", "poiDestinations", "towns", "townGazetteer", "regionGazetteer", "poiGazetteer", "atlas", "acpedia"];
  const absent = need.filter((k) => !fs.existsSync(DEFAULT_PATHS[k]));
  if (absent.length) {
    console.log(`    note: real gazetteer inputs not on this machine (${absent.join(", ")}) — full-data build not run`);
    return;
  }
  const t0 = Date.now();
  const { sites: all, stats } = await buildGazetteer({ log: () => {} });
  const ms = Date.now() - t0;
  console.log(`    full build: ${all.length} sites ${JSON.stringify(stats.byKind)} in ${ms} ms`);
  assert.ok(ms < 60000, `${ms} ms`);
  assert.ok(all.length > 3000, `${all.length} sites`);
  assert.ok(stats.byKind.town >= 55, `${stats.byKind.town} towns`);
  for (const s of all) assert.ok(typeof s.teleport.best === "string" && s.teleport.best.startsWith("@"), `${s.id} has no teleport`);
  assert.equal(new Set(all.map((s) => s.id)).size, all.length, "ids unique");
  const h = all.filter((s) => s.name === "Holtburg");
  assert.equal(h.length, 1);
  assert.equal(h[0].teleport.best, "@telepoi Holtburg");
  assert.equal(new Set(all.filter((s) => s.kind === "town").map((s) => compactKey(s.name))).size, stats.byKind.town, "no duplicate towns");
  assert.ok(stats.withTelepoi >= 50, `${stats.withTelepoi} @telepoi sites`);
  assert.equal(all.filter((s) => s.kind === "wilderness").length, 400);
  // the lexicon speaks the gazetteer's vocabulary: ≥ 80 % of concepts expand to a term some site carries
  const vocab = new Set();
  for (const s of all) for (const t of tokenize([s.biome, ...(s.terrain ?? []), ...s.tags].join(" "))) vocab.add(t);
  const concepts = Object.values(LEX.concepts);
  const live = concepts.filter((c) => [...c.tags, ...c.terrain, ...c.biome].some((w) => tokenize(w).some((t) => vocab.has(t))));
  assert.ok(live.length >= 0.8 * concepts.length, `${live.length}/${concepts.length} concepts hit the vocabulary`);
  const top = searchSites(all, "lonely snowy mountain at dawn", { limit: 5 });
  assert.ok(top.every((r) => r.site.kind !== "town"), top.map((r) => r.site.name).join(", "));
});

await checkAsync("a missing / unconfigured source is logged and skipped; the rest still builds", async () => {
  const log = [];
  const { sites: part, stats } = await buildGazetteer({ paths: { ...FIXTURE_PATHS, atlas: path.join(TMP, "missing.jsonl"), acpedia: undefined }, log: (m) => log.push(m) });
  assert.ok(log.some((m) => m.startsWith("[sites] atlas: cannot read")), log.join(" | "));
  assert.ok(log.some((m) => m.startsWith("[sites] acpedia: no path configured")), log.join(" | "));
  assert.equal(stats.inputs.atlas, 0);
  assert.equal(part.filter((s) => s.kind === "wilderness").length, 0, "no atlas → no wilderness");
  const h = one(part, (s) => s.name === "Holtburg", "Holtburg without atlas/acpedia");
  assert.equal(h.teleport.best, "@telepoi Holtburg");
  assert.equal(h.lore.startsWith("\"Standing on a hill"), true, "POI-gazetteer description is the lore fallback");
  assert.equal(mapFromWorld(32532, 34567.1).ew.toFixed(2), "33.60");
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`film_sites: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
