"""MotionTable (0x09) and Animation (0x03) parse/encode.

Field order is taken from vanilla ACE.DatLoader (the SERVER reads these two
types, so ACE is truth here; dats.xml agrees, acclient.c would win a conflict
but none was found):

  MotionTable  (ACE.DatLoader/FileTypes/MotionTable.cs)
      u32 Id
      u32 DefaultStyle
      u32 numStyleDefaults ; (u32 key, u32 value) *
      Cycles     : u32 count ; (u32 key, MotionData) *
      Modifiers  : u32 count ; (u32 key, MotionData) *
      Links      : u32 count ; (u32 key, u32 count2 ; (u32 key2, MotionData)*) *

  MotionData   (ACE.DatLoader/Entity/MotionData.cs)
      u8 numAnims, u8 Bitfield, u8 Flags, <align to 4>
      AnimData * numAnims
      [Vector3 Velocity]  if Flags & 0x1 (HasVelocity)
      [Vector3 Omega]     if Flags & 0x2 (HasOmega)

  AnimData     (ACE.DatLoader/Entity/AnimData.cs)
      u32 AnimId, i32 LowFrame, i32 HighFrame, f32 Framerate

  Animation    (ACE.DatLoader/FileTypes/Animation.cs)
      u32 Id, u32 Flags, u32 NumParts, u32 NumFrames
      [Frame * NumFrames]                if Flags & 0x1 (PosFrames)
      NumFrames * ( Frame * NumParts ; u32 numHooks ; hook* )

  Frame        (ACE.DatLoader/Entity/Frame.cs)
      f32 x, y, z, then f32 qw, qx, qy, qz     <- origin FIRST, quat is WXYZ

Every encoder in here is gated by `roundtrip()`: decode+encode of an untouched
record must be byte-identical before the encoder may be trusted with edits.
"""
import struct

# ---------------------------------------------------------------- primitives


class _R:
    def __init__(self, b):
        self.b = b
        self.o = 0

    def u8(self):
        v = self.b[self.o]
        self.o += 1
        return v

    def u32(self):
        v = struct.unpack_from("<I", self.b, self.o)[0]
        self.o += 4
        return v

    def i32(self):
        v = struct.unpack_from("<i", self.b, self.o)[0]
        self.o += 4
        return v

    def f32(self):
        v = struct.unpack_from("<f", self.b, self.o)[0]
        self.o += 4
        return v

    def align(self):
        self.o = (self.o + 3) & ~3


# ---------------------------------------------------------------- MotionTable

MDF_HAS_VELOCITY = 0x1
MDF_HAS_OMEGA = 0x2


def _read_motiondata(r):
    n = r.u8()
    bitfield = r.u8()
    flags = r.u8()
    r.align()
    anims = []
    for _ in range(n):
        anims.append(dict(anim=r.u32(), low=r.i32(), high=r.i32(), fps=r.f32()))
    md = dict(bitfield=bitfield, flags=flags, anims=anims)
    if flags & MDF_HAS_VELOCITY:
        md["velocity"] = (r.f32(), r.f32(), r.f32())
    if flags & MDF_HAS_OMEGA:
        md["omega"] = (r.f32(), r.f32(), r.f32())
    return md


def _write_motiondata(md):
    out = bytearray()
    out += struct.pack("<BBB", len(md["anims"]), md["bitfield"], md["flags"])
    out += b"\x00" * ((4 - (len(out) % 4)) % 4)
    for a in md["anims"]:
        out += struct.pack("<Iiif", a["anim"], a["low"], a["high"], a["fps"])
    if md["flags"] & MDF_HAS_VELOCITY:
        out += struct.pack("<3f", *md["velocity"])
    if md["flags"] & MDF_HAS_OMEGA:
        out += struct.pack("<3f", *md["omega"])
    return bytes(out)


def parse_motiontable(data):
    r = _R(data)
    mt = {}
    mt["id"] = r.u32()
    mt["default_style"] = r.u32()
    n = r.u32()
    sd = {}
    for _ in range(n):
        k = r.u32()
        sd[k] = r.u32()
    mt["style_defaults"] = sd
    for name in ("cycles", "modifiers"):
        n = r.u32()
        d = {}
        for _ in range(n):
            k = r.u32()
            d[k] = _read_motiondata(r)
        mt[name] = d
    n = r.u32()
    links = {}
    for _ in range(n):
        k = r.u32()
        m = r.u32()
        inner = {}
        for _ in range(m):
            k2 = r.u32()
            inner[k2] = _read_motiondata(r)
        links[k] = inner
    mt["links"] = links
    mt["_tail"] = len(data) - r.o
    return mt


def encode_motiontable(mt):
    out = bytearray()
    out += struct.pack("<II", mt["id"], mt["default_style"])
    out += struct.pack("<I", len(mt["style_defaults"]))
    for k, v in mt["style_defaults"].items():
        out += struct.pack("<II", k, v)
    for name in ("cycles", "modifiers"):
        d = mt[name]
        out += struct.pack("<I", len(d))
        for k, md in d.items():
            out += struct.pack("<I", k)
            out += _write_motiondata(md)
    out += struct.pack("<I", len(mt["links"]))
    for k, inner in mt["links"].items():
        out += struct.pack("<I", k)
        out += struct.pack("<I", len(inner))
        for k2, md in inner.items():
            out += struct.pack("<I", k2)
            out += _write_motiondata(md)
    return bytes(out)


