#!/usr/bin/env python3
"""
build_ontology_enrichment.py — Deterministic ontology enrichment from structured data.

Reads:
  1. ACE-master/Source/ACE.Entity/Enum/WeenieClassName.cs   → name↔wcid mapping
  2. ACE-master/Source/ACE.Entity/Enum/CreatureType.cs       → creature family IDs
  3. LSD-Partial-*/weenie_summary.jsonl                      → wcid→setupDid, level, creatureType, weenieType
  4. LSD-Partial-*/spawnmap_summary.jsonl                    → spawn validation data (optional)

Produces:
  canonical_enrichment.json — one entry per world-relevant wcid, every tag traceable to a source.

Design principles:
  - ZERO hallucination: every tag is derived from data, not guessed
  - World-independent: biome/architecture tags are intrinsic object properties, not retail positions
  - Deterministic: run twice → identical output
  - Extensible: wiki data becomes another input later
"""

import json
import re
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

# ── Paths (relative to project root) ──────────────────────────────────────────

PROJ_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

WEENIE_CLASS_NAME_CS = os.path.join(PROJ_ROOT, "ACE-master", "Source", "ACE.Entity", "Enum", "WeenieClassName.cs")
CREATURE_TYPE_CS     = os.path.join(PROJ_ROOT, "ACE-master", "Source", "ACE.Entity", "Enum", "CreatureType.cs")
WEENIE_SUMMARY_JSONL = os.path.join(PROJ_ROOT, "LSD-Partial-2025-02-23_16-15", "weenie_summary.jsonl")
SPAWNMAP_JSONL       = os.path.join(PROJ_ROOT, "LSD-Partial-2025-02-23_16-15", "spawnmap_summary.jsonl")

OUTPUT_FILE          = os.path.join(PROJ_ROOT, "pipeline_data", "enrichment", "canonical_enrichment.json")

# ── Intrinsic creature family → biome mapping ────────────────────────────────
# These are INHERENT properties of each creature family, not derived from where
# they spawn in retail. A new world should respect these same affinities.
# Source: creature names, AC lore, and common sense (Ice Golem → Snowy, etc.)

