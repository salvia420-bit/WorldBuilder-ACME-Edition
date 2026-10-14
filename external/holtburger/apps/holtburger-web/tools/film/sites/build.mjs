// tools/film/sites/build.mjs — film-mode SITE GAZETTEER builder: data sources → merged, teleport-ready sites.
//
// WHY
// ---
// Film mode (`?filmMode=on`, DEFAULT OFF) has a Claude Code director that matches lyric imagery and script
// beats to places in Dereth and then teleports the hidden player (the streaming dolly, SPEC §0) there before
// each take (≈10 s per teleport). It needs ONE offline list of sites, each with a ready teleport command,
// map coordinates, the landblock for the readiness gate (SPEC §3.4) and enough words (terrain, culture,
// features, lore) for `search.mjs` to rank sites against a lyric. Nothing here talks to WBT, ACE, a browser
// or the network: every input is a file verified on 2026-10-13 (docs/film-mode-2026-10-13/recon/recon_wbt.md).
//
// WHAT
// ----
//   buildGazetteer({paths, includeSpawns=false, log, maxWilderness=400}) → Promise<{sites, stats}>
//   writeGazetteer(sites, outPath=DEFAULT_GAZETTEER_PATH, {meta}) → {path, count, bytes}   (JSONL, atomic)
//   telelocCmd / teleMapCmd / telepoiCmd / teledungeonCmd / headingQuatDeg / telelocForSite — teleport strings
//
// Site = {id, name, aliases[], kind:'town'|'dungeon'|'poi'|'landmark'|'region'|'wilderness', cell:"0x…"|null,
//   lb:"0xXXYY", pos:[wx,wy,z]|null, local:{x,y,z}|null, quat:[w,x,y,z]|null, indoor, map:{ns,ew}|null,
//   teleport:{best, teleloc?, telepoi?, tele?, teledungeon?}, region?, culture?, biome?, terrain?:[words],
//   hasRoad?, structures?, tags:[words], lore?, notes?, near?:{town, km, dir}, sources:[…]}
//   - pos/local/quat are set only when the exact position is known (Locations.txt, @telepoi destinations,
//     spawn rows); then teleport.teleloc is ALWAYS present (verbatim numbers, heading quat qw=cos θ/2,
//     qz=−sin θ/2). pos is SPEC §1 world metres (a dungeon's pos is in its own landblock's frame).
//   - map is the Dereth map position; for a dungeon interior it is the ENTRANCE when a source gives one,
//     otherwise null (a dungeon landblock's square is not a place on the map).
//   - teleport.best: @telepoi when the place is an ACE point of interest; dungeons → exact @teleloc, else
//     @teledungeon <LB>; outdoor → exact @teleloc when z is known, else @tele <ns> <ew> (server snaps Z).
//
// Merge rules: same cell + same local point (±1 m) → one site; same name key (case/diacritic/punctuation-
// free, aliases included) → one site when the positions agree (both in the same dungeon landblock, or within
// 2.5 km for towns / 1 km otherwise, or one side is a dungeon interior and the other its unique outdoor
// entrance); tags, lore, aliases and sources are unioned. Wilderness representatives: atlas landblocks
// clustered by (terrain group, relief, coast, structures), farthest-point sampled per cluster, up to
// `maxWilderness`, all-water landblocks skipped, named "Snowy highlands near Kryst".
//
// Node-only. Default output home (owner decision 2026-10-13): /mnt/wbterminal2/film-projects/_gazetteer/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as src from "./sources.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** apps/holtburger-web */
export const HB_ROOT = path.resolve(HERE, "../../..");
const REPO_ROOT = path.resolve(HB_ROOT, "../../../..");
const RETAILSMOKE = process.env.FILM_RETAILSMOKE_DIR || path.join(os.homedir(), "projects", "RetailSmoke");

export const DEFAULT_GAZETTEER_DIR = "/mnt/wbterminal2/film-projects/_gazetteer";
export const DEFAULT_GAZETTEER_PATH = path.join(DEFAULT_GAZETTEER_DIR, "film_gazetteer.jsonl");

/** The real inputs (read-only). Pass your own `paths` object to buildGazetteer to replace ALL of them. */
export const DEFAULT_PATHS = Object.freeze({
  locations: path.join(REPO_ROOT, "WorldBuilder/Data/Locations.txt"),
  poiDestinations: path.resolve(HB_ROOT, "../../scripts/net-review/poi-destinations.json"),
  towns: path.join(HB_ROOT, "rynth/ai/tools/towns.js"),
  townGazetteer: path.join(RETAILSMOKE, "town_gazetteer.json"),
  regionGazetteer: path.join(RETAILSMOKE, "region_gazetteer.json"),
  poiGazetteer: path.join(RETAILSMOKE, "poi_gazetteer.json"),
  atlas: path.join(REPO_ROOT, "pipeline_data/reference/atlas_describe_v1.jsonl"),
  acpedia: path.join(HB_ROOT, "rynth/ai/tools/knowledge.acpedia.json"),
  objectTags: path.join(REPO_ROOT, "WorldBuilder/Data/object-tags.json"),
  spawns: path.join(RETAILSMOKE, "ace_spawn_records.jsonl"),
  weenieIndex: path.join(RETAILSMOKE, "weenie_index.jsonl"),
});

export const SITE_KINDS = Object.freeze(["town", "dungeon", "poi", "landmark", "region", "wilderness"]);
const KIND_RANK = Object.freeze({ town: 6, dungeon: 5, poi: 4, landmark: 3, region: 2, wilderness: 1 });
const KM_PER_DEG = 0.24;
// Dereth is ≈49 km across (1 map degree = 240 m); towns sit ≈3 km apart.
const MERGE_KM_TOWN = 2.0;
const MERGE_KM_OTHER = 0.75;
const NEAR_KM = 1.5; // "… near <town>"
const DIR_KM = 5; // "… <direction> of <town>"

// ── teleport strings (SPEC §2.8 formats; numbers keep their source precision, ≤ 6 decimals) ────────────
function fmtNum(n, dp = 6) {
  if (!Number.isFinite(n)) throw new TypeError(`teleport number is not finite: ${n}`);
  let s = Number(n).toFixed(dp);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}
function parseCell(cell) {
  if (typeof cell === "string") return parseInt(cell.replace(/^0x/i, ""), 16) >>> 0;
  return Number(cell) >>> 0;
}
/** @teleloc heading quaternion [w,x,y,z] for a compass heading in degrees (clockwise from north). */
export function headingQuatDeg(compassDeg) {
  const th = (Number(compassDeg) * Math.PI) / 180;
  return [Math.cos(th / 2), 0, 0, -Math.sin(th / 2)];
}
/** `@teleloc 0xCELLID x y z qw qx qy qz` (ACE AdminCommands order). */
export function telelocCmd(cell, local, quat) {
  const q = Array.isArray(quat) && quat.length === 4 && quat.every(Number.isFinite) ? quat : [1, 0, 0, 0];
  return `@teleloc ${src.cellHex(parseCell(cell))} ${fmtNum(local.x)} ${fmtNum(local.y)} ${fmtNum(local.z)} ` +
    q.map((v) => fmtNum(v)).join(" ");
}
/** `@tele 42.08N 33.60E` — ACE snaps Z to terrain/building; refuses all-water landblocks. */
export function teleMapCmd(ns, ew) {
  return `@tele ${src.formatMap(ns, ew, 2)}`;
}
export function telepoiCmd(name) {
  return `@telepoi ${String(name).trim()}`;
}
/** `@teledungeon 01F6` (4-hex landblock: ACE tries a single token as hex first). */
export function teledungeonCmd(lb) {
  return `@teledungeon ${src.lbHex4(typeof lb === "string" ? parseInt(lb.replace(/^0x/i, ""), 16) : lb)}`;
}
/** Exact @teleloc for a site with a new compass heading (degrees); null when the site has no exact position. */
export function telelocForSite(site, { headingDeg } = {}) {
  if (!site || !site.cell || !site.local || !Number.isFinite(site.local.z)) return null;
  const q = Number.isFinite(headingDeg) ? headingQuatDeg(headingDeg) : site.quat;
  return telelocCmd(site.cell, site.local, q);
}

