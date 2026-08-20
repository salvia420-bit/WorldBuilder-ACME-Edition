#!/usr/bin/env python3
"""queue_worker.py -- AcmeRedline: turn player redline reports into machine-
actionable work items for the existing dat-patch lanes.

    python3 queue_worker.py --queue fixtures/redline.jsonl \
        --portal ~/ac_base_dats/client_portal.dat [--cell ...] \
        [--status redline-status.jsonl] [--out work-items.json]

READ-ONLY.  It opens the dats through tools/dat-patch/datlib.py + gfxlib.py and
never writes to them; the only file it creates is work-items.json (+ whatever
--out names).

Five stages per entry, in order:

  1. VALIDATE  against schema_v1.json (a small draft-07 subset validator lives
     here so the tool runs on a box with no `jsonschema` installed; if the real
     library IS importable it is used instead and the subset is bypassed).

  2. RESOLVE   every cited id against the REAL dat: does the record exist, what
     are the RenderSurface's true dims/format, does the GfxObj record still
     hash to the reporter's `baseRecordSha256`.  A hash mismatch is
     "stale-selection" and the triangle indices are then re-derived from the
     stored geometric footprint (nearest-centroid) instead of trusted.

  3. GUARD     the three refusals the shipped lanes already enforce:
       * RenderSurface in terrain_protected_rs.txt  -> terrain-lane-only.
         (texture_lane.py:505-524, fill_import.py:77-101: a DXT/2048 overwrite
         of a MergeTexture-locked terrain RS crashes the client at VeryHigh.)
       * RenderSurface format INDEX16(101)/P8(41)   -> palette route, 2x,
         indices re-solved against the record's OWN palette; NEVER converted to
         DXT, which would freeze the colours and break every ClothingTable
         subpalette recolour (fill_import.py:13-19,150-170).
       * GfxObj whose degrade band 0 is a DIFFERENT record -> the retail client
         never draws the root mesh, so displacing it is invisible bytes
         (tranche.py:309-330, gfxlib.py:235-253).

  4. CLASSIFY  into a lane plus a CONCRETE knob menu -- the real environment
     variables, CLI flags and module constants of the lane that would do the
     work, filled in with this record's measured facts.

  5. AGGREGATE by primary target id (rsId for texture reports, gfxObjId for
     triangle reports) and rank by reports x instance exposure.

Nothing here mutates a dat, runs WorldBuilder.Terminal, or shells out.  The
suggested actions are DATA: an agent (or a human) reads work-items.json and
runs them.
"""
import argparse
import hashlib
import json
import math
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATPATCH = os.path.dirname(HERE)                    # tools/dat-patch
sys.path.insert(0, DATPATCH)

import datlib                                       # noqa: E402
import gfxlib                                       # noqa: E402

SCHEMA_PATH = os.path.join(HERE, "schema_v1.json")
PROTECTED_PATH = os.path.join(DATPATCH, "terrain_protected_rs.txt")

# PixelFormat numeric ids -- copied from texture_lane.py:54-64 (retail D3DFMT /
# FourCC values; the palettized pair was corrected there on 2026-08-16).
PF = {
    101: "INDEX16", 41: "P8",
    20: "R8G8B8", 21: "A8R8G8B8", 23: "R5G6B5", 26: "A4R4G4B4", 28: "A8",
    827611204: "DXT1", 861165636: "DXT3", 894720068: "DXT5",
    1000: "CUSTOM_RAW_JPEG",
}
PALETTED = {41, 101}                                # texture_lane.py:64

# Lane knob defaults, quoted from the shipped modules so the work item can name
# a real starting value instead of a guess.
KNOBS = {
    # tools/dat-patch/pilot.py:30,48-58
    "AMP_WALL": 0.20, "GROUND_SCALE": 0.55, "PLINTH_LO": 0.45, "PLINTH_HI": 0.75,
    "NORMAL_GAIN": 2.5, "FLOOR_M": 0.006, "FINE_BUDGET": 220000,
    "WALL_CLASSES": ["Brick", "Stone", "Plank", "Timber"],
    # tools/dat-patch/relief3d.py:32-33,59-61
    "MAX_AMPLITUDE_M": 0.10, "BOUNDARY_RAMP_M": 0.03,
    "UP_MODE": "veto", "UP_NZ": 0.7, "UP_CLAMP_M": 0.006,
    # tools/dat-patch/tranche.py:111-116
    "RECIPE_VERSION": "C-2026-08-15", "MULT_MIN": 4.0, "MULT_MAX": 6.0,
    "DEFAULT_MIN_TRIS": 50, "DEFAULT_BYTES_PER_TRI": 106.0,
    # tools/dat-patch/matlib.py:66-69
    "CLASS_AMP": {"Brick": 0.060, "Stone": 0.070, "Timber": 0.080,
                  "Plank": 0.055, "Shingle": 0.070},
    # tools/dat-patch/fill_import.py:66-69 (WBT refuses 4096-side inputs)
    "DXT_MAX_SIDE": 2048,
    # tools/dat-patch/texture_lane.py:408-410 -> legibility.GAINSETS["mid"]
    "GAINSET": "mid",
}


# =============================================================== JSON Schema
# A draft-07 SUBSET validator: type/required/properties/additionalProperties/
# enum/const/pattern/items/minItems/maxItems/minLength/maxLength/minimum/
# maximum/anyOf/oneOf/$ref(#/definitions/...).  That is everything schema_v1.json
# uses -- _schema_selfcheck() below asserts it, so the two cannot drift.
_SUPPORTED = {
    "$schema", "$id", "title", "description", "definitions", "type", "required",
    "properties", "additionalProperties", "enum", "const", "pattern", "items",
    "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum",
    "anyOf", "oneOf", "$ref",
}

_TYPES = {
    "object": dict, "array": list, "string": str, "number": (int, float),
    "integer": int, "boolean": bool, "null": type(None),
}


def _schema_selfcheck(node, path="#", bad=None):
    """Refuse to run against a schema that uses a keyword we do not honour --
    silently ignoring `if/then` or `patternProperties` would mean validating
    less than the schema promises."""
    bad = [] if bad is None else bad
    if isinstance(node, dict):
        for k, v in node.items():
            if k in ("properties", "definitions"):
                for pk, pv in v.items():
                    _schema_selfcheck(pv, "%s/%s/%s" % (path, k, pk), bad)
                continue
            if k not in _SUPPORTED:
                bad.append("%s/%s" % (path, k))
            if isinstance(v, dict):
                _schema_selfcheck(v, "%s/%s" % (path, k), bad)
            elif isinstance(v, list):
                for i, item in enumerate(v):
                    _schema_selfcheck(item, "%s/%s[%d]" % (path, k, i), bad)
    return bad


def _deref(schema, root):
    seen = 0
    while isinstance(schema, dict) and "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise ValueError("only local $ref supported: %s" % ref)
        node = root
        for part in ref[2:].split("/"):
            node = node[part]
        schema = node
        seen += 1
        if seen > 32:
            raise ValueError("$ref cycle at %s" % ref)
    return schema