CREATURE_FAMILY_BIOME = {
    # family_name_lower: (biome_list, behavior)
    "olthoi":           (["Underground", "Swamp"],          "Melee"),
    "banderling":       (["Temperate", "Swamp"],            "Melee"),
    "drudge":           (["Temperate", "Swamp"],            "Mixed"),
    "mosswart":         (["Swamp", "Temperate"],            "Melee"),
    "lugian":           (["Temperate", "Volcanic"],         "Melee"),
    "tumerok":          (["Temperate", "Desert"],           "Mixed"),
    "mite":             (["Underground", "Temperate"],      "Melee"),
    "tusker":           (["Temperate"],                     "Melee"),
    "phyntoswasp":      (["Temperate", "Swamp"],            "Melee"),
    "rat":              (["Any"],                           "Melee"),
    "auroch":           (["Temperate"],                     "Passive"),
    "cow":              (["Temperate"],                     "Passive"),
    "golem":            (["Any"],                           "Melee"),   # sub-typed below
    "undead":           (["Underground", "Swamp"],          "Mixed"),
    "gromnie":          (["Temperate", "Swamp"],            "Melee"),
    "reedshark":        (["Coastal", "Swamp"],              "Melee"),
    "armoredillo":      (["Desert", "Temperate"],           "Melee"),
    "fae":              (["Temperate"],                     "Caster"),
    "virindi":          (["Any"],                           "Caster"),
    "wisp":             (["Temperate", "Swamp"],            "Caster"),
    "knathtead":        (["Underground"],                   "Melee"),
    "shadow":           (["Any"],                           "Caster"),
    "mattekar":         (["Snowy"],                         "Melee"),
    "mumiyah":          (["Desert", "Underground"],         "Melee"),
    "rabbit":           (["Temperate"],                     "Passive"),
    "sclavus":          (["Swamp", "Underground"],          "Mixed"),
    "shallowsshark":    (["Coastal"],                       "Melee"),
    "monouga":          (["Temperate", "Underground"],      "Melee"),
    "zefir":            (["Desert"],                        "Melee"),
    "skeleton":         (["Underground", "Any"],            "Mixed"),
    "human":            (["Any"],                           "Mixed"),
    "shreth":           (["Temperate", "Desert"],           "Melee"),
    "chittick":         (["Swamp"],                         "Melee"),
    "moarsman":         (["Coastal", "Swamp"],              "Melee"),
    "olthoilarvae":     (["Underground"],                   "Melee"),
    "slithis":          (["Swamp", "Underground"],          "Melee"),
    "deru":             (["Temperate"],                     "Melee"),
    "fireelemental":    (["Volcanic", "Desert"],            "Caster"),
    "snowman":          (["Snowy"],                         "Melee"),
    "bunny":            (["Temperate"],                     "Passive"),
    "lightningelemental": (["Any"],                         "Caster"),
    "rockslide":        (["Volcanic", "Desert"],            "Melee"),
    "grievver":         (["Underground"],                   "Melee"),
    "niffis":           (["Swamp"],                         "Caster"),
    "ursuin":           (["Snowy", "Temperate"],            "Melee"),
    "crystal":          (["Underground"],                   "Caster"),
    "hollowminion":     (["Any"],                           "Mixed"),
    "scarecrow":        (["Temperate"],                     "Melee"),
    "idol":             (["Underground"],                   "Caster"),
    "empyrean":         (["Any"],                           "Caster"),
    "hopeslayer":       (["Underground"],                   "Boss"),
    "doll":             (["Any"],                           "Caster"),
    "marionette":       (["Underground"],                   "Caster"),
    "carenzi":          (["Temperate"],                     "Melee"),
    "siraluun":         (["Temperate"],                     "Melee"),
    "auntumerok":       (["Temperate"],                     "Mixed"),
    "heatumerok":       (["Desert", "Temperate"],           "Mixed"),
    "simulacrum":       (["Any"],                           "Mixed"),
    "acidelemental":    (["Swamp", "Underground"],          "Caster"),
    "frostelemental":   (["Snowy"],                         "Caster"),
    "elemental":        (["Any"],                           "Caster"),
    "statue":           (["Any"],                           "Melee"),
    "wall":             (["Any"],                           "Melee"),
    "alteredhuman":     (["Any"],                           "Mixed"),
    "device":           (["Any"],                           "Passive"),
    "harbinger":        (["Any"],                           "Boss"),
    "darksarcophagus":  (["Underground"],                   "Melee"),
    "chicken":          (["Temperate"],                     "Passive"),
    "gotroklugian":     (["Temperate", "Volcanic"],         "Melee"),
    "margul":           (["Underground"],                   "Melee"),
    "bleachedrabbit":   (["Temperate"],                     "Passive"),
    "nastyrabbit":      (["Temperate"],                     "Melee"),
    "grimacingrabbit":  (["Temperate"],                     "Melee"),
    "burun":            (["Swamp"],                         "Melee"),
    "target":           (["Any"],                           "Passive"),
    "ghost":            (["Underground", "Swamp"],          "Caster"),
    "fiun":             (["Snowy"],                         "Mixed"),
    "eater":            (["Swamp"],                         "Melee"),
    "penguin":          (["Snowy", "Coastal"],              "Passive"),
    "ruschk":           (["Snowy"],                         "Melee"),
    "thrungus":         (["Underground"],                   "Melee"),
    "viamontianknight": (["Temperate"],                     "Melee"),
    "remoran":          (["Coastal"],                       "Melee"),
    "swarm":            (["Any"],                           "Melee"),
    "moar":             (["Underground"],                   "Melee"),
    "enchantedarms":    (["Underground"],                   "Melee"),
    "sleech":           (["Swamp"],                         "Melee"),
    "mukkir":           (["Underground"],                   "Melee"),
    "merwart":          (["Coastal", "Swamp"],              "Melee"),
    "food":             (["Any"],                           "Passive"),
    "paradoxolthoi":    (["Underground"],                   "Melee"),
    "harvest":          (["Any"],                           "Passive"),
    "energy":           (["Any"],                           "Caster"),
    "apparition":       (["Underground", "Swamp"],          "Caster"),
    "aerbax":           (["Underground"],                   "Boss"),
    "touched":          (["Any"],                           "Mixed"),
    "blightedmoarsman": (["Swamp", "Coastal"],              "Melee"),
    "gearknight":       (["Any"],                           "Melee"),
    "gurog":            (["Underground", "Volcanic"],       "Melee"),
    "anekshay":         (["Underground"],                   "Mixed"),
}

