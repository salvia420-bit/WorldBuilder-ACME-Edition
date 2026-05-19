/**
 * Stub for Item — extends WorldObject.
 *
 * Mirrors Chorizite/ACPlugin/API/WorldObjects/Item.cs.
 *
 * Behaviors to add in follow-on PRs (per ACPlugin source):
 *   - Type-specific accessors (e.g. Vendor.openContainer, Door.isOpen)
 *   - Event handlers from the §3.4 event taxonomy
 *
 * Today this is the empty extension — typed dispatch + identity only.
 */

import { WorldObject } from './world_object.js';

export class Item extends WorldObject {}
