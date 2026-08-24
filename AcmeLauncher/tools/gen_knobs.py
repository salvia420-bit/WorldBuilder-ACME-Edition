#!/usr/bin/env python3
"""Generate AcmeLauncher/Knobs.Generated.cs from the three plugin config sources so the
Tune tab's knob table never drifts. Re-run when a plugin's config changes:
    python3 AcmeLauncher/tools/gen_knobs.py
EXACT counts required: 84 lights + 35 sky + 28 ragdoll = 147. Fails loud otherwise and
writes nothing on failure."""
import re, sys, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LIGHTS = os.path.join(ROOT, "AcmeLights/Lib/LightsConfig.cs")
SKY    = os.path.join(ROOT, "AcmeSky/Services/LiveSky/SkyConfig.cs")
RAG    = os.path.join(ROOT, "AcmeRagdoll/Lib/LiveMotionConfig.cs")

def read(p): return open(p, encoding="utf-8", errors="replace").read()

def num(s):
    if s is None: return None
    s = s.strip().rstrip('fF').replace('_', '')
    try: return float(s)
    except: return None

def is_whole(x): return x is not None and x == int(x)

def norm_default(default, typ):
    """Normalise a default literal for the cfg: bool->1/0, color->bare hex, else trim f suffix.
    A numeric field with no explicit default is 0 (an uninitialised C# bool/float/int is 0);
    only Color/String stay blank when unknown."""
    if default is None: return "0" if typ in ("Toggle", "Float", "Integer") else ""
    d = default.strip()
    if typ == "Color":
        d = d.replace("0x", "").replace("0X", "").rstrip("uU")
        return d if d else "0"
    if d.lower() in ("true", "1"): return "1" if typ == "Toggle" else d
    if d.lower() in ("false", "0"): return "0" if typ == "Toggle" else d
    d = d.rstrip('fF').replace('_', '')
    return d

def fields(text):
    """field name -> (default_literal, description, decl_type) from a same-line // comment (not ///)."""
    out = {}
    for m in re.finditer(r'public\s+(float|uint|int|bool|long)\s+(\w+)\s*=\s*([^;]+);(?:\s*//(?!/)\s*(.*))?', text):
        dtype, name, default, comment = m.group(1), m.group(2), m.group(3).strip(), (m.group(4) or "").strip()
        desc = re.sub(r'^[a-z0-9]+:\s*', '', comment)
        if desc.lstrip().startswith('---'): desc = ''
        out[name] = (default, desc, dtype)
    return out

def infer_type(default_lit, mn, mx, is_color, is_bool):
    if is_color: return "Color"
    if is_bool: return "Toggle"
    d, lo, hi = num(default_lit), num(mn), num(mx)
    if lo is None or hi is None: return "String"
    if lo == 0 and hi == 1 and d in (0.0, 1.0): return "Toggle"
    # any non-integer bound => a float knob (never a tick-snapped integer slider)
    if not is_whole(lo) or not is_whole(hi): return "Float"
    if is_whole(d) and default_lit is not None and '.' not in default_lit and (hi - lo) > 2:
        return "Integer"
    return "Float"

def sky_env_defaults(text):
    """Real sky defaults live in FromDefaultsAndEnv(): EnvFloat 2nd arg, direct `X = Nf,`,
    the Axis `?? "..."`, and EnvBool-assigned fields (bool). field name -> (default, is_bool)."""
    m = re.search(r'FromDefaultsAndEnv\(\)\s*\{(.*?)\n\s{8}\}', text, re.S)
    body = m.group(1) if m else text
    out = {}
    for mm in re.finditer(r'(\w+)\s*=\s*(?:SkySunModel\.)?EnvFloat\(\s*"[^"]*"\s*,\s*([^,]+?)\s*,', body):
        arg = mm.group(2).strip()
        # Only a NUMERIC literal is the real default. Some fields self-reference
        # (`c.RayMode = EnvFloat("…", c.RayMode, …)`) — reject that so the `X = Nf,`
        # literal (or the field default 0) wins instead of the string "c.RayMode".
        if re.fullmatch(r'-?\d+(?:\.\d+)?f?', arg):
            out[mm.group(1)] = (arg, False)
    for mm in re.finditer(r'^\s*(\w+)\s*=\s*(-?\d+(?:\.\d+)?f?)\s*,\s*$', body, re.M):
        out.setdefault(mm.group(1), (mm.group(2).strip(), False))
    am = re.search(r'Axis\s*=\s*Environment\.GetEnvironmentVariable\([^)]*\)\s*\?\?\s*"([^"]*)"', body)
    if am: out["Axis"] = (am.group(1), False)
    for mm in re.finditer(r'c\.(\w+)\s*=\s*EnvBool\(', body):
        out[mm.group(1)] = (None, True)   # bool; default comes from the field decl
    return out

