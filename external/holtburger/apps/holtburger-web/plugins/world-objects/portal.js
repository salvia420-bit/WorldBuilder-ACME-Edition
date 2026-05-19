/** Portal — extends Static.
 *
 * AC retail behavior: clicking a portal teleports the player to the
 * portal's destination.
 */
import { Static } from './static.js';

export class Portal extends Static {
  /** Enter the portal — server teleports the player to the destination. */
  enter() {
    return this.examine();
  }

  /**
   * Portal destination text (e.g. "Holtburg (87, -3, 0)"). Sourced from
   * `PropertyString.AppraisalPortalDestination` (= 38 in retail). Empty
   * string when the appraisal hasn't completed yet.
   */
  get destination() {
    return this.stringValue(38, '');
  }
}
