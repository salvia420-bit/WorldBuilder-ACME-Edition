#!/usr/bin/env python3
"""HBV1 byte fixtures, generated FROM the wire spec.

Interprets vehicles.protocol.xml (field order, types, vectors, since= / default=) and packs the sample values
in fixtures-input.json, so the bytes come from the spec itself rather than from either implementation.
Writes vehicle-wire-fixtures.json, which the Rust (holtburger-protocol) and C# (ACE.Server.Tests) tests
round-trip: unpack(hex) == fields, and pack(fields) == pack(unpack(hex)) == repack_hex if present, else hex.

  python3 gen_fixtures.py            # regenerate
  python3 gen_fixtures.py --check    # exit 1 if the committed JSON is stale

Fixture payloads start at the HBV1 header (right after the GameAction / GameEvent opcode). The "fields"
objects omit the header (Tag 0x31564248, Version = the schema's version, Reserved 0 are implied) except where
a fixture overrides it (the legacy-version, bad-tag and future-version cases). Every record carries the
payload's header "version".

Versioning: an element marked since="N" is packed only when the payload's header Version >= N. For an older
payload "fields" still lists it, at its default (default="..." in the XML, else 0 / empty) -- exactly what a
current reader yields -- and the input must not give it. When a current-version writer would emit different
bytes for "fields" (an older payload, or a newer one with trailing bytes), the record carries "repack_hex":
the payload as the current writer emits it. Three fixtures also carry the full AC frame ("frame_hex": 0xF7B1
game action / 0xF7B0 game event) to test the framing.
"""
import json
import struct
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = HERE / "vehicles.protocol.xml"
INPUT = HERE / "fixtures-input.json"
OUTPUT = HERE / "vehicle-wire-fixtures.json"

TAG = 0x31564248  # b"HBV1" little-endian
PRIMS = {
    "uint": "<I", "int": "<i", "ushort": "<H", "short": "<h", "byte": "<B", "sbyte": "<b",
    "float": "<f", "ObjectId": "<I", "LandcellId": "<I", "bool": "<I",
}
BUILTIN_TYPES = {
    "Vector3": [("float", "X"), ("float", "Y"), ("float", "Z")],
    "Quaternion": [("float", "W"), ("float", "X"), ("float", "Y"), ("float", "Z")],
}


def since(el):
    return int(el.get("since", "1"))


def f32(v):
    return struct.unpack("<f", struct.pack("<f", float(v)))[0]