def _check(inst, schema, root, path, errs):
    schema = _deref(schema, root)
    if not isinstance(schema, dict):
        return

    if "anyOf" in schema or "oneOf" in schema:
        alts = schema.get("anyOf") or schema.get("oneOf")
        sub = []
        for alt in alts:
            e = []
            _check(inst, alt, root, path, e)
            if not e:
                break
            sub.append(e)
        else:
            errs.append("%s: matches none of the %d alternatives (%s)"
                        % (path, len(alts), "; ".join(s[0] for s in sub if s)))
            return

    t = schema.get("type")
    if t:
        want = t if isinstance(t, list) else [t]
        py = tuple(_TYPES[x] for x in want)
        ok = isinstance(inst, py)
        # JSON has no bool/int distinction in Python; a bool is never a number.
        if ok and isinstance(inst, bool) and "boolean" not in want:
            ok = False
        if ok and "integer" in want and isinstance(inst, float):
            ok = inst.is_integer()
        if not ok:
            errs.append("%s: expected %s, got %s" % (path, "/".join(want),
                                                     type(inst).__name__))
            return

    if "const" in schema and inst != schema["const"]:
        errs.append("%s: must be %r" % (path, schema["const"]))
    if "enum" in schema and inst not in schema["enum"]:
        errs.append("%s: %r not in %r" % (path, inst, schema["enum"]))

    if isinstance(inst, str):
        pat = schema.get("pattern")
        if pat and not re.search(pat, inst):
            errs.append("%s: %r does not match /%s/" % (path, inst[:60], pat))
        if "minLength" in schema and len(inst) < schema["minLength"]:
            errs.append("%s: shorter than %d" % (path, schema["minLength"]))
        if "maxLength" in schema and len(inst) > schema["maxLength"]:
            errs.append("%s: longer than %d" % (path, schema["maxLength"]))

    if isinstance(inst, (int, float)) and not isinstance(inst, bool):
        if "minimum" in schema and inst < schema["minimum"]:
            errs.append("%s: %r < minimum %r" % (path, inst, schema["minimum"]))
        if "maximum" in schema and inst > schema["maximum"]:
            errs.append("%s: %r > maximum %r" % (path, inst, schema["maximum"]))

    if isinstance(inst, list):
        if "minItems" in schema and len(inst) < schema["minItems"]:
            errs.append("%s: %d items < minItems %d" % (path, len(inst), schema["minItems"]))
        if "maxItems" in schema and len(inst) > schema["maxItems"]:
            errs.append("%s: %d items > maxItems %d" % (path, len(inst), schema["maxItems"]))
        if "items" in schema:
            for i, v in enumerate(inst):
                _check(v, schema["items"], root, "%s[%d]" % (path, i), errs)

    if isinstance(inst, dict):
        props = schema.get("properties") or {}
        for r in schema.get("required", []):
            if r not in inst:
                errs.append("%s: missing required property %r" % (path, r))
        if schema.get("additionalProperties") is False:
            for k in inst:
                if k not in props:
                    errs.append("%s: unexpected property %r" % (path, k))
        for k, v in inst.items():
            if k in props:
                _check(v, props[k], root, "%s.%s" % (path, k), errs)


class Validator:
    def __init__(self, schema_path=SCHEMA_PATH):
        with open(schema_path) as f:
            self.root = json.load(f)
        bad = _schema_selfcheck(self.root)
        if bad:
            raise SystemExit(
                "schema uses keywords this validator does not honour: %s\n"
                "  Refusing to validate less than the schema promises -- either "
                "extend _SUPPORTED/_check in queue_worker.py or simplify the "
                "schema." % ", ".join(sorted(set(bad))))
        self.lib = None
        try:                                        # prefer the real thing
            import jsonschema
            self.lib = jsonschema
        except ImportError:
            pass

    def errors(self, inst, defname):
        sub = {"$ref": "#/definitions/" + defname,
               "definitions": self.root["definitions"]}
        if self.lib is not None:
            v = self.lib.Draft7Validator(sub)
            return ["%s: %s" % ("#" + "".join("/%s" % p for p in e.path), e.message)
                    for e in v.iter_errors(inst)]
        errs = []
        _check(inst, sub, sub, "#", errs)
        return errs


# ============================================================== dat resolving
def rs_header(dat, rsid):
    """RenderSurface header, byte-for-byte the layout texture_lane.rs_header()
    reads (texture_lane.py:68-78): Id, DataCategory, Width, Height, Format,
    sourceDataLength, SourceData[, DefaultPaletteId]."""
    raw = dat.get(rsid)
    if raw is None or len(raw) < 24:
        return None
    oid, dcat, w, h, fmt, dlen = struct.unpack_from("<6I", raw, 0)
    out = dict(id=oid, dcat=dcat, w=w, h=h, fmt=fmt,
               fmtName=PF.get(fmt, "0x%08X" % fmt), dataLen=dlen,
               recordBytes=len(raw))
    if fmt in PALETTED and 24 + dlen + 4 <= len(raw):
        # fill_import.default_palette() (fill_import.py:45-53)
        out["defaultPaletteId"] = "0x%08X" % struct.unpack_from("<I", raw, 24 + dlen)[0]
    return out


def hexid(v):
    return "0x%08X" % v


# --------------------------------------------------------- triangle stream
# The index convention is the plugin's FROZEN contract, verified against the
# plugin's final emit (AcmeRedline/Services/SelectionService.cs:639-699
# BuildFanStreamStatic + BuildFanTrianglePayload) and the decomp it cites
# (Render::GfxObjUnderSelectionRay, ac-headers/acclient.c:379997, iterates
# mesh->polygons positionally over num_polygons):
#   selection.triangles.indices are indices into the record's fan-triangulated
#   draw-triangle stream over EVERY polygon in record (positional) order --
#   NOT drawn-only, NOT polygon keys.  Polygon pi contributes len(v)-2
#   triangles (v[0],v[k],v[k+1]); stippled/NoPos filler polys stay IN the
#   stream so an index is a stable address into the record.  The basis is
#   carried by MATCHING it exactly, not by any in-entry field.  This is the
#   convention _tri_stream builds, the same one relief3d.SourceMesh triangulates
#   from (pilot.py:273 uses the identical len(v)-2 fan).
def _tri_stream(rec):
    """(polyListIndex, (a,b,c)) per triangle, fan order, over EVERY polygon of
    the record in record (positional) order.  See the note above + SCHEMA.md."""
    out = []
    for pi, p in enumerate(rec["polys"]):
        v = p["v"]
        for k in range(1, len(v) - 1):
            out.append((pi, (v[0], v[k], v[k + 1])))
    return out


def _tri_geom(rec, tri):
    a, b, c = (rec["P"][i] for i in tri)
    u = [b[j] - a[j] for j in range(3)]
    w = [c[j] - a[j] for j in range(3)]
    n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2],
         u[0] * w[1] - u[1] * w[0]]
    L = math.sqrt(sum(x * x for x in n))
    unit = [x / L for x in n] if L > 1e-12 else [0.0, 0.0, 1.0]
    cen = [sum(rec["P"][i][j] for i in tri) / 3.0 for j in range(3)]
    return 0.5 * L, unit, cen


