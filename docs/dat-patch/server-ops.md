# ACME dat patch — server operator notes (roadmap §5.3)

> **REVISED 2026-08-21 for the r8+ HIFI split.** From r8 on a release is a
> **TRIO**: `client_portal.dat` + `client_cell_1.dat` + `client_highres.dat`,
> plus the client patcher (see community-norms.md). The upgraded world
> textures live in `client_highres.dat` (force-mounted by the patched client
> exe); a client on the ACME portal WITHOUT the matching highres + patched
> exe dangles texture lookups. **Ship and serve the trio together, always**
> (reports/phase4-P4-eyetest-2026-08-21.md).

Applies to every ACME release; **mandatory reading from r5 on**,
because r5 is the first tier where `client_cell_1.dat` differs from retail
(the environment-variant lane rewrites `EnvCell.EnvironmentId` for ~300k
dungeon cells and mints ~4k variant Environment records in the portal dat).

## The two supported configurations

### A. Server adopts the dats (recommended)
Point ACE at a directory holding the release TRIO:

```
Config.js:  "DatFilesDirectory": "/path/to/acme-dats-rN/"
```

- Portal, cell AND highres must come from the SAME release — the variant lane
  writes portal+cell as a matched pair (mixing tiers dangles ~300k
  environment references), and the HIFI split makes portal+highres a matched
  pair too. ACE opens `client_highres.dat` when present (optional load,
  ACE.DatLoader/DatManager.cs:64) — keep it identical to the clients' copy.
- Physics stays exact: variant Environments are verbatim clones of retail
  records (identical physics polys, portals, BSPs), so the server's collision
  view is byte-equivalent to retail whether or not it adopts. Adopting is
  still recommended so DDD iterations match patched clients.
- ACE loads cell/portal fully at boot — budget ~2 GB extra RSS for the pair
  (the ~1.3 GB highres is opened but its texture records are never read
  server-side).
- ⚠ **Never serve a portal with zlib-compressed records of types the server
  reads** (GfxObj/Setup/Environment/MotionTable/Animation…). Vanilla ACE has
  no record decompression and dies silently seconds after "World is now open"
  (found 2026-08-21; reports/r10-acefix-and-eyetest-2026-08-21.md). ACME
  releases from r10 on are built compression-clean for server-read types;
  only 0x05/0x06 texture records may be compressed. If you rebuild or insert
  records yourself, keep that rule.
- ⚠ Aliveness check after (re)start: `ss -ulpn | grep ':900'` (or your ports)
  AND the process surviving ~2 min past the "World is now open" log line —
  the log line alone is NOT proof the server is up.

### B. Server stays retail, DDD default
Clients with patched dats connect to a retail-dat server only if the DAT
ITERATIONS match (ACME releases keep the retail iteration pair for exactly
this reason; DDD compares iterations, not bytes). Patched clients then see
patched visuals; unpatched clients see retail. Because variant physics is
verbatim, both populations share one movement truth — no server-visible
desync. The only cost: unpatched clients in a patched player's group see
nothing different (cosmetics only).

**Do not** run a server on an OLDER tier than its clients with DDD on —
"newer DATs than server" boots the client.

## Release/restore mechanics (this box)
- Live laptop ACE: `Config.js` `DatFilesDirectory` currently selects the
  served tier; restore chain = `Config.js.pre-*-bak` files alongside it.
- Swap = edit Config.js + restart ACE (see memory/ace-live.md for the
  console-FIFO restart); clients must relog.
- Before/after showcase arms: serve matching dats per arm, or run the client
  with `-rodat` and a spare dat directory client-side.
