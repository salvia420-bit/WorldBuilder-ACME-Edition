#!/usr/bin/env python3
"""fix_degrade_chains.py — the F1 degrade-chain invariant + fixup.

Background (docs/dat-patch/reports/degrade-chain-audit-2026-08-17.md).  A
SurfaceTexture (0x05) holds a *degrade chain*: an ordered list of RenderSurface
(0x06) ids, highest detail first.  The retail client drops the FIRST n levels
per the "Environment texture detail level" preference
(`RenderTexture::DropUnwantedLevels`, acclient.c:137195) — a no-op once the
chain has <= 1 entry.  So whenever our lanes bake a RenderSurface, the owning
chain MUST be collapsed to exactly that one baked id, or a retail-detail
sibling can still top the stack.

    INVARIANT:  for every 0x05 whose chain contains a baked 0x06,
                len(chain) == 1  (and that entry is the baked id).

The r7 export violates it exactly once (`0x05000ECE`) because the importer
keyed its collapse list on the *SurfaceTexture / Surface*, and two 0x05s shared
one retail chain — one got rewritten, its twin did not.  This tool therefore
**keys on the CHAIN**: it groups every 0x05 by its exact chain tuple and acts on
the whole group, so a shared chain can never be half-fixed again.

Wire format (validated 100% over all 7,221 r7 SurfaceTextures by the audit;
`RenderTexture::Serialize` acclient.c:137475, dats.xml, ACE SurfaceTexture.cs):

    u32 id, u32 dataCategory, u8 TextureType, u32 count, count x u32 0x06 id

The record therefore shrinks by 4 bytes per dropped entry.  The rewrite is NOT
done here: it is delegated to WorldBuilder.Terminal's `surface-texture-collapse`
(CommandEngine.DatBake.cs:317, DatReaderWriter 2.1.8 `TryWriteFile`) — the exact
write path the r7/r6 drivers already used for the 1,400 chains they *did*
collapse.  This tool only fixes the SELECTION, which is where the bug was.

Baked-set derivation.  "Baked" = a 0x06 whose bytes differ from retail's.  The
full byte-compare over all 20,684 0x06 records is the audit's job and costs a
minute; the invariant only ever needs the baked status of ids named by
multi-entry chains, so by default we resolve *only those* (a few thousand, with
a compressed-size prefix shortcut before any inflate) — seconds, read-only,
cheap enough to run after every driver step.  `--full-baked` reproduces the
audit's whole 2,412-id set; `--baked-ids FILE` accepts a precomputed list.

usage:
  # CI invariant (read-only; exit 1 on violation) — run next to walk_check.py
  python3 fix_degrade_chains.py PORTAL.dat --check [--retail RETAIL.dat]

  # fixup (writes via WBT); --dry-run plans without writing
  python3 fix_degrade_chains.py PORTAL.dat --fix --wbt WorldBuilder.Terminal.dll

  # extras: --baked-ids F  --dump-baked F  --full-baked  --json REPORT.json  -v

Cost.  Every pass is seek-bound, not CPU-bound (a --check on the r7 export is
~1.4 s of CPU and ~10 min of wall cold on the /mnt/wbterminal2 spindle, far
less warm), so records are always read in FILE OFFSET order.  Intended cadence
is twice per take — --fix in the driver's fixup stage, --check on the packaged
file — not after every step.  To make a check take seconds, dump the baked list
and reuse it:

    python3 fix_degrade_chains.py $PORTAL --full-baked --dump-baked $R/baked.txt
    python3 fix_degrade_chains.py $PORTAL --check --baked-ids $R/baked.txt

which skips the retail dat and every 0x06 read entirely — but a list dumped
before a lane ran is stale by construction, so only reuse one dumped from the
same dat you are checking.
"""
import argparse
import json
import os
import struct
import subprocess
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from datlib import Dat                                          # noqa: E402

DEFAULT_RETAIL = os.path.expanduser("~/ac_base_dats/client_portal.dat")
DEFAULT_WBT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "WorldBuilder.Terminal", "bin", "Release", "net8.0", "WorldBuilder.Terminal.dll")


# ───────────────────────────────────────────────────────── dat index