class Resolver:
    """One open portal (+ optional cell) dat, cached."""

    def __init__(self, portal_path, cell_path=None):
        self.portal_path = os.path.abspath(portal_path)
        self.P = gfxlib.Portal(self.portal_path)
        self.dat = self.P.dat
        self.cell_path = os.path.abspath(cell_path) if cell_path else None
        self._instances = None
        self.protected = self._load_protected()

    @staticmethod
    def _load_protected():
        """terrain_protected_rs.txt, read exactly as texture_lane.py:505-510 and
        fill_import.py:77-80 read it."""
        if not os.path.exists(PROTECTED_PATH):
            return set()
        with open(PROTECTED_PATH) as f:
            return {int(l, 16) for l in f
                    if l.strip() and not l.lstrip().startswith("#")}

    # ---- placement counts -> "instance exposure" ---------------------------
    def instances(self):
        """{gfxObjId: placement count} over every LandBlockInfo in the cell dat,
        the same walk tranche.py:187-201 does (buildings[] + objects[], model
        ids resolved through pilot.resolve_gfx).  Empty when --cell is absent."""
        if self._instances is not None:
            return self._instances
        self._instances = {}
        if not self.cell_path:
            return self._instances
        os.environ.setdefault("DATPATCH_PORTAL", self.portal_path)
        import pilot                                 # pulls numpy; only on demand
        cd = datlib.Dat(self.cell_path)
        models = {}
        for rid in sorted(i for i in cd.files if (i & 0xFFFF) == 0xFFFE):
            try:
                info = pilot.parse_lbinfo(cd.get(rid))
            except Exception:
                continue
            for mid, _o, _q in info["buildings"] + info["objects"]:
                models[mid] = models.get(mid, 0) + 1
        for mid, cnt in models.items():
            try:
                gids = pilot.resolve_gfx(mid, self.P)
            except Exception:
                continue
            for gid in gids:
                self._instances[gid] = self._instances.get(gid, 0) + cnt
        return self._instances

    # ---- per-id resolution -------------------------------------------------
    def gfxobj(self, gid_hex):
        gid = int(gid_hex, 16)
        out = dict(gfxObjId=hexid(gid), exists=gid in self.dat.files)
        if not out["exists"]:
            out["error"] = "no 0x01 record in %s" % os.path.basename(self.portal_path)
            return out
        raw = self.dat.get(gid)
        out["recordBytes"] = len(raw)
        out["recordSha256"] = hashlib.sha256(raw).hexdigest()
        out["compressed"] = bool(self.dat.flags.get(gid, 0) & 0x1)
        try:
            rec = self.P.gfx(gid)
        except Exception as ex:
            out["error"] = "parse: %s: %s" % (type(ex).__name__, str(ex)[:160])
            return out
        # tranche.py:301 counts DRAWN tris as "not NoPos"; the raw stream keeps
        # every polygon so an index is a stable address into the record.
        out["triCountAll"] = sum(max(0, len(p["v"]) - 2) for p in rec["polys"])
        out["triCountDrawn"] = sum(len(p["v"]) - 2 for p in rec["polys"]
                                   if not (p["stip"] & 0x4))
        out["polyCount"] = len(rec["polys"])
        out["physPolyCount"] = len(rec["phys"])
        out["vertCount"] = len(rec["P"])
        out["surfaces"] = [hexid(s) for s in rec["surfaces"]]
        # ---- degrade guard, mirroring tranche.py:309-330 --------------------
        bands = self.P.degrade(gid)
        out["degradeId"] = hexid(rec["degrade"]) if rec.get("degrade") else None
        out["degradeBands"] = [dict(id=hexid(b["id"]), mode=b["mode"], min=b["min"],
                                    ideal=b["ideal"], max=b["max"]) for b in bands]
        out["band0Self"] = (not bands) or bands[0]["id"] == gid
        out["band0"] = hexid(bands[0]["id"]) if bands else None
        # tranche.py:304 long-tail cut
        out["belowMinTris"] = out["triCountDrawn"] <= KNOBS["DEFAULT_MIN_TRIS"]
        return out

    def surface(self, sid_hex):
        sid = int(sid_hex, 16)
        out = dict(surfaceId=hexid(sid), exists=sid in self.dat.files)
        if not out["exists"]:
            return out
        s = self.P.surface(sid)
        if s is None:
            out["error"] = "surface record unreadable"
            return out
        out.update(type=s["type"],
                   base1Solid=bool(s["type"] & gfxlib.SURF_BASE1SOLID),
                   base1Image=bool(s["type"] & gfxlib.SURF_BASE1IMAGE),
                   base1ClipMap=bool(s["type"] & gfxlib.SURF_BASE1CLIPMAP),
                   translucency=s["translucency"], luminosity=s["luminosity"],
                   diffuse=s["diffuse"],
                   surfaceTextureId=hexid(s["tex"]) if s["tex"] else None,
                   paletteId=hexid(s["pal"]) if s["pal"] else None,
                   resolvedRsId=s.get("rsId"),
                   hasHighresEntry=bool(s.get("hasHighres")))
        # The first four branches of matlib.classify (matlib.py:89-97) are pure
        # record reads -- reproduced here so the worker needs no corpus tables.
        veto = None
        if s["type"] & gfxlib.SURF_BASE1CLIPMAP:
            veto = "veto:Base1ClipMap (alpha cutout card)"
        elif not (s["type"] & gfxlib.SURF_BASE1IMAGE):
            veto = "veto:Base1Solid (no texture)"
        elif s["translucency"] > 0.0:
            veto = "veto:translucent %.2f" % s["translucency"]
        elif s["luminosity"] > 0.0:
            veto = "veto:luminous %.2f" % s["luminosity"]
        out["reliefClassVeto"] = veto
        out["reliefClassNote"] = (
            veto or "no record-level veto; the material CLASS still comes from "
            "matlib.classify's curated/kNN tables (matlib.py:83, "
            "DATPATCH_CLASSES_JSON + DATPATCH_CURATED_JSON) which this worker "
            "does not load -- run tranche.py enumerate for the class")
        return out

    def rendersurface(self, rs_hex):
        rs = int(rs_hex, 16)
        out = dict(rsId=hexid(rs), exists=rs in self.dat.files)
        if not out["exists"]:
            out["error"] = ("no 0x06 record in %s -- on a HIFI-split kit it may "
                            "live in client_highres.dat (see docs/dat-patch/"
                            "PLAN-2026-08-18-hedonic-allocation.md 3.1)"
                            % os.path.basename(self.portal_path))
            return out
        h = rs_header(self.dat, rs)
        if h is None:
            out["error"] = "record shorter than a RenderSurface header"
            return out
        out.update(h)
        out["paletted"] = h["fmt"] in PALETTED
        out["terrainProtected"] = rs in self.protected
        out["dimsMult4"] = (h["w"] % 4 == 0 and h["h"] % 4 == 0)
        return out

    def setup(self, setup_hex):
        sid = int(setup_hex, 16)
        out = dict(setupId=hexid(sid), exists=sid in self.dat.files)
        if not out["exists"]:
            return out
        try:
            s = datlib.parse_setup(self.dat.get(sid))
        except Exception as ex:
            out["error"] = "parse_setup: %s" % str(ex)[:120]
            return out
        out["parts"] = [hexid(p) for p in s["parts"]]
        out["partCount"] = len(s["parts"])
        return out

    # ---- triangle selection ------------------------------------------------
    def triangles(self, sel):
        """Resolve selection.triangles against the FROZEN fan-triangle-stream
        convention (see _tri_stream).  indices -> triangles -> their source
        polygons (the granularity every displace knob works at).  On a
        stale/out-of-range selection the triangles are re-located from the
        stored footprint centroids."""
        gid_hex = sel["gfxObjId"]
        indices = list(sel.get("indices", []))
        out = dict(gfxObjId=gid_hex, requestedIndices=indices)
        gid = int(gid_hex, 16)
        if gid not in self.dat.files:
            out["error"] = "GfxObj record absent"
            return out
        raw = self.dat.get(gid)
        cur_sha = hashlib.sha256(raw).hexdigest()
        out["currentRecordSha256"] = cur_sha
        want = sel.get("baseRecordSha256")
        out["reportedRecordSha256"] = want
        out["stale"] = bool(want) and want.lower() != cur_sha.lower()
        rec = self.P.gfx(gid)
        stream = _tri_stream(rec)

        # worker-COMPUTED counts (our emit, not the entry -- the frozen entry
        # carries no counts).  triCountAll == len(stream); triCountDrawn is the
        # not-NoPos count tranche.py:301 uses.  Kept as outputs, and if a future
        # entry ever carried them the drift check below would fire.
        out["triCountAll"] = len(stream)
        out["triCountDrawn"] = sum(len(p["v"]) - 2 for p in rec["polys"]
                                   if not (p["stip"] & 0x4))
        out["polyCount"] = len(rec["polys"])
        for k in ("triCountAll", "triCountDrawn"):
            if k in sel and sel[k] != out[k]:
                out.setdefault("countDrift", {})[k] = dict(reported=sel[k],
                                                           dat=out[k])

        idx = list(indices)
        oob = [i for i in idx if i < 0 or i >= len(stream)]
        if oob:
            out["outOfRangeIndices"] = oob
            idx = [i for i in idx if 0 <= i < len(stream)]

        fp = sel.get("footprint") or {}
        cents = fp.get("centroids") or []
        if out["stale"] or oob:
            # FALLBACK: the record moved under the reporter.  Re-locate the
            # selection geometrically -- nearest current triangle centroid to
            # each stored centroid.  Report the residual so a human can judge.
            relocated, worst = [], 0.0
            geoms = [_tri_geom(rec, tri)[2] for _pi, tri in stream]
            for c in cents:
                best_i, best_d = None, None
                for i, cc in enumerate(geoms):
                    d = math.dist(cc, c)
                    if best_d is None or d < best_d:
                        best_i, best_d = i, d
                if best_i is not None:
                    relocated.append(best_i)
                    worst = max(worst, best_d)
            out["footprintRelocatedIndices"] = sorted(set(relocated))
            out["footprintMaxResidualM"] = round(worst, 4)
            out["footprintNote"] = (
                ("baseRecordSha256 no longer matches the record in this dat "
                 "(stale-selection): the stored triangle indices are NOT "
                 "trustworthy. Indices above were re-derived by nearest "
                 "centroid from selection.triangles.footprint; residual "
                 "%.4f m. Confirm on a before-shot before acting." % worst)
                if out["stale"] else
                "index out of range for this record; re-derived from footprint")
            if out["stale"] or (oob and not idx):
                idx = out["footprintRelocatedIndices"] or idx

        out["effectiveIndices"] = sorted(set(idx))
        polys, tri_facts, area = {}, [], 0.0
        for i in out["effectiveIndices"]:
            pi, tri = stream[i]
            p = rec["polys"][pi]
            a, n, cen = _tri_geom(rec, tri)
            area += a
            sid = rec["surfaces"][p["pos"]] if 0 <= p["pos"] < len(rec["surfaces"]) else None
            # relief3d.SourceMesh.from_record's per-poly flags (relief3d.py:152,157)
            excluded = bool(p["stip"] & 0x4) or p["sides"] in (gfxlib.CULL_NONE,
                                                               gfxlib.CULL_CW)
            polys.setdefault(pi, dict(
                polyIndex=pi, stip=p["stip"], sides=p["sides"],
                surfaceId=hexid(sid) if sid is not None else None,
                noPosFiller=bool(p["stip"] & 0x4),
                alreadyExcludedByRecipe=excluded,
                excludedWhy=("NoPos filler" if p["stip"] & 0x4 else
                             ("CullMode.None alpha card" if p["sides"] == gfxlib.CULL_NONE
                              else ("CullMode.Clockwise two-surface sheet"
                                    if p["sides"] == gfxlib.CULL_CW else None))),
                triangles=[]))
            polys[pi]["triangles"].append(i)
            tri_facts.append(dict(index=i, poly=pi, areaM2=round(a, 4),
                                  normal=[round(x, 4) for x in n],
                                  centroid=[round(x, 4) for x in cen],
                                  upFacing=n[2] >= KNOBS["UP_NZ"]))
        out["sourcePolygons"] = [polys[k] for k in sorted(polys)]
        out["sourcePolyIndices"] = sorted(polys)
        out["selectedAreaM2"] = round(area, 4)
        out["reportedAreaM2"] = fp.get("areaM2")
        out["triangleFacts"] = tri_facts
        # relief3d.py:38-52: an UP-facing polygon carves the drawn floor above
        # the untouched collision plane -- the r5 feet-sink.
        out["upFacingCount"] = sum(1 for t in tri_facts if t["upFacing"])
        out["surfaceIds"] = sorted({p["surfaceId"] for p in out["sourcePolygons"]
                                    if p["surfaceId"]})
        return out