// ── vocabulary: terrain types, features, landmark types ───────────────────────────────────────────────
/** atlas dominantTerrainTypes name → {group, words}. Groups drive wilderness clustering and site.biome. */
export const TERRAIN_INFO = Object.freeze({
  BarrenRock: { group: "rock", words: ["rock", "rocky", "barren", "stone"] },
  SemiBarrenRock: { group: "rock", words: ["rock", "rocky", "scrub"] },
  SedimentaryRock: { group: "rock", words: ["rock", "rocky", "stone", "cliffs"] },
  Grassland: { group: "grass", words: ["grass", "grassland", "meadow"] },
  LushGrass: { group: "grass", words: ["grass", "lush", "meadow", "green"] },
  PatchyGrassland: { group: "grass", words: ["grass", "grassland", "plains"] },
  forestfloor: { group: "forest", words: ["forest", "woods", "trees"] },
  Snow: { group: "snow", words: ["snow", "snowy", "winter"] },
  Ice: { group: "ice", words: ["ice", "frozen", "glacier"] },
  BlueIce: { group: "ice", words: ["ice", "glacier", "frozen"] },
  "sand-yellow": { group: "sand", words: ["sand", "desert", "dunes"] },
  "sand-grey": { group: "sand", words: ["sand", "beach"] },
  "sand-rockStrewn": { group: "sand", words: ["sand", "desert", "rocky"] },
  ObsidianPlain: { group: "volcanic", words: ["obsidian", "volcanic", "ash"] },
  Volcano1: { group: "volcanic", words: ["volcano", "lava", "volcanic", "fire"] },
  Volcano2: { group: "volcanic", words: ["volcano", "lava", "volcanic", "fire"] },
  MarshSparseSwamp: { group: "swamp", words: ["swamp", "marsh", "bog"] },
  MudRichDirt: { group: "swamp", words: ["mud", "marsh"] },
  Moss: { group: "swamp", words: ["moss", "damp"] },
  DarkMoss: { group: "swamp", words: ["moss", "dark"] },
  PackedDirt: { group: "dirt", words: ["dirt", "earth"] },
  PatchyDirt: { group: "dirt", words: ["dirt", "earth"] },
  Argila: { group: "dirt", words: ["clay", "earth"] },
  olthoi: { group: "olthoi", words: ["olthoi", "hive", "infested"] },
  WaterDeepSea: { group: "sea", words: ["sea", "ocean", "water"] },
  WaterShallowSea: { group: "sea", words: ["sea", "shallows", "water", "coast"] },
  WaterShallowStillSea: { group: "sea", words: ["sea", "lagoon", "water"] },
  SeaSlime: { group: "sea", words: ["sea", "slime"] },
  WaterRunning: { group: "river", words: ["river", "stream", "water"] },
  FauxWaterRunning: { group: "river", words: ["river", "water"] },
  WaterStandingFresh: { group: "lake", words: ["lake", "pond", "water"] },
});
const WATER_GROUPS = new Set(["sea", "lake", "river"]);
const GROUP_BIOME = Object.freeze({
  snow: "snowy", ice: "frozen", sand: "desert", forest: "forest", grass: "grassland", rock: "rocky",
  volcanic: "volcanic", swamp: "swamp", dirt: "barren", olthoi: "olthoi-infested",
});
const GROUP_TAGS = Object.freeze({
  snow: ["snow", "ice", "winter", "frozen"], ice: ["ice", "frozen", "glacier", "snow"], sand: ["desert", "sand", "dunes"],
  forest: ["forest", "woods", "trees"], grass: ["grassland", "meadow", "plains"], rock: ["rocky", "stone", "barren"],
  volcanic: ["volcano", "volcanic", "fire", "lava", "obsidian"], swamp: ["swamp", "marsh", "bog"], dirt: ["barren", "dirt"],
  olthoi: ["olthoi", "hive", "infested"],
});
const LANDFORM = Object.freeze({
  snow: { mountain: "Snowy peaks", highlands: "Snowy highlands", hills: "Snowy hills", flat: "Snowfield" },
  ice: { mountain: "Frozen peaks", highlands: "Frozen highlands", hills: "Icy hills", flat: "Ice field" },
  sand: { mountain: "Desert mountains", highlands: "Desert highlands", hills: "Desert hills", flat: "Desert dunes" },
  forest: { mountain: "Forested mountains", highlands: "Forested highlands", hills: "Wooded hills", flat: "Forest" },
  grass: { mountain: "Grassy mountains", highlands: "Grassy highlands", hills: "Rolling hills", flat: "Grassy plain" },
  rock: { mountain: "Rocky mountains", highlands: "Rocky highlands", hills: "Rocky hills", flat: "Barren plain" },
  volcanic: { mountain: "Volcanic peaks", highlands: "Volcanic highlands", hills: "Volcanic hills", flat: "Obsidian plain" },
  swamp: { mountain: "Mountain bog", highlands: "Highland bog", hills: "Marshy hills", flat: "Swamp" },
  dirt: { mountain: "Barren mountains", highlands: "Badlands", hills: "Dusty hills", flat: "Dirt plain" },
  olthoi: { mountain: "Olthoi peaks", highlands: "Olthoi-infested highlands", hills: "Olthoi hills", flat: "Olthoi plain" },
});
const COAST_NAME = Object.freeze({
  snow: "Snowy coast", ice: "Frozen coast", sand: "Sandy beach", forest: "Forested coast", grass: "Grassy shore",
  rock: "Rocky coast", volcanic: "Volcanic coast", swamp: "Swampy shore", dirt: "Barren coast", olthoi: "Olthoi-infested coast",
});
const RELIEF_TAGS = Object.freeze({
  mountain: ["mountain", "peak", "highlands"], highlands: ["highlands", "mountain"], hills: ["hills"], flat: ["plain", "flat"],
});

