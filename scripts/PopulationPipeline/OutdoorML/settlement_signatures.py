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