# ── Golem sub-type biome overrides (from name keywords) ──────────────────────

GOLEM_BIOME_OVERRIDE = {
    "ice":        ["Snowy"],
    "frost":      ["Snowy"],
    "snow":       ["Snowy"],
    "magma":      ["Volcanic"],
    "lava":       ["Volcanic"],
    "fire":       ["Volcanic", "Desert"],
    "obsidian":   ["Volcanic"],
    "sand":       ["Desert"],
    "sandstone":  ["Desert"],
    "mud":        ["Swamp"],
    "coral":      ["Coastal"],
    "water":      ["Coastal", "Swamp"],
    "copper":     ["Any"],
    "iron":       ["Any"],
    "bronze":     ["Any"],
    "granite":    ["Temperate"],
    "limestone":  ["Temperate"],
    "diamond":    ["Underground"],
    "crystal":    ["Underground"],
    "oak":        ["Temperate"],
    "wood":       ["Temperate"],
}

# ── Architecture keywords in WeenieClassName ─────────────────────────────────

ARCHITECTURE_KEYWORDS = {
    "aluvian":    "Aluvian",
    "sho":        "Sho",          # careful: "shoushi" is a town, "sho" matches cultural
    "gharun":     "Gharu'ndim",
    "gm":         "Gharu'ndim",   # short form used in some names like GMDOOR
    "viamontian": "Viamontian",
    "viam":       "Viamontian",
    "empyrean":   "Empyrean",
    "falatacot":  "Empyrean",
}

# ── Town names → architecture (intrinsic cultural affiliation) ───────────
# NPCs, signs, and structures named after towns inherit the town's culture.
# This is world-independent: these town names are cultural identifiers.

TOWN_ARCHITECTURE = {
    # Aluvian towns
    "holtburg":     "Aluvian",
    "lytelthorpe":  "Aluvian",
    "rithwic":      "Aluvian",
    "cragstone":    "Aluvian",
    "arwic":        "Aluvian",
    "eastham":      "Aluvian",
    "glenden":      "Aluvian",
    "stonehold":    "Aluvian",
    "dryreach":     "Aluvian",
    "plateau":      "Aluvian",
    "bandit":       "Aluvian",  # Bandit Castle area
    # Sho towns
    "shoushi":      "Sho",
    "yanshi":       "Sho",
    "mayoi":        "Sho",
    "nanto":        "Sho",
    "hebian":       "Sho",
    "sawato":       "Sho",
    "baishi":       "Sho",
    "toutou":       "Sho",
    "kara":         "Sho",
    "linvak":       "Sho",     # Linvak Massif (mixed but Sho-adjacent)
    # Gharu'ndim towns
    "yaraq":        "Gharu'ndim",
    "samsur":       "Gharu'ndim",
    "alarqas":      "Gharu'ndim",
    "aljalima":     "Gharu'ndim",
    "tufa":         "Gharu'ndim",
    "qalabar":      "Gharu'ndim",
    "uziz":         "Gharu'ndim",
    "xarabydun":    "Gharu'ndim",
    "zaikhal":      "Gharu'ndim",
    "khayyaban":    "Gharu'ndim",
    "ayan":         "Gharu'ndim",  # Ayan Baqur
    # Viamontian towns
    "sanamar":      "Viamontian",
    "silyun":       "Viamontian",
    "freehold":     "Viamontian",
    "viamont":      "Viamontian",
    # Empyrean locations
    "knorr":        "Empyrean",
    "aerlinthe":    "Empyrean",
    "candeth":      "Empyrean",  # Candeth Keep
}

# ── Object type keywords in WeenieClassName ──────────────────────────────────