# ================================================================ classifying
def _uv_region(uv_hints, w, h):
    """uvHints bbox -> both the UV rect and the texel rect at the record's real
    dims, so a source-replacement request names actual pixels."""
    if not uv_hints:
        return None
    us = [p[0] for p in uv_hints]
    vs = [p[1] for p in uv_hints]
    u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
    out = dict(uvBBox=[round(u0, 5), round(v0, 5), round(u1, 5), round(v1, 5)],
               pointCount=len(uv_hints))
    if w and h:
        out["texelBBox"] = [int(math.floor(u0 * w)), int(math.floor(v0 * h)),
                            int(math.ceil(u1 * w)), int(math.ceil(v1 * h))]
        out["texelBBoxNote"] = ("v is used as stored in the DAT (no flip "
                                "applied) -- confirm orientation on the mask "
                                "attachment before cropping")
    return out


def _target_dims(w, h, max_side=None):
    """The 4x DXT bake target, capped and snapped to a multiple of 4.
    Cap: fill_import.py:66-69 (WBT's importer throws on 4096-side inputs).
    Mult-4: texture_lane.py:592 refuses non-mult-4 dims for DXT."""
    cap = max_side or KNOBS["DXT_MAX_SIDE"]
    tw, th = w * 4, h * 4
    if max(tw, th) > cap:
        sc = cap / float(max(tw, th))
        tw, th = int(round(w * 4 * sc)), int(round(h * 4 * sc))
    tw = max(4, tw & ~3)
    th = max(4, th & ~3)
    return tw, th


