#!/usr/bin/env python3
"""
settlement_signatures.py - Coarse settlement-family helpers for OutdoorML
=========================================================================

These helpers classify outdoor landblocks into coarse structure/service
signatures so analysis and extraction summaries can reason about clustering
and co-occurrence without relying on raw WCID identity alone.
"""

from __future__ import annotations

from typing import Any

from housing_linker import classify_slumlord_house_type


WT_VENDOR = 12
WT_PORTAL = 7
WT_LIFESTONE = 25
WT_SLUMLORD = 55
WT_DOOR = 19
WT_CREATURE = 10

SETTLEMENT_SIGNATURE_TRAIN_WEIGHTS = {
    "service_housing_town": 1.8,
    "housing_cluster": 1.6,
    "service_node": 1.2,
    "portal_creature_outpost": 0.7,
    "vendor_portal_hub": 0.85,
}

SETTLEMENT_ROLE_LABELS = (
    "sparse_creature",
    "service_node",
    "housing_cluster",
    "service_housing_town",
    "outpost",
)

SETTLEMENT_ARCHETYPE_LABELS = (
    "service_node",
    "housing_cluster",
    "service_housing_town",
    "portal_creature_outpost",
    "vendor_portal_hub",
    "sparse_misc",
)

SERVICE_STYLE_LABELS = (
    "non_service",
    "portal_only",
    "portal_lifestone",
    "portal_vendor",
    "full_service",
    "vendor_only",
    "lifestone_only",
)


def family_labels_for_landblock(insts: list[dict[str, Any]], wcid_types: dict[int, int]) -> list[str]:
    labels: set[str] = set()

    for inst in insts:
        wcid = inst["wcid"]
        wtype = wcid_types.get(wcid, 0)

        if wtype == WT_VENDOR:
            labels.add("vendor")
        elif wtype == WT_PORTAL:
            labels.add("portal")
        elif wtype == WT_LIFESTONE:
            labels.add("lifestone")
        elif wtype == WT_DOOR:
            labels.add("door")
        elif wtype == WT_CREATURE:
            labels.add("creature")
        elif wtype == WT_SLUMLORD:
            house_type = classify_slumlord_house_type(wcid)
            if house_type:
                labels.add(f"housing_{house_type.lower()}")
            else:
                labels.add("housing_unknown")
        else:
            labels.add(f"wt_{wtype}")

    return sorted(labels)


def classify_settlement_signature(family_labels: list[str], object_count: int) -> str:
    labels = set(family_labels)
    has_housing = any(label.startswith("housing_") for label in labels)
    has_service = bool({"vendor", "portal", "lifestone"} & labels)
    has_vendor = "vendor" in labels
    has_portal = "portal" in labels
    has_lifestone = "lifestone" in labels
    has_door = "door" in labels
    has_creature = "creature" in labels

    if has_housing and has_door and has_service:
        return "service_housing_town"
    if has_housing and has_door:
        return "housing_cluster"
    if has_service and has_creature and object_count >= 20:
        return "service_creature_town"
    if has_vendor and has_portal:
        return "vendor_portal_hub"
    if has_portal and has_lifestone:
        return "portal_lifestone_hub"
    if has_creature and has_portal:
        return "portal_creature_outpost"
    if has_creature and has_door:
        return "door_creature_cluster"
    if has_creature and has_vendor:
        return "vendor_creature_mix"
    if has_housing:
        return "housing_sparse"
    if has_service:
        return "service_node"
    if has_creature:
        return "creature_field"
    if has_door:
        return "door_only_cluster"
    return "misc_sparse"


def settlement_signature_weight(signature: str) -> float:
    """Sampling weight used to rebalance training toward retail-like settlements."""
    return SETTLEMENT_SIGNATURE_TRAIN_WEIGHTS.get(signature, 1.0)


