/**
 * Stub for Vendor — extends NPC.
 *
 * Mirrors Chorizite/ACPlugin/API/WorldObjects/Vendor.cs.
 *
 * Behaviors to add in follow-on PRs (per ACPlugin source):
 *   - Type-specific accessors (e.g. Vendor.openContainer, Door.isOpen)
 *   - Event handlers from the §3.4 event taxonomy
 *
 * Today this is the empty extension — typed dispatch + identity only.
 */

import { NPC } from './npc.js';

export class Vendor extends NPC {}
