/**
 * Stub for Container — extends Item.
 *
 * Mirrors Chorizite/ACPlugin/API/WorldObjects/Container.cs.
 *
 * Behaviors to add in follow-on PRs (per ACPlugin source):
 *   - Type-specific accessors (e.g. Vendor.openContainer, Door.isOpen)
 *   - Event handlers from the §3.4 event taxonomy
 *
 * Today this is the empty extension — typed dispatch + identity only.
 */

import { Item } from './item.js';

export class Container extends Item {}