def settlement_role_from_signature(signature: str) -> str:
    """Collapse detailed settlement signatures into a compact training role."""
    if signature == "service_housing_town":
        return "service_housing_town"
    if signature in {"housing_cluster", "housing_sparse", "door_only_cluster"}:
        return "housing_cluster"
    if signature in {"service_node", "portal_lifestone_hub"}:
        return "service_node"
    if signature in {
        "portal_creature_outpost",
        "vendor_portal_hub",
        "service_creature_town",
        "vendor_creature_mix",
        "door_creature_cluster",
    }:
        return "outpost"
    return "sparse_creature"


def settlement_role_one_hot(role: str) -> list[float]:
    return [1.0 if label == role else 0.0 for label in SETTLEMENT_ROLE_LABELS]


def settlement_archetype_from_signature(signature: str) -> str:
    if signature in {
        "service_node",
        "portal_lifestone_hub",
        "service_creature_town",
    }:
        return "service_node"
    if signature in {"housing_cluster", "housing_sparse", "door_only_cluster", "door_creature_cluster"}:
        return "housing_cluster"
    if signature == "service_housing_town":
        return "service_housing_town"
    if signature == "portal_creature_outpost":
        return "portal_creature_outpost"
    if signature in {"vendor_portal_hub", "vendor_creature_mix"}:
        return "vendor_portal_hub"
    return "sparse_misc"


def settlement_archetype_one_hot(archetype: str) -> list[float]:
    return [1.0 if label == archetype else 0.0 for label in SETTLEMENT_ARCHETYPE_LABELS]


def classify_service_style(family_labels: list[str]) -> str:
    labels = set(family_labels)
    has_portal = "portal" in labels
    has_vendor = "vendor" in labels
    has_lifestone = "lifestone" in labels

    if has_portal and has_vendor and has_lifestone:
        return "full_service"
    if has_portal and has_vendor:
        return "portal_vendor"
    if has_portal and has_lifestone:
        return "portal_lifestone"
    if has_portal:
        return "portal_only"
    if has_vendor:
        return "vendor_only"
    if has_lifestone:
        return "lifestone_only"
    return "non_service"


def infer_settlement_role_from_context(
    culture_strength: float,
    difficulty: float,
    flatness: float,
    coast_distance: float,
) -> str:
    """
    Heuristic role prior for inference-time contexts where we do not know the
    actual generated family mix yet.
    """
    if (
        culture_strength >= 0.20 and
        flatness >= 0.68 and
        difficulty <= 0.45 and
        coast_distance >= 0.08
    ):
        return "service_housing_town"
    if culture_strength >= 0.18 and flatness >= 0.58 and difficulty <= 0.55:
        return "housing_cluster"
    if culture_strength >= 0.12 and flatness >= 0.45 and difficulty <= 0.65:
        return "service_node"
    if flatness >= 0.30 and difficulty <= 0.70 and coast_distance >= 0.04:
        return "outpost"
    return "sparse_creature"


def infer_settlement_archetype_from_context(
    culture_strength: float,
    difficulty: float,
    flatness: float,
    coast_distance: float,
    settlement_role: str | None = None,
) -> str:
    role = settlement_role or infer_settlement_role_from_context(
        culture_strength=culture_strength,
        difficulty=difficulty,
        flatness=flatness,
        coast_distance=coast_distance,
    )
    if role == "service_housing_town":
        return "service_housing_town"
    if role == "housing_cluster":
        if culture_strength >= 0.24 and flatness >= 0.68:
            return "service_housing_town"
        return "housing_cluster"
    if role == "service_node":
        if culture_strength >= 0.16 and flatness >= 0.50 and difficulty <= 0.55:
            return "service_node"
        return "vendor_portal_hub"
    if role == "outpost":
        if difficulty >= 0.55 or culture_strength < 0.10:
            return "portal_creature_outpost"
        return "vendor_portal_hub"
    if flatness >= 0.45 and coast_distance >= 0.08 and culture_strength >= 0.12:
        return "housing_cluster"
    return "sparse_misc"
