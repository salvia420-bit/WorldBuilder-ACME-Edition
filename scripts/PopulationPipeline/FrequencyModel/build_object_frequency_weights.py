#!/usr/bin/env python3
"""
build_object_frequency_weights.py
=================================

Build per-WCID frequency-aware scoring weights from a full Dereth object-count
dump. This is intended as a foundation for a new model/evaluator path that does
not depend on the OutdoorML trainer.

Core behavior:
  - Common objects receive smaller positive reward when predicted correctly.
  - Rare objects receive larger positive reward when predicted correctly.
  - Rare objects receive larger penalty when predicted incorrectly.
  - Infrastructure classes such as hooks and housing-related support objects are
    damped so they do not dominate the objective by sheer volume.

The output is a JSON mapping from WCID -> scoring metadata that can be consumed
by a future trainer or evaluator.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[3]
REFERENCE_DIR = BASE_DIR / "pipeline_data" / "reference"

DEFAULT_COUNTS_JSON = REFERENCE_DIR / "dereth_object_counts.json"
DEFAULT_WCID_TYPES_JSON = REFERENCE_DIR / "wcid_types_cache.json"
DEFAULT_OUTPUT_JSON = REFERENCE_DIR / "dereth_frequency_weights.json"


WEENIE_TYPE_NAMES = {
    0: "Undef",
    1: "Generic",
    2: "Clothing",
    3: "MissileLauncher",
    4: "Missile",
    5: "Ammunition",
    6: "MeleeWeapon",
    7: "Portal",
    8: "Book",
    9: "Coin",
    10: "Creature",
    11: "Admin",
    12: "Vendor",
    13: "HotSpot",
    14: "Corpse",
    15: "Cow",
    16: "AI",
    17: "Machine",
    18: "Food",
    19: "Door",
    20: "Chest",
    21: "Container",
    22: "Key",
    23: "Lockpick",
    24: "PressurePlate",
    25: "LifeStone",
    26: "Switch",
    27: "PKModifier",
    28: "Healer",
    29: "LightSource",
    30: "Allegiance",
    31: "UNKNOWN__GUESSEDNAME32",
    32: "SpellComponent",
    33: "ProjectileSpell",
    34: "Scroll",
    35: "Caster",
    36: "Channel",
    37: "ManaStone",
    38: "Gem",
    39: "AdvocateFane",
    40: "AdvocateItem",
    41: "Sentinel",
    42: "GSpellEconomy",
    43: "LSpellEconomy",
    44: "CraftTool",
    45: "LScoreKeeper",
    46: "GScoreKeeper",
    47: "GScoreGatherer",
    48: "ScoreBook",
    49: "EventCoordinator",
    50: "Entity",
    51: "Stackable",
    52: "HUD",
    53: "House",
    54: "Deed",
    55: "SlumLord",
    56: "Hook",
    57: "Storage",
    58: "BootSpot",
    59: "HousePortal",
    60: "Game",
    61: "GamePiece",
    62: "SkillAlterationDevice",
    63: "AttributeTransferDevice",
    64: "Hooker",
    65: "AllegianceBindstone",
    66: "InGameStatKeeper",
    67: "AugmentationDevice",
    68: "SocialManager",
    69: "Pet",
    70: "PetDevice",
    71: "CombatPet",
}

INFRA_DAMPING_BY_TYPE = {
    "Hook": 0.18,
    "House": 0.22,
    "Deed": 0.20,
    "SlumLord": 0.15,
    "Storage": 0.20,
    "BootSpot": 0.20,
    "HousePortal": 0.20,
    "Hooker": 0.18,
}

SERVICE_DAMPING_BY_TYPE = {
    "Portal": 0.65,
    "Vendor": 0.75,
    "LifeStone": 0.75,
    "Healer": 0.80,
}


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def smooth_rarity_weight(count: int, median_count: float) -> float:
    count = max(int(count), 1)
    median_count = max(float(median_count), 1.0)
    # Smoothed inverse-sqrt so rare objects matter more without exploding.
    raw = math.sqrt(median_count / count)
    return min(max(raw, 0.25), 4.0)


def wrong_penalty_weight(reward_weight: float) -> float:
    # Make rare mistakes more expensive than common mistakes.
    return min(max(0.75 + 0.85 * reward_weight, 0.75), 4.5)


def type_damping(weenie_type_name: str | None) -> float:
    if not weenie_type_name:
        return 1.0
    if weenie_type_name in INFRA_DAMPING_BY_TYPE:
        return INFRA_DAMPING_BY_TYPE[weenie_type_name]
    if weenie_type_name in SERVICE_DAMPING_BY_TYPE:
        return SERVICE_DAMPING_BY_TYPE[weenie_type_name]
    return 1.0


def build_weights(count_rows: list[dict], wcid_types: dict[str, int]) -> dict:
    wcid_rows = [row for row in count_rows if row.get("classIdSpace") == "wcid"]
    counts = [int(row["count"]) for row in wcid_rows]
    if not counts:
        raise SystemExit("No WCID rows found in counts file.")

    median_count = sorted(counts)[len(counts) // 2]
    max_count = max(counts)

    result = {
        "metadata": {
            "source_counts_file": str(DEFAULT_COUNTS_JSON),
            "source_type_cache": str(DEFAULT_WCID_TYPES_JSON),
            "median_wcid_count": median_count,
            "max_wcid_count": max_count,
            "formula": {
                "reward": "clamp(sqrt(median_count / count), 0.25, 4.0) * type_damping",
                "wrong_penalty": "clamp(0.75 + 0.85 * reward_weight, 0.75, 4.5)",
            },
            "infra_type_damping": INFRA_DAMPING_BY_TYPE,
            "service_type_damping": SERVICE_DAMPING_BY_TYPE,
        },
        "weights": {},
    }

    for row in wcid_rows:
        wcid = int(row["classId"])
        count = int(row["count"])
        name = row.get("name")
        weenie_type = wcid_types.get(str(wcid))
        weenie_type_name = WEENIE_TYPE_NAMES.get(weenie_type, f"Type{weenie_type}") if weenie_type is not None else None
        rarity_weight = smooth_rarity_weight(count, median_count)
        damping = type_damping(weenie_type_name)
        reward_weight = min(max(rarity_weight * damping, 0.10), 3.0)
        penalty_weight = wrong_penalty_weight(reward_weight)

        result["weights"][str(wcid)] = {
            "wcid": wcid,
            "name": name,
            "count": count,
            "relative_frequency": count / max_count,
            "weenie_type": weenie_type,
            "weenie_type_name": weenie_type_name,
            "rarity_weight": round(rarity_weight, 6),
            "type_damping": round(damping, 6),
            "reward_weight": round(reward_weight, 6),
            "wrong_penalty_weight": round(penalty_weight, 6),
        }

    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build per-WCID frequency-aware scoring weights for Dereth.")
    parser.add_argument("--counts-json", type=Path, default=DEFAULT_COUNTS_JSON)
    parser.add_argument("--wcid-types-json", type=Path, default=DEFAULT_WCID_TYPES_JSON)
    parser.add_argument("--out-json", type=Path, default=DEFAULT_OUTPUT_JSON)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    count_rows = load_json(args.counts_json)
    wcid_types = load_json(args.wcid_types_json)
    result = build_weights(count_rows, wcid_types)
    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    with args.out_json.open("w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print(f"Wrote frequency-aware weights to {args.out_json}")
    for wcid in ("9686", "11697", "11698", "9896"):
        if wcid in result["weights"]:
            print(json.dumps(result["weights"][wcid], indent=2))


if __name__ == "__main__":
    main()