# ----------------------------------------------------------------- Animation

ANIM_POSFRAMES = 0x1


def parse_animation(data):
    r = _R(data)
    a = {}
    a["id"] = r.u32()
    a["flags"] = r.u32()
    a["numparts"] = r.u32()
    a["numframes"] = r.u32()
    a["posframes"] = []
    if a["flags"] & ANIM_POSFRAMES:
        for _ in range(a["numframes"]):
            a["posframes"].append(_read_frame(r))
    frames = []
    for _ in range(a["numframes"]):
        parts = [_read_frame(r) for _ in range(a["numparts"])]
        nh = r.u32()
        hooks = []
        for _ in range(nh):
            start = r.o
            _skip_hook(r)
            hooks.append(bytes(data[start:r.o]))
        frames.append(dict(parts=parts, hooks=hooks))
    a["frames"] = frames
    a["_tail"] = len(data) - r.o
    return a


def _read_frame(r):
    x, y, z, qw, qx, qy, qz = struct.unpack_from("<7f", r.b, r.o)
    r.o += 28
    return ((x, y, z), (qw, qx, qy, qz))


def _write_frame(f):
    (x, y, z), (qw, qx, qy, qz) = f
    return struct.pack("<7f", x, y, z, qw, qx, qy, qz)


# hook sizes, from ACE.DatLoader/Entity/AnimationHooks/*.cs. Every hook starts
# with u32 HookType + i32 Direction; the payload follows.
_HOOK_FIXED = {
    0x01: 4,           # Sound          : u32 gid
    0x02: 4,           # SoundTable     : u32 soundType
    0x03: 8,           # Attack         : f32 leftRight, f32 hi/lo (2 floats)
    0x04: 8,           # AnimationDone? -> see below (unused)
    0x05: 8,           # ReplaceObject  : AnimationPartChange (u16 partIdx,u32 partId) -> 6+pad
    0x06: 4,           # Ethereal       : i32
    0x07: 4,           # TransparentPart
    0x08: 0,           # Luminous
    0x09: 0,
}


def _skip_hook(r):
    """Only needed to walk retail animations; the baker emits zero hooks."""
    htype = r.u32()
    r.i32()  # direction
    from_ = _HOOK_SKIP.get(htype)
    if from_ is None:
        raise ValueError("unhandled animation hook type 0x%X" % htype)
    from_(r)


def _sk(nbytes):
    def f(r):
        r.o += nbytes
    return f


def _sk_partchange(r):
    r.o += 2  # part index u16
    r.o += 4  # part id u32
    r.align()


def _sk_texchange(r):
    n = r.u32()
    for _ in range(n):
        r.o += 2      # part index u16
        r.o += 8      # old/new tex u32 u32
        r.align()


def _sk_scale(r):
    r.o += 8          # end f32, time f32


def _sk_create_particle(r):
    r.o += 4 * 4 + 28  # emitterId, partIndex, offset Frame(28), emitterInfoId


_HOOK_SKIP = {
    0x01: _sk(4),          # Sound            : u32 GID
    0x02: _sk(4),          # SoundTable       : u32 SoundType
    0x03: _sk(8),          # Attack           : f32 LeftRight, f32 unk? (2 f32)
    0x04: _sk(8),          # ReplaceObject    : see below (overwritten)
    0x05: _sk(4),          # Ethereal         : i32
    0x06: _sk(4),          # TransparentPart
    0x07: _sk(4),          # Luminous
    0x08: _sk(4),
}


class HookWalkUnsupported(Exception):
    pass


def roundtrip_motiontable(data):
    mt = parse_motiontable(data)
    return encode_motiontable(mt) == data, mt


def roundtrip_animation(data):
    a = parse_animation(data)
    return encode_animation(a) == data, a


def encode_animation(a):
    out = bytearray()
    out += struct.pack("<IIII", a["id"], a["flags"], a["numparts"], a["numframes"])
    if a["flags"] & ANIM_POSFRAMES:
        for f in a["posframes"]:
            out += _write_frame(f)
    for fr in a["frames"]:
        for p in fr["parts"]:
            out += _write_frame(p)
        out += struct.pack("<I", len(fr["hooks"]))
        for h in fr["hooks"]:
            out += h
    return bytes(out)


# --------------------------------------------------------------- key helpers

NONCOMBAT = 0x8000003D
DEAD = 0x40000011
READY = 0x41000003


def cyc_key(stance, motion):
    """ACE: (uint)stance << 16 | (uint)motion & 0xFFFFF   (32-bit wrap)."""
    return ((stance << 16) & 0xFFFFFFFF) | (motion & 0xFFFFF)


def anim_length(anim_data, numframes_lookup):
    """Port of ACE MotionTable.GetAnimationLength(AnimData).

    `numframes_lookup(anim_id)` returns the Animation's NumFrames, and MUST
    return 0 for a missing id (ACE's ReadFromDat returns a default-constructed
    Animation whose NumFrames is 0 -- that is what makes the phantom spacer
    work).
    """
    nf = numframes_lookup(anim_data["anim"])
    high = anim_data["high"]
    if high == -1:
        high = nf
    if high > nf:
        high = nf
    return (high - anim_data["low"]) / abs(anim_data["fps"])