def classify_texture(entry, rs, surf, tags):
    """-> (lane, actions[], guards[], notes[])."""
    actions, guards, notes = [], [], []
    tagset = set(tags)

    if not rs.get("exists"):
        return "triage", [], [dict(guard="rs-missing", blocking=True,
                                   why=rs.get("error", "RenderSurface absent"))], notes

    # ---- GUARD 1: terrain-protected -------------------------------------
    if rs.get("terrainProtected"):
        guards.append(dict(
            guard="terrain-protected-rs", blocking=True,
            why=("%s is in tools/dat-patch/terrain_protected_rs.txt: the retail "
                 "client REQUIRES it at %dx%d %s. ImgTex::MergeTexture locks and "
                 "composites terrain RSs; a DXT/2048 overwrite reads out of "
                 "bounds and crashes at LandscapeTextureDetail=VeryHigh "
                 "(root-caused 2026-08-16)." % (rs["rsId"], rs["w"], rs["h"],
                                                rs["fmtName"])),
            enforcedAt=["tools/dat-patch/texture_lane.py:505-524",
                        "tools/dat-patch/fill_import.py:77-101"]))
        actions.append(dict(
            action="route-to-terrain-lane",
            tool="tools/dat-patch/terrain_lane.py",
            why=("Any improvement to this texture has to come from the terrain "
                 "lane, which respects the 512^2 A8R8G8B8 contract, or from the "
                 "detail-texture route (PLAN-2026-08-18 rank 6, D5 "
                 "DetailTextureId) which dodges the composite entirely."),
            todo=("NOT VERIFIED by this worker: terrain_lane.py's CLI was not "
                  "read for this deliverable. Read its argparse before "
                  "scheduling.")))
        return "terrain-lane-only", actions, guards, notes

    # ---- GUARD 2: palette route -----------------------------------------
    if rs.get("paletted"):
        guards.append(dict(
            guard="palette-route", blocking=False,
            why=("%s is %s. Converting it to DXT would freeze its colours and "
                 "break every ClothingTable subpalette recolour (most of the "
                 "creature/clothing corpus). It stays palettized: 2x upscale, "
                 "indices re-solved against the record's OWN DefaultPalette "
                 "(%s) and its OWN used index subset."
                 % (rs["rsId"], rs["fmtName"],
                    rs.get("defaultPaletteId", "unread"))),
            enforcedAt=["tools/dat-patch/fill_import.py:13-19",
                        "tools/dat-patch/fill_import.py:150-170",
                        "tools/dat-patch/texture_lane.py:533-544"]))
        tw, th = rs["w"] * 2, rs["h"] * 2
        actions.append(dict(
            action="palette-route-rebake",
            tool="tools/dat-patch/fill_import.py",
            argv=["python3", "tools/dat-patch/fill_import.py",
                  "--ids", "<file containing %s>" % rs["rsId"],
                  "--upscales", "$UPSCALE_DIR", "--out-root", "$OUT_ROOT",
                  "--portal", "$BASE_PORTAL"],
            targetDims=[tw, th],
            sourceDims=[rs["w"], rs["h"]], sourceFormat=rs["fmtName"],
            keepFormat=rs["fmtName"],
            defaultPaletteId=rs.get("defaultPaletteId"),
            why=("2x (fill_import.py:152) keeping %s; the record's own palette "
                 "and used-index subset are the only allowed colours."
                 % rs["fmtName"]),
            insertedBy=("the palette route's records are NOT written by "
                        "render-surface-import -- fill_import emits raw record "
                        "bytes to idx/<id>.bin for DatRecordInsert "
                        "(fill_import.py:24-26,166-169)")))
        if "recolor" in tagset or "wrong-material" in tagset:
            notes.append(
                "recolor/wrong-material on a palettized record: the fix is a "
                "PALETTE edit or a source-art replacement, not a rebake. Check "
                "pallib.py RECOLOR SAFETY and the ClothingTable census before "
                "touching the palette -- a shared palette recolours other "
                "weenies too.")
        return "texture-palette-fill", actions, guards, notes

    # ---- non-palette routes ---------------------------------------------
    if not rs.get("dimsMult4"):
        guards.append(dict(
            guard="dims-not-mult-4", blocking=True,
            why="%dx%d is not a multiple of 4; the DXT route skips it "
                "(texture_lane.py:592)." % (rs["w"], rs["h"]),
            enforcedAt=["tools/dat-patch/texture_lane.py:591-596"]))

    if surf and surf.get("reliefClassVeto"):
        notes.append("Surface %s carries a record-level relief veto (%s) -- it "
                     "is still TEXTURE-bakeable, but the geometry lane will "
                     "never carve it (matlib.py:89-97)."
                     % (surf.get("surfaceId"), surf["reliefClassVeto"]))

    if surf and surf.get("hasHighresEntry"):
        notes.append("SurfaceTexture %s's chain leads with an id that is absent "
                     "from this dat -- i.e. a client_highres.dat entry "
                     "(gfxlib.py:332-340). Patch the HIGHRES record, not the "
                     "portal one, on a HIFI-split kit."
                     % surf.get("surfaceTextureId"))

    if tagset & {"wrong-material", "recolor"}:
        lane = "texture-source-replacement"
        actions.append(dict(
            action="flag-needs-source-replacement",
            tool="(human/AI art step -- no automated recipe exists)",
            why=("'%s' is a claim about WHAT the texture depicts, not how "
                 "sharp it is. The legibility bake (emboss/AO/anchor) cannot "
                 "change subject matter -- it only re-renders the existing "
                 "albedo (texture_lane.py:363-422)."
                 % ",".join(sorted(tagset & {"wrong-material", "recolor"}))),
            region=_uv_region((entry["selection"].get("renderSurfaces") or [{}])[0]
                              .get("uvHints"), rs["w"], rs["h"]),
            sourceDims=[rs["w"], rs["h"]], sourceFormat=rs["fmtName"],
            deliverable=("a replacement RGBA PNG at %dx%d (or larger, "
                         "mult-4) dropped into $DATPATCH_TEX_BASE as %s.png; "
                         "the normal rebake then ships it."
                         % (rs["w"], rs["h"], rs["rsId"]))))
        notes.append("Alpha is retail truth and is transplanted from the base "
                     "decode on every bake (texture_lane.py:570-587) -- a "
                     "replacement source does not need to carry it, and cannot "
                     "override it without editing the base PNG.")
        return lane, actions, guards, notes

    # default: too-blurry / seam / silhouette-on-a-texture / other
    tw, th = _target_dims(rs["w"], rs["h"])
    fmt_out = "DXT5" if (surf and surf.get("base1ClipMap")) else "DXT1"
    actions.append(dict(
        action="rebake-upscale",
        lane_module="tools/dat-patch/texture_lane.py",
        argv=["python3", "tools/dat-patch/texture_lane.py", "run",
              "--root", "$RUN_ROOT", "--base", "$BASE_PORTAL",
              "--patched", "$PATCHED_PORTAL",
              "--ids-file", "<file containing the SURFACE id %s>"
              % (surf.get("surfaceId") if surf else "<unknown>"),
              "--wbt", "$WBT_DLL", "--remacri"],
        sourceDims=[rs["w"], rs["h"]], sourceFormat=rs["fmtName"],
        sourceDataBytes=rs["dataLen"],
        suggestedTargetDims=[tw, th],
        suggestedFormat=fmt_out,
        formatWhy=("DXT5 when the surface is Base1ClipMap or the baked alpha is "
                   "non-opaque, else DXT1 (texture_lane.py:588-591)"),
        knobs={
            "DATPATCH_BAKE_MAX_SIDE": max(tw, th),
            "DATPATCH_TEX_BASE": "<dir of retail re-export PNGs, <rsId>.png>",
            "DATPATCH_REMACRI": "<upscale corpus dirs, colon separated>",
            "DATPATCH_WRAPPED_CORPUS": "1 if the corpus is the wrap-padded "
                                       "re-upscale (texture_lane.py:381-390)",
            "DATPATCH_DEBLOCK_BASE": "<deblock.py output dir, optional>",
            "gainset": KNOBS["GAINSET"],
        },
        wbtCommands=[
            dict(command="render-surface-import", datPath="$PATCHED_PORTAL",
                 imports=[dict(idHex=rs["rsId"], pngPath="$RUN_ROOT/baked/%s.png"
                               % rs["rsId"], format=fmt_out, allowResize=True)]),
            dict(command="surface-texture-collapse", datPath="$PATCHED_PORTAL",
                 collapses=[dict(idHex=(surf or {}).get("surfaceTextureId"),
                                 keepDid=rs["rsId"])]),
        ],
        why=("Reported %s at %dx%d %s. The 4x bake target is capped at %d/side "
             "because WBT's importer throws on 4096-side inputs "
             "(fill_import.py:66-69)."
             % ("/".join(sorted(tagset)) or "no tag", rs["w"], rs["h"],
                rs["fmtName"], KNOBS["DXT_MAX_SIDE"]))))
    if "seam" in tagset:
        notes.append("'seam' on a tiled wall is usually TILEABILITY, not "
                     "sharpness: ESRGAN pads its input at the borders, so an "
                     "un-wrapped upscale breaks the wrap and shows a hairline "
                     "grid. Bake from the wrap-padded corpus with "
                     "DATPATCH_WRAPPED_CORPUS=1 (texture_lane.py:381-390).")
    notes.append("Resume trap: DATPATCH_BAKE_CACHE=1 over a warm baked/ dir "
                 "ships the OLD pixels. texture_lane.bake_config_guard "
                 "(texture_lane.py:439-474) makes a config change fatal -- do "
                 "not set DATPATCH_BAKE_CACHE_FORCE=1 to get past it.")
    return "texture-legibility-rebake", actions, guards, notes


