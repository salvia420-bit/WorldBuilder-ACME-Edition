/**
 * REMOVED from normal flow per docs/entity-completeness-method.md (rev 2,
 * 2026-05-19). The hand-coded ItemType-only heuristic that previously
 * lived here was a simplified subset of ACPlugin's canonical
 * `GetObjectClass`; under the entity-completeness contract, the
 * authoritative classifier is `canonical_classify.js` — a 1:1 port of
 * ACPlugin/API/WorldObject.cs:344-411 — which takes ALL THREE wire
 * inputs (itemType, objDescFlags, weenieFlags) and produces the same
 * ObjectClass output every other AC client implementation produces.
 *
 * This file is kept only for migration grep-discoverability; new code
 * MUST import from `./canonical_classify.js` directly. Anything calling
 * `resolveClassName` is using the deleted heuristic and will produce
 * drift from retail/ACPlugin classification — flag it as a bug.
 *
 * To verify no remaining callsites:
 *   grep -rn "resolveClassName\|from.*get_object_class" \
 *     apps/holtburger-web/plugins/ apps/holtburger-web/scene3d/
 *
 * If you find one, port it to `canonicalClassify(itemType, objDescFlags,
 * weenieFlags)`. The latter requires both new wire fields surfaced in
 * Entity-Completeness E.B (commit landing 2026-05-19).
 */

throw new Error(
  "get_object_class.js was REMOVED per entity-completeness-method.md §3. " +
  "Use canonical_classify.js instead (see file header)."
);
