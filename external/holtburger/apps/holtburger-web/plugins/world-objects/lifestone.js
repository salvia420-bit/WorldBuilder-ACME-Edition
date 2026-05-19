/** Lifestone — extends Static.
 *
 * AC retail behavior: clicking a lifestone binds the player's respawn
 * point to that lifestone. Server handles the bind + announces via chat.
 */
import { Static } from './static.js';

export class Lifestone extends Static {
  /** Bind the player's respawn point to this lifestone. */
  tie() {
    return this.examine();
  }
}