def classify_triangles(entry, tri, gfx, tags):
    actions, guards, notes = [], [], []
    tagset = set(tags)

    if not gfx.get("exists") or gfx.get("error"):
        return "triage", [], [dict(guard="gfxobj-missing", blocking=True,
                                   why=gfx.get("error", "GfxObj absent"))], notes

    # Raised BEFORE the band-0 early return: a stale selection is a fact about
    # the report, and it stays true whichever lane the record ends up in.
    if tri.get("stale"):
        guards.append(dict(
            guard="stale-selection", blocking=False,
            why=("baseRecordSha256 %s != current %s. The record changed between "
                 "the report and now (another lane patched it, or the reporter "
                 "was on a different kit). Triangle indices are re-derived from "
                 "the stored footprint; residual %s m."
                 % ((tri.get("reportedRecordSha256") or "")[:16],
                    (tri.get("currentRecordSha256") or "")[:16],
                    tri.get("footprintMaxResidualM"))),
            fallback=tri.get("footprintNote")))
    if tri.get("countDrift"):
        # The frozen entry carries no counts, so this is inert for valid input;
        # kept so a future count-bearing entry (or a hand-authored one) still
        # trips a tripwire instead of silently mis-resolving.
        guards.append(dict(
            guard="index-count-drift", blocking=False,
            why=("a reported triangle count disagrees with this record: %s -- "
                 "the report was filed against a different mesh than the dat "
                 "being resolved against"
                 % json.dumps(tri["countDrift"], sort_keys=True))))
    if tri.get("upFacingCount"):
        notes.append(
            "%d selected triangle(s) are up-facing (nz >= %.2f). The orientation "
            "veto (DATPATCH_UP_MODE=veto, the default) already stops them "
            "carving, because displacing a walkable surface upward over "
            "untouched physics is the r5 feet-sink (relief3d.py:38-61)."
            % (tri["upFacingCount"], KNOBS["UP_NZ"]))

    # ---- GUARD: degrade band 0 is a different record --------------------
    if not gfx.get("band0Self"):
        guards.append(dict(
            guard="band0-not-self", blocking=True,
            why=("cannot displace root: degrade band 0 of %s is %s, not the "
                 "record itself. CPhysicsPart::LoadGfxObjArray fills the draw "
                 "array EXCLUSIVELY from the degrade bands, so the root mesh is "
                 "never drawn at ANY distance and patching it is invisible "
                 "bytes." % (gfx["gfxObjId"], gfx["band0"])),
            enforcedAt=["tools/dat-patch/tranche.py:309-330",
                        "tools/dat-patch/tranche.py:458-464",
                        "tools/dat-patch/gfxlib.py:235-253"],
            deferTo=dict(bandObjects=[b["id"] for b in gfx["degradeBands"]],
                         lane="degrade-deferred band-object lane "
                              "(degrade_deferred.json; PLAN-2026-08-18 4.P2)")))
        actions.append(dict(
            action="retarget-to-band-object",
            why=("Re-run the selection against %s (band 0). The reporter is "
                 "looking at that mesh, not this one." % gfx["band0"]),
            candidateTargets=[b["id"] for b in gfx["degradeBands"]]))
        return "geometry-degrade-deferred", actions, guards, notes

    if gfx.get("belowMinTris"):
        guards.append(dict(
            guard="below-min-tris", blocking=False,
            why=("%d drawn tris <= --min-tris %d: tranche's long-tail cut routes "
                 "this record to skip-small on the grounds that the texture lane "
                 "covers it for free. Overriding is a deliberate call."
                 % (gfx["triCountDrawn"], KNOBS["DEFAULT_MIN_TRIS"])),
            enforcedAt=["tools/dat-patch/tranche.py:303-308"],
            override="--min-tris %d" % max(0, gfx["triCountDrawn"] - 1)))

    already = [p for p in tri.get("sourcePolygons", [])
               if p["alreadyExcludedByRecipe"]]
    if already:
        notes.append(
            "%d of the %d selected source polygons are ALREADY excluded by the "
            "recipe (%s) -- their vertices are pinned to zero amplitude "
            "(relief3d.py:152,287-304), so they carry no shell today and "
            "'remove-detail' on them is already satisfied."
            % (len(already), len(tri.get("sourcePolygons", [])),
               ", ".join(sorted({p["excludedWhy"] for p in already if p["excludedWhy"]}))))

    poly_idx = [p["polyIndex"] for p in tri.get("sourcePolygons", [])]

    if tagset & {"remove-detail"}:
        actions.append(dict(
            action="per-poly-exclusion",
            knob="relief3d.SourceMesh poly['excluded'] = True",
            appliedAt="tools/dat-patch/relief3d.py:152-163 (set at "
                      "from_record) / :287-304 (amplitudes pinned to zero)",
            polygons=poly_idx,
            triangles=tri.get("effectiveIndices"),
            why=("Excluding a source polygon removes its shell entirely and "
                 "welds its vertex amplitudes to zero, so neighbours ramp down "
                 "into it over BOUNDARY_RAMP_M=%.2f m instead of opening a slit."
                 % KNOBS["BOUNDARY_RAMP_M"]),
            todo=("NOT VERIFIED: there is no per-polygon override FILE in the "
                  "shipped tranche today -- exclusion is derived from the "
                  "record's own stip/sides. Landing this needs a small "
                  "per-record override input to tranche.py/pilot.recipe_c_source "
                  "and a RECIPE_VERSION bump (tranche.py:111).")))
        actions.append(dict(
            action="amp-override-down",
            knob="pilot.AMP_WALL / matlib.CLASS_AMP[<class>]",
            currentDefaults=dict(AMP_WALL=KNOBS["AMP_WALL"],
                                 GROUND_SCALE=KNOBS["GROUND_SCALE"],
                                 CLASS_AMP=KNOBS["CLASS_AMP"],
                                 MAX_AMPLITUDE_M=KNOBS["MAX_AMPLITUDE_M"]),
            appliedAt=["tools/dat-patch/pilot.py:48-58",
                       "tools/dat-patch/matlib.py:66-69",
                       "tools/dat-patch/relief3d.py:32"],
            why=("A softer read without losing the triangles: amplitude is "
                 "clamped to MAX_AMPLITUDE_M=%.2f m in relief3d, and pilot "
                 "temporarily raises that ceiling to AMP_WALL for recipe C "
                 "(tranche.py:474-476). Lowering AMP is a per-CLASS change, so "
                 "it hits every record wearing that material -- prefer the "
                 "per-poly exclusion for a single-record complaint."
                 % KNOBS["MAX_AMPLITUDE_M"])))
        actions.append(dict(
            action="class-veto",
            knob="pilot.WALL_CLASSES / matlib.classify override",
            currentDefaults=dict(WALL_CLASSES=KNOBS["WALL_CLASSES"],
                                 MACRO_OK=["Stone", "Brick", "Timber", "Plank",
                                           "Shingle"]),
            appliedAt=["tools/dat-patch/pilot.py:48",
                       "tools/dat-patch/matlib.py:62",
                       "tools/dat-patch/pipeline.py:38-75 (OVERRIDES / force=)"],
            surfaces=tri.get("surfaceIds"),
            why=("If the complaint is really 'this MATERIAL should not be "
                 "carved anywhere', veto the class rather than the record: "
                 "pipeline.surface_meta accepts force={sid: (cls, why)} and "
                 "pipeline.OVERRIDES is the shipped precedent.")))

    if tagset & {"silhouette"}:
        actions.append(dict(
            action="mult-override-up",
            knob="tranche models.json entry 'mult' (per record)",
            currentBand=[KNOBS["MULT_MIN"], KNOBS["MULT_MAX"]],
            rampedBy="tranche._mult_for (tranche.py:204-213): >1.5 m vertex "
                     "spacing -> 6x, >0.9 m -> 5x, else 4x",
            appliedAt="tools/dat-patch/tranche.py:383-389 (enumerate writes "
                      "mult) / :574-587 (build reads it)",
            recordTris=gfx["triCountDrawn"],
            estimatedAddedTrisAt6x=int(round(gfx["triCountDrawn"] * (KNOBS["MULT_MAX"] - 1))),
            estimatedBytesAt6x=int(round(gfx["triCountDrawn"] * (KNOBS["MULT_MAX"] - 1)
                                         * KNOBS["DEFAULT_BYTES_PER_TRI"])),
            why=("A silhouette complaint is about the OUTLINE, which only more "
                 "triangles on the boundary can fix. Raising this record's mult "
                 "to the top of r2's 4-6x architecture band is the honest knob; "
                 "the byte cost is charged at %.0f B/added-tri against the "
                 "budget plan." % KNOBS["DEFAULT_BYTES_PER_TRI"])))
        actions.append(dict(
            action="segments-and-decimator",
            knobs=dict(max_segments=16, area_share=0.75,
                       FINE_BUDGET=KNOBS["FINE_BUDGET"]),
            appliedAt=["tools/dat-patch/tranche.py:675-679",
                       "tools/dat-patch/tranche.py:471-473 (FINE_BUDGET back-off)"],
            why=("--max-segments controls how fine the pre-decimation mesh is; "
                 "the back-off loop drops it in steps of 2 while "
                 "carve_fans*segs^2 > FINE_BUDGET, so a record with many "
                 "carving fans silently gets a coarser shell. Check "
                 "build_stats.json 'segments' before blaming the recipe.")))

    actions.append(dict(
        action="rebuild-this-record",
        argv=["python3", "tools/dat-patch/tranche.py", "build",
              "--root", "$RUN_ROOT", "--only", gfx["gfxObjId"],
              "--portal", "$BASE_PORTAL", "--cell", "$BASE_CELL"],
        why=("--only takes a comma-separated hex list and refuses ids that are "
             "not route=displace in models.json (tranche.py:533-539). The "
             "resume hash covers the base record bytes AND every recipe knob, "
             "so any knob change above must bump RECIPE_VERSION (currently %s) "
             "or the stale OBJ is reused (tranche.py:440-450)."
             % KNOBS["RECIPE_VERSION"]),
        emits="obj/<gid>.obj + imports.jsonl (obj-import, overwrite=True, "
              "preservePhysics=True, gfxObjOnly=True) -- physics polygons are "
              "never touched (tranche.py:606-609)"))
    return "geometry-displace", actions, guards, notes


