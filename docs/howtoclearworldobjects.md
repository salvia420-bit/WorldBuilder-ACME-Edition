# How To Clear World Objects

A quick reference for wiping all placed objects from your world so you can start fresh.

## The Two Layers

Asheron's Call stores world objects in **two separate places**:

| Layer | What's In It | Where It Lives |
|-------|-------------|----------------|
| **DAT (client_cell_1.dat)** | Buildings, trees, doors, decorations, signs — everything the **client renders** | LandBlockInfo layer (0xFFFE) per landblock |
| **ACE Database (MariaDB)** | NPCs, vendors, monsters, functional portals — things the **server spawns** | `ace_world.landblock_instance` table |

To truly wipe the world clean, you need to clear **both**.

---

## Step 1: Load Your Project

```
wb> load "path\to\your.wbproj"
```

## Step 2: Clear DAT Objects (Buildings, Trees, Decorations)

This removes all static objects from the client DAT — buildings, houses, trees, doors, signs, everything visual.

```
wb> clear-objects --all
```

**What it clears:**
- ✅ Buildings (houses, taverns, shops)
- ✅ Trees, rocks, ground decorations
- ✅ Doors, signs, furniture
- ✅ Static portals (the visual swirl)

**What it does NOT touch:**
- ❌ Terrain (heightmaps, textures) — stays intact
- ❌ EnvCells (dungeon/building interiors) — separate layer, stays intact
- ❌ The ACE database — see Step 3

You can also clear a single landblock instead of the whole world:
```
wb> clear-objects 63 63
```

## Step 3: Clear ACE Database Instances (NPCs, Portals, Vendors)

This removes all server-side spawns. **Requires `ace-db connect` first.**

### Connect to the database (if not already):
```
wb> ace-db connect localhost 3306 ace_world root (your-password)
```

### Then clear everything:
```
wb> ace-db clear-instances
```

It will ask for confirmation before deleting. This removes:
- ✅ All NPCs and vendors
- ✅ All functional portals (the teleport logic)
- ✅ All monsters / spawn points
- ✅ All inter-object links (`landblock_instance_link`)

## Step 4: Export the Clean DATs

After clearing, export so the clean DATs are saved to disk:

```
wb> export "D:\your\output\folder"
```

---

## Quick Copy-Paste: Full Wipe

```
load "path\to\your.wbproj"
clear-objects --all
ace-db connect localhost 3306 ace_world root yourpassword
ace-db clear-instances
export "D:\output"
```

## After the Wipe

Your world now has:
- **Terrain** — still there (heightmaps + terrain types)
- **Dungeons** — still there (EnvCells are a separate layer)
- **Everything else** — gone, ready to repopulate

To repopulate, you can use:
- `add-object` / `bulk-place-objects` — for DAT-side objects
- `apply-population` — for the automated population pipeline
- Direct SQL inserts to `landblock_instance` — for NPCs/portals

---

## FAQ

**Q: Will this break my dungeons?**
A: No. Dungeon interiors (EnvCells) live in a completely separate layer (0x0100–0xFFFD). They are never touched by `clear-objects`.

**Q: Do I need to restart the ACE server after this?**
A: Yes — the server caches landblock instances in memory. Restart it to pick up the changes.

**Q: Can I undo this?**
A: Not easily. Make a backup of your DATs and database before wiping. You can use `clone-dat` to back up your DATs first.

**Q: What about the `--reposition` flag on export?**
A: That's for adjusting existing objects to match changed terrain. After a full wipe there's nothing to reposition, so just use plain `export`.
