"""
Unified ontology resolver.

Loads `pipeline_data/enrichment/unified_ontology.json` (built by
`scripts/build_unified_ontology.py`) and exposes lookup methods keyed by
either model_id (Setup 0x02 or GfxObj 0x01) or wcid.

Usage::

    from PopulationPipeline.lib.unified_ontology import UnifiedOntology

    onto = UnifiedOntology.load_default()
    entry = onto.lookup_model_id(0x02000183)  # -> {'name': 'Bookcase', ...}
    name  = onto.name_for_model_id(0x02000183)
    cat   = onto.category_for_model_id(0x02000183)
    wcid_entry = onto.lookup_wcid(21089)

If the unified file is missing the resolver still constructs (returns
empty results), so legacy callers fall through to their own indexes.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

# Default location matches scripts/build_unified_ontology.py output.
_REPO = Path(__file__).resolve().parents[3]
DEFAULT_UNIFIED_PATH = _REPO / "pipeline_data" / "enrichment" / "unified_ontology.json"


class UnifiedOntology:
    """Read-only resolver over the merged ontology document."""

    def __init__(self, payload: dict | None):
        self._payload = payload or {}
        self._by_setup = self._payload.get("by_setup_did", {}) or {}
        self._by_gfx = self._payload.get("by_gfx_obj_id", {}) or {}
        self._by_wcid = self._payload.get("by_wcid", {}) or {}

    # ── Construction ────────────────────────────────────────────────
    @classmethod
    def load(cls, path: Path) -> "UnifiedOntology":
        if not path.exists():
            return cls(None)
        try:
            return cls(json.loads(path.read_text(encoding="utf-8-sig")))
        except Exception:
            return cls(None)

    @classmethod
    def load_default(cls) -> "UnifiedOntology":
        return cls.load(DEFAULT_UNIFIED_PATH)

    # ── Status ──────────────────────────────────────────────────────
    @property
    def loaded(self) -> bool:
        return bool(self._payload)

    @property
    def stats(self) -> dict:
        return self._payload.get("stats", {}) or {}

    @property
    def sources(self) -> dict:
        return self._payload.get("sources", {}) or {}

    # ── Lookups ─────────────────────────────────────────────────────
    def lookup_model_id(self, model_id: int) -> dict | None:
        """Return the ontology entry for a Setup or GfxObj id, or None."""
        if model_id is None:
            return None
        key = str(int(model_id))
        space = (int(model_id) >> 24) & 0xFF
        if space == 0x02:
            return self._by_setup.get(key)
        if space == 0x01:
            return self._by_gfx.get(key)
        return None

    def lookup_setup(self, setup_did: int) -> dict | None:
        if setup_did is None:
            return None
        return self._by_setup.get(str(int(setup_did)))

    def lookup_gfx(self, gfx_id: int) -> dict | None:
        if gfx_id is None:
            return None
        return self._by_gfx.get(str(int(gfx_id)))

    def lookup_wcid(self, wcid: int) -> dict | None:
        if wcid is None:
            return None
        return self._by_wcid.get(str(int(wcid)))

    # ── Convenience accessors ────────────────────────────────────────
    def name_for_model_id(self, model_id: int) -> str | None:
        e = self.lookup_model_id(model_id)
        return e.get("name") if e else None

    def category_for_model_id(self, model_id: int) -> str | None:
        e = self.lookup_model_id(model_id)
        if not e:
            return None
        types = e.get("types") or []
        if types:
            return types[0]
        gc = e.get("geom_category")
        if gc and gc != "Unknown":
            return gc
        return None

    def types_for_model_id(self, model_id: int) -> list[str]:
        e = self.lookup_model_id(model_id)
        return list(e.get("types") or []) if e else []

    def scale_for_model_id(self, model_id: int) -> str | None:
        e = self.lookup_model_id(model_id)
        if not e:
            return None
        gs = e.get("geom_scale")
        return gs if gs and gs != "Unknown" else None

    def is_building(self, model_id: int) -> bool:
        e = self.lookup_model_id(model_id)
        if not e:
            return False
        return bool(e.get("is_building") or e.get("building_via_parent"))

    def is_scenery(self, model_id: int) -> bool:
        e = self.lookup_model_id(model_id)
        if not e:
            return False
        return bool(e.get("is_scenery") or e.get("scenery_via_parent"))

    def parent_setups(self, gfx_id: int) -> list[int]:
        e = self.lookup_gfx(gfx_id)
        return list(e.get("parent_setups_int") or []) if e else []

    # ── Bulk projections (for legacy index compatibility) ────────────
    def setup_name_index(self) -> dict[int, str]:
        """setup_did -> name (None entries dropped)."""
        out: dict[int, str] = {}
        for k, v in self._by_setup.items():
            if v.get("name"):
                out[int(k)] = v["name"]
        return out

    def gfx_name_index(self) -> dict[int, str]:
        out: dict[int, str] = {}
        for k, v in self._by_gfx.items():
            if v.get("name"):
                out[int(k)] = v["name"]
        return out

    def model_id_name_index(self) -> dict[int, str]:
        idx = self.setup_name_index()
        idx.update(self.gfx_name_index())
        return idx

    def all_setup_dids(self) -> Iterable[int]:
        return (int(k) for k in self._by_setup.keys())

    def all_gfx_ids(self) -> Iterable[int]:
        return (int(k) for k in self._by_gfx.keys())
