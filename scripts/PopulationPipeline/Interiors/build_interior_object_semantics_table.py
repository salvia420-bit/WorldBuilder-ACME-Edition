#!/usr/bin/env python3
"""
Build a canonical interior object semantics table from grounded repo sources.

This intentionally preserves raw semantic signals and empirical interior
affinities instead of forcing every identity into a guessed family label.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"
ENRICHMENT_DIR = ROOT / "pipeline_data" / "enrichment"
LSD_WEENIES_DIR = ROOT / "external" / "LSD-Partial-2025-02-23_16-15" / "weenies"

_SCRIPTS_ROOT = ROOT / "scripts"
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from PopulationPipeline.lib.unified_ontology import (  # noqa: E402
    DEFAULT_UNIFIED_PATH as DEFAULT_UNIFIED_ONTOLOGY_PATH,
    UnifiedOntology,
)

DEFAULT_SELECTION_JSONL = REFERENCE_DIR / "fullworld_interior_support_object_selection_v1.jsonl"
DEFAULT_GROUNDING_JSONL = REFERENCE_DIR / "world_grammar_grounding_table.jsonl"
DEFAULT_CANONICAL_ENRICHMENT_JSON = ENRICHMENT_DIR / "canonical_enrichment.json"
DEFAULT_WCID_TYPES_JSON = REFERENCE_DIR / "wcid_types_cache.json"
DEFAULT_LSD_WEENIES_DIR = LSD_WEENIES_DIR
DEFAULT_ACE_WORLD_SQL = ROOT / "ace_world_release" / "ACE-World-Database-v0.9.292.sql"
DEFAULT_OUT_JSONL = REFERENCE_DIR / "interior_object_semantics_v1.jsonl"
DEFAULT_OUT_SUMMARY_JSON = REFERENCE_DIR / "interior_object_semantics_v1_summary.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a canonical interior object semantics table.")
    parser.add_argument("--selection-jsonl", type=Path, default=DEFAULT_SELECTION_JSONL)
    parser.add_argument("--grounding-jsonl", type=Path, default=DEFAULT_GROUNDING_JSONL)
    parser.add_argument("--canonical-enrichment-json", type=Path, default=DEFAULT_CANONICAL_ENRICHMENT_JSON)
    parser.add_argument("--wcid-types-json", type=Path, default=DEFAULT_WCID_TYPES_JSON)
    parser.add_argument("--lsd-weenies-dir", type=Path, default=DEFAULT_LSD_WEENIES_DIR)
    parser.add_argument("--ace-world-sql", type=Path, default=DEFAULT_ACE_WORLD_SQL)
    parser.add_argument("--unified-ontology-json", type=Path, default=DEFAULT_UNIFIED_ONTOLOGY_PATH,
                        help="Merged ontology covering setupDid, gfxObjId, and wcid lookups.")
    parser.add_argument("--out-jsonl", type=Path, default=DEFAULT_OUT_JSONL)
    parser.add_argument("--out-summary-json", type=Path, default=DEFAULT_OUT_SUMMARY_JSON)
    return parser.parse_args()


def iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8-sig") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=True) + "\n")


def load_grounding_index(path: Path) -> dict[tuple[str, int], dict]:
    index = {}
    for row in iter_jsonl(path):
        key = (str(row.get("class_space")), int(row.get("class_id") or -1))
        index[key] = row
    return index


def load_wcid_types(path: Path) -> dict[int, int]:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    return {int(k): int(v) for k, v in raw.items()}


def load_canonical_enrichment(path: Path) -> dict[int, dict]:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    entries = raw.get("entries") or []
    return {int(entry["wcid"]): entry for entry in entries if entry.get("wcid") is not None}


def first_string_stat(data: dict, key: int) -> str | None:
    for row in data.get("stringStats") or []:
        if row.get("key") == key:
            return row.get("value")
    return None


def keyed_stat_map(data: dict, field: str) -> dict[int, int | float]:
    out = {}
    for row in data.get(field) or []:
        if isinstance(row, dict) and "key" in row:
            out[int(row["key"])] = row.get("value")
    return out


def load_lsd_index(path: Path) -> dict[int, dict]:
    index = {}
    if not path.exists():
        return index
    for file_path in sorted(path.glob("*.json")):
        try:
            raw = json.loads(file_path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        wcid = raw.get("wcid")
        if wcid is None:
            continue
        int_stats = keyed_stat_map(raw, "intStats")
        did_stats = keyed_stat_map(raw, "didStats")
        bool_stats = keyed_stat_map(raw, "boolStats")
        index[int(wcid)] = {
            "wcid": int(wcid),
            "weenieType": raw.get("weenieType"),
            "name": first_string_stat(raw, 1),
            "hookType151": int_stats.get(151),
            "itemType1": int_stats.get(1),
            "value19": int_stats.get(19),
            "encumbrance5": int_stats.get(5),
            "useability16": int_stats.get(16),
            "targetType94": int_stats.get(94),
            "bonded33": int_stats.get(33),
            "placementPosition9": int_stats.get(9),
            "hookPlacementFlags131": int_stats.get(131),
            "setupDid1": did_stats.get(1),
            "iconDid8": did_stats.get(8),
            "soundDid22": did_stats.get(22),
            "inscribable22": bool_stats.get(22),
            "destroyOnSell69": bool_stats.get(69),
            "showableOnRadar100": bool_stats.get(100),
            "fileName": file_path.name,
        }
    return index


WEENIE_INSERT_RE = re.compile(r"\((\d+),'((?:\\\\.|[^'])*)',(\d+),'[^']*'\)")
WEENIE_STRING_INSERT_RE = re.compile(r"\(\d+,(\d+),1,'((?:\\\\.|[^'])*)'\)")


def sql_unescape(value: str) -> str:
    return value.replace("\\'", "'").replace("\\\\", "\\")


def load_ace_world_index(path: Path) -> dict[int, dict]:
    index: dict[int, dict] = {}
    if not path.exists():
        return index
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            if "INSERT INTO `weenie` VALUES" in line:
                for match in WEENIE_INSERT_RE.finditer(line):
                    wcid = int(match.group(1))
                    row = index.setdefault(wcid, {})
                    row["wcid"] = wcid
                    row["aceClassName"] = sql_unescape(match.group(2))
                    row["aceWeenieType"] = int(match.group(3))
            elif "INSERT INTO `weenie_properties_string` VALUES" in line:
                for match in WEENIE_STRING_INSERT_RE.finditer(line):
                    wcid = int(match.group(1))
                    row = index.setdefault(wcid, {})
                    row["wcid"] = wcid
                    row["aceDisplayName"] = sql_unescape(match.group(2))
    return index


def sorted_counter(counter: Counter, limit: int | None = None) -> list[dict]:
    items = sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0])))
    if limit is not None:
        items = items[:limit]
    return [{"value": key, "count": count} for key, count in items]


def add_name(counter: Counter, value: str | None) -> None:
    text = str(value or "").strip()
    if text:
        counter[text] += 1


def dominant_from_counter(counter: Counter):
    if not counter:
        return None
    return sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0])))[0][0]


def empty_stats() -> dict:
    return {
        "classIdSpace": None,
        "classId": None,
        "wcid": None,
        "roleCounts": Counter(),
        "nameCounts": Counter(),
        "propClassCounts": Counter(),
        "supportClassCounts": Counter(),
        "sourceKindCounts": Counter(),
        "groundingConfidenceCounts": Counter(),
        "groundingNameSourceCounts": Counter(),
        "enrichmentTypeCounts": Counter(),
        "enrichmentTagCounts": Counter(),
        "weenieTypeCounts": Counter(),
        "lsdHookTypeCounts": Counter(),
        "positiveSupportClassCounts": Counter(),
        "negativeSupportClassCounts": Counter(),
        "negativeReasonCounts": Counter(),
        "sceneIds": set(),
        "landblockIds": set(),
        "componentIds": set(),
        "cellIds": set(),
        "supportKeys": set(),
    }


def main() -> None:
    args = parse_args()
    grounding_index = load_grounding_index(args.grounding_jsonl)
    canonical_enrichment = load_canonical_enrichment(args.canonical_enrichment_json)
    wcid_types = load_wcid_types(args.wcid_types_json)
    lsd_index = load_lsd_index(args.lsd_weenies_dir)
    ace_world_index = load_ace_world_index(args.ace_world_sql)
    unified = UnifiedOntology.load(args.unified_ontology_json)
    if unified.loaded:
        s = unified.stats
        print(
            f"[ontology] unified loaded: setups={s.get('setups', {}).get('total', 0):,} "
            f"({s.get('setups', {}).get('named', 0):,} named, {s.get('setups', {}).get('resolved', 0):,} resolved); "
            f"gfx_objs={s.get('gfx_objs', {}).get('total', 0):,} "
            f"({s.get('gfx_objs', {}).get('named', 0):,} named, {s.get('gfx_objs', {}).get('resolved', 0):,} resolved)"
        )
    else:
        print(f"[ontology] unified ontology not found at {args.unified_ontology_json} — model_id rows will lack the model_id-derived enrichment")

    identity_stats: dict[str, dict] = defaultdict(empty_stats)
    rows = 0
    support_rows = 0

    for row in iter_jsonl(args.selection_jsonl):
        rows += 1
        support = row.get("support") or {}
        support_key = str(row.get("supportKey") or "")
        scene_id = row.get("sceneId")
        landblock_id = row.get("landblockId")
        component_id = row.get("componentId")
        cell_id = row.get("cellId")
        support_class = support.get("supportClass")

        stats = identity_stats[str(support.get("objectKey"))]
        stats["classIdSpace"] = support.get("classIdSpace")
        stats["classId"] = support.get("classId")
        stats["wcid"] = support.get("wcid")
        stats["roleCounts"]["support"] += 1
        stats["supportClassCounts"][support_class or "<none>"] += 1
        stats["sourceKindCounts"][support.get("sourceKind") or "<none>"] += 1
        stats["groundingConfidenceCounts"][support.get("groundingConfidence") or "<none>"] += 1
        stats["groundingNameSourceCounts"][support.get("groundingNameSource") or "<none>"] += 1
        stats["enrichmentTypeCounts"][support.get("enrichmentType") or "<none>"] += 1
        for tag in support.get("enrichmentTags") or []:
            stats["enrichmentTagCounts"][tag] += 1
        if support.get("weenieType") is not None:
            stats["weenieTypeCounts"][support["weenieType"]] += 1
        if support.get("lsdHookType") is not None:
            stats["lsdHookTypeCounts"][support["lsdHookType"]] += 1
        add_name(stats["nameCounts"], support.get("preferredName"))
        if scene_id:
            stats["sceneIds"].add(scene_id)
        if landblock_id:
            stats["landblockIds"].add(landblock_id)
        if component_id is not None:
            stats["componentIds"].add(component_id)
        if cell_id:
            stats["cellIds"].add(cell_id)
        if support_key:
            stats["supportKeys"].add(support_key)
        support_rows += 1

        for group_name, role_name in (("positiveObjects", "positive_object"), ("negativeObjects", "negative_object")):
            for candidate in row.get(group_name) or []:
                obj = candidate.get("object") or {}
                obj_key = str(obj.get("objectKey"))
                stats = identity_stats[obj_key]
                stats["classIdSpace"] = obj.get("classIdSpace")
                stats["classId"] = obj.get("classId")
                stats["wcid"] = obj.get("wcid")
                stats["roleCounts"][role_name] += 1
                stats["propClassCounts"][obj.get("propClass") or "<none>"] += 1
                stats["sourceKindCounts"][obj.get("sourceKind") or "<none>"] += 1
                stats["groundingConfidenceCounts"][obj.get("groundingConfidence") or "<none>"] += 1
                stats["groundingNameSourceCounts"][obj.get("groundingNameSource") or "<none>"] += 1
                stats["enrichmentTypeCounts"][obj.get("enrichmentType") or "<none>"] += 1
                for tag in obj.get("enrichmentTags") or []:
                    stats["enrichmentTagCounts"][tag] += 1
                if obj.get("weenieType") is not None:
                    stats["weenieTypeCounts"][obj["weenieType"]] += 1
                if obj.get("lsdHookType") is not None:
                    stats["lsdHookTypeCounts"][obj["lsdHookType"]] += 1
                add_name(stats["nameCounts"], obj.get("preferredName"))
                if scene_id:
                    stats["sceneIds"].add(scene_id)
                if landblock_id:
                    stats["landblockIds"].add(landblock_id)
                if component_id is not None:
                    stats["componentIds"].add(component_id)
                if cell_id:
                    stats["cellIds"].add(cell_id)
                if support_key:
                    stats["supportKeys"].add(support_key)
                if group_name == "positiveObjects":
                    stats["positiveSupportClassCounts"][support_class or "<none>"] += 1
                else:
                    stats["negativeSupportClassCounts"][support_class or "<none>"] += 1
                    stats["negativeReasonCounts"][candidate.get("candidateReason") or "<none>"] += 1

    out_rows = []
    class_space_counts = Counter()
    role_presence_counts = Counter()
    positive_affinity_presence = 0
    lsd_hook_presence = 0
    names_present = 0
    enrichment_present = 0
    wcid_present = 0
    ace_world_present = 0
    normalized_none_wcid = 0
    unified_present = 0
    unified_named_via_unified_only = 0

    for object_key, stats in sorted(identity_stats.items(), key=lambda kv: kv[0]):
        raw_class_space = str(stats["classIdSpace"])
        raw_class_id = int(stats["classId"] or -1)
        wcid = int(stats["wcid"]) if stats["wcid"] is not None else None
        effective_class_space = raw_class_space
        effective_class_id = raw_class_id
        if wcid is not None and raw_class_space in {"None", "none", "null", "<none>"}:
            effective_class_space = "wcid"
            effective_class_id = wcid
            normalized_none_wcid += 1
        grounding = grounding_index.get((effective_class_space, effective_class_id)) or grounding_index.get((raw_class_space, raw_class_id))
        enrichment = canonical_enrichment.get(wcid) if wcid is not None else None
        lsd = lsd_index.get(wcid) if wcid is not None else None
        ace_world = ace_world_index.get(wcid) if wcid is not None else None

        # model_id-keyed rows (static envcell objects) bypass every wcid-based
        # source above; the unified ontology fills the gap.
        unified_entry = None
        if effective_class_space == "model_id":
            unified_entry = unified.lookup_model_id(effective_class_id)
        elif wcid is not None and unified.loaded:
            wcid_entry = unified.lookup_wcid(wcid)
            if wcid_entry and wcid_entry.get("setup_did"):
                unified_entry = unified.lookup_model_id(wcid_entry["setup_did"])

        best_name = None
        if stats["nameCounts"]:
            best_name = sorted(stats["nameCounts"].items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        if not best_name:
            best_name = (
                (grounding or {}).get("preferred_name")
                or (grounding or {}).get("ace_friendly_name")
                or (enrichment or {}).get("name")
                or (lsd or {}).get("name")
                or (ace_world or {}).get("aceDisplayName")
                or (ace_world or {}).get("aceClassName")
                or (unified_entry or {}).get("name")
            )

        role_kind = ",".join(sorted(stats["roleCounts"]))
        role_presence_counts[role_kind] += 1
        class_space_counts[effective_class_space] += 1
        if stats["positiveSupportClassCounts"]:
            positive_affinity_presence += 1
        if best_name:
            names_present += 1
        if enrichment:
            enrichment_present += 1
        if wcid is not None:
            wcid_present += 1
        if ace_world:
            ace_world_present += 1
        if (lsd or {}).get("hookType151") is not None:
            lsd_hook_presence += 1
        if unified_entry is not None:
            unified_present += 1
            if (
                best_name
                and not (grounding or {}).get("preferred_name")
                and not (enrichment or {}).get("name")
                and not (lsd or {}).get("name")
                and not (ace_world or {}).get("aceDisplayName")
                and not (ace_world or {}).get("aceClassName")
                and unified_entry.get("name") == best_name
            ):
                unified_named_via_unified_only += 1

        dominant_prop_class = dominant_from_counter(stats["propClassCounts"])
        dominant_support_class = dominant_from_counter(stats["supportClassCounts"])
        dominant_source_kind = dominant_from_counter(stats["sourceKindCounts"])
        dominant_weenie_type = dominant_from_counter(stats["weenieTypeCounts"])
        dominant_lsd_hook_type = dominant_from_counter(stats["lsdHookTypeCounts"])
        lsd_item_type = (lsd or {}).get("itemType1")
        lsd_useability = (lsd or {}).get("useability16")
        lsd_target_type = (lsd or {}).get("targetType94")
        lsd_setup_did = (lsd or {}).get("setupDid1")
        lsd_icon_did = (lsd or {}).get("iconDid8")
        exogenous_signature = {
            "weenieType": dominant_weenie_type,
            "propClass": dominant_prop_class,
            "sourceKind": dominant_source_kind,
            "lsdHookType151": (lsd or {}).get("hookType151"),
            "itemType1": lsd_item_type,
            "useability16": lsd_useability,
            "targetType94": lsd_target_type,
            "setupDid1": lsd_setup_did,
            "iconDid8": lsd_icon_did,
            "enrichmentType": (enrichment or {}).get("type"),
        }
        exogenous_signature_key = "|".join(
            [
                str(exogenous_signature["weenieType"] or "<none>"),
                str(exogenous_signature["propClass"] or "<none>"),
                str(exogenous_signature["sourceKind"] or "<none>"),
                str(exogenous_signature["lsdHookType151"] or "<none>"),
                str(exogenous_signature["itemType1"] or "<none>"),
                str(exogenous_signature["useability16"] or "<none>"),
                str(exogenous_signature["targetType94"] or "<none>"),
                str(exogenous_signature["setupDid1"] or "<none>"),
                str(exogenous_signature["iconDid8"] or "<none>"),
                str(exogenous_signature["enrichmentType"] or "<none>"),
            ]
        )

        out_rows.append(
            {
                "objectKey": object_key,
                "canonicalIdentityKey": f"wcid:{wcid}" if wcid is not None else object_key,
                "classIdSpace": effective_class_space,
                "classId": effective_class_id,
                "rawClassIdSpace": raw_class_space,
                "rawClassId": raw_class_id,
                "wcid": wcid,
                "preferredName": best_name,
                "observedRoles": sorted(stats["roleCounts"]),
                "observedCounts": {
                    "support": int(stats["roleCounts"].get("support", 0)),
                    "positiveObject": int(stats["roleCounts"].get("positive_object", 0)),
                    "negativeObject": int(stats["roleCounts"].get("negative_object", 0)),
                    "sceneCount": len(stats["sceneIds"]),
                    "landblockCount": len(stats["landblockIds"]),
                    "componentCount": len(stats["componentIds"]),
                    "cellCount": len(stats["cellIds"]),
                    "supportUsageCount": len(stats["supportKeys"]),
                },
                "observedSemantics": {
                    "propClasses": sorted_counter(stats["propClassCounts"]),
                    "supportClasses": sorted_counter(stats["supportClassCounts"]),
                    "sourceKinds": sorted_counter(stats["sourceKindCounts"]),
                    "weenieTypes": sorted_counter(stats["weenieTypeCounts"]),
                    "lsdHookTypes": sorted_counter(stats["lsdHookTypeCounts"]),
                    "enrichmentTypes": sorted_counter(stats["enrichmentTypeCounts"]),
                    "enrichmentTags": sorted_counter(stats["enrichmentTagCounts"], limit=20),
                    "names": sorted_counter(stats["nameCounts"], limit=8),
                    "groundingConfidences": sorted_counter(stats["groundingConfidenceCounts"]),
                    "groundingNameSources": sorted_counter(stats["groundingNameSourceCounts"]),
                },
                "interiorAffinities": {
                    "positiveSupportClasses": sorted_counter(stats["positiveSupportClassCounts"]),
                    "negativeSupportClasses": sorted_counter(stats["negativeSupportClassCounts"]),
                    "negativeReasons": sorted_counter(stats["negativeReasonCounts"]),
                },
                "grounding": None
                if grounding is None
                else {
                    "preferredName": grounding.get("preferred_name"),
                    "aceClassName": grounding.get("ace_class_name"),
                    "aceFriendlyName": grounding.get("ace_friendly_name"),
                    "lsdName": grounding.get("lsd_name"),
                    "observedWeenieType": grounding.get("observed_weenie_type"),
                    "sourceOfName": grounding.get("source_of_name"),
                    "groundingConfidence": grounding.get("grounding_confidence"),
                    "observedCount": grounding.get("observed_count"),
                },
                "enrichment": None
                if enrichment is None
                else {
                    "name": enrichment.get("name"),
                    "type": enrichment.get("type"),
                    "weenieType": enrichment.get("weenieType"),
                    "tags": list(enrichment.get("tags") or [])[:20],
                },
                "lsd": None
                if lsd is None
                else {
                    "name": lsd.get("name"),
                    "weenieType": lsd.get("weenieType"),
                    "hookType151": lsd.get("hookType151"),
                    "itemType1": lsd.get("itemType1"),
                    "placementPosition9": lsd.get("placementPosition9"),
                    "useability16": lsd.get("useability16"),
                    "targetType94": lsd.get("targetType94"),
                    "hookPlacementFlags131": lsd.get("hookPlacementFlags131"),
                    "encumbrance5": lsd.get("encumbrance5"),
                    "value19": lsd.get("value19"),
                    "setupDid1": lsd.get("setupDid1"),
                    "iconDid8": lsd.get("iconDid8"),
                    "fileName": lsd.get("fileName"),
                },
                "aceWorld": None
                if ace_world is None
                else {
                    "aceClassName": ace_world.get("aceClassName"),
                    "aceDisplayName": ace_world.get("aceDisplayName"),
                    "aceWeenieType": ace_world.get("aceWeenieType"),
                },
                "unifiedOntology": None
                if unified_entry is None
                else {
                    "modelIdHex": unified_entry.get("model_id_hex"),
                    "idSpace": unified_entry.get("id_space"),
                    "name": unified_entry.get("name"),
                    "nameSource": unified_entry.get("name_source"),
                    "types": list(unified_entry.get("types") or []),
                    "architectures": list(unified_entry.get("architectures") or []),
                    "biomes": list(unified_entry.get("biomes") or []),
                    "behaviors": list(unified_entry.get("behaviors") or []),
                    "creatureFamilies": list(unified_entry.get("creature_families") or []),
                    "isBuilding": bool(unified_entry.get("is_building") or unified_entry.get("building_via_parent")),
                    "isScenery": bool(unified_entry.get("is_scenery") or unified_entry.get("scenery_via_parent")),
                    "geomCategory": unified_entry.get("geom_category"),
                    "geomScale": unified_entry.get("geom_scale"),
                    "geomMaxDimension": unified_entry.get("geom_max_dimension"),
                    "geomAspectRatio": unified_entry.get("geom_aspect_ratio"),
                    "geomPartCount": unified_entry.get("geom_part_count"),
                    "geomPolyCount": unified_entry.get("geom_poly_count"),
                    "parentSetups": list(unified_entry.get("parent_setups") or []),
                    "wcids": list(unified_entry.get("wcids") or []),
                    "weenieTypes": list(unified_entry.get("weenie_types") or []),
                    "resolved": bool(unified_entry.get("resolved")),
                    "resolutionSource": unified_entry.get("resolution_source"),
                },
                "canonicalSignals": {
                    "hasWcid": wcid is not None,
                    "hasPreferredName": bool(best_name),
                    "hasLsdHookType151": (lsd or {}).get("hookType151") is not None,
                    "isLsdHookPlacable": (lsd or {}).get("hookType151") is not None,
                    "hasEnrichment": enrichment is not None,
                    "hasGroundingRow": grounding is not None,
                    "hasAceWorldRow": ace_world is not None,
                    "hasUnifiedOntology": unified_entry is not None,
                    "normalizedFromNoneClassSpace": wcid is not None and raw_class_space in {"None", "none", "null", "<none>"},
                },
                "exogenousSemantics": {
                    "dominantPropClass": dominant_prop_class,
                    "dominantSupportClass": dominant_support_class,
                    "dominantSourceKind": dominant_source_kind,
                    "dominantWeenieType": dominant_weenie_type or (ace_world or {}).get("aceWeenieType"),
                    "dominantLsdHookType": dominant_lsd_hook_type,
                    "lsdItemType1": lsd_item_type,
                    "lsdUseability16": lsd_useability,
                    "lsdTargetType94": lsd_target_type,
                    "lsdSetupDid1": lsd_setup_did,
                    "lsdIconDid8": lsd_icon_did,
                    "enrichmentType": (enrichment or {}).get("type"),
                    "signatureKey": exogenous_signature_key,
                },
            }
        )

    write_jsonl(args.out_jsonl, out_rows)
    summary = {
        "selection_jsonl": str(args.selection_jsonl),
        "out_jsonl": str(args.out_jsonl),
        "counts": {
            "selection_rows": rows,
            "support_rows": support_rows,
            "unique_identities": len(out_rows),
            "with_wcid": wcid_present,
            "with_preferred_name": names_present,
            "with_lsd_hook_type151": lsd_hook_presence,
            "with_enrichment": enrichment_present,
            "with_positive_affinity": positive_affinity_presence,
            "with_ace_world_row": ace_world_present,
            "with_unified_ontology": unified_present,
            "named_only_via_unified": unified_named_via_unified_only,
            "normalized_none_classspace_wcid": normalized_none_wcid,
        },
        "identity_class_spaces": sorted_counter(class_space_counts),
        "role_presence": sorted_counter(role_presence_counts),
    }
    args.out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    with args.out_summary_json.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)

    print("Interior object semantics table complete")
    print(f"  Unique identities: {len(out_rows):,}")
    print(f"  Output JSONL:      {args.out_jsonl}")
    print(f"  Summary JSON:      {args.out_summary_json}")


if __name__ == "__main__":
    main()
