#!/usr/bin/env python3
"""
Build a grounded support-level object-selection dataset.

Each row represents a support surface plus candidate object identities that may
or may not belong on that support. Unlike the arrangement ranker, this stage is
about object compatibility and composition, not precise dx/dy placement.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"
ENRICHMENT_DIR = ROOT / "pipeline_data" / "enrichment"

_SCRIPTS_ROOT = ROOT / "scripts"
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from PopulationPipeline.lib.unified_ontology import (  # noqa: E402
    DEFAULT_UNIFIED_PATH as DEFAULT_UNIFIED_ONTOLOGY_PATH,
    UnifiedOntology,
)

DEFAULT_INPUT_JSONL = REFERENCE_DIR / "fullworld_interior_support_arrangements_v1.jsonl"
DEFAULT_GROUNDING_JSONL = REFERENCE_DIR / "world_grammar_grounding_table.jsonl"
DEFAULT_CANONICAL_ENRICHMENT_JSON = ENRICHMENT_DIR / "canonical_enrichment.json"
DEFAULT_WCID_TYPES_JSON = REFERENCE_DIR / "wcid_types_cache.json"
DEFAULT_SEMANTICS_JSONL = REFERENCE_DIR / "interior_object_semantics_v1.jsonl"
DEFAULT_OUT_JSONL = REFERENCE_DIR / "fullworld_interior_support_object_selection_v2.jsonl"
DEFAULT_OUT_SUMMARY_JSON = REFERENCE_DIR / "fullworld_interior_support_object_selection_v2_summary.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build grounded support/object selection dataset.")
    parser.add_argument("--input-jsonl", type=Path, default=DEFAULT_INPUT_JSONL)
    parser.add_argument("--grounding-jsonl", type=Path, default=DEFAULT_GROUNDING_JSONL)
    parser.add_argument("--canonical-enrichment-json", type=Path, default=DEFAULT_CANONICAL_ENRICHMENT_JSON)
    parser.add_argument("--wcid-types-json", type=Path, default=DEFAULT_WCID_TYPES_JSON)
    parser.add_argument("--semantics-jsonl", type=Path, default=DEFAULT_SEMANTICS_JSONL)
    parser.add_argument("--unified-ontology-json", type=Path, default=DEFAULT_UNIFIED_ONTOLOGY_PATH,
                        help="Merged ontology used to attach name/types/geom/etc to every object & support.")
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


def load_semantics_index(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    return {str(row.get("objectKey")): row for row in iter_jsonl(path)}


def object_key(prop: dict) -> str:
    return f"{prop.get('classIdSpace')}:{prop.get('classId')}"


def top_value(items: list[dict], allow_none: bool = False):
    for item in items or []:
        value = item.get("value")
        if allow_none or value not in (None, "", "<none>"):
            return value
    return None


def lookup_semantics(prop: dict, semantics_index: dict[str, dict]) -> dict | None:
    keys = [object_key(prop)]
    wcid = prop.get("wcid")
    if wcid is not None:
        keys.extend([f"wcid:{int(wcid)}", f"None:{int(wcid)}"])
    for key in keys:
        row = semantics_index.get(key)
        if row is not None:
            return row
    return None


def semantic_summary(semantics_row: dict | None) -> dict | None:
    if not semantics_row:
        return None
    observed = semantics_row.get("observedSemantics") or {}
    signals = semantics_row.get("canonicalSignals") or {}
    exogenous = semantics_row.get("exogenousSemantics") or {}
    return {
        "dominantPropClass": exogenous.get("dominantPropClass") or top_value(observed.get("propClasses") or []),
        "dominantSupportClass": exogenous.get("dominantSupportClass") or top_value(observed.get("supportClasses") or []),
        "dominantSourceKind": exogenous.get("dominantSourceKind") or top_value(observed.get("sourceKinds") or []),
        "dominantWeenieType": exogenous.get("dominantWeenieType"),
        "dominantLsdHookType": exogenous.get("dominantLsdHookType"),
        "dominantEnrichmentType": exogenous.get("enrichmentType") or top_value(observed.get("enrichmentTypes") or []),
        "dominantGroundingConfidence": top_value(observed.get("groundingConfidences") or []),
        "enrichmentTags": [item.get("value") for item in (observed.get("enrichmentTags") or [])[:12] if item.get("value")],
        "hasLsdHookType151": bool(signals.get("hasLsdHookType151")),
        "isLsdHookPlacable": bool(signals.get("isLsdHookPlacable")),
        "hasGroundingRow": bool(signals.get("hasGroundingRow")),
        "hasEnrichment": bool(signals.get("hasEnrichment")),
        "lsdItemType1": exogenous.get("lsdItemType1"),
        "lsdUseability16": exogenous.get("lsdUseability16"),
        "lsdTargetType94": exogenous.get("lsdTargetType94"),
        "lsdSetupDid1": exogenous.get("lsdSetupDid1"),
        "lsdIconDid8": exogenous.get("lsdIconDid8"),
        "signatureKey": exogenous.get("signatureKey"),
        "canonicalIdentityKey": semantics_row.get("canonicalIdentityKey"),
    }


def lookup_unified(prop: dict, unified: UnifiedOntology) -> dict | None:
    if not unified.loaded:
        return None
    class_space = str(prop.get("classIdSpace"))
    class_id = prop.get("classId")
    wcid = prop.get("wcid")
    if class_space == "model_id" and class_id is not None:
        return unified.lookup_model_id(int(class_id))
    if wcid is not None:
        wcid_entry = unified.lookup_wcid(int(wcid))
        if wcid_entry and wcid_entry.get("setup_did") is not None:
            return unified.lookup_model_id(int(wcid_entry["setup_did"]))
    return None


def unified_block(uo_entry: dict | None) -> dict | None:
    if not uo_entry:
        return None
    return {
        "modelIdHex": uo_entry.get("model_id_hex"),
        "idSpace": uo_entry.get("id_space"),
        "name": uo_entry.get("name"),
        "nameSource": uo_entry.get("name_source"),
        "types": list(uo_entry.get("types") or []),
        "primaryType": (uo_entry.get("types") or [None])[0],
        "architectures": list(uo_entry.get("architectures") or []),
        "biomes": list(uo_entry.get("biomes") or []),
        "behaviors": list(uo_entry.get("behaviors") or []),
        "creatureFamilies": list(uo_entry.get("creature_families") or []),
        "isBuilding": bool(uo_entry.get("is_building") or uo_entry.get("building_via_parent")),
        "isScenery": bool(uo_entry.get("is_scenery") or uo_entry.get("scenery_via_parent")),
        "geomCategory": uo_entry.get("geom_category"),
        "geomScale": uo_entry.get("geom_scale"),
        "geomMaxDimension": uo_entry.get("geom_max_dimension"),
        "geomAspectRatio": uo_entry.get("geom_aspect_ratio"),
        "geomPartCount": uo_entry.get("geom_part_count"),
        "geomPolyCount": uo_entry.get("geom_poly_count"),
        "parentSetups": list(uo_entry.get("parent_setups") or []),
        "wcids": list(uo_entry.get("wcids") or []),
        "weenieTypes": list(uo_entry.get("weenie_types") or []),
        "resolved": bool(uo_entry.get("resolved")),
        "resolutionSource": uo_entry.get("resolution_source"),
    }


def ontology_signature(uo_entry: dict | None) -> tuple[str, str, str]:
    """Bucket key for ontology-aware confuser pools: (geomCategory, geomScale, primaryType)."""
    if not uo_entry:
        return ("<none>", "<none>", "<none>")
    primary = (uo_entry.get("types") or [None])[0] or "<none>"
    return (
        uo_entry.get("geom_category") or "<none>",
        uo_entry.get("geom_scale") or "<none>",
        primary,
    )


def grounded_object_identity(
    prop: dict,
    grounding_index: dict[tuple[str, int], dict],
    canonical_enrichment: dict[int, dict],
    wcid_types: dict[int, int],
    semantics_index: dict[str, dict],
    unified: UnifiedOntology,
) -> dict:
    class_space = str(prop.get("classIdSpace"))
    class_id = int(prop.get("classId") or -1)
    wcid = prop.get("wcid")
    grounding = grounding_index.get((class_space, class_id))
    enrichment = canonical_enrichment.get(int(wcid)) if wcid is not None and int(wcid) in canonical_enrichment else None
    uo_entry = lookup_unified(prop, unified)
    preferred_name = (
        prop.get("name")
        or (grounding or {}).get("preferred_name")
        or (grounding or {}).get("ace_friendly_name")
        or (grounding or {}).get("lsd_name")
        or (enrichment or {}).get("name")
        or (uo_entry or {}).get("name")
    )
    tags = list((enrichment or {}).get("tags") or [])
    semantics = lookup_semantics(prop, semantics_index)
    return {
        "objectKey": object_key(prop),
        "classIdSpace": class_space,
        "classId": class_id,
        "wcid": wcid,
        "preferredName": preferred_name,
        "propClass": prop.get("propClass"),
        "sourceKind": prop.get("sourceKind"),
        "lsdHookType": prop.get("lsdHookType"),
        "isHookPlacable": bool(prop.get("isHookPlacable")),
        "weenieType": (enrichment or {}).get("weenieType") or (grounding or {}).get("observed_weenie_type") or (wcid_types.get(int(wcid)) if wcid is not None and int(wcid) in wcid_types else None),
        "groundingConfidence": (grounding or {}).get("grounding_confidence"),
        "groundingNameSource": (grounding or {}).get("source_of_name"),
        "enrichmentType": (enrichment or {}).get("type"),
        "enrichmentTags": tags[:12],
        "semanticSummary": semantic_summary(semantics),
        "unifiedOntology": unified_block(uo_entry),
    }


def support_signature(
    row: dict,
    grounding_index: dict[tuple[str, int], dict],
    canonical_enrichment: dict[int, dict],
    wcid_types: dict[int, int],
    semantics_index: dict[str, dict],
    unified: UnifiedOntology,
) -> dict:
    support = row.get("support") or {}
    grounded = grounded_object_identity(support, grounding_index, canonical_enrichment, wcid_types, semantics_index, unified)
    return {
        "supportKey": row.get("supportKey"),
        "sceneId": row.get("sceneId"),
        "landblockId": row.get("landblockId"),
        "componentId": row.get("componentId"),
        "cellId": row.get("cellId"),
        "support": {
            **grounded,
            "supportClass": support.get("supportClass"),
        },
        "supportGeometry": row.get("supportGeometry") or {},
        "cellGeometry": row.get("cellGeometry") or {},
        "roomContext": row.get("roomContext") or {},
        "arrangementSummary": row.get("arrangementSummary") or {},
    }


def candidate_from_candidate(
    candidate: dict,
    label: int,
    reason: str,
    grounding_index: dict[tuple[str, int], dict],
    canonical_enrichment: dict[int, dict],
    wcid_types: dict[int, int],
    semantics_index: dict[str, dict],
    unified: UnifiedOntology,
) -> dict:
    prop = candidate.get("prop") or {}
    grounded = grounded_object_identity(prop, grounding_index, canonical_enrichment, wcid_types, semantics_index, unified)
    return {
        "label": label,
        "candidateReason": reason,
        "object": grounded,
        "evidenceWeight": float(candidate.get("evidenceWeight", 1.0)),
        "labelTier": candidate.get("labelTier"),
    }


def confuser_signature(candidate: dict) -> tuple:
    prop = candidate.get("prop") or {}
    return (
        prop.get("wcid"),
        prop.get("propClass"),
        prop.get("sourceKind"),
        prop.get("lsdHookType"),
    )


def semantics_signature_from_candidate(candidate: dict, semantics_index: dict[str, dict]) -> tuple:
    prop = candidate.get("prop") or {}
    semantics = semantic_summary(lookup_semantics(prop, semantics_index))
    return (
        semantics.get("dominantWeenieType") if semantics else None,
        semantics.get("lsdItemType1") if semantics else None,
        semantics.get("lsdUseability16") if semantics else None,
        semantics.get("lsdTargetType94") if semantics else None,
        semantics.get("dominantLsdHookType") if semantics else None,
        semantics.get("dominantPropClass") if semantics else prop.get("propClass"),
    )


def main() -> None:
    args = parse_args()
    grounding_index = load_grounding_index(args.grounding_jsonl)
    canonical_enrichment = load_canonical_enrichment(args.canonical_enrichment_json)
    wcid_types = load_wcid_types(args.wcid_types_json)
    semantics_index = load_semantics_index(args.semantics_jsonl)
    unified = UnifiedOntology.load(args.unified_ontology_json)
    if unified.loaded:
        s = unified.stats
        print(
            f"[ontology] unified loaded: {s.get('setups',{}).get('total',0):,} setups "
            f"({s.get('setups',{}).get('named',0):,} named), "
            f"{s.get('gfx_objs',{}).get('total',0):,} gfx_objs "
            f"({s.get('gfx_objs',{}).get('named',0):,} named)"
        )
    else:
        print(f"[ontology] unified ontology not found at {args.unified_ontology_json}; ontology-aware confuser tiers will be empty")

    arrangement_rows = list(iter_jsonl(args.input_jsonl))
    positive_pool_by_support_class: dict[str, dict[str, dict[str, dict]]] = defaultdict(lambda: defaultdict(dict))
    semantic_pool_by_support_class: dict[str, dict[tuple, dict[str, dict]]] = defaultdict(lambda: defaultdict(dict))
    # Ontology-aware confuser pools, keyed by:
    #   tier 1 (semantic):  (supportClass, geomCategory, geomScale, primaryType)
    #   tier 2 (size):      (supportClass, geomCategory, geomScale)
    #   tier 3 (category):  (supportClass, geomCategory)
    onto_pool_t1: dict[tuple, dict[str, dict]] = defaultdict(dict)
    onto_pool_t2: dict[tuple, dict[str, dict]] = defaultdict(dict)
    onto_pool_t3: dict[tuple, dict[str, dict]] = defaultdict(dict)
    for row in arrangement_rows:
        support_class = str(((row.get("support") or {}).get("supportClass")) or "<none>")
        for candidate in row.get("positives") or []:
            obj = candidate.get("object") or {}
            prop_class = str(obj.get("propClass") or "<none>")
            key = object_key(obj)
            positive_pool_by_support_class[support_class][prop_class][key] = candidate
            semantic_pool_by_support_class[support_class][semantics_signature_from_candidate(candidate, semantics_index)][key] = candidate
            uo_entry = lookup_unified(obj, unified)
            geom_cat, geom_scale, primary = ontology_signature(uo_entry)
            onto_pool_t1[(support_class, geom_cat, geom_scale, primary)][key] = candidate
            onto_pool_t2[(support_class, geom_cat, geom_scale)][key] = candidate
            onto_pool_t3[(support_class, geom_cat)][key] = candidate

    out_rows = []
    support_class_counts = Counter()
    positive_reason_counts = Counter()
    negative_reason_counts = Counter()
    grounded_positive_names = 0
    grounded_negative_names = 0

    for row in arrangement_rows:
        positives = []
        seen_positive_keys = set()
        for candidate in row.get("positives") or []:
            built = candidate_from_candidate(candidate, 1, "observed_positive", grounding_index, canonical_enrichment, wcid_types, semantics_index, unified)
            key = built["object"]["objectKey"]
            if key in seen_positive_keys:
                continue
            seen_positive_keys.add(key)
            positives.append(built)
            positive_reason_counts[built["candidateReason"]] += 1
            if built["object"].get("preferredName"):
                grounded_positive_names += 1

        negatives = []
        seen_negative_keys = set()
        for candidate in row.get("negatives") or []:
            # For object selection, keep only negatives that challenge object compatibility.
            reason = str(candidate.get("candidateSource") or "")
            if reason != "negative_nearby_support_borrow":
                continue
            built = candidate_from_candidate(candidate, 0, reason, grounding_index, canonical_enrichment, wcid_types, semantics_index, unified)
            key = built["object"]["objectKey"]
            if key in seen_positive_keys or key in seen_negative_keys:
                continue
            seen_negative_keys.add(key)
            negatives.append(built)
            negative_reason_counts[built["candidateReason"]] += 1
            if built["object"].get("preferredName"):
                grounded_negative_names += 1

        support_class = str((((row.get("support") or {}).get("supportClass")) or "<none>"))
        positive_object_keys = {entry["object"]["objectKey"] for entry in positives}
        # Harder confuser negatives: same propClass, same supportClass, different object identity.
        for positive in positives:
            prop_class = str(((positive.get("object") or {}).get("propClass")) or "<none>")
            pool = positive_pool_by_support_class.get(support_class, {}).get(prop_class, {})
            pos_signature = (
                (positive.get("object") or {}).get("weenieType"),
                ((positive.get("object") or {}).get("semanticSummary") or {}).get("lsdItemType1"),
                ((positive.get("object") or {}).get("semanticSummary") or {}).get("lsdUseability16"),
                ((positive.get("object") or {}).get("semanticSummary") or {}).get("lsdTargetType94"),
                ((positive.get("object") or {}).get("semanticSummary") or {}).get("dominantLsdHookType"),
                ((positive.get("object") or {}).get("semanticSummary") or {}).get("dominantPropClass"),
            )
            semantic_pool = semantic_pool_by_support_class.get(support_class, {}).get(pos_signature, {})
            for candidate in semantic_pool.values():
                built = candidate_from_candidate(
                    candidate,
                    0,
                    "negative_same_semantic_signature_other_identity",
                    grounding_index,
                    canonical_enrichment,
                    wcid_types,
                    semantics_index,
                    unified,
                )
                key = built["object"]["objectKey"]
                if key in positive_object_keys or key in seen_negative_keys:
                    continue
                seen_negative_keys.add(key)
                negatives.append(built)
                negative_reason_counts[built["candidateReason"]] += 1
                if built["object"].get("preferredName"):
                    grounded_negative_names += 1
                break
            for candidate in pool.values():
                built = candidate_from_candidate(
                    candidate,
                    0,
                    "negative_same_propclass_other_identity",
                    grounding_index,
                    canonical_enrichment,
                    wcid_types,
                    semantics_index,
                    unified,
                )
                key = built["object"]["objectKey"]
                if key in positive_object_keys or key in seen_negative_keys:
                    continue
                seen_negative_keys.add(key)
                negatives.append(built)
                negative_reason_counts[built["candidateReason"]] += 1
                if built["object"].get("preferredName"):
                    grounded_negative_names += 1
                break

            # NEW ontology-aware confuser tiers (rely on unified ontology — these
            # produce well-distinguished confusers when the propClass-based pool
            # collapses because every static_clutter row carries the same legacy
            # propClass. The 'positive' uo entry below drives the bucket lookup.
            pos_obj = positive.get("object") or {}
            pos_uo_entry = lookup_unified({"classIdSpace": pos_obj.get("classIdSpace"),
                                            "classId": pos_obj.get("classId"),
                                            "wcid": pos_obj.get("wcid")}, unified)
            pos_geom_cat, pos_geom_scale, pos_primary = ontology_signature(pos_uo_entry)
            pos_key_str = pos_obj.get("objectKey")

            # Tier 1: same (supportClass, geomCategory, geomScale, primaryType), different identity.
            for cand_key, candidate in onto_pool_t1.get((support_class, pos_geom_cat, pos_geom_scale, pos_primary), {}).items():
                if cand_key == pos_key_str or cand_key in positive_object_keys or cand_key in seen_negative_keys:
                    continue
                built = candidate_from_candidate(
                    candidate,
                    0,
                    "negative_uo_same_geomcat_scale_type",
                    grounding_index,
                    canonical_enrichment,
                    wcid_types,
                    semantics_index,
                    unified,
                )
                seen_negative_keys.add(built["object"]["objectKey"])
                negatives.append(built)
                negative_reason_counts[built["candidateReason"]] += 1
                if built["object"].get("preferredName"):
                    grounded_negative_names += 1
                break

            # Tier 2: same (supportClass, geomCategory, geomScale) — different primaryType.
            for cand_key, candidate in onto_pool_t2.get((support_class, pos_geom_cat, pos_geom_scale), {}).items():
                if cand_key == pos_key_str or cand_key in positive_object_keys or cand_key in seen_negative_keys:
                    continue
                cand_uo = lookup_unified(candidate.get("object") or {}, unified)
                if ontology_signature(cand_uo)[2] == pos_primary:
                    continue  # same primary type, would already be Tier 1
                built = candidate_from_candidate(
                    candidate,
                    0,
                    "negative_uo_same_geomcat_scale_other_type",
                    grounding_index,
                    canonical_enrichment,
                    wcid_types,
                    semantics_index,
                    unified,
                )
                seen_negative_keys.add(built["object"]["objectKey"])
                negatives.append(built)
                negative_reason_counts[built["candidateReason"]] += 1
                if built["object"].get("preferredName"):
                    grounded_negative_names += 1
                break

            # Tier 3: same (supportClass, geomCategory) — different scale.
            for cand_key, candidate in onto_pool_t3.get((support_class, pos_geom_cat), {}).items():
                if cand_key == pos_key_str or cand_key in positive_object_keys or cand_key in seen_negative_keys:
                    continue
                cand_uo = lookup_unified(candidate.get("object") or {}, unified)
                cand_geom_cat, cand_geom_scale, _ = ontology_signature(cand_uo)
                if cand_geom_scale == pos_geom_scale:
                    continue  # same scale, would already be Tier 2
                built = candidate_from_candidate(
                    candidate,
                    0,
                    "negative_uo_same_geomcat_other_scale",
                    grounding_index,
                    canonical_enrichment,
                    wcid_types,
                    semantics_index,
                    unified,
                )
                seen_negative_keys.add(built["object"]["objectKey"])
                negatives.append(built)
                negative_reason_counts[built["candidateReason"]] += 1
                if built["object"].get("preferredName"):
                    grounded_negative_names += 1
                break

            # If same-class confuser was unavailable, force a different-object confuser from the same support family.
            if any(key not in positive_object_keys for key in pool.keys()):
                continue
            for other_prop_class, other_pool in positive_pool_by_support_class.get(support_class, {}).items():
                if other_prop_class == prop_class:
                    continue
                for candidate in other_pool.values():
                    built = candidate_from_candidate(
                        candidate,
                        0,
                        "negative_same_supportclass_other_propclass",
                        grounding_index,
                        canonical_enrichment,
                        wcid_types,
                        semantics_index,
                        unified,
                    )
                    key = built["object"]["objectKey"]
                    if key in positive_object_keys or key in seen_negative_keys:
                        continue
                    seen_negative_keys.add(key)
                    negatives.append(built)
                    negative_reason_counts[built["candidateReason"]] += 1
                    if built["object"].get("preferredName"):
                        grounded_negative_names += 1
                    break
                else:
                    continue
                break

        if not positives:
            continue

        signature = support_signature(row, grounding_index, canonical_enrichment, wcid_types, semantics_index, unified)
        support_class_counts[(signature.get("support") or {}).get("supportClass") or "<none>"] += 1
        out_rows.append(
            {
                **signature,
                "positiveObjects": positives,
                "negativeObjects": negatives,
            }
        )

    write_jsonl(args.out_jsonl, out_rows)
    summary = {
        "input_jsonl": str(args.input_jsonl),
        "out_jsonl": str(args.out_jsonl),
        "counts": {
            "support_rows": len(out_rows),
            "positive_objects": sum(len(row["positiveObjects"]) for row in out_rows),
            "negative_objects": sum(len(row["negativeObjects"]) for row in out_rows),
            "positive_objects_with_grounded_name": grounded_positive_names,
            "negative_objects_with_grounded_name": grounded_negative_names,
            "objects_with_semantic_summary": sum(
                1
                for row in out_rows
                for group in ("positiveObjects", "negativeObjects")
                for candidate in row[group]
                if (candidate.get("object") or {}).get("semanticSummary")
            ),
        },
        "support_class_counts": dict(support_class_counts.most_common()),
        "positive_reason_counts": dict(positive_reason_counts.most_common()),
        "negative_reason_counts": dict(negative_reason_counts.most_common()),
    }
    args.out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    with args.out_summary_json.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)

    print("Interior support object-selection dataset complete")
    print(f"  Support rows:      {len(out_rows):,}")
    print(f"  Positive objects:  {summary['counts']['positive_objects']:,}")
    print(f"  Negative objects:  {summary['counts']['negative_objects']:,}")
    print(f"  Output JSONL:      {args.out_jsonl}")
    print(f"  Summary JSON:      {args.out_summary_json}")


if __name__ == "__main__":
    main()
