/** Vendor — extends NPC.
 *
 * AC retail behavior: clicking a vendor opens the trade UI; ACE sends
 * an `OpenContainer` carrying the vendor's stock.
 */
import { NPC } from './npc.js';

export class Vendor extends NPC {
  /**
   * Open the vendor's trade window. Server responds with a
   * `kind=12 ContainerOpened` event (per CHORIZITE_PORTING_PLAN.md
   * §3.4) carrying the vendor's stock.
   */
  openTrade() {
    return this.examine();
  }
}