def parse_lights_sky(path, group_fn, env_defaults=None):
    text = read(path); fs = fields(text); env_defaults = env_defaults or {}
    knobs, seen = [], set()
    # fall-through labels (`case "a": case "b":`) -> String knob for the earlier label
    for m in re.finditer(r'case\s+"([a-z0-9]+)"\s*:\s*(?=case\s+")', text):
        fk = m.group(1)
        knobs.append(dict(knob=fk, group=group_fn(fk), type="String", default="", min="", max="",
                          desc="one of a fixed set (see plugin docs)")); seen.add(fk)
    for m in re.finditer(r'case\s+"([a-z0-9]+)"\s*:\s*(.*?)break;', text, re.S):
        knob, body = m.group(1), m.group(2)
        if knob in seen: continue
        is_color = 'Hex(' in body
        cm = re.search(r'(\w+)\s*=\s*Math\.Clamp\([^,]+,\s*([^,]+),\s*([^)]+)\)', body)
        assign = re.search(r'(\w+)\s*=', body)
        field = cm.group(1) if cm else (assign.group(1) if assign else None)
        mn = cm.group(2).strip() if cm else None
        mx = cm.group(3).strip() if cm else None
        fdef, desc, dtype = fs.get(field, (None, "", None))
        edef, ebool = env_defaults.get(field, (None, None))
        default = edef if edef is not None else fdef
        is_bool = bool(ebool) or dtype == "bool"
        typ = infer_type(default, mn, mx, is_color, is_bool)
        if not cm and not is_color: typ = "String"
        knobs.append(dict(knob=knob, group=group_fn(knob), type=typ,
                          default=norm_default(default, typ),
                          min=(str(num(mn)) if num(mn) is not None else ""),
                          max=(str(num(mx)) if num(mx) is not None else ""),
                          desc=desc.replace('"', "'")))
    return knobs

def parse_ragdoll(path):
    text = read(path)
    fdef = {}
    for m in re.finditer(r'public\s+(?:float|bool|int|long)\s+(\w+)\s*=\s*([^;]+);(?:\s*//(?!/)\s*(.*))?', text):
        rdesc = (m.group(3) or "").strip()
        if rdesc.lstrip().startswith("---"): rdesc = ""
        fdef[m.group(1)] = (m.group(2).strip(), rdesc)
    knobs, seen = [], set()
    for m in re.finditer(r'case\s+"([a-z0-9_]+)"\s*:\s*(Set(?:F|B|Ms|I)\([^;]*)', text):
        knob, body = m.group(1), m.group(2)
        if knob in seen: continue
        sf = re.search(r'Set(?:F|Ms|I)\(\s*ref\s+[\w.]*?(\w+)\s*,\s*val\s*,\s*[^,]+,\s*([^,]+),\s*([^,]+),', body)
        sb = re.search(r'SetB\(\s*ref\s+[\w.]*?(\w+)\s*,', body)
        if sf:
            field, mn, mx = sf.group(1), sf.group(2).strip(), sf.group(3).strip()
            default, desc = fdef.get(field, ("", ""))
            is_ms = body.lstrip().startswith("SetMs") or body.lstrip().startswith("SetI")
            typ = "Integer" if is_ms else infer_type(default, mn, mx, False, False)
            knobs.append(dict(knob=knob, group="Ragdoll", type=typ, default=norm_default(default, typ),
                              min=str(num(mn)) if num(mn) is not None else "", max=str(num(mx)) if num(mx) is not None else "",
                              desc=desc.replace('"', "'"))); seen.add(knob)
        elif sb:
            field = sb.group(1); default, desc = fdef.get(field, ("true", ""))
            knobs.append(dict(knob=knob, group="Ragdoll", type="Toggle", default=norm_default(default, "Toggle"),
                              min="0", max="1", desc=desc.replace('"', "'"))); seen.add(knob)
    return knobs

def lights_group(k):
    if k.startswith("mem") or k in ("diet", "framelog"): return "Memory & stability"
    if k.startswith("bloom"): return "Bloom"
    if k.startswith("glow"): return "Glow lights"
    if k.startswith("sel"): return "Light selection"
    if k.startswith("headlamp"): return "Headlamp"
    if k in ("torchlights","flicker","flickeramp","ambientfix","ambientboost","dungeonambient","dungeonambientcolor","rangeadjust","maxstatic","maxdynamic"): return "Torches & ambient"
    return "Misc"
def sky_group(k):
    if k.startswith("cloud"): return "Clouds"
    if k in ("stars","lunar","moonang","sunang"): return "Stars & bodies"
    if k in ("time","timeofs","skytimeoverride","weather","skyweatheroverride","storm"): return "Time & weather"
    return "Atmosphere & render"

L = parse_lights_sky(LIGHTS, lights_group); [d.update(plugin="Lights", cfg="lights") for d in L]
S = parse_lights_sky(SKY, sky_group, sky_env_defaults(read(SKY))); [d.update(plugin="Sky", cfg="sky") for d in S]
R = parse_ragdoll(RAG); [d.update(plugin="Ragdoll", cfg="ragdoll") for d in R]

print(f"lights={len(L)} sky={len(S)} ragdoll={len(R)}", file=sys.stderr)
ok = len(L) == 84 and len(S) == 35 and len(R) == 28
if not ok:
    print("EXACT COUNT CHECK FAILED (need 84/35/28) — writing nothing.", file=sys.stderr)
    sys.exit(1)

allk = L + S + R
def cs(s): return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
out = ["// GENERATED by AcmeLauncher/tools/gen_knobs.py — do not edit by hand.",
       "// Regenerate when a plugin config changes: python3 AcmeLauncher/tools/gen_knobs.py",
       "namespace AcmeLauncher {", "    internal static class GeneratedKnobs {",
       "        public static readonly KnobDef[] All = new KnobDef[] {"]
for d in allk:
    out.append("            new KnobDef({}, {}, {}, {}, KnobType.{}, {}, {}, {}, {}),".format(
        cs(d["plugin"]), cs(d["cfg"]), cs(d["group"]), cs(d["knob"]), d["type"],
        cs(d["default"]), cs(d["min"]), cs(d["max"]), cs(d["desc"])))
out += ["        };", "    }", "}"]
open(os.path.join(ROOT, "AcmeLauncher/Knobs.Generated.cs"), "w").write("\n".join(out) + "\n")
print(f"wrote Knobs.Generated.cs with {len(allk)} knobs", file=sys.stderr)
sys.exit(0)