class Spec:
    def __init__(self, path):
        root = ET.parse(path).getroot()
        # the version every current writer emits (Rust HBV1_VERSION, C# VehicleWire.Version)
        self.version = int(root.get("version", "1"))
        newest = max(since(el) for el in root.iter() if el.tag in ("field", "vector"))
        if newest > self.version:
            raise ValueError(f"an element is since={newest} but the schema is version {self.version}")
        self.enums = {e.get("name"): e.get("parent") for e in root.iter("enum")}
        self.types = {}
        for t in root.find("types"):
            if t.get("primitive"):
                PRIMS.setdefault(t.get("name"), PRIMS[t.get("primitive")])
                continue
            self.types[t.get("name")] = list(t)
        self.messages = {}
        for group, direction in (("gameactions", "C2S"), ("gameevents", "S2C")):
            for t in root.find(group):
                self.messages[t.get("name")] = (direction, int(t.get("type"), 16), list(t))

    def prim_of(self, tname):
        if tname in PRIMS:
            return PRIMS[tname]
        if tname in self.enums:
            return PRIMS[self.enums[tname]]
        return None

    def zero(self, tname, default=None):
        """The value a reader yields for an element of type tname that is not on the wire."""
        prim = self.prim_of(tname)
        if prim:
            if prim == "<f":
                return f32(float(default)) if default is not None else 0.0
            return int(default, 0) if default is not None else 0
        if tname == "string":
            return default or ""
        if tname in BUILTIN_TYPES:
            return {n: self.zero(t) for t, n in BUILTIN_TYPES[tname]}
        if tname in self.types:
            return {c.get("name"): self.default_of(c) for c in self.types[tname]}
        raise KeyError(f"unknown type {tname}")

    def default_of(self, el):
        if el.tag == "vector":
            return []
        return self.zero(el.get("type"), el.get("default"))

    def pack_type(self, tname, value, out, version):
        prim = self.prim_of(tname)
        if prim:
            v = f32(value) if prim == "<f" else int(value)
            out += struct.pack(prim, v)
            return f32(value) if prim == "<f" else int(value)
        if tname == "string":
            raw = str(value).encode("cp1252")
            out += struct.pack("<H", len(raw)) + raw
            out += b"\0" * ((4 - (2 + len(raw)) % 4) % 4)
            return str(value)
        if tname in BUILTIN_TYPES:
            fields = [(t, n) for t, n in BUILTIN_TYPES[tname]]
            norm = {}
            for t, n in fields:
                norm[n] = self.pack_type(t, value[n], out, version)
            return norm
        if tname in self.types:
            return self.pack_children(self.types[tname], value, out, version)
        raise KeyError(f"unknown type {tname}")

    def pack_children(self, children, values, out, version=None):
        """Packs children in order. The message's VehicleHeader (omitted from values = the current version)
        sets the version that decides which since= elements are on the wire."""
        if version is None:
            version = self.version
        norm = {}
        for child in children:
            tag = child.tag
            name = child.get("name")
            if tag not in ("field", "vector"):
                raise KeyError(f"unsupported element {tag}")
            if tag == "field" and child.get("type") == "VehicleHeader" and name == "Header":
                hdr = values.get("Header", {"Tag": TAG, "Version": self.version, "Reserved": 0})
                h = self.pack_type("VehicleHeader", hdr, out, version)
                version = h["Version"]
                if "Header" in values:
                    norm["Header"] = h
                continue
            if version < since(child):
                if name in values:
                    raise ValueError(f"{name} is since={since(child)}: not on the wire of a v{version} payload")
                norm[name] = self.default_of(child)
                continue
            if tag == "field":
                norm[name] = self.pack_type(child.get("type"), values[name], out, version)
            else:
                items = values[name]
                length = child.get("length")
                if length and norm.get(length) != len(items):
                    raise ValueError(f"{name}: {len(items)} items but {length} = {norm.get(length)}")
                norm[name] = [self.pack_type(child.get("type"), it, out, version) for it in items]
        return norm


def build(spec, inputs):
    fixtures = []
    for fx in inputs["fixtures"]:
        direction, opcode, children = spec.messages[fx["message"]]
        payload = bytearray()
        fields = spec.pack_children(children, fx["fields"], payload)
        payload += bytes.fromhex(fx.get("trailing_hex", ""))
        expect = fx.get("expect", "ok")
        rec = {
            "name": fx["name"],
            "message": fx["message"],
            "dir": direction,
            "opcode": opcode,
            "version": fields["Header"]["Version"] if "Header" in fields else spec.version,
            "expect": expect,
            "fields": fields,
            "hex": payload.hex(),
        }
        if expect == "ok":
            # what a current-version writer emits for these fields (header implied, every element packed)
            again = bytearray()
            spec.pack_children(children, {k: v for k, v in fields.items() if k != "Header"}, again)
            if again != payload:
                rec["repack_hex"] = again.hex()
        if "trailing_hex" in fx:
            rec["trailing_hex"] = fx["trailing_hex"]
        frame = fx.get("frame")
        if frame:
            if direction == "C2S":
                head = struct.pack("<III", 0xF7B1, frame["sequence"], opcode)
            else:
                head = struct.pack("<IIII", 0xF7B0, frame["target"], frame["sequence"], opcode)
            rec["frame"] = frame
            rec["frame_hex"] = (head + payload).hex()
        fixtures.append(rec)
    return {
        "spec": f"HBV1 vehicles wire v{spec.version} — generated by gen_fixtures.py from vehicles.protocol.xml; do not edit",
        "tag": TAG,
        "version": spec.version,
        "fixtures": fixtures,
    }


def main():
    spec = Spec(SPEC)
    inputs = json.loads(INPUT.read_text())
    out = json.dumps(build(spec, inputs), indent=1) + "\n"
    if "--check" in sys.argv:
        if not OUTPUT.exists() or OUTPUT.read_text() != out:
            print("vehicle-wire-fixtures.json is STALE — run gen_fixtures.py", file=sys.stderr)
            sys.exit(1)
        print("fixtures up to date")
        return
    OUTPUT.write_text(out)
    print(f"wrote {OUTPUT.name}: {len(json.loads(out)['fixtures'])} fixtures")


if __name__ == "__main__":
    main()
