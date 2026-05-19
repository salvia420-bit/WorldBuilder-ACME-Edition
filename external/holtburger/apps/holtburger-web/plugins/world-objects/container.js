/** Container — extends Item.
 *
 * AC retail behavior: clicking a container (chest, pack, sack) opens it
 * server-side; ACE responds with `ContainerOpened` + a list of contents.
 */
import { Item } from './item.js';

const PROP_ITEMS_CAPACITY      = 81;
const PROP_CONTAINERS_CAPACITY = 82;

export class Container extends Item {
  /** Open this container. */
  open() {
    return this.examine();
  }

  /** Maximum inventory slot count, or 0 if not yet known. */
  get itemsCapacity() {
    return this.intValue(PROP_ITEMS_CAPACITY, 0);
  }

  /** Maximum nested-container slot count, or 0 if not yet known. */
  get containersCapacity() {
    return this.intValue(PROP_CONTAINERS_CAPACITY, 0);
  }
}
