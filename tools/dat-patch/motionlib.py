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
    # ACE ReplaceObjectHook: u16 PartIndex, then a PACKED DataID (ReadAsDataIDOfKnownType):
    # u16, high bit set -> a second u16 follows. Variable length, no alignment.
    r.o += 2                                   # part index u16
    tag = struct.unpack_from("<H", r.b, r.o)[0]
    r.o += 4 if (tag & 0x8000) else 2          # packed 0x01-range DID


def _sk_texchange(r):
    n = r.u32()
    for _ in range(n):
        r.o += 2      # part index u16
        r.o += 8      # old/new tex u32 u32
        r.align()


def _sk_scale(r):
    r.o += 8          # end f32, time f32


def _sk_create_particle(r):
    # ACE CreateParticleHook: EmitterInfoId u32, PartIndex u32, Offset Frame(28), EmitterId u32
    r.o += 4 + 4 + 28 + 4


# Payload sizes after the common (u32 HookType + i32 Direction) prefix, one entry per
# ACE.DatLoader/Entity/AnimationHooks/*.cs Unpack (AnimationHookType 2026-08-24) — the whole
# retail range 0x00..0x1A. Validated by parse+re-encode byte-identity over every 0x03 record
# in retail client_portal.dat (see the sweep note in the git log); a wrong size here cannot
# hide, it desyncs the walk and fails that roundtrip.
_HOOK_SKIP = {
    0x00: _sk(0),          # NoOp
    0x01: _sk(4),          # Sound            : u32 GID
    0x02: _sk(4),          # SoundTable       : u32 SoundType
    0x03: _sk(28),         # Attack           : AttackCone (PartIndex u32 + 6 f32)
    0x04: _sk(0),          # AnimationDone    : no payload
    0x05: _sk_partchange,  # ReplaceObject    : AnimationPartChange
    0x06: _sk(4),          # Ethereal         : i32
    0x07: _sk(16),         # TransparentPart  : Part u32 + Start/End/Time f32
    0x08: _sk(12),         # Luminous         : Start/End/Time f32
    0x09: _sk(16),         # LuminousPart     : Part u32 + Start/End/Time f32
    0x0A: _sk(12),         # Diffuse          : Start/End/Time f32
    0x0B: _sk(16),         # DiffusePart      : Part u32 + Start/End/Time f32
    0x0C: _sk(8),          # Scale            : End/Time f32
    0x0D: _sk_create_particle,   # CreateParticle
    0x0E: _sk(4),          # DestroyParticle  : u32 EmitterId
    0x0F: _sk(4),          # StopParticle     : u32 EmitterId
    0x10: _sk(4),          # NoDraw           : u32
    0x11: _sk(0),          # DefaultScript    : no payload
    0x12: _sk(4),          # DefaultScriptPart: u32 PartIndex
    0x13: _sk(8),          # CallPES          : u32 PES + f32 Pause
    0x14: _sk(12),         # Transparent      : Start/End/Time f32
    0x15: _sk(16),         # SoundTweaked     : u32 SoundID + Priority/Probability/Volume f32
    0x16: _sk(12),         # SetOmega         : Vector3
    0x17: _sk(8),          # TextureVelocity  : USpeed/VSpeed f32
    0x18: _sk(12),         # TextureVelocityPart : u32 PartIndex + USpeed/VSpeed f32
    0x19: _sk(4),          # SetLight         : i32 LightsOn
    0x1A: _sk_create_particle,   # CreateBlockingParticle : CreateParticleHook subclass
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
