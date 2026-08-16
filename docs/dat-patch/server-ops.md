# ACME dat patch — server operator notes (roadmap §5.3)

Applies to every `acme-dats-*.tgz` release; **mandatory reading from r5 on**,
because r5 is the first tier where `client_cell_1.dat` differs from retail
(the environment-variant lane rewrites `EnvCell.EnvironmentId` for ~300k
dungeon cells and mints ~4k variant Environment records in the portal dat).

## The two supported configurations

### A. Server adopts the dats (recommended)
Point ACE at a directory holding the release pair:

```
Config.js:  "DatFilesDirectory": "/path/to/acme-dats-rN/"
```

- Portal AND cell dat must come from the SAME release tgz — the variant lane
  writes both sides as a matched pair (variant records live in the portal;
  the cells that reference them live in the cell dat). Mixing tiers dangles
  ~300k environment references.
- Physics stays exact: variant Environments are verbatim clones of retail
  records (identical physics polys, portals, BSPs), so the server's collision
  view is byte-equivalent to retail whether or not it adopts. Adopting is
  still recommended so DDD iterations match patched clients.
- ACE loads cell/portal fully at boot — budget ~2 GB extra RSS for the pair.

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
