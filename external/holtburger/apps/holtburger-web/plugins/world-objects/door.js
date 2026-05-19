/** Door — extends Static.
 *
 * AC retail behavior: clicking a door toggles open/closed (if unlocked).
 * Server is authoritative — it broadcasts the new state via property
 * updates, and the renderer's hinge-frame system (per memory
 * `project_holtburger_entity_collision_done_2026-05-16.md`) animates
 * the rotation.
 */
import { Static } from './static.js';

// PhysicsState.OPEN bit per acclient.h. Surfaced on doors via the
// PhysicsDescription update channel; read via PropertyInt.PhysicsState.
const PHYSICS_STATE_PROP = 100;
const PHYSICS_STATE_OPEN = 0x00000020;

export class Door extends Static {
  /** Toggle the door's open/closed state. Server-authoritative. */
  use() {
    return this.examine();
  }

  /**
   * Whether the door currently reports as open. Reads
   * PropertyInt.PhysicsState for the OPEN bit. Returns `null` when the
   * property hasn't been observed yet.
   */
  get isOpen() {
    if (!this.intValues.has(PHYSICS_STATE_PROP)) return null;
    return (this.intValues.get(PHYSICS_STATE_PROP) & PHYSICS_STATE_OPEN) !== 0;
  }
}