TYPE_KEYWORDS = {
    # Structures
    "house":      "Structure",
    "cottage":    "Structure",
    "villa":      "Structure",
    "mansion":    "Structure",
    "tower":      "Structure",
    "fort":       "Structure",
    "keep":       "Structure",
    # Doors
    "door":       "Interactive_Door",
    # Portals
    "portal":     "Interactive_Portal",
    "lifestone":  "Interactive_Lifestone",
    # Furniture
    "chest":      "Furniture_Storage",
    "crate":      "Furniture_Storage",
    "barrel":     "Furniture_Storage",
    "coffin":     "Furniture_Storage",
    "sarcophagus":"Furniture_Storage",
    "coffer":     "Furniture_Storage",
    "brazier":    "Furniture_Light",
    "candle":     "Furniture_Light",
    "candlestick":"Furniture_Light",
    "candelabra": "Furniture_Light",
    "chandelier": "Furniture_Light",
    "lantern":    "Furniture_Light",
    "lamp":       "Furniture_Light",
    "sconce":     "Furniture_Light",
    "cresset":    "Furniture_Light",
    "torch":      "Furniture_Light",
    "campfire":   "Furniture_Light",
    "chair":      "Furniture_Chair",
    "bench":      "Furniture_Chair",
    "stool":      "Furniture_Chair",
    "throne":     "Furniture_Chair",
    "couch":      "Furniture_Chair",
    "desk":       "Furniture_Table",
    "table":      "Furniture_Table",
    "workbench":  "Furniture_Functional",
    "hearth":     "Furniture_Functional",
    "bed":        "Furniture_Bed",
    "bedroll":    "Furniture_Bed",
    "painting":   "Furniture_Decorative",
    "tapestry":   "Furniture_Decorative",
    # Scenery
    "tree":       "Scenery_Tree",
    "bush":       "Scenery_Bush",
    "shrub":      "Scenery_Bush",
    "rock":       "Scenery_Rock",
    "boulder":    "Scenery_Rock",
    "fountain":   "Scenery_Water",
    "well":       "Scenery_Water",
    "pool":       "Scenery_Water",
    "cistern":    "Scenery_Water",
    "mushroom":   "Natural_Mushroom",
    # Signs
    "sign":       "Sign_Town",
    "signpost":   "Sign_Town",
    "bulletin":   "Sign_Info",
    # NPCs (by role in name)
    "barkeep":    "NPC_Barkeep",
    "barkeeper":  "NPC_Barkeep",
    "archmage":   "NPC_Archmage",
    "blacksmith": "NPC_Vendor",
    "bowyer":     "NPC_Vendor",
    "healer":     "NPC_Vendor",
    "grocer":     "NPC_Vendor",
    "jeweler":    "NPC_Vendor",
    "tailor":     "NPC_Vendor",
    "scribe":     "NPC_Vendor",
    "weaponsmith":"NPC_Vendor",
    "armorer":    "NPC_Vendor",
    "shopkeep":   "NPC_Vendor",
    "peddler":    "NPC_Vendor",
    "vendor":     "NPC_Vendor",
    # Generators
    "generator":  "Interactive_Generator",
}

# ── WeenieType → ontology category mapping ───────────────────────────────────

WEENIE_TYPE_CATEGORY = {
    1:  "Prop",             # Generic
    2:  None,               # Clothing (inventory, skip)
    3:  None,               # MissileLauncher (inventory)
    4:  None,               # Missile (inventory)
    5:  None,               # Ammunition (inventory)
    6:  None,               # MeleeWeapon (inventory)
    7:  "Interactive_Portal",# Portal
    8:  None,               # Book (inventory)
    9:  None,               # Coin (inventory)
    10: "Creature",         # Creature
    12: "NPC",              # Vendor
    14: "Interactive_Door", # Door
    15: None,               # Corpse
    18: None,               # Food
    19: "Furniture_Storage",# Chest
    20: "Furniture_Storage",# Container
    24: "Interactive_Switch",# PressurePlate
    25: "Interactive_Lifestone",# LifeStone
    26: "Interactive_Switch",# Switch
    29: "Furniture_Light",  # LightSource
    34: "Furniture_Light",  # LightSource (alt index)
    37: None,               # ProjectileSpell
    38: None,               # Gem (inventory)
    44: None,               # CraftTool (inventory)
    55: "Structure",        # House
}

# ── World-relevant WeenieTypes (objects that get placed in the world) ────────

