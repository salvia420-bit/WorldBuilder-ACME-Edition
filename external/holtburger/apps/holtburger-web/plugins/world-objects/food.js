/** Food — extends Item.
 *
 * AC retail behavior: clicking food consumes one stack-unit and applies
 * its restoration (health/stamina/mana). Server decrements stack +
 * applies vital.
 */
import { Item } from './item.js';

export class Food extends Item {
  /** Eat one unit of this food item. */
  eat() {
    return this.examine();
  }

  /** Drink one unit (potions/beverages — wire-equivalent to eat). */
  drink() {
    return this.eat();
  }
}
