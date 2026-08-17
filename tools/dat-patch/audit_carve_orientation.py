"""audit_carve_orientation.py — quantify UP-FACING carved shell area in the
shipped r5 environment variants (TASKLIST-2026-08-17 C1).

The relief pipeline has no orientation veto: a floor poly whose slot surface
classifies wall-class (Stone/Brick/Plank/Timber) carves OUTWARD = UP at
AMP_WALL=0.20 m over verbatim physics — the observed feet-sink. This measures
how much appended-shell area is up-facing, per variant and in aggregate, and
therefore both the visual exposure and the byte savings of an orientation gate.

Shell polys = the variant cellstruct's render polys beyond the retail source
env's poly count (env_geo appends; originals are never reordered).

Orientation caveat: normals are env-LOCAL. Dungeon EnvCells overwhelmingly
place with yaw-only orientation (rotation about +z), which preserves z-up; the
script verifies that claim over the variant's retargeted cells (retail cell
dat — placements are untouched by our lanes) and reports the exception rate.

usage: python3 audit_carve_orientation.py <patched_portal.dat> <retail_portal.dat>
           <retail_cell.dat> <variants.json> [--sample N] [--out report.json]
"""
import json
import math
import struct
import sys

sys.path.insert(0, "/home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch")
import datlib

UP_NZ = 0.7


def poly_area_normal(P, vids):
    """Area-weighted face normal over the fan; returns (area, unit normal)."""
    if len(vids) < 3:
        return 0.0, (0.0, 0.0, 0.0)
    ax, ay, az = P[vids[0]]
    nx = ny = nz = 0.0
    for k in range(1, len(vids) - 1):
        bx, by, bz = P[vids[k]]
        cx, cy, cz = P[vids[k + 1]]
        ux, uy, uz = bx - ax, by - ay, bz - az
        vx, vy, vz = cx - ax, cy - ay, cz - az
        nx += uy * vz - uz * vy
        ny += uz * vx - ux * vz
        nz += ux * vy - uy * vx
    l = math.sqrt(nx * nx + ny * ny + nz * nz)
    if l < 1e-12:
        return 0.0, (0.0, 0.0, 0.0)
    return 0.5 * l, (nx / l, ny / l, nz / l)


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    patched_p, retail_p, retail_cell_p, variants_p = argv[:4]
    sample = None
    outp = None
    for i, a in enumerate(sys.argv):
        if a == "--sample":
            sample = int(sys.argv[i + 1])
        if a == "--out":
            outp = sys.argv[i + 1]

    patched = datlib.Dat(patched_p)
    retail = datlib.Dat(retail_p)
    cellniv = datlib.Dat(retail_cell_p)

    variants = json.load(open(variants_p))["variants"]
    if sample:
        variants = variants[:sample]

    src_cache = {}
    rows = []
    tot = dict(up=0.0, down=0.0, side=0.0, polys=0, up_polys=0, envs=0,
               parse_fail=0, yaw_cells=0, nonyaw_cells=0)

    for v in variants:
        new_id = int(v["newEnvIdHex"], 16)
        src_id = int(v["sourceEnvIdHex"], 16)
        cs = v["cs"]
        raw = patched.get(new_id)
        if raw is None:
            tot["parse_fail"] += 1
            continue
        try:
            _, cells = datlib.parse_environment(raw)
        except Exception:
            tot["parse_fail"] += 1
            continue
        if src_id not in src_cache:
            sraw = retail.get(src_id)
            try:
                src_cache[src_id] = datlib.parse_environment(sraw)[1] if sraw else None
            except Exception:
                src_cache[src_id] = None
        scells = src_cache[src_id]
        if scells is None or cs not in cells or cs not in scells:
            tot["parse_fail"] += 1
            continue
        base_n = len(scells[cs]["polys"])
        c = cells[cs]
        up = down = side = 0.0
        up_polys = 0
        shell = c["polys"][base_n:]
        for p in shell:
            area, n = poly_area_normal(c["P"], p["v"])
            if n[2] > UP_NZ:
                up += area
                up_polys += 1
            elif n[2] < -UP_NZ:
                down += area
            else:
                side += area
        tot["up"] += up
        tot["down"] += down
        tot["side"] += side
        tot["polys"] += len(shell)
        tot["up_polys"] += up_polys
        tot["envs"] += 1
        shell_area = up + down + side
        rows.append(dict(env=v["newEnvIdHex"], src=v["sourceEnvIdHex"], cs=cs,
                         cells=v["cellCount"], shell_polys=len(shell),
                         up_m2=round(up, 2), down_m2=round(down, 2),
                         side_m2=round(side, 2),
                         up_frac=round(up / shell_area, 3) if shell_area else 0.0))

        # yaw-only check over this variant's first few retargeted cells
        for ch in v["cells"][:3]:
            craw = cellniv.get(int(ch, 16))
            if not craw:
                continue
            try:
                cell = datlib.parse_envcell(craw)
            except Exception:
                continue
            qw, qx, qy, qz = cell["orient"] if isinstance(cell, dict) else cell[-1]
            if abs(qx) < 1e-3 and abs(qy) < 1e-3:
                tot["yaw_cells"] += 1
            else:
                tot["nonyaw_cells"] += 1

    shell_area = tot["up"] + tot["down"] + tot["side"]
    print(f"variants audited: {tot['envs']}  (parse skips: {tot['parse_fail']})")
    print(f"shell polys: {tot['polys']:,}  up-facing polys: {tot['up_polys']:,} "
          f"({100.0 * tot['up_polys'] / max(tot['polys'], 1):.1f}%)")
    if shell_area:
        print(f"shell area m²: up {tot['up']:,.0f} ({100 * tot['up'] / shell_area:.1f}%)  "
              f"down {tot['down']:,.0f} ({100 * tot['down'] / shell_area:.1f}%)  "
              f"side {tot['side']:,.0f} ({100 * tot['side'] / shell_area:.1f}%)")
    ny = tot["yaw_cells"] + tot["nonyaw_cells"]
    if ny:
        print(f"placement yaw-only: {tot['yaw_cells']}/{ny} "
              f"({100.0 * tot['yaw_cells'] / ny:.1f}%) — env-local z ≈ world z")
    rows.sort(key=lambda r: -r["up_m2"])
    print("\nworst 15 by up-facing area (these are the floors you sink into):")
    for r in rows[:15]:
        print(f"  {r['env']} cs{r['cs']} src {r['src']}  cells {r['cells']:>6}  "
              f"up {r['up_m2']:>9.1f} m² ({r['up_frac'] * 100:.0f}% of shell)  "
              f"polys {r['shell_polys']}")
    if outp:
        json.dump(dict(total=tot, rows=rows), open(outp, "w"), indent=1)
        print(f"\nfull table -> {outp}")


if __name__ == "__main__":
    main()