# ================================================================ status log
def derive_status(path):
    """Current state per entryId = LAST event in the append-only log."""
    cur = {}
    if not path or not os.path.exists(path):
        return cur
    with open(path) as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            eid = ev.get("entryId")
            if eid:
                cur[eid] = ev
    return cur


# ==================================================================== worker
def _safe_attachments(paths, queue_dir):
    """Attachment paths are reporter-controlled. Keep them inside the queue
    directory: no absolute paths, no '..'."""
    out, rejected = [], []
    for p in paths or []:
        if os.path.isabs(p) or ".." in p.replace("\\", "/").split("/"):
            rejected.append(p)
            continue
        full = os.path.join(queue_dir, p)
        out.append(dict(path=p, exists=os.path.exists(full)))
    return out, rejected


def process(entry, res, queue_dir):
    """One entry -> a partially-built work item (pre-aggregation)."""
    sel = entry["selection"]
    kind = sel["kind"]
    tags = entry.get("tags", [])
    resolved = {}
    guards, actions, notes = [], [], []
    lane = "triage"
    target = None

    atts, bad_atts = _safe_attachments(entry.get("attachments"), queue_dir)
    if bad_atts:
        guards.append(dict(guard="unsafe-attachment-path", blocking=False,
                           why="refused reporter-supplied paths outside the "
                               "queue directory: %s" % bad_atts))

    # objects[] always resolved, whatever the kind
    objs = []
    for o in sel.get("objects") or []:
        r = res.gfxobj(o["gfxObjId"])
        r["objectId"] = o.get("objectId")
        if o.get("setupId"):
            r["setup"] = res.setup(o["setupId"])
            if r["setup"].get("parts") and r["gfxObjId"] not in r["setup"]["parts"]:
                guards.append(dict(
                    guard="setup-part-mismatch", blocking=False,
                    why="%s is not among Setup %s's parts (%d parts) -- the "
                        "plugin's setup/gfxobj pairing is suspect"
                        % (r["gfxObjId"], o["setupId"], r["setup"]["partCount"])))
        r["instances"] = res.instances().get(int(o["gfxObjId"], 16))
        objs.append(r)
    if objs:
        resolved["objects"] = objs

    if kind == "texture":
        rss = sel.get("renderSurfaces") or []
        if not rss:
            guards.append(dict(guard="empty-selection", blocking=True,
                               why="kind=texture but selection.renderSurfaces "
                                   "is empty"))
        else:
            r0 = rss[0]
            rs = res.rendersurface(r0["rsId"])
            surf = res.surface(r0["surfaceId"]) if r0.get("surfaceId") else None
            resolved["renderSurface"] = rs
            if surf:
                resolved["surface"] = surf
                if surf.get("resolvedRsId") and \
                        surf["resolvedRsId"].upper() != rs["rsId"].upper():
                    guards.append(dict(
                        guard="rs-id-drift", blocking=False,
                        why="Surface %s resolves to %s in this dat, but the "
                            "report cites %s. The SurfaceTexture chain takes "
                            "the highest entry PRESENT in the dat "
                            "(gfxlib.py:332-340), so a HIFI-split kit and a "
                            "base install disagree by design."
                            % (surf["surfaceId"], surf["resolvedRsId"], rs["rsId"])))
                if r0.get("surfaceTextureId") and surf.get("surfaceTextureId") and \
                        r0["surfaceTextureId"].upper() != surf["surfaceTextureId"].upper():
                    guards.append(dict(
                        guard="st-id-mismatch", blocking=False,
                        why="reported SurfaceTexture %s != the Surface's %s"
                            % (r0["surfaceTextureId"], surf["surfaceTextureId"])))
            resolved["uvRegion"] = _uv_region(r0.get("uvHints"),
                                              rs.get("w"), rs.get("h"))
            lane, a, g, n = classify_texture(entry, rs, surf, tags)
            actions += a
            guards += g
            notes += n
            target = dict(kind="renderSurface", id=rs["rsId"])
            if len(rss) > 1:
                notes.append("entry cited %d RenderSurfaces; this work item "
                             "covers the first (%s). The rest: %s"
                             % (len(rss), rs["rsId"],
                                ", ".join(x["rsId"] for x in rss[1:])))

    elif kind == "triangles":
        t = sel.get("triangles")
        if not t:
            guards.append(dict(guard="empty-selection", blocking=True,
                               why="kind=triangles but selection.triangles is "
                                   "absent"))
        else:
            gfx = res.gfxobj(t["gfxObjId"])
            gfx["instances"] = res.instances().get(int(t["gfxObjId"], 16))
            trir = res.triangles(t)
            resolved["gfxObj"] = gfx
            resolved["triangles"] = trir
            lane, a, g, n = classify_triangles(entry, trir, gfx, tags)
            actions += a
            guards += g
            notes += n
            target = dict(kind="gfxObj", id=gfx["gfxObjId"])

    else:                                            # kind == "object"
        lane = "triage"
        if objs:
            target = dict(kind="gfxObj", id=objs[0]["gfxObjId"])
            allsurf = sorted({s for o in objs for s in o.get("surfaces", [])})
            resolved["candidateSurfaces"] = [
                dict(surfaceId=s, **{k: v for k, v in res.surface(s).items()
                                     if k in ("resolvedRsId", "reliefClassVeto",
                                              "base1ClipMap", "translucency")})
                for s in allsurf]
            actions.append(dict(
                action="narrow-the-selection",
                why=("kind=object names a whole model, which is not an "
                     "actionable target: the texture lane works per "
                     "RenderSurface and the geometry lane per GfxObj record + "
                     "polygon set. %d candidate surfaces are listed under "
                     "resolved.candidateSurfaces; ask the reporter (or an "
                     "agent replaying the stored camera) which one."
                     % len(allsurf))))
        else:
            guards.append(dict(guard="empty-selection", blocking=True,
                               why="kind=object with no objects[]"))

    # guard drift: the plugin's optimistic pre-flight vs the dats
    pg = entry.get("guards") or {}
    real = dict(terrainProtected=bool(resolved.get("renderSurface", {}).get("terrainProtected")),
                paletteRoute=bool(resolved.get("renderSurface", {}).get("paletted")))
    drift = {k: dict(plugin=pg.get(k), dat=real[k]) for k in real
             if k in pg and bool(pg.get(k)) != real[k]}
    if drift:
        guards.append(dict(
            guard="guard-drift", blocking=False,
            why="entry.guards disagrees with the dats: %s. The plugin's "
                "acme-meta.json is probably from a different kit than --portal."
                % json.dumps(drift, sort_keys=True)))

    return dict(entryId=entry["id"], lane=lane, target=target,
                severity=entry.get("severity", 1), tags=tags,
                author=entry.get("author"), createdAt=entry.get("createdAt"),
                prompt=entry.get("prompt"),
                clientRelease=entry.get("clientRelease"),
                world=entry.get("world"), camera=entry.get("camera"),
                attachments=atts,
                resolved=resolved, guards=guards, actions=actions, notes=notes)


