# perf settle baseline — 62-POI battery (2026-07-20, current defaults)

> GENERATED — battery-telepoi.mjs --mode local, dwellMax 25, single session (account tailnet1).
> Authoritative AXIS = teleport settle time (cold-load decode/residency), per the re-aim doc.

- landed **58/62**, settle median **21323ms**, **26/58 capped at 25s** (never settled), boots {'inWorld': 1, 'stall': 0, 'error': 0}
- wasm main max **587MB** / worker 281MB · workMed 119 reclaimMed 152
- did NOT land (4): Hotel Swank, HotelSwank, NightClub, TownNetwork
- settle by session-age: [{'sessionIdx': 0, 'n': 58, 'settleMedMs': 21323, 'reclaimMedMs': 152}]

**CONFOUND (per docs 1121/1123):** single-session — residency accumulates (lru→203, wasm→587MB), so LATER stops starve. settle-cap != clean per-POI cost; it's the residency-accumulation signal. For clean per-POI A/B use fixed-length sessions + session-age-matched medians.

## Worst settle (top 15)

| POI | settle ms | land ms | cells | lru | work+ |
|:--|--:|--:|--:|--:|--:|
| Shoushi | 25074 | 280 | 354 | 203 | 166 |
| Al-Jalima | 25000 | 126 | 279 | 148 | 117 |
| Arwic | 25000 | 193 | 279 | 203 | 206 |
| Eastham | 25000 | 115 | 126 | 203 | 113 |
| Greenspire | 25000 | 209 | 24 | 203 | 87 |
| Hebian-to | 25000 | 113 | 33 | 203 | 108 |
| Holtburg | 25000 | 166 | 132 | 203 | 165 |
| Linvak Tukal | 25000 | 327 | 184 | 203 | 145 |
| Neydisa | 25000 | 704 | 72 | 203 | 141 |
| Outpost | 25000 | 287 | 904 | 130 | 93 |
| Plateau | 25000 | 194 | 0 | 203 | 132 |
| Redspire | 25000 | 151 | 177 | 203 | 108 |
| Refuge | 25000 | 133 | 84 | 203 | 108 |
| Rithwic | 25000 | 154 | 90 | 203 | 142 |
| Sanamar | 25000 | 405 | 134 | 203 | 130 |