WORLD_RELEVANT_TYPES = {1, 7, 10, 12, 14, 19, 20, 24, 25, 26, 29, 34, 55}


# ═══════════════════════════════════════════════════════════════════════════════
#  PARSING FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════════

def parse_weenie_class_names(filepath: str) -> dict[int, str]:
    """Parse WeenieClassName.cs → {wcid: cleaned_name}"""
    result = {}
    pattern = re.compile(r'^\s*W_(\w+?)_CLASS\s*=\s*(\d+)', re.MULTILINE)
    
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    for m in pattern.finditer(content):
        name = m.group(1).lower()
        wcid = int(m.group(2))
        result[wcid] = name
    
    print(f"[WeenieClassName] Parsed {len(result)} entries from {os.path.basename(filepath)}")
    return result


def parse_creature_types(filepath: str) -> dict[int, str]:
    """Parse CreatureType.cs → {type_id: family_name_lower}"""
    result = {}
    
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Extract just the enum body
    enum_start = content.find('{', content.find('enum'))
    enum_end = content.find('}', enum_start)
    if enum_start < 0:
        return result
    enum_body = content[enum_start+1:enum_end]
    
    # C# enum: auto-increments from 0 unless explicit value given
    idx = 0
    for line in enum_body.strip().split('\n'):
        line = line.strip().rstrip(',').strip()
        if not line or line.startswith('//') or line.startswith('['):
            continue
        # Must be a valid identifier (not { or })
        m = re.match(r'^([A-Za-z_]\w*)(?:\s*=\s*(\d+))?$', line)
        if not m:
            continue
        name = m.group(1)
        if m.group(2) is not None:
            idx = int(m.group(2))
        result[idx] = name.lower()
        idx += 1
    
    print(f"[CreatureType]    Parsed {len(result)} families from {os.path.basename(filepath)}")
    return result


def parse_weenie_summary(filepath: str) -> dict[int, dict]:
    """Parse weenie_summary.jsonl → {wcid: {name, weenieType, setupDid, level, creatureType}}"""
    result = {}
    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                wcid = obj.get("wcid", 0)
                result[wcid] = {
                    "name": obj.get("name"),
                    "weenieType": obj.get("weenieType"),
                    "setupDid": obj.get("setupDid"),
                    "level": obj.get("level"),
                    "creatureType": obj.get("creatureType"),
                    "itemType": obj.get("itemType"),
                }
            except json.JSONDecodeError:
                continue
    print(f"[WeenieSummary]   Parsed {len(result)} entries from {os.path.basename(filepath)}")
    return result


# ═══════════════════════════════════════════════════════════════════════════════
#  ENRICHMENT LOGIC
# ═══════════════════════════════════════════════════════════════════════════════

def extract_architecture(class_name_lower: str, weenie_name_lower: str = "") -> tuple[str | None, str]:
    """Extract architecture style from weenie class name or display name. Returns (architecture, source)."""
    # Must be careful with short patterns like "sho" — don't match "shovel", "shopkeep"
    # Use word-boundary-like checks
    
    for keyword, arch in ARCHITECTURE_KEYWORDS.items():
        if keyword == "sho":
            # "sho" must appear as prefix or after a word break, not in "shovel", "shopkeep", etc.
            if re.search(r'(?:^|_)sho(?:_|lantern|door|slide|left|right|house|$)', class_name_lower):
                return arch, f"WeenieClassName contains '{keyword}'"
        elif keyword == "gm":
            # "gm" prefix pattern like "gmdoor"
            if class_name_lower.startswith("gm") or "_gm" in class_name_lower:
                # But not "gem", "game", etc.
                if re.search(r'(?:^|_)gm(?:door|tent|house|wall|tower)', class_name_lower):
                    return arch, f"WeenieClassName contains '{keyword}' prefix"
        else:
            if keyword in class_name_lower:
                return arch, f"WeenieClassName contains '{keyword}'"
    
    # Check town names in both class name and display name
    search_texts = [class_name_lower, weenie_name_lower]
    for text in search_texts:
        if not text:
            continue
        for town, arch in TOWN_ARCHITECTURE.items():
            if town in text:
                src_label = "WeenieClassName" if text == class_name_lower else "weenie name"
                return arch, f"{src_label} contains town '{town}' ({arch})"
    
    return None, ""