def aggregate(items):
    """Merge by primary target id: rsId for textures, gfxObjId for triangles.
    Priority = reports x instance exposure (severity breaks ties)."""
    by_key = {}
    for it in items:
        t = it["target"]
        key = ("%s:%s" % (t["kind"], t["id"])) if t else ("unresolved:%s" % it["entryId"])
        g = by_key.setdefault(key, dict(
            workItemId="wi-" + key.replace(":", "-").lower(),
            target=t, lanes=[], entryIds=[], reports=0, reporters=[],
            severityMax=0, tags=[], prompts=[], cameras=[], attachments=[],
            resolved={}, guards=[], actions=[], notes=[],
            clientReleases=[]))
        g["entryIds"].append(it["entryId"])
        g["reports"] += 1
        if it["lane"] not in g["lanes"]:
            g["lanes"].append(it["lane"])
        if it["author"] and it["author"] not in g["reporters"]:
            g["reporters"].append(it["author"])
        g["severityMax"] = max(g["severityMax"], it["severity"] or 1)
        for t2 in it["tags"]:
            if t2 not in g["tags"]:
                g["tags"].append(t2)
        g["prompts"].append(dict(entryId=it["entryId"], author=it["author"],
                                 text=it["prompt"]))
        g["cameras"].append(dict(entryId=it["entryId"], world=it["world"],
                                 camera=it["camera"],
                                 attachments=it["attachments"]))
        kt = (it.get("clientRelease") or {}).get("kitTag")
        if kt and kt not in g["clientReleases"]:
            g["clientReleases"].append(kt)
        # resolved facts are a property of the TARGET, not the report -- first
        # writer wins, and a later disagreement would already have surfaced as
        # a stale-selection / rs-id-drift guard.
        for k, v in it["resolved"].items():
            g["resolved"].setdefault(k, v)
        for gd in it["guards"]:
            if gd not in g["guards"]:
                g["guards"].append(gd)
        for ac in it["actions"]:
            # Two reports on the same target produce the same action with a
            # different `why` (different tags).  Keep ONE action and collect the
            # extra reasons, so the menu stays a menu.
            same = next((x for x in g["actions"]
                         if x.get("action") == ac.get("action")), None)
            if same is None:
                g["actions"].append(ac)
            elif same != ac and ac.get("why") and ac["why"] != same.get("why"):
                same.setdefault("alsoBecause", [])
                if ac["why"] not in same["alsoBecause"]:
                    same["alsoBecause"].append(ac["why"])
        for nt in it["notes"]:
            if nt not in g["notes"]:
                g["notes"].append(nt)

    out = []
    for g in by_key.values():
        r = g["resolved"]
        inst = None
        for src in (r.get("gfxObj"), (r.get("objects") or [{}])[0]):
            if src and src.get("instances"):
                inst = src["instances"]
                break
        g["instanceExposure"] = inst
        exposure = inst if inst else 1
        g["priority"] = g["reports"] * exposure
        g["priorityFormula"] = ("reports(%d) x instanceExposure(%s) = %d"
                                % (g["reports"],
                                   inst if inst is not None else "1 (unknown: "
                                   "no --cell, or the record is not a "
                                   "LandBlockInfo static)", g["priority"]))
        g["blocked"] = any(x.get("blocking") for x in g["guards"])
        g["lane"] = g["lanes"][0] if len(g["lanes"]) == 1 else "mixed"
        out.append(g)
    out.sort(key=lambda g: (g["blocked"], -g["priority"], -g["severityMax"],
                            g["workItemId"]))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--queue", required=True, help="redline.jsonl")
    ap.add_argument("--portal", required=True,
                    help="client_portal.dat to resolve ids against (READ-ONLY)")
    ap.add_argument("--cell", default=None,
                    help="client_cell_1.dat -- enables real instance-exposure "
                         "counts from LandBlockInfo placements (slow, ~1 min)")
    ap.add_argument("--status", default=None,
                    help="redline-status.jsonl; entries whose derived state is "
                         "'fixed' are skipped unless --include-fixed")
    ap.add_argument("--include-fixed", action="store_true")
    ap.add_argument("--out", default=None, help="default <queue dir>/work-items.json")
    ap.add_argument("--schema", default=SCHEMA_PATH)
    ap.add_argument("--strict", action="store_true",
                    help="exit nonzero if any entry fails validation")
    a = ap.parse_args(argv)

    queue_path = os.path.abspath(a.queue)
    queue_dir = os.path.dirname(queue_path)
    out_path = os.path.abspath(a.out or os.path.join(queue_dir, "work-items.json"))

    val = Validator(a.schema)
    print("[schema] %s (validator: %s)"
          % (os.path.relpath(a.schema, DATPATCH),
             "jsonschema" if val.lib else "built-in draft-07 subset"))

    entries, invalid = [], []
    with open(queue_path) as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                e = json.loads(line)
            except Exception as ex:
                invalid.append(dict(line=ln, id=None, errors=["not JSON: %s" % ex]))
                continue
            errs = val.errors(e, "entry")
            if errs:
                invalid.append(dict(line=ln, id=e.get("id"), errors=errs[:8]))
                continue
            entries.append(e)
    rel = os.path.relpath(queue_path, os.getcwd())
    print("[queue] %s: %d valid, %d invalid"
          % (queue_path if rel.startswith("..") else rel,
             len(entries), len(invalid)))
    for iv in invalid:
        print("   INVALID line %d (%s): %s" % (iv["line"], iv["id"], iv["errors"][0]))

    status = derive_status(a.status)
    skipped = []
    if status and not a.include_fixed:
        keep = []
        for e in entries:
            st = status.get(e["id"], {}).get("state")
            if st == "fixed":
                skipped.append(dict(entryId=e["id"], state=st,
                                    release=status[e["id"]].get("release")))
            else:
                keep.append(e)
        entries = keep
        if skipped:
            print("[status] %d entr(ies) already fixed -> skipped" % len(skipped))

    res = Resolver(a.portal, a.cell)
    print("[dats] portal %s (%d records)%s"
          % (os.path.basename(res.portal_path), len(res.dat.files),
             "  cell %s" % os.path.basename(res.cell_path) if res.cell_path else ""))
    print("[guards] terrain_protected_rs.txt: %d RenderSurfaces"
          % len(res.protected))
    if a.cell:
        n = len(res.instances())
        print("[exposure] LandBlockInfo placements resolved for %d GfxObjs" % n)

    items = []
    for e in entries:
        try:
            items.append(process(e, res, queue_dir))
        except Exception as ex:
            import traceback
            invalid.append(dict(line=None, id=e["id"],
                                errors=["resolve crashed: %s: %s" % (type(ex).__name__, ex)],
                                trace=traceback.format_exc()[-800:]))
            print("   RESOLVE FAILED %s: %s" % (e["id"], ex))

    work = aggregate(items)
    doc = dict(
        generatedBy="tools/dat-patch/redline/queue_worker.py",
        schemaVersion=1,
        queue=queue_path,
        portal=res.portal_path,
        cell=res.cell_path,
        statusLog=os.path.abspath(a.status) if a.status else None,
        counts=dict(entriesRead=len(entries) + len(invalid) + len(skipped),
                    valid=len(entries), invalid=len(invalid),
                    skippedFixed=len(skipped),
                    workItems=len(work),
                    blocked=sum(1 for w in work if w["blocked"])),
        lanes={l: sum(1 for w in work if w["lane"] == l)
               for l in sorted({w["lane"] for w in work})},
        invalidEntries=invalid,
        skippedFixed=skipped,
        workItems=work)
    tmp = out_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=1)
    os.replace(tmp, out_path)

    print("=" * 72)
    for w in work:
        print("%-9s %-28s reports=%d exposure=%-5s prio=%-5d %s%s"
              % ("BLOCKED" if w["blocked"] else "ready",
                 (w["target"] or {}).get("id", "-"), w["reports"],
                 w["instanceExposure"] if w["instanceExposure"] is not None else "?",
                 w["priority"], w["lane"],
                 "  [%s]" % ",".join(g["guard"] for g in w["guards"]
                                     if g.get("blocking")) if w["blocked"] else ""))
    print("=" * 72)
    print("[out] %d work items -> %s" % (len(work), out_path))
    if a.strict and invalid:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