/** regex (on folded lower-case text, apostrophes removed) → tags; the matched word itself is also a tag. */
const FEATURE_RULES = [
  [/\bcastles?\b/g, ["castle", "fortress"]],
  [/\b(?:fort|forts|fortress(?:es)?|keeps?|citadels?|strongholds?|bastions?|redoubts?|garrisons?|barracks|ramparts?)\b/g, ["fortress"]],
  [/\b(?:towers?|spires?|minarets?|lighthouses?|belfry)\b/g, ["tower"]],
  [/\b(?:temples?|shrines?|chapels?|sanctums?|sanctuary|sanctuaries|monastery|cathedrals?|cloisters?|abbey|altars?|holy|sacred)\b/g, ["temple"]],
  [/\b(?:tombs?|crypts?|catacombs?|mausoleums?|graves?|graveyards?|cemetery|cemeteries|cenotaphs?|barrows?|ossuary|necropolis|burial)\b/g, ["tomb", "grave"]],
  [/\b(?:undead|skeletons?|liche?s?|zombies?|ghosts?|wights?|phantoms?|spectres?|specters?|revenants?|haunted|ghouls?|banshees?|shades)\b/g, ["undead"]],
  [/\b(?:ruins?|ruined|crumbling|remnants?)\b/g, ["ruins"]],
  [/\b(?:ancient|forgotten|abandoned|lost)\b/g, ["ancient"]],
  [/\b(?:caves?|caverns?|grottos?|grottoes|burrows?|lairs?|dens|warrens?|chasms?|pits?)\b/g, ["cave"]],
  [/\b(?:mines?|mineshafts?|quarry|quarries|excavations?)\b/g, ["mine", "cave"]],
  [/\b(?:tunnels?|sewers?|cisterns?|underground|subterranean|underworld)\b/g, ["tunnel", "underground"]],
  [/\b(?:lakes?|ponds?|lagoons?|pools?|loch)\b/g, ["lake", "water"]],
  [/\b(?:rivers?|streams?|creeks?|brooks?|rapids|fords?)\b/g, ["river", "water"]],
  [/\b(?:waterfalls?|falls|cascades?)\b/g, ["waterfall", "water"]],
  [/\b(?:seas?|oceans?|tides?|waves|surf)\b/g, ["sea"]],
  [/\b(?:coasts?|coastal|shores?|beach(?:es)?|coves?|bays?|harbou?rs?|docks?|piers?|wharf|peninsula|seaside)\b/g, ["coast"]],
  [/\b(?:islands?|isles?|islets?|atolls?|archipelago)\b/g, ["island"]],
  [/\b(?:swamps?|marsh(?:es)?|bogs?|mires?|fens?|bayou|wetlands?|moors?|mosswarts?)\b/g, ["swamp"]],
  [/\b(?:mountains?|mount|mt|peaks?|summits?|massif)\b/g, ["mountain"]],
  [/\b(?:hills?|highlands?|ridges?|crags?|bluffs?|plateaus?|mesas?|foothills)\b/g, ["hills"]],
  [/\b(?:cliffs?|precipice|ledges?|overlook|escarpment)\b/g, ["cliff"]],
  [/\b(?:valleys?|vales?|canyons?|gorges?|ravines?|gulch|gully|basins?|glen)\b/g, ["valley"]],
  [/\b(?:forests?|woods?|woodlands?|groves?|thickets?|jungles?|trees?|copse)\b/g, ["forest"]],
  [/\b(?:plains?|fields?|meadows?|grasslands?|prairies?|steppes?|pastures?)\b/g, ["plains"]],
  [/\b(?:deserts?|dunes?|sands?|oasis|oases|wastes|wasteland|badlands)\b/g, ["desert"]],
  [/\b(?:snow|snowy|ice|icy|frozen|frost|frosty|glaciers?|winter|tundra|blizzards?|frore)\b/g, ["snow", "ice"]],
  [/\b(?:volcano(?:es)?|volcanic|lava|magma|calderas?|obsidian|eruptions?|molten)\b/g, ["volcano", "fire"]],
  [/\b(?:craters?)\b/g, ["crater"]],
  [/\b(?:fires?|flames?|burning|inferno|embers?|braziers?|blaze|firestorm)\b/g, ["fire"]],
  [/\b(?:crystals?|crystalline|gems?|geodes?|diamonds?|jewels?)\b/g, ["crystal"]],
  [/\b(?:bridges?|viaducts?|aqueducts?)\b/g, ["bridge"]],
  [/\b(?:gates?|gateways?|doors?|portcullis|archways?)\b/g, ["gate"]],
  [/\b(?:walls?|palisades?)\b/g, ["wall"]],
  [/\b(?:roads?|paths?|trails?|highways?|crossroads)\b/g, ["road"]],
  [/\b(?:statues?|monuments?|memorials?|obelisks?|totems?|colossus|idols?|sculptures?|effigy)\b/g, ["statue", "monument"]],
  [/\b(?:fountains?|wells?)\b/g, ["fountain", "water"]],
  [/\b(?:gardens?|flowers?|blossoms?)\b/g, ["garden"]],
  [/\b(?:farms?|farmsteads?|orchards?|vineyards?|mills?|windmills?|barns?|ranch)\b/g, ["farm"]],
  [/\b(?:villages?|hamlets?|towns?|cities|city|settlements?|townships?|capital)\b/g, ["settlement"]],
  [/\b(?:cottages?|villas?|estates?|mansions?|apartments?|residential|housing)\b/g, ["housing", "settlement"]],
  [/\b(?:markets?|marketplace|bazaars?)\b/g, ["market"]],
  [/\b(?:taverns?|inns?|hotels?|clubs?|casinos?|pubs?)\b/g, ["tavern"]],
  [/\b(?:library|libraries|archives?|academy|academies|collegium|scriptorium)\b/g, ["library"]],
  [/\b(?:arenas?|colosseum|battlefields?|battles?|wars?|sieges?)\b/g, ["battle"]],
  [/\b(?:prisons?|jails?|gaols?|cages?|captives?|prisoners?)\b/g, ["prison"]],
  [/\b(?:palaces?|thrones?|royal|kings?|queens?|emperors?|empress|crowns?)\b/g, ["palace"]],
  [/\b(?:maze|mazes|labyrinths?)\b/g, ["maze"]],
  [/\b(?:laboratory|laboratories|workshops?|foundry|foundries|forges?|facility|factory|smithy)\b/g, ["workshop"]],
  [/\b(?:treasury|vaults?|hoards?|treasures?|riches|gold)\b/g, ["treasure"]],
  [/\b(?:pyramids?|ziggurats?)\b/g, ["pyramid"]],
  [/\b(?:portals?|nexus|teleporters?)\b/g, ["portal"]],
  [/\b(?:camps?|encampments?|outposts?|tents?)\b/g, ["camp"]],
  [/\b(?:hives?|nests?|brood)\b/g, ["hive"]],
  [/\bolthoi\b/g, ["olthoi", "hive"]],
  [/\bempyreans?\b/g, ["empyrean", "ancient"]],
  [/\bvirindi\b/g, ["virindi"]],
  [/\b(?:shadows?|shadowy)\b/g, ["shadow"]],
  [/\b(?:dark|darkness|gloom|gloomy)\b/g, ["dark"]],
  [/\b(?:cursed|corrupt(?:ed|ion)?|blighted|tainted|plague|poison(?:ed|ous)?)\b/g, ["corrupt"]],
  [/\b(?:storms?|stormy|thunder|lightning|tempest)\b/g, ["storm"]],
  [/\b(?:winds?|windy|gusts?)\b/g, ["wind"]],
  [/\b(?:moons?|lunar|moonlit)\b/g, ["moon"]],
  [/\b(?:sun|suns|solar|sunlit)\b/g, ["sun"]],
  [/\b(?:stars?|starlit|celestial|astral)\b/g, ["stars"]],
  [/\b(?:sky|skies|floating|aerial|clouds?)\b/g, ["sky"]],
  [/\b(?:ships?|boats?|vessels?|galleons?|shipwrecks?|wrecks?)\b/g, ["ship"]],
];
/** Singular, lower-case form of a matched feature word (for use as a tag). */
function featureWord(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(?:ss|us|is)$/.test(w) || w === "falls" || w === "waves" || w === "barracks" || w === "rapids" || w === "wastes") return w;
  if (/(?:ches|shes|xes|oes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}
/**
 * The first sentence of a lore/description text, with proper-noun mountain references ("Mount Esper",
 * "Mt. Zabool") removed — feature tags come from what a place IS, not from what its lore mentions.
 */
export function leadSentence(text) {
  // a leading "Route: …" sentence says how players get there, not what the place is
  const t = String(text ?? "").trim().replace(/^Route:[^.]*\.+\s*/i, "");
  const m = /^[\s\S]{20,}?[.!?]["”']?(?=\s+["“(A-Z])/.exec(t);
  return (m ? m[0] : t).slice(0, 240).replace(/\b(?:Mount|Mt\.?)\s+[A-Z][\w'-]+/g, " ");
}
/** Feature tags of free text (names, categories, notes, lore). */
export function featureTags(text) {
  const t = src.foldText(text).toLowerCase().replace(/['’`]/g, "");
  const out = new Set();
  if (!t.trim()) return out;
  for (const [re, tags] of FEATURE_RULES) {
    re.lastIndex = 0;
    let m;
    let hit = false;
    while ((m = re.exec(t))) {
      hit = true;
      const w = featureWord(m[0]);
      if (/^[a-z]{3,14}$/.test(w)) out.add(w);
    }
    if (hit) for (const g of tags) out.add(g);
  }
  return out;
}
const LANDMARK_TAGS = Object.freeze({
  lifestone: ["lifestone", "crystal", "glowing", "resurrection"],
  statue: ["statue", "monument", "sculpture"],
  fountain: ["fountain", "water"],
  shrine: ["shrine", "temple", "holy"],
  altar: ["altar", "temple", "ritual"],
  totem: ["totem", "monument"],
  obelisk: ["obelisk", "monument", "ancient"],
  portal: ["portal", "gateway", "magic", "travel"],
});
const GENERIC_LANDMARK_NAMES = new Set(["lifestone", "statue", "fountain", "shrine", "altar", "totem", "obelisk"]);
/** Evocative object-tags.json words worth keeping on a landmark (colours and body parts dropped). */
const OBJECT_TAG_ALLOW = new Set([
  "crystal", "stone", "ancient", "weathered", "ethereal", "glowing", "luminous", "sculpture", "statue", "tower", "ice",
  "gem", "gemstone", "diamond", "wings", "fire", "flame", "tree", "moss", "skull", "bone", "bones", "gold", "golden",
  "marble", "obsidian", "glass", "rune", "runes", "pillar", "column", "arch", "dome", "brick", "lantern", "candle",
  "torch", "banner", "fountain", "water", "altar", "shrine", "totem", "idol", "portal", "swirl", "ornate", "aged",
  "ruined", "broken", "cracked", "feather", "flower", "vine", "foliage", "rock", "mountain", "castle", "boat", "ship",
  "bridge", "throne", "crown", "skeleton", "ghostly", "wooden", "carved", "mystical", "magical",
]);
/** POI-gazetteer categories that are bookkeeping, not features. */
const SKIP_CATEGORY = /^(?:(?:North|South)(?:east|west) POI|Minor POI|Major POI|Lore Database Entry|Unmapped|Archive|Video|Trivia|Update)$/i;

// ── geometry helpers ─────────────────────────────────────────────────────────────────────────────────
function mapDistKm(a, b) {
  return Math.hypot(a.ns - b.ns, a.ew - b.ew) * KM_PER_DEG;
}
function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
const DIRS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
/** 8-wind direction of `to` as seen from `from` (map coords). */
function dirWord(from, to) {
  const a = (Math.atan2(to.ew - from.ew, to.ns - from.ns) * 180) / Math.PI;
  return DIRS[((Math.round(a / 45) % 8) + 8) % 8];
}
function nameKeyTokens(name) {
  return src.nameTokens(name);
}
const AFFIX_OK = new Set(["city", "village", "town", "outpost", "castle", "keep", "fort", "fortress", "refuge", "settlement", "hamlet"]);
/**
 * Two place names that differ only by a settlement word or a possessive owner ("Fiun" ≈ "Fiun Outpost",
 * "Freehold" ≈ "MacNiall's Freehold", "Underground" ≈ "Underground City").
 */
function affixCompatible(shortName, longName) {
  const a = nameKeyTokens(shortName), b = nameKeyTokens(longName);
  if (!a.length || a.length >= b.length || a.join("").length < 4) return false;
  let extra = null;
  if (a.every((t, i) => b[i] === t)) extra = b.slice(a.length);
  else if (a.every((t, i) => b[b.length - a.length + i] === t)) extra = b.slice(0, b.length - a.length);
  if (!extra) return false;
  if (extra.every((t) => AFFIX_OK.has(t))) return true;
  // possessive owner prefix: "MacNiall's Freehold", "Oolutanga's Refuge"
  return extra.length === 1 && b[0] === extra[0] && /^[^\s]+['’]s\s/.test(src.foldText(longName).trim());
}

// ── Locations.txt row classification ─────────────────────────────────────────────────────────────────
const GENERIC_LOCATION_NAMES = new Set([
  "surface", "surface portal", "exit", "exit portal", "portal", "gateway", "exit to surface", "exit to the surface",
  "surface exit", "cavern exit", "dungeon exit", "return portal", "town network portal",
]);
const MERGE_ONLY_PREFIX = /^(?:exit\s+to|destroyed\s+portal\s+to|portal\s+to|return\s+to|back\s+to|exit\s+portal\s+to)\s+(.+)$/i;
const JUNK_NAME = /\b(?:test|jumpshaft\w*|jumpentry|jumpexit|placeholder|debug)\b/i;
/** {display, baseName, mergeOnly, skip} for a Locations.txt "Dungeon"-type destination name. */
function classifyDestinationName(name) {
  const n = name.trim();
  const low = n.toLowerCase();
  if (!n || GENERIC_LOCATION_NAMES.has(low) || JUNK_NAME.test(n)) return { skip: true };
  const pre = MERGE_ONLY_PREFIX.exec(n);
  if (pre) return { display: pre[1].trim(), mergeOnly: true, stripped: true };
  const suf = /^(.+?)\s+portal$/i.exec(n);
  if (suf && suf[1].trim().length >= 3) return { display: suf[1].trim(), mergeOnly: false, stripped: true };
  return { display: n, mergeOnly: false, stripped: false };
}

// ── atlas helpers ────────────────────────────────────────────────────────────────────────────────────
/** {groups:{group:share}, water, primary, primaryShare, rock, words[]} of an atlas row. */
export function terrainProfile(row) {
  const groups = {};
  const words = [];
  for (const t of row?.terrain ?? []) {
    const info = TERRAIN_INFO[t.name];
    const g = info ? info.group : "other";
    groups[g] = (groups[g] ?? 0) + t.share;
    if (info && t.share >= 0.15) for (const w of info.words) if (!words.includes(w)) words.push(w);
  }
  const water = (groups.sea ?? 0) + (groups.lake ?? 0);
  let primary = null, primaryShare = 0;
  for (const [g, s] of Object.entries(groups)) {
    if (WATER_GROUPS.has(g) || g === "other") continue;
    // snow and ice are one visual family: the larger names it, both count
    const share = g === "snow" || g === "ice" ? (groups.snow ?? 0) + (groups.ice ?? 0) : s;
    if (share > primaryShare || (share === primaryShare && g < primary)) {
      primary = g === "snow" || g === "ice" ? ((groups.ice ?? 0) > (groups.snow ?? 0) ? "ice" : "snow") : g;
      primaryShare = share;
    }
  }
  return { groups, water, primary, primaryShare, rock: groups.rock ?? 0, words };
}
function biomeOfProfile(p) {
  if (!p.primary) return p.water >= 0.5 ? "sea" : null;
  const b = GROUP_BIOME[p.primary] ?? null;
  return p.water >= 0.2 && b ? `${b} coastal` : b;
}
function reliefOf(p, elev) {
  if (elev && elev.n >= 3) {
    const range = elev.max - elev.min;
    return range >= 60 ? "mountain" : range >= 20 ? "hills" : "flat";
  }
  return p.rock >= 0.45 ? "highlands" : p.rock >= 0.2 ? "hills" : "flat";
}
/** Landscape landblock (building interiors are on the map) vs a dungeon-only landblock. */
function isLandscapeLb(atlas, lb) {
  const row = atlas.get(lb);
  if (!row || !(row.structureCount > 0)) return false;
  return terrainProfile(row).water < 0.9;
}

// ── the registry: rows → merged draft sites ──────────────────────────────────────────────────────────
const GRID = 8; // spatial bucket = 8×8 landblocks (1536 m)

class Registry {
  constructor(atlas) {
    this.atlas = atlas;
    this.list = [];
    this.byKey = new Map(); // key → [{site, how:'name'|'alias'}]
    this.byCell = new Map(); // cell → [site]
    this.byLb = new Map(); // dungeon lb → [site]
    this.grid = new Map(); // bucket → Set(site)
    this.stats = { merged: 0, created: 0, dropped: 0 };
  }
  _addKey(site, name, how) {
    const k = src.compactKey(name);
    if (!k) return;
    let l = this.byKey.get(k);
    if (!l) this.byKey.set(k, (l = []));
    if (!l.some((e) => e.site === site)) l.push({ site, how });
    site.keys.add(k);
  }
  _bucketOf(w) {
    return `${Math.floor(w[0] / (192 * GRID))},${Math.floor(w[1] / (192 * GRID))}`;
  }
  _indexPos(site) {
    const w = site.map ? src.worldFromMap(site.map.ns, site.map.ew) : null;
    if (site._bucket) this.grid.get(site._bucket)?.delete(site);
    site._bucket = null;
    if (!w) return;
    const b = this._bucketOf(w);
    let s = this.grid.get(b);
    if (!s) this.grid.set(b, (s = new Set()));
    s.add(site);
    site._bucket = b;
  }
  _indexCell(site) {
    if (site.cell == null) return;
    let l = this.byCell.get(site.cell);
    if (!l) this.byCell.set(site.cell, (l = []));
    if (!l.includes(site)) l.push(site);
  }
  _indexDlb(site, lb) {
    let l = this.byLb.get(lb);
    if (!l) this.byLb.set(lb, (l = []));
    if (!l.includes(site)) l.push(site);
  }
  _near(map, km) {
    const w = src.worldFromMap(map.ns, map.ew);
    const r = Math.ceil((km * 1000) / (192 * GRID));
    const bx = Math.floor(w[0] / (192 * GRID)), by = Math.floor(w[1] / (192 * GRID));
    const out = [];
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      const s = this.grid.get(`${bx + dx},${by + dy}`);
      if (s) for (const site of s) out.push(site);
    }
    return out;
  }

  /** Normalise a row: exact position, indoor/interior, map position, dungeon landblocks. */
  prep(row) {
    const r = { ...row };
    r.exact = r.cell != null && r.local && [r.local.x, r.local.y, r.local.z].every(Number.isFinite);
    r.indoor = r.exact ? src.isIndoorCell(r.cell) : false;
    r.interior = r.indoor ? isLandscapeLb(this.atlas, src.lbOfCell(r.cell)) : false;
    if (r.exact && (!r.indoor || r.interior)) {
      const w = src.worldFromCellLocal(r.cell, r.local.x, r.local.y);
      r.map = src.mapFromWorld(w[0], w[1]);
    }
    r.dlbs = new Set(r.dungeonLbs ?? []);
    if (r.indoor && !r.interior) r.dlbs.add(src.lbOfCell(r.cell));
    return r;
  }

  /** Distance-like compatibility score (lower = better), or null when the row cannot be this site. */
  _compat(s, r, how) {
    const kindTown = s.kind === "town" || r.kind === "town";
    if (s.kind === "region" || r.kind === "region" || s.kind === "wilderness" || r.kind === "wilderness") return null;
    if (s.dlbs.size && r.dlbs.size) {
      for (const lb of r.dlbs) if (s.dlbs.has(lb)) return 0;
      return null;
    }
    if (s.map && r.map) {
      const d = mapDistKm(s.map, r.map);
      const lim = how === "affix" ? (kindTown ? MERGE_KM_OTHER : 0.4) : kindTown ? MERGE_KM_TOWN : MERGE_KM_OTHER;
      return d <= lim ? d : null;
    }
    if (how !== "name") return null;
    // one side is a dungeon interior without a map position, the other an outdoor entrance (or nothing)
    if ((s.dlbs.size && !s.map) || (r.dlbs.size && !r.map)) {
      if (!["dungeon", "town", "poi"].includes(r.kind)) return null;
      return 0.5;
    }
    if (!r.map && !r.dlbs.size) return 1; // position-less row (lore, a town with no landblock)
    if (!s.map && !s.dlbs.size) return 1;
    return null;
  }

  find(row) {
    const r = row.exact === undefined ? this.prep(row) : row;
    if (r.exact && r.cellMerge !== false) {
      for (const s of this.byCell.get(r.cell) ?? []) {
        if (s.exact && Math.hypot(s.local.x - r.local.x, s.local.y - r.local.y, s.local.z - r.local.z) <= 1) return s;
      }
    }
    const cands = new Map(); // site → how
    const names = [r.name, ...(r.matchNames ?? [])];
    for (const n of names) {
      for (const e of this.byKey.get(src.compactKey(n)) ?? []) {
        // position-less rows only match real names, never aliases
        if (!r.map && !r.dlbs.size && e.how !== "name") continue;
        cands.set(e.site, "name"); // an alias key match is as good as a name match
      }
    }
    // affix matches among nearby sites / sites in the same dungeon landblock
    const nearby = [];
    if (r.map) nearby.push(...this._near(r.map, MERGE_KM_OTHER));
    for (const lb of r.dlbs) nearby.push(...(this.byLb.get(lb) ?? []));
    for (const s of nearby) {
      if (cands.has(s)) continue;
      if (affixCompatible(s.name, r.name) || affixCompatible(r.name, s.name)) cands.set(s, "affix");
    }
    // uniqueness for interior↔entrance matches: only when exactly one candidate holds a dungeon landblock
    let best = null, bestD = Infinity;
    const dlbHolders = [...cands.keys()].filter((s) => s.dlbs.size && !s.map).length;
    for (const [s, how] of cands) {
      const d = this._compat(s, r, how);
      if (d == null) continue;
      if (d === 0.5 && dlbHolders > 1 && !r.dlbs.size) continue;
      if (d < bestD || (d === bestD && best && KIND_RANK[s.kind] > KIND_RANK[best.kind])) {
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  create(r) {
    const s = {
      name: r.name,
      kind: r.kind,
      aliases: new Map(),
      keys: new Set(),
      exact: false,
      cell: null,
      local: null,
      quat: null,
      indoor: false,
      interior: false,
      map: null,
      dlbs: new Set(),
      telepoiNames: [],
      categories: new Set(),
      tags: new Set(),
      sources: new Set(),
      lore: null,
      loreRank: 0,
      notes: new Set(),
      culture: null,
      landmarkType: null,
      near: null,
      atlasLb: null,
      region: null,
      biome: null,
      extra: {},
      order: this.list.length,
    };
    this.list.push(s);
    this._addKey(s, r.name, "name");
    this.stats.created++;
    this.apply(s, r, true);
    return s;
  }

  apply(s, r, isNew = false) {
    s.sources.add(r.source);
    if (KIND_RANK[r.kind] > KIND_RANK[s.kind]) s.kind = r.kind;
    const addAlias = (a) => {
      const k = src.compactKey(a);
      if (!k || s.keys.has(k) || k.length < 3) return;
      s.aliases.set(k, a.trim());
      this._addKey(s, a, "alias");
    };
    if (!isNew && r.aliasOk !== false && src.compactKey(r.name) !== src.compactKey(s.name)) addAlias(r.name);
    if (isNew || !r.aliasesOnCreate) for (const a of r.aliases ?? []) addAlias(a);
    if (r.exact && !s.exact) {
      s.exact = true;
      s.cell = r.cell >>> 0;
      s.local = { x: r.local.x, y: r.local.y, z: r.local.z };
      s.quat = r.quat && r.quat.every(Number.isFinite) ? [...r.quat] : null;
      s.indoor = r.indoor;
      s.interior = r.interior;
      this._indexCell(s);
      if (r.map && (!s.map || !s.indoor || s.interior)) s.map = { ...r.map };
    }
    if (!s.map && r.map) s.map = { ...r.map };
    this._indexPos(s);
    for (const lb of r.dlbs ?? []) {
      // a dungeon landblock alias only sticks to indoor sites or sites without an exact outdoor position
      if (s.exact && !s.indoor) continue;
      s.dlbs.add(lb);
      this._indexDlb(s, lb);
    }
    if (r.telepoi) s.telepoiNames.push(r.telepoi);
    for (const c of r.categories ?? []) s.categories.add(c);
    for (const t of r.tags ?? []) s.tags.add(t);
    if (r.notes) s.notes.add(r.notes);
    if (r.culture && !s.culture) s.culture = r.culture;
    if (r.lore && r.lore.text && (r.lore.rank > s.loreRank || (r.lore.rank === s.loreRank && r.lore.text.length > (s.lore ?? "").length))) {
      s.lore = r.lore.text;
      s.loreRank = r.lore.rank;
    }
    if (r.landmarkType) s.landmarkType = r.landmarkType;
    if (!isNew) this.stats.merged++;
  }

  /**
   * Town names are unique in Dereth: an outdoor town/poi row whose name is exactly one known town's name is
   * that town even when its coordinates disagree (community POI and DerethMaps coordinates are often wrong:
   * "Sawato" 26.0S 48.4E in towns.js, "Ayan Baqur" 12.7N 1.7W in the POI gazetteer). The town keeps its
   * own position.
   */
  townAuthority(r) {
    if (!(r.kind === "town" || r.kind === "poi") || r.dlbs.size || r.source === "acpedia" || r.source === "spawns") return null;
    const towns = (this.byKey.get(src.compactKey(r.name)) ?? []).filter((e) => e.how === "name" && e.site.kind === "town").map((e) => e.site);
    return towns.length === 1 ? towns[0] : null;
  }
  place(row) {
    const r = this.prep(row);
    let m = this.find(r);
    if (!m) {
      const t = this.townAuthority(r);
      if (t) {
        m = t;
        r.map = null; // the row's coordinates are the disagreeing ones
        r.exact = false;
      }
    }
    if (m) {
      this.apply(m, r);
      return m;
    }
    if (r.mergeOnly) {
      this.stats.dropped++;
      return null;
    }
    if (!r.exact && !r.map && !r.dlbs.size) {
      this.stats.dropped++;
      return null;
    }
    return this.create(r);
  }
}

// ── poi coordinate choice (tie-break with acpedia coordinate hints) ──────────────────────────────────
function pickPoiCoords(p, hints) {
  if (p.coordSource === "title" || !p.candidates || p.candidates.length < 2 || !hints?.length) return { ns: p.ns, ew: p.ew };
  const top = p.candidates[0].n;
  const tied = p.candidates.filter((c) => c.n === top);
  if (tied.length < 2) return { ns: p.ns, ew: p.ew };
  let best = tied[0], bestD = Infinity;
  for (const c of tied) {
    const d = Math.min(...hints.map((h) => mapDistKm(c, h)));
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return { ns: best.ns, ew: best.ew };
}

function poiKind(categories) {
  const set = new Set(categories);
  if (set.has("Town")) return "town";
  if (set.has("Dungeon")) return "dungeon";
  return "poi";
}
function categoryTags(categories) {
  const out = [];
  for (const c of categories) {
    if (SKIP_CATEGORY.test(c)) continue;
    const low = c.toLowerCase();
    if (low === "geographic area") out.push("area");
    else if (low === "historical site") out.push("historical", "memorial");
    else if (low === "settlement") out.push("settlement", "housing");
    else out.push(...low.split(/\s+/));
  }
  return out;
}

// ── buildGazetteer ───────────────────────────────────────────────────────────────────────────────────
/**
 * Build the site gazetteer from the data files.
 * @param {{paths?: object, includeSpawns?: boolean, log?: (msg: string) => void, maxWilderness?: number}} [opts]
 *   `paths` REPLACES DEFAULT_PATHS wholesale (a key left out = that source is skipped); to override one file
 *   pass `{...DEFAULT_PATHS, spawns: "/x.jsonl"}`. `includeSpawns` streams the 255 MB ACE spawn dump for life
 *   stones / portals / statues / fountains / shrines / totems / altars / obelisks (+ per-landblock relief).
 * @returns {Promise<{sites: object[], stats: object}>}
 */
export async function buildGazetteer({ paths = DEFAULT_PATHS, includeSpawns = false, log = (m) => console.warn(m), maxWilderness = 400 } = {}) {
  const t0 = Date.now();
  const P = paths || {};
  const L = { log };
  const locations = src.loadLocations(P.locations, L);
  const poiDest = src.loadPoiDestinations(P.poiDestinations, L);
  const towns = await src.loadTowns(P.towns, L);
  const townGaz = src.loadTownGazetteer(P.townGazetteer, L);
  const regionGaz = src.loadRegionGazetteer(P.regionGazetteer, L);
  const pois = src.loadPoiGazetteer(P.poiGazetteer, L);
  const atlas = src.loadAtlas(P.atlas, L);
  const acpedia = src.loadAcpedia(P.acpedia, L);
  const spawns = includeSpawns ? await src.streamSpawns(P.spawns, L) : null;
  const tLoad = Date.now();

  const reg = new Registry(atlas);
  const acByKey = new Map();
  for (const a of acpedia) {
    if (a.entity) continue;
    const k = src.compactKey(a.name);
    if (!k) continue;
    let l = acByKey.get(k);
    if (!l) acByKey.set(k, (l = []));
    l.push(a);
  }
  const counts = { locations: locations.length, poiDestinations: poiDest.length, towns: towns.length, townGazetteer: townGaz.length, regions: regionGaz.regions.length, poiGazetteer: pois.length, atlas: atlas.size, acpedia: acpedia.length, spawnLandmarks: spawns ? spawns.landmarks.length : 0 };
  let skippedLocations = 0;

  // 1) Locations.txt: towns, then POIs, then the @telepoi list, then dungeon-type destinations.
  const locRow = (l, kind, display, extra = {}) => ({
    name: display,
    kind,
    source: "locations",
    cell: l.cell,
    local: l.local,
    quat: l.quat,
    tags: [...featureTags(display)],
    ...extra,
  });
  for (const l of locations) {
    if (l.type !== "Town" || src.isBogusPosition(l.cell, l.local)) continue;
    reg.place(locRow(l, "town", l.name));
  }
  for (const l of locations) {
    if (l.type !== "POI" || src.isBogusPosition(l.cell, l.local)) continue;
    reg.place(locRow(l, "poi", l.name));
  }
  for (const p of poiDest) {
    reg.place({ name: p.name, kind: "poi", source: "poi-destinations", cell: p.cell, local: p.local, quat: p.quat, telepoi: p.name, tags: [...featureTags(p.name)] });
  }
  const deferred = [];
  for (const l of locations) {
    if (l.type === "Town" || l.type === "POI") continue;
    const c = classifyDestinationName(l.name);
    if (c.skip || src.isBogusPosition(l.cell, l.local)) {
      skippedLocations++;
      continue;
    }
    const row = { l, c };
    if (c.mergeOnly) deferred.push(row);
    else {
      const indoor = src.isIndoorCell(l.cell);
      const interior = indoor && isLandscapeLb(atlas, src.lbOfCell(l.cell));
      const kind = indoor && !interior ? "dungeon" : "poi";
      const extraTags = interior ? ["interior"] : [];
      reg.place(locRow(l, kind, c.display, {
        aliases: c.stripped ? [l.name] : [],
        aliasesOnCreate: true,
        aliasOk: false,
        tags: [...featureTags(l.name), ...extraTags],
      }));
    }
  }
  for (const { l, c } of deferred) reg.place(locRow(l, "poi", c.display, { mergeOnly: true, aliasOk: false }));

  // 2) Town gazetteer (culture + notes), towns.js (map coordinates).
  const townToRegion = regionGaz.townToRegion;
  for (const t of townGaz) {
    const isDungeon = /\(dungeon\)/i.test(t.rawName);
    const row = { name: t.name, kind: isDungeon ? "dungeon" : "town", source: "town-gazetteer", culture: t.culture, notes: t.notes || null, tags: [...featureTags(`${t.name} ${t.notes}`)] };
    if (t.lb != null) {
      // a landscape landblock → its centre is a map position; a dungeon-only landblock → a dungeon landblock
      const landscape = atlas.size ? isLandscapeLb(atlas, t.lb) : !isDungeon;
      if (landscape) {
        const w = [((t.lb >>> 8) & 0xff) * src.LB_SIZE + 96, (t.lb & 0xff) * src.LB_SIZE + 96];
        row.map = src.mapFromWorld(w[0], w[1]);
      } else row.dungeonLbs = [t.lb];
    }
    reg.place(row);
  }
  for (const t of towns) reg.place({ name: t.name, kind: "town", source: "towns.js", map: { ns: t.ns, ew: t.ew }, tags: [...featureTags(t.name)] });

  // 3) acpedia POI gazetteer (place categories only, de-duplicated, wikitext stripped).
  for (const p of pois) {
    const hints = (acByKey.get(src.compactKey(p.name)) ?? []).flatMap((a) => a.coordHints);
    const coords = pickPoiCoords(p, hints);
    const kind = poiKind(p.categories);
    const row = {
      name: p.name,
      kind,
      source: "poi-gazetteer",
      map: coords,
      categories: p.categories,
      tags: [...categoryTags(p.categories), ...featureTags(p.name), ...featureTags(leadSentence(p.description))],
      lore: p.description ? { text: p.description, rank: 1 } : null,
    };
    // A title spread over several coordinates: the chosen one first, then any other that agrees with a
    // known site of that name; otherwise place (create, or the town-name authority) at the chosen one.
    let placed = false;
    const tries = [coords, ...(p.candidates ?? []).filter((c) => !(c.ns === coords.ns && c.ew === coords.ew))];
    for (const c of tries) {
      const r = reg.prep({ ...row, map: { ns: c.ns, ew: c.ew } });
      const m = reg.find(r);
      if (m) {
        reg.apply(m, r);
        placed = true;
        break;
      }
    }
    if (!placed) reg.place(row);
  }

  // 4) acpedia knowledge corpus: lore for known sites; new sites for unmatched place articles.
  let acpediaSites = 0;
  for (const a of acpedia) {
    if (a.entity) continue;
    let coords = a.coords;
    if (!coords && a.location === "Landscape") coords = src.parseCoordText(a.text);
    const placeLike = !!(coords || a.lbAliases.length) && (a.location == null || a.location === "Dungeon" || a.location === "Landscape");
    const kind = a.lbAliases.length || a.location === "Dungeon" ? "dungeon" : "poi";
    const r = reg.prep({
      name: a.name,
      kind,
      source: "acpedia",
      map: coords ?? undefined,
      dungeonLbs: a.lbAliases,
      aliases: a.aliases.filter((x) => src.compactKey(x).length >= 3),
      aliasOk: false,
      lore: a.text ? { text: a.text, rank: 3 } : null,
    });
    const m = reg.find(r);
    if (!m && !placeLike) continue; // lore for a place we do not know (yet): late-lore pass below
    r.tags = [...featureTags(a.name), ...featureTags(leadSentence(a.text))];
    if (m) reg.apply(m, r);
    else {
      reg.create(r);
      acpediaSites++;
    }
  }

  // 5) Spawn landmarks (opt-in): life stones, outdoor portals, statues, fountains, shrines, totems, altars, obelisks.
  const townSites = () => reg.list.filter((s) => s.kind === "town" && s.map && (!s.indoor || s.interior));
  const nearestTown = (map, towns) => {
    let best = null, bestD = Infinity;
    for (const t of towns) {
      const d = mapDistKm(t.map, map);
      if (d < bestD || (d === bestD && best && t.name < best.name)) {
        best = t;
        bestD = d;
      }
    }
    return best ? { town: best.name, km: round(bestD, 2), dir: dirWord(best.map, map) } : null;
  };
  const landmarkSites = [];
  if (spawns) {
    let setupTags = new Map();
    if (P.weenieIndex && P.objectTags) {
      const wcids = new Set(spawns.landmarks.map((l) => l.wcid).filter(Number.isFinite));
      const setups = await src.loadWeenieSetups(P.weenieIndex, wcids, L);
      const ot = src.loadObjectTags(P.objectTags, L);
      for (const [wcid, setup] of setups) {
        const words = (ot.get(setup.toString(16).toUpperCase().padStart(8, "0")) ?? []).filter((w) => OBJECT_TAG_ALLOW.has(w));
        if (words.length) setupTags.set(wcid, words);
      }
    }
    const tl = townSites();
    const groups = new Map();
    for (const lm of spawns.landmarks) {
      if (src.isBogusPosition(lm.cell, lm.local)) continue;
      // dungeon-internal portals are navigation, not landmarks (portals inside town buildings are kept)
      if (lm.type === "portal" && lm.indoor && !isLandscapeLb(atlas, src.lbOfCell(lm.cell))) continue;
      const k = `${lm.type}|${src.compactKey(lm.name)}|${lm.lb}`;
      const g = groups.get(k);
      if (g) g.n++;
      else groups.set(k, { lm, n: 1 });
    }
    for (const { lm, n } of groups.values()) {
      const r = reg.prep({ name: lm.name, kind: "landmark", source: "spawns", cell: lm.cell, local: lm.local, quat: lm.quat });
      let name = lm.name.trim();
      const generic = GENERIC_LANDMARK_NAMES.has(src.compactKey(name));
      const near = r.map ? nearestTown(r.map, tl) : null;
      if (generic) {
        if (r.indoor && !r.interior) {
          const host = (reg.byLb.get(src.lbOfCell(lm.cell)) ?? []).filter((s) => s.kind !== "landmark").sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind] || a.order - b.order)[0];
          name = host ? `${name} in ${host.name}` : `${name} (dungeon ${src.lbHex4(src.lbOfCell(lm.cell))})`;
        } else if (near && near.km <= NEAR_KM) name = `${name} near ${near.town}`;
        else if (r.map) name = `${name} at ${src.formatMap(r.map.ns, r.map.ew, 1)}`;
      } else if (lm.type === "portal" && !/\bportal\b/i.test(name)) name = `${name} Portal`;
      const s = reg.create({
        ...r,
        name,
        landmarkType: lm.type,
        aliases: name !== lm.name.trim() ? [lm.name] : [],
        tags: [...(LANDMARK_TAGS[lm.type] ?? []), ...featureTags(lm.name), ...(setupTags.get(lm.wcid) ?? [])],
      });
      s.near = near;
      if (n > 1) s.extra.count = n;
      landmarkSites.push(s);
    }
  }

  // 5b) An outdoor portal object named "<Dungeon> Portal" marks that dungeon's entrance when no source gave one.
  let entrancesFromPortals = 0;
  for (const s of landmarkSites) {
    if (s.landmarkType !== "portal" || !s.map || (s.indoor && !s.interior)) continue;
    const m = /^(.+?)\s+portal$/i.exec(s.name);
    if (!m) continue;
    const hosts = (reg.byKey.get(src.compactKey(m[1])) ?? []).map((e) => e.site).filter((d) => d.kind === "dungeon" && !d.map && d.dlbs.size);
    if (hosts.length !== 1) continue;
    hosts[0].map = { ...s.map };
    hosts[0].sources.add("spawns");
    reg._indexPos(hosts[0]);
    entrancesFromPortals++;
  }

  // 6) Regions: one site per region, anchored on its most central non-water landblock.
  const regionInfo = new Map(regionGaz.regions.map((r) => [r.name, r]));
  const regionRows = new Map();
  for (const row of atlas.values()) {
    if (!row.region) continue;
    let l = regionRows.get(row.region);
    if (!l) regionRows.set(row.region, (l = []));
    l.push(row);
  }
  for (const r of regionGaz.regions) {
    const rows = (regionRows.get(r.name) ?? []).filter((x) => terrainProfile(x).water < 0.5);
    let map = null, lb = null;
    if (rows.length) {
      const cx = rows.reduce((a, x) => a + x.lbX, 0) / rows.length, cy = rows.reduce((a, x) => a + x.lbY, 0) / rows.length;
      let best = rows[0], bd = Infinity;
      for (const x of rows) {
        const d = (x.lbX - cx) ** 2 + (x.lbY - cy) ** 2;
        if (d < bd || (d === bd && x.lb < best.lb)) {
          best = x;
          bd = d;
        }
      }
      lb = best.lb;
      map = src.mapFromWorld(best.lbX * src.LB_SIZE + 96, best.lbY * src.LB_SIZE + 96);
    } else {
      const anchors = regionGaz.anchors.filter((a) => a.region === r.name);
      if (anchors.length) {
        const ax = anchors.reduce((a, x) => a + x.lbX, 0) / anchors.length, ay = anchors.reduce((a, x) => a + x.lbY, 0) / anchors.length;
        map = src.mapFromWorld(ax * src.LB_SIZE + 96, ay * src.LB_SIZE + 96);
      }
    }
    if (!map) continue;
    const s = reg.create({ name: r.name, kind: "region", source: "region-gazetteer", map, exact: false, dlbs: new Set(), culture: r.culture, tags: ["region", ...featureTags(`${r.name} ${r.description}`)], lore: r.description ? { text: r.description, rank: 4 } : null });
    s.biome = r.biome;
    s.region = r.name;
    if (lb != null) s.atlasLb = lb;
  }

  // 7) Wilderness representatives from the atlas.
  const wilderness = buildWilderness({ atlas, reg, maxWilderness, elevation: spawns?.elevation ?? null, towns: townSites(), nearestTown, regionInfo });

  // 8a) Nearest town for every placed non-town site (explainSite: "1.2 km northeast of Holtburg").
  {
    const tl = townSites();
    for (const s of reg.list) {
      if (s.near || !s.map || s.kind === "town" || s.kind === "region") continue;
      s.near = nearestTown(s.map, tl);
    }
  }

  // 8) Late lore: exact-name acpedia lore for sites that still have none (landmarks, regions, wilderness).
  for (const s of reg.list) {
    const rows = acByKey.get(src.compactKey(s.name));
    if (!rows || !rows.length) continue;
    const text = rows.map((a) => a.text).reduce((a, b) => (b.length > a.length ? b : a), "");
    if (!text) continue;
    if (s.kind === "region" && s.lore && !s.lore.includes(text)) s.lore = `${s.lore} ${text}`;
    else if (!s.lore) s.lore = text;
    s.sources.add("acpedia");
  }

  // 9) Finalise.
  const sites = finalize(reg, { atlas, townToRegion, regionInfo });
  const byKind = Object.fromEntries(SITE_KINDS.map((k) => [k, 0]));
  for (const s of sites) byKind[s.kind]++;
  const stats = {
    total: sites.length,
    byKind,
    inputs: counts,
    merged: reg.stats.merged,
    droppedRows: reg.stats.dropped,
    skippedLocations,
    acpediaSites,
    landmarks: landmarkSites.length,
    entrancesFromPortals,
    wilderness: wilderness.length,
    withTelepoi: sites.filter((s) => s.teleport.telepoi).length,
    withTeleloc: sites.filter((s) => s.teleport.teleloc).length,
    withLore: sites.filter((s) => s.lore).length,
    includeSpawns: !!spawns,
    loadMs: tLoad - t0,
    buildMs: Date.now() - t0,
  };
  return { sites, stats };
}

function buildWilderness({ atlas, reg, maxWilderness, elevation, towns, nearestTown, regionInfo }) {
  if (!(maxWilderness > 0) || !atlas.size) return [];
  const clusters = new Map();
  for (const row of atlas.values()) {
    if (row.townName || (row.settlementHint && /settlement/i.test(row.settlementHint))) continue;
    const p = terrainProfile(row);
    if (p.water >= 0.6 || !p.primary || p.primaryShare < 0.25) continue;
    const relief = reliefOf(p, elevation?.get(row.lb));
    const coastal = p.water >= 0.2;
    const built = row.structureCount > 0;
    const key = `${p.primary}|${relief}|${coastal ? "coast" : "inland"}|${built ? "built" : "wild"}`;
    let c = clusters.get(key);
    if (!c) clusters.set(key, (c = { key, group: p.primary, relief, coastal, built, rows: [] }));
    c.rows.push({ row, p });
  }
  const list = [...clusters.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (!list.length) return [];
  // quotas ∝ √size, ≥ 1 each, ≤ cluster size, Σ ≤ maxWilderness
  const sq = list.map((c) => Math.sqrt(c.rows.length));
  const sum = sq.reduce((a, b) => a + b, 0);
  const quota = list.map((c, i) => Math.min(c.rows.length, Math.max(1, Math.round((maxWilderness * sq[i]) / sum))));
  let total = quota.reduce((a, b) => a + b, 0);
  while (total > maxWilderness) {
    let iMax = -1;
    for (let i = 0; i < quota.length; i++) if (quota[i] > 1 && (iMax < 0 || quota[i] > quota[iMax])) iMax = i;
    if (iMax < 0) break;
    quota[iMax]--;
    total--;
  }
  if (total > maxWilderness) {
    // more clusters than slots: keep the largest clusters
    const order = list.map((c, i) => i).sort((a, b) => list[b].rows.length - list[a].rows.length || a - b);
    for (const i of order.slice(maxWilderness)) quota[i] = 0;
  }
  const usedNames = new Set(reg.list.map((s) => s.name.toLowerCase()));
  const out = [];
  list.forEach((c, ci) => {
    const k = quota[ci];
    if (!k) return;
    const rows = c.rows.slice().sort((a, b) => b.p.primaryShare - a.p.primaryShare || a.row.lb - b.row.lb);
    const picked = [rows[0]];
    const minD = rows.map((x) => (x.row.lbX - rows[0].row.lbX) ** 2 + (x.row.lbY - rows[0].row.lbY) ** 2);
    while (picked.length < k) {
      let bi = -1;
      for (let i = 0; i < rows.length; i++) if (minD[i] > 0 && (bi < 0 || minD[i] > minD[bi] || (minD[i] === minD[bi] && rows[i].row.lb < rows[bi].row.lb))) bi = i;
      if (bi < 0) break;
      picked.push(rows[bi]);
      const pr = rows[bi].row;
      for (let i = 0; i < rows.length; i++) minD[i] = Math.min(minD[i], (rows[i].row.lbX - pr.lbX) ** 2 + (rows[i].row.lbY - pr.lbY) ** 2);
    }
    for (const { row, p } of picked) {
      const map = src.mapFromWorld(row.lbX * src.LB_SIZE + 96, row.lbY * src.LB_SIZE + 96);
      const near = nearestTown(map, towns);
      const landform = c.coastal ? COAST_NAME[c.group] : LANDFORM[c.group][c.relief];
      // "near X" within NEAR_KM, "<dir> of X" within DIR_KM, otherwise "in <region>"
      let name;
      if (near && near.km <= NEAR_KM) name = `${landform} near ${near.town}`;
      else if (near && near.km <= DIR_KM) name = `${landform} ${near.dir} of ${near.town}`;
      else name = `${landform} in ${row.region ?? "Dereth"}`;
      if (usedNames.has(name.toLowerCase()) && near && near.km <= DIR_KM) name = `${landform} ${near.dir} of ${near.town}`;
      if (usedNames.has(name.toLowerCase()) && near) name = `${landform} ${Math.round(near.km)} km ${near.dir} of ${near.town}`;
      if (usedNames.has(name.toLowerCase())) name = `${name} (${src.lbHex(row.lb)})`;
      usedNames.add(name.toLowerCase());
      const tags = ["wilderness", "wild", "remote", ...(GROUP_TAGS[c.group] ?? []), ...RELIEF_TAGS[c.relief]];
      if (c.coastal) tags.push("coast", "shore", "sea");
      if (!c.built && !row.hasRoad) tags.push("isolated", "empty");
      if (c.built) tags.push("structure", "lone building");
      const s = reg.create({ name, kind: "wilderness", source: "atlas", map, exact: false, dlbs: new Set(), tags, culture: regionInfo.get(row.region)?.culture ?? null });
      s.atlasLb = row.lb;
      s.near = near;
      s.extra.cluster = c.key;
      s.extra.clusterSize = c.rows.length;
      out.push(s);
    }
  });
  return out;
}

function pickTelepoi(s) {
  if (!s.telepoiNames.length) return null;
  const key = src.compactKey(s.name);
  const uniq = [...new Set(s.telepoiNames)];
  const keyEq = uniq.filter((n) => src.compactKey(n) === key);
  const noSpace = keyEq.filter((n) => !/\s/.test(n));
  if (noSpace.length) return noSpace[0];
  if (keyEq.length) return keyEq[0];
  return uniq.slice().sort((a, b) => b.length - a.length || (a < b ? -1 : 1))[0];
}

function finalize(reg, { atlas, townToRegion, regionInfo }) {
  const out = [];
  for (const s of reg.list) {
    // landblock / cell / map
    let cell = null, lb = null, pos = null, local = null, quat = null;
    if (s.exact) {
      cell = s.cell;
      lb = src.lbOfCell(s.cell);
      const w = src.worldFromCellLocal(s.cell, s.local.x, s.local.y);
      pos = [round(w[0], 3), round(w[1], 3), round(s.local.z, 3)];
      local = { x: s.local.x, y: s.local.y, z: s.local.z };
      quat = s.quat;
    }
    const indoorDungeon = s.exact ? s.indoor && !s.interior : s.dlbs.size > 0 && s.kind === "dungeon";
    let map = s.map ? { ns: round(s.map.ns, 2), ew: round(s.map.ew, 2) } : null;
    if (!s.exact) {
      if (indoorDungeon) lb = [...s.dlbs][0];
      else if (map) {
        const w = src.worldFromMap(s.map.ns, s.map.ew);
        const oc = src.outdoorCellOfWorld(w[0], w[1]);
        cell = oc.cell;
        lb = src.lbOfCell(oc.cell);
      } else if (s.dlbs.size) lb = [...s.dlbs][0];
    }
    if (lb == null && s.atlasLb != null) lb = s.atlasLb;
    if (lb == null) continue; // nowhere to go
    // atlas enrichment: the landblock on the map (outdoor site, building interior, or a dungeon's entrance)
    const surfaceLb = s.atlasLb ?? (s.exact && (!s.indoor || s.interior) ? lb : map ? src.lbOfWorld(...src.worldFromMap(map.ns, map.ew)) : null);
    const arow = surfaceLb != null ? atlas.get(surfaceLb) : null;
    const prof = arow ? terrainProfile(arow) : null;
    const region = s.region ?? arow?.region ?? townToRegion.get(src.compactKey(s.name)) ?? null;
    const culture = s.culture ?? arow?.culture ?? regionInfo.get(region)?.culture ?? (arow?.architecture && arow.architecture !== "Mixed" ? arow.architecture : null);
    // the atlas describes the SURFACE: an underground site (dungeon interior, or any dungeon) does not take
    // its entrance landblock's terrain words
    const underground = indoorDungeon || s.kind === "dungeon";
    const tags = new Set(s.tags);
    const kindTags = { town: ["town", "settlement"], dungeon: ["dungeon", "underground"], poi: [], landmark: ["landmark"], region: ["region"], wilderness: ["wilderness"] }[s.kind];
    for (const t of kindTags) tags.add(t);
    if (s.landmarkType) for (const t of LANDMARK_TAGS[s.landmarkType] ?? []) tags.add(t);
    for (const t of featureTags([s.name, ...s.aliases.values()].join(" "))) tags.add(t);
    if (s.lore) for (const t of featureTags(leadSentence(s.lore))) tags.add(t);
    for (const n of s.notes) for (const t of featureTags(n)) tags.add(t);
    if (arow && s.kind !== "region") {
      if (prof.primary && !underground) for (const t of GROUP_TAGS[prof.primary] ?? []) tags.add(t);
      for (const [shape, n] of Object.entries(arow.roofs ?? {})) {
        if (shape === "spire" && n > 0) tags.add("spire");
        if (shape === "tapered" && n > 0 && culture === "Sho") tags.add("pagoda");
      }
      if (arow.maxStories >= 4) tags.add("tower");
    }
    tags.add(indoorDungeon || (s.exact && s.indoor) ? "indoor" : "outdoor");
    // teleport
    const teleport = {};
    if (s.exact) teleport.teleloc = telelocCmd(s.cell, s.local, s.quat);
    const poiName = pickTelepoi(s);
    if (poiName) teleport.telepoi = telepoiCmd(poiName);
    if (indoorDungeon) teleport.teledungeon = teledungeonCmd(lb);
    if (map) teleport.tele = teleMapCmd(map.ns, map.ew); // for a dungeon interior: its outdoor entrance
    teleport.best = teleport.telepoi ?? (indoorDungeon ? teleport.teleloc ?? teleport.teledungeon ?? teleport.tele : teleport.teleloc ?? teleport.tele ?? teleport.teledungeon);
    if (!teleport.best) continue;

    const site = {
      id: null,
      name: s.name,
      aliases: [...s.aliases.values()].filter((a) => a !== s.name),
      kind: s.kind,
      cell: cell != null ? src.cellHex(cell) : null,
      lb: src.lbHex(lb),
      pos,
      local,
      quat,
      indoor: !!(indoorDungeon || (s.exact && s.indoor)),
      map,
      teleport,
    };
    if (region) site.region = region;
    if (culture) site.culture = culture;
    const biome = s.biome ?? (prof && !underground ? biomeOfProfile(prof) : null);
    if (biome) site.biome = biome;
    if (prof && prof.words.length && !underground) site.terrain = prof.words;
    if (arow && !underground) {
      site.hasRoad = !!arow.hasRoad;
      site.structures = arow.structureCount;
    }
    site.tags = [...tags].sort();
    if (s.lore) site.lore = s.lore;
    if (s.notes.size) site.notes = [...s.notes].join("; ");
    if (s.near) site.near = s.near;
    if (s.categories.size) site.categories = [...s.categories].sort();
    if (s.extra.count) site.count = s.extra.count;
    site.sources = [...s.sources].sort();
    site._order = s.order;
    out.push(site);
  }
  // stable output order: kind, name, landblock; ids are name slugs, disambiguated by landblock
  out.sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.lb < b.lb ? -1 : a.lb > b.lb ? 1 : 0) || a._order - b._order);
  const bySlug = new Map();
  for (const s of out) {
    const slug = src.slugify(s.name);
    let l = bySlug.get(slug);
    if (!l) bySlug.set(slug, (l = []));
    l.push(s);
  }
  const used = new Set();
  for (const [slug, l] of bySlug) {
    for (const s of l) {
      let id = l.length === 1 ? slug : `${slug}-${s.lb.slice(2).toLowerCase()}`;
      let n = 2;
      while (used.has(id)) id = `${l.length === 1 ? slug : `${slug}-${s.lb.slice(2).toLowerCase()}`}-${n++}`;
      used.add(id);
      s.id = id;
    }
  }
  for (const s of out) delete s._order;
  return out;
}

// ── output ───────────────────────────────────────────────────────────────────────────────────────────
/**
 * Write sites as JSONL (one site per line), atomically (tmp file + rename); creates the directory.
 * `meta` (e.g. build stats) is written next to it as `<outPath>.meta.json` when given.
 */
export function writeGazetteer(sites, outPath = DEFAULT_GAZETTEER_PATH, { meta } = {}) {
  if (!Array.isArray(sites)) throw new TypeError("writeGazetteer: sites must be an array");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const text = sites.map((s) => JSON.stringify(s)).join("\n") + (sites.length ? "\n" : "");
  const tmp = `${outPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, outPath);
  if (meta) fs.writeFileSync(`${outPath}.meta.json`, JSON.stringify({ written: new Date().toISOString(), count: sites.length, ...meta }, null, 1) + "\n", "utf8");
  return { path: outPath, count: sites.length, bytes: Buffer.byteLength(text) };
}