class DatIndex(Dat):
    """datlib.Dat + the b-tree entry bitflags datlib drops.

    flag bit 0 = the payload is `[u32 uncompressedSize][zlib stream]` (r7 ships
    20,669 of 20,684 0x06 records compressed; every 0x05 is uncompressed).
    """

    def __init__(self, path):
        self.flags = {}
        super().__init__(path)

    def _read_dir(self, off):
        objsize = 4 * 0x3E + 4 + 24 * 0x3D
        b = self.read_raw(off, objsize)
        branches = struct.unpack_from("<62I", b, 0)
        cnt = struct.unpack_from("<I", b, 62 * 4)[0]
        base = 62 * 4 + 4
        for i in range(cnt):
            bf, oid, foff, fsize, _date, itr = struct.unpack_from("<6I", b, base + i * 24)
            self.files[oid] = (foff, fsize, itr)
            self.flags[oid] = bf
        if branches[0] != 0:
            for i in range(cnt + 1):
                self._read_dir(branches[i])

    def ids_of_type(self, top):
        return sorted(i for i in self.files if (i >> 24) == top)

    def by_offset(self, ids):
        """Read order matters: the working dats live on a spinning volume and
        these passes are 100% seek-bound, so walk records in file order."""
        return sorted((i for i in ids if i in self.files),
                      key=lambda i: self.files[i][0])

    def record(self, oid):
        """Inflated record payload (streams one record at a time — never the dat)."""
        off, size, _itr = self.files[oid]
        raw = self.read_raw(off, size)
        if self.flags.get(oid, 0) & 1:
            return zlib.decompress(raw[4:])
        return raw

    def uncompressed_size(self, oid):
        """Payload length without inflating (4-byte prefix when compressed)."""
        off, size, _itr = self.files[oid]
        if self.flags.get(oid, 0) & 1:
            return struct.unpack("<I", self.read_raw(off, 4))[0]
        return size

    def close(self):
        try:
            self.f.close()
        except Exception:
            pass


def parse_surface_texture(b, oid=None):
    """u32 id, u32 dataCategory, u8 TextureType, u32 count, count x u32 rs id."""
    if len(b) < 13:
        raise ValueError("SurfaceTexture record too short (%d bytes)" % len(b))
    rid, cat = struct.unpack_from("<II", b, 0)
    ttype = b[8]
    n = struct.unpack_from("<I", b, 9)[0]
    if n > 64 or 13 + 4 * n > len(b):
        raise ValueError("implausible texture count %d in a %d-byte record" % (n, len(b)))
    ids = tuple(struct.unpack_from("<%dI" % n, b, 13))
    if oid is not None and rid != oid:
        raise ValueError("id echo 0x%08X != b-tree id 0x%08X" % (rid, oid))
    return dict(id=rid, cat=cat, type=ttype, chain=ids, tail=len(b) - (13 + 4 * n))


# ───────────────────────────────────────────────────────── baked set

def derive_baked(patched, retail, candidates, verbose=False):
    """baked = 0x06 whose patched bytes differ from retail's.

    `candidates` limits the work to the ids the decision actually needs.  Two
    passes: uncompressed-size vs retail record size (no inflate), then a full
    byte compare only for the ones that match in size.
    """
    baked = set()
    need_full = []
    for i in patched.by_offset(candidates):
        if i not in patched.files:
            continue                       # highres-only id: not in this dat at all
        if i not in retail.files:
            baked.add(i)                   # record we added — baked by definition
            continue
        if patched.uncompressed_size(i) != retail.uncompressed_size(i):
            baked.add(i)
        else:
            need_full.append(i)
    if verbose:
        print("  baked-derivation: %d candidates, %d differ by size, "
              "%d need a full compare" % (len(candidates), len(baked), len(need_full)))
    for n, i in enumerate(patched.by_offset(need_full)):
        if patched.record(i) != retail.record(i):
            baked.add(i)
        if verbose and n and n % 5000 == 0:
            print("    ... %d/%d compared" % (n, len(need_full)), flush=True)
    return baked


def load_baked_ids(path):
    out = set()
    with open(path) as fh:
        for line in fh:
            line = line.split("#", 1)[0].strip()
            if line:
                out.add(int(line, 16))
    return out


# ───────────────────────────────────────────────────────── analysis

