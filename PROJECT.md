# Project: Articulated Semi-Trailer System

## Architecture
- Backend (`WorldBuilder.Shared`): Defines base and specialized trailer classes (`SemiTrailerBase`, `Chassis20ft`, `Chassis40ft`) in `WorldBuilder.Shared/Lib/Vehicle/` for ISO container transport, including `TwistlockState`.
- Frontend (`holtburger-web`): Integrates specialized trailer models, entity management updates for polymorphism in `entities.js`, and HUD adaptation in `hud_adapter.js` for twistlock state tracking.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Backend Refactoring | Move classes to Vehicle/, fix IsoContainerDeployable | M0 | Plan |
| 2 | Backend Polish | Finalize TwistlockState/VehicleWire v6 | M1 | Plan |
| 3 | Frontend Dir | trailer_models directory | M2 | Plan |
| 4 | HUD Adapter | hud_adapter.js implementation | M2 | Plan |
| 5 | Entity Integration | entities.js polymorphism/anchor support | M2 | Plan |
| 6 | Automated Tests | VehicleWire/TwistlockState validation | M3 | Plan |
| 7 | Manual Verification | PBR shaders, TwistlockState transitions | M3 | Plan |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 0 | Backend Refactoring | Correct file paths, modify IsoContainerDeployable | none | IN_PROGRESS |
| 1 | Backend Polish | Finalize logic and protocol | M0 | PLANNED |
| 2 | Frontend Implementation | Scaffolding, HUD, Entity Integration | M1 | PLANNED |
| 3 | Verification & Testing | Automated + Manual testing | M2 | PLANNED |

## Interface Contracts
### Backend ↔ Frontend
- `TwistlockState`: Observable property in `SemiTrailerBase` for broadcast to `holtburger-web` HUD.