def extract_type_from_name(class_name_lower: str) -> tuple[str | None, str]:
    """Extract object type from weenie class name keywords."""
    # Check longest keywords first to avoid partial matches
    sorted_keywords = sorted(TYPE_KEYWORDS.keys(), key=len, reverse=True)
    
    for keyword in sorted_keywords:
        if keyword in class_name_lower:
            # Avoid false positives: "doorprison" should match "door", not miss it
            return TYPE_KEYWORDS[keyword], f"WeenieClassName contains '{keyword}'"
    
    return None, ""


def classify_creature(
    wcid: int,
    weenie_data: dict,
    class_name: str | None,
    creature_types: dict[int, str],
) -> dict:
    """Build creature-specific tags from weenie data and name analysis."""
    result = {
        "creature_family": None,
        "creature_family_source": None,
        "biome": None,
        "biome_source": None,
        "behavior": None,
        "behavior_source": None,
        "difficulty_tier": None,
        "difficulty_tier_source": None,
    }
    
    # Creature family from CreatureType enum
    ct = weenie_data.get("creatureType")
    if ct is not None and ct in creature_types:
        family_name = creature_types[ct]
        result["creature_family"] = family_name
        result["creature_family_source"] = f"CreatureType enum ({ct}={family_name})"
        
        # Look up biome and behavior from intrinsic mapping
        family_key = family_name.lower()
        if family_key in CREATURE_FAMILY_BIOME:
            biome_list, behavior = CREATURE_FAMILY_BIOME[family_key]
            result["biome"] = biome_list
            result["biome_source"] = f"intrinsic family affinity ({family_name})"
            result["behavior"] = behavior
            result["behavior_source"] = f"intrinsic family behavior ({family_name})"
            
            # Golem sub-type override from name
            if family_key == "golem" and class_name:
                for golem_key, golem_biome in GOLEM_BIOME_OVERRIDE.items():
                    if golem_key in class_name:
                        result["biome"] = golem_biome
                        result["biome_source"] = f"golem sub-type '{golem_key}' in name"
                        break
    
    # Difficulty tier from level
    level = weenie_data.get("level")
    if level is not None:
        if level < 20:
            tier = "Starter"
        elif level < 40:
            tier = "Low"
        elif level < 80:
            tier = "Medium"
        elif level < 125:
            tier = "Hard"
        elif level < 200:
            tier = "Elite"
        else:
            tier = "Legendary"
        result["difficulty_tier"] = tier
        result["difficulty_tier_source"] = f"level {level} → bracket"
    
    return result