def analyse(portal_path, retail_path=None, baked_ids_path=None,
            full_baked=False, verbose=False):
    """Read-only.  Returns the report dict (chain-keyed groups + violations)."""
    d = DatIndex(portal_path)
    st_ids = d.ids_of_type(0x05)
    rs_ids = set(d.ids_of_type(0x06))

    chains = {}
    parse_errors = []
    for i in d.by_offset(st_ids):
        try:
            chains[i] = parse_surface_texture(d.record(i), i)["chain"]
        except Exception as ex:                      # noqa: BLE001
            parse_errors.append(dict(id="0x%08X" % i, error=str(ex)))

    # ---- key on the CHAIN, never on the SurfaceTexture id ----
    groups = {}
    for i, ch in chains.items():
        groups.setdefault(ch, []).append(i)

    multi = {ch: sts for ch, sts in groups.items() if len(ch) > 1}
    candidates = set()
    for ch in multi:
        candidates |= set(ch)

    if baked_ids_path:
        baked = load_baked_ids(baked_ids_path)
        baked_scope = "file:" + baked_ids_path
    else:
        retail_path = retail_path or DEFAULT_RETAIL
        r = DatIndex(retail_path)
        scope = rs_ids if full_baked else (candidates & rs_ids)
        baked = derive_baked(d, r, scope, verbose=verbose)
        baked_scope = ("all 0x06 (%d)" % len(rs_ids)) if full_baked else \
                      ("0x06 named by multi-entry chains (%d)" % len(scope))
        r.close()

    violations = []
    for ch, sts in sorted(multi.items()):
        hit = [e for e in ch if e in baked]
        if not hit:
            continue
        distinct = sorted(set(hit))
        violations.append(dict(
            chain=["0x%08X" % e for e in ch],
            surface_textures=["0x%08X" % s for s in sorted(sts)],
            baked_entries=["0x%08X" % e for e in distinct],
            keep=("0x%08X" % distinct[0]) if len(distinct) == 1 else None,
            dropped=["0x%08X" % e for e in ch if e != distinct[0]]
                    if len(distinct) == 1 else None,
            ambiguous=len(distinct) != 1,
        ))

    # Only meaningful when the baked set covers every 0x06 — in the default
    # (scoped) mode `baked` deliberately holds nothing outside multi-entry
    # chains, so a len-1 chain can never be counted.
    compliant = None
    if full_baked or baked_ids_path:
        compliant = sum(1 for ch, sts in groups.items()
                        if len(ch) == 1 and ch[0] in baked for _ in sts)
    rep = dict(
        portal=os.path.abspath(portal_path),
        retail=(os.path.abspath(retail_path) if retail_path and not baked_ids_path else None),
        baked_scope=baked_scope,
        baked_count=len(baked),
        surface_textures=len(chains),
        distinct_chains=len(groups),
        multi_entry_chains=len(multi),
        chain_len_histogram={str(n): c for n, c in sorted(
            {k: sum(1 for ch in chains.values() if len(ch) == k)
             for k in {len(v) for v in chains.values()}}.items())},
        already_collapsed_baked_chains=compliant,
        parse_errors=parse_errors,
        violations=violations,
        violation_surface_textures=sorted(
            s for v in violations for s in v["surface_textures"]),
    )
    d.close()
    return rep


# ───────────────────────────────────────────────────────── fixup

def wbt_run(wbt_dll, cmds, timeout=1800):
    dotnet = os.environ.get("DOTNET_BIN")
    if not dotnet:
        for c in (os.path.expanduser("~/.local/bin/dotnet"), "/usr/bin/dotnet", "dotnet"):
            if c == "dotnet" or os.path.exists(c):
                dotnet = c
                break
    env = dict(os.environ, DOTNET_ROLL_FORWARD="LatestMajor")
    inp = "\n".join(json.dumps(c) for c in cmds) + "\n"
    p = subprocess.run([dotnet, wbt_dll, "--stdin"], input=inp, env=env,
                       capture_output=True, text=True, timeout=timeout)
    out = []
    for line in p.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    if not out and p.returncode != 0:
        raise RuntimeError("WorldBuilder.Terminal failed (rc=%d): %s"
                           % (p.returncode, (p.stderr or "")[-2000:]))
    return out


def do_fix(portal_path, rep, wbt_dll, dry_run=False):
    ambiguous = [v for v in rep["violations"] if v["ambiguous"]]
    if ambiguous:
        raise SystemExit(
            "REFUSING to fix: %d chain(s) name more than one baked RenderSurface, "
            "so the keeper is ambiguous — resolve by hand:\n%s"
            % (len(ambiguous), json.dumps(ambiguous, indent=1)))
    collapses = []
    for v in rep["violations"]:
        for st in v["surface_textures"]:
            collapses.append(dict(idHex=st, keepDid=v["keep"]))
    if not collapses:
        return dict(requested=0, note="nothing to collapse")
    outs = wbt_run(wbt_dll, [dict(command="surface-texture-collapse",
                                  datPath=os.path.abspath(portal_path),
                                  collapses=collapses, dryRun=bool(dry_run))])
    res = next((o for o in outs if o.get("command") == "surface-texture-collapse"), None)
    if res is None:
        raise RuntimeError("surface-texture-collapse returned nothing: %s" % outs[:2])
    return res


