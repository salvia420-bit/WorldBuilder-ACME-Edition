/**
 * Stub for Character — extends Container.
 *
 * Mirrors Chorizite/ACPlugin/API/WorldObjects/Character.cs.
 *
 * Behaviors to add in follow-on PRs (per ACPlugin source):
 *   - Type-specific accessors (e.g. Vendor.openContainer, Door.isOpen)
 *   - Event handlers from the §3.4 event taxonomy
 *
 * Today this is the empty extension — typed dispatch + identity only.
 */

import { Container } from './container.js';

export class Character extends Container {}
