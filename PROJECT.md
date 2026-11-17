# Project: Manual Hydraulic Pallet Jack & Physical ISO Container Pallet Logistics

## Architecture
- HBV1 v6 protocol extension
- 30 Hz deterministic kinematics in Server (C#) and Client (JS/WASM)
- 2D SAT OBB collision for pallet placement and jack movement

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Pallet Jack Vehicle | Interactive manual jack | M1 | Implementation Plan |
| 2 | ISO Container Logistics | OBB bay, door/sill checks | M2 | Implementation Plan |
| 3 | Pallet Physics | Broken states, pump/lower mechanics | M3 | Implementation Plan |
| 4 | Protocol Update | Add `Vehicle_PalletAction` (0x090F) | M3 | Implementation Plan |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Pallet Jack Basic | Vehicle mechanics | none | DONE |
| 2 | Container Physics | Container bay collision | M1 | BLOCKED |
| 3 | Pallet & Protocol | Add Pallet/Protocol | M2 | DONE |

## Interface Contracts
### HBV1 v6 ↔ ACE.Server
- VehicleLocomotion.PalletJack = 3
- Opcode 0x090F: Vehicle_PalletAction (C2S), Vehicle_PalletEvent (S2C)