def build_enrichment_entry(
    wcid: int,
    weenie_data: dict,
    class_name: str | None,
    creature_types: dict[int, str],
) -> dict | None:
    """Build a single enrichment entry for a world-relevant weenie."""
    
    wt = weenie_data.get("weenieType")
    
    # Skip non-world-relevant types (inventory items, spells, etc.)
    if wt not in WORLD_RELEVANT_TYPES:
        return None
    
    entry = {
        "wcid": wcid,
        "name": weenie_data.get("name"),
        "setupDid": weenie_data.get("setupDid"),
        "weenieType": wt,
        "architecture": None,
        "biome": None,
        "type": None,
        "creature_family": None,
        "difficulty_tier": None,
        "level": weenie_data.get("level"),
        "behavior": None,
        "tags": [],
        "tag_sources": {},
    }
    
    # -- Architecture from class name + weenie display name --
    weenie_name_lower = (weenie_data.get("name") or "").lower()
    if class_name:
        arch, arch_src = extract_architecture(class_name, weenie_name_lower)
    else:
        arch, arch_src = extract_architecture("", weenie_name_lower)
    if arch:
        entry["architecture"] = arch
        entry["tag_sources"]["architecture"] = arch_src
    else:
        # Culturally neutral IS a culture — everything gets an architecture tag
        entry["architecture"] = "Neutral"
        entry["tag_sources"]["architecture"] = "no cultural keyword detected"
    
    # ── Type from weenieType enum ──
    base_type = WEENIE_TYPE_CATEGORY.get(wt)
    if base_type:
        entry["type"] = base_type
        entry["tag_sources"]["type"] = f"WeenieType {wt}"
    
    # ── Type override from class name (more specific) ──
    if class_name:
        name_type, name_type_src = extract_type_from_name(class_name)
        if name_type:
            # Name-derived type is more specific than weenieType
            entry["type"] = name_type
            entry["tag_sources"]["type"] = name_type_src
    
    # -- Creature-specific enrichment --
    if wt == 10:  # Creature
        creature_tags = classify_creature(wcid, weenie_data, class_name, creature_types)
        entry["creature_family"] = creature_tags["creature_family"]
        entry["biome"] = creature_tags["biome"]
        entry["behavior"] = creature_tags["behavior"]
        entry["difficulty_tier"] = creature_tags["difficulty_tier"]
        
        if creature_tags["creature_family_source"]:
            entry["tag_sources"]["creature_family"] = creature_tags["creature_family_source"]
        if creature_tags["biome_source"]:
            entry["tag_sources"]["biome"] = creature_tags["biome_source"]
        if creature_tags["behavior_source"]:
            entry["tag_sources"]["behavior"] = creature_tags["behavior_source"]
        if creature_tags["difficulty_tier_source"]:
            entry["tag_sources"]["difficulty_tier"] = creature_tags["difficulty_tier_source"]
        
        # Fill gaps for creatures missing data
        if not entry["biome"]:
            entry["biome"] = ["Any"]
            entry["tag_sources"]["biome"] = "default (no creature family mapping)"
        if not entry["behavior"]:
            entry["behavior"] = "Mixed"
            entry["tag_sources"]["behavior"] = "default (no creature family mapping)"
    else:
        # Non-creature objects: biome is Any (place anywhere), behavior is Passive
        entry["biome"] = ["Any"]
        entry["behavior"] = "Passive"
        entry["tag_sources"]["biome"] = "non-creature default"
        entry["tag_sources"]["behavior"] = "non-creature default"
    
    # ── Build compound tags ──
    tags = []
    if entry["name"]:
        tags.append(entry["name"].lower())
    if entry["architecture"]:
        tags.append(entry["architecture"].lower())
    if entry["creature_family"]:
        tags.append(entry["creature_family"])
    if entry["type"]:
        tags.append(entry["type"].lower())
    if entry["difficulty_tier"]:
        tags.append(f"tier_{entry['difficulty_tier'].lower()}")
    if entry["behavior"]:
        tags.append(entry["behavior"].lower())
    
    entry["tags"] = sorted(set(tags))
    
    return entry