# ───────────────────────────────────────────────────────── cli

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("portal", help="portal dat to check / fix (a COPY, never a base dat)")
    ap.add_argument("--check", action="store_true",
                    help="read-only invariant (default); exit 1 on violation")
    ap.add_argument("--fix", action="store_true",
                    help="collapse every violating chain via WBT surface-texture-collapse")
    ap.add_argument("--dry-run", action="store_true", help="with --fix: plan, write nothing")
    ap.add_argument("--retail", default=None,
                    help="retail portal for the baked byte-compare (default %s)" % DEFAULT_RETAIL)
    ap.add_argument("--baked-ids", default=None,
                    help="precomputed baked 0x06 id list (hex per line) instead of comparing")
    ap.add_argument("--full-baked", action="store_true",
                    help="derive the baked set over ALL 0x06 (audit parity; slower)")
    ap.add_argument("--dump-baked", default=None, help="write the derived baked ids here")
    ap.add_argument("--wbt", default=DEFAULT_WBT, help="WorldBuilder.Terminal.dll")
    ap.add_argument("--json", default=None, help="write the report JSON here")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()

    rep = analyse(a.portal, a.retail, a.baked_ids, a.full_baked, a.verbose)

    if a.dump_baked and not a.baked_ids:
        # re-derive is wasteful; analyse() already has it, so recompute cheaply
        # only when asked (kept explicit rather than smuggled through the report)
        d = DatIndex(a.portal)
        r = DatIndex(a.retail or DEFAULT_RETAIL)
        scope = set(d.ids_of_type(0x06)) if a.full_baked else None
        if scope is None:
            scope = set()
            for i in d.by_offset(d.ids_of_type(0x05)):
                ch = parse_surface_texture(d.record(i), i)["chain"]
                if len(ch) > 1:
                    scope |= set(ch)
            scope &= set(d.ids_of_type(0x06))
        with open(a.dump_baked, "w") as fh:
            for i in sorted(derive_baked(d, r, scope)):
                fh.write("0x%08X\n" % i)
        d.close()
        r.close()
        print("baked ids -> %s" % a.dump_baked)

    name = os.path.basename(a.portal)
    print("%s: %d SurfaceTextures, %d distinct chains (%d multi-entry), "
          "baked set %d [%s]" % (name, rep["surface_textures"], rep["distinct_chains"],
                                 rep["multi_entry_chains"], rep["baked_count"],
                                 rep["baked_scope"]))
    print("  chain-length histogram: %s" % rep["chain_len_histogram"])
    if rep["parse_errors"]:
        print("  SurfaceTexture PARSE ERRORS: %d" % len(rep["parse_errors"]))
        for e in rep["parse_errors"][:10]:
            print("    " + json.dumps(e))
    print("  degrade-chain violations (baked entry under a multi-entry chain): %d"
          % len(rep["violations"]))
    for v in rep["violations"]:
        print("    chain %s  sts %s  keep %s%s"
              % (v["chain"], v["surface_textures"], v["keep"],
                 "  AMBIGUOUS" if v["ambiguous"] else ""))

    if a.json:
        json.dump(rep, open(a.json, "w"), indent=1)
        print("  report -> %s" % a.json)

    if a.fix:
        res = do_fix(a.portal, rep, a.wbt, a.dry_run)
        print("  surface-texture-collapse: requested=%s collapsed=%s unchanged=%s fail=%s"
              % (res.get("requestedCount") or res.get("requested"),
                 res.get("collapsedCount"), res.get("unchangedCount"), res.get("failCount")))
        for r in (res.get("records") or []):
            if r.get("status") not in ("COLLAPSED", "ALREADY-SINGLE", "DRY-RUN"):
                print("    FAIL " + json.dumps(r))
        if res.get("failCount"):
            sys.exit(1)
        if not a.dry_run:
            after = analyse(a.portal, a.retail, a.baked_ids, a.full_baked)
            print("  re-check after fix: %d violation(s)" % len(after["violations"]))
            sys.exit(1 if after["violations"] else 0)
        sys.exit(0)

    # default / --check
    sys.exit(1 if (rep["violations"] or rep["parse_errors"]) else 0)


if __name__ == "__main__":
    main()