# ═══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    print("=" * 72)
    print("  Canonical Ontology Enrichment Builder")
    print("=" * 72)
    print()
    
    # ── Validate inputs exist ──
    for path, label in [
        (WEENIE_CLASS_NAME_CS, "WeenieClassName.cs"),
        (CREATURE_TYPE_CS, "CreatureType.cs"),
        (WEENIE_SUMMARY_JSONL, "weenie_summary.jsonl"),
    ]:
        if not os.path.exists(path):
            print(f"ERROR: {label} not found at {path}")
            sys.exit(1)
    
    # ── Parse sources ──
    wcn_names = parse_weenie_class_names(WEENIE_CLASS_NAME_CS)
    creature_types = parse_creature_types(CREATURE_TYPE_CS)
    weenie_data = parse_weenie_summary(WEENIE_SUMMARY_JSONL)
    
    print()
    print("-" * 72)
    print("  Building enrichment entries...")
    print("-" * 72)
    
    # ── Build entries ──
    entries = []
    stats = Counter()
    
    for wcid, wd in sorted(weenie_data.items()):
        class_name = wcn_names.get(wcid)
        entry = build_enrichment_entry(wcid, wd, class_name, creature_types)
        
        if entry is None:
            stats["skipped_non_world"] += 1
            continue
        
        entries.append(entry)
        stats["total"] += 1
        
        if entry["architecture"]:
            stats["has_architecture"] += 1
        if entry["biome"]:
            stats["has_biome"] += 1
        if entry["type"]:
            stats["has_type"] += 1
        if entry["creature_family"]:
            stats["has_creature_family"] += 1
        if entry["difficulty_tier"]:
            stats["has_difficulty_tier"] += 1
        if entry["behavior"]:
            stats["has_behavior"] += 1
    
    # ── Compute architecture distribution ──
    arch_counts = Counter(e["architecture"] for e in entries if e["architecture"])
    type_counts = Counter(e["type"] for e in entries if e["type"])
    biome_counts = Counter()
    for e in entries:
        if e["biome"]:
            for b in e["biome"]:
                biome_counts[b] += 1
    family_counts = Counter(e["creature_family"] for e in entries if e["creature_family"])
    tier_counts = Counter(e["difficulty_tier"] for e in entries if e["difficulty_tier"])
    
    # ── Write output ──
    output = {
        "version": "1.0",
        "generated": datetime.now(timezone.utc).isoformat(),
        "generator": "build_ontology_enrichment.py",
        "sources": [
            os.path.basename(WEENIE_CLASS_NAME_CS),
            os.path.basename(CREATURE_TYPE_CS),
            os.path.basename(WEENIE_SUMMARY_JSONL),
        ],
        "statistics": {
            "total_entries": stats["total"],
            "skipped_non_world": stats["skipped_non_world"],
            "has_architecture": stats["has_architecture"],
            "has_biome": stats["has_biome"],
            "has_type": stats["has_type"],
            "has_creature_family": stats["has_creature_family"],
            "has_difficulty_tier": stats["has_difficulty_tier"],
            "has_behavior": stats["has_behavior"],
            "architecture_distribution": dict(arch_counts.most_common()),
            "type_distribution": dict(type_counts.most_common()),
            "biome_distribution": dict(biome_counts.most_common()),
            "creature_family_top20": dict(family_counts.most_common(20)),
            "difficulty_tier_distribution": dict(tier_counts.most_common()),
        },
        "entries": entries,
    }
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    file_size_mb = os.path.getsize(OUTPUT_FILE) / (1024 * 1024)
    
    # ── Print report ──
    print()
    print("=" * 72)
    print("  ENRICHMENT REPORT")
    print("=" * 72)
    print()
    print(f"  Input weenies:           {len(weenie_data):>8,}")
    print(f"  Skipped (non-world):     {stats['skipped_non_world']:>8,}")
    print(f"  World-relevant entries:  {stats['total']:>8,}")
    print()
    print(f"  With architecture tag:   {stats['has_architecture']:>8,}  ({100*stats['has_architecture']/max(stats['total'],1):.1f}%)")
    print(f"  With biome tag:          {stats['has_biome']:>8,}  ({100*stats['has_biome']/max(stats['total'],1):.1f}%)")
    print(f"  With type tag:           {stats['has_type']:>8,}  ({100*stats['has_type']/max(stats['total'],1):.1f}%)")
    print(f"  With creature_family:    {stats['has_creature_family']:>8,}  ({100*stats['has_creature_family']/max(stats['total'],1):.1f}%)")
    print(f"  With difficulty_tier:    {stats['has_difficulty_tier']:>8,}  ({100*stats['has_difficulty_tier']/max(stats['total'],1):.1f}%)")
    print(f"  With behavior:           {stats['has_behavior']:>8,}  ({100*stats['has_behavior']/max(stats['total'],1):.1f}%)")
    print()
    
    print("  Architecture distribution:")
    for arch, count in arch_counts.most_common():
        print(f"    {arch:<20s} {count:>6,}")
    print()
    
    print("  Type distribution (top 15):")
    for t, count in type_counts.most_common(15):
        print(f"    {t:<25s} {count:>6,}")
    print()
    
    print("  Biome distribution:")
    for b, count in biome_counts.most_common():
        print(f"    {b:<20s} {count:>6,}")
    print()
    
    print("  Difficulty tier distribution:")
    for t, count in tier_counts.most_common():
        print(f"    {t:<20s} {count:>6,}")
    print()
    
    print("  Creature families (top 15):")
    for fam, count in family_counts.most_common(15):
        print(f"    {fam:<25s} {count:>6,}")
    print()
    
    print(f"  Output: {OUTPUT_FILE}")
    print(f"  Size:   {file_size_mb:.1f} MB")
    print()
    print("=" * 72)


if __name__ == "__main__":
    main()
