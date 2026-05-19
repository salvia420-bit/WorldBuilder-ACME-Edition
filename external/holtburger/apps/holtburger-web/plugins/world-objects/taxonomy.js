/**
 * Loads + exposes the WorldObject class taxonomy emitted by
 * WorldBuilder.Terminal's chorizite-dump-world-object-taxonomy command.
 *
 * Data shape (per ../../data/chorizite/world-object-taxonomy.json):
 *   { classes: [ { name, baseClass, relativePath, itemTypeTags, objectClassTags }, ... ] }
 *
 * Source of truth: external/chorizite/ACPlugin/API/WorldObjects/*.cs
 */

export class WorldObjectTaxonomy {
  #classes = new Map();      // name → record
  #childrenByBase = new Map(); // baseName → Set<name>

  /**
   * Load the taxonomy JSON. Call once at app init.
   * @param {string} url path to world-object-taxonomy.json
   */
  async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`taxonomy load failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!Array.isArray(data.classes)) {
      throw new Error(`taxonomy malformed: expected .classes[] (got: ${JSON.stringify(Object.keys(data))})`);
    }
    for (const cls of data.classes) {
      this.#classes.set(cls.name, cls);
      if (cls.baseClass) {
        if (!this.#childrenByBase.has(cls.baseClass)) {
          this.#childrenByBase.set(cls.baseClass, new Set());
        }
        this.#childrenByBase.get(cls.baseClass).add(cls.name);
      }
    }
  }

  /** Get the raw record for a class name. */
  get(name) {
    return this.#classes.get(name) ?? null;
  }

  /** Return the chain from a class up to WorldObject, e.g. ['Vendor','NPC','Creature','Container','Item','WorldObject']. */
  inheritanceChain(name) {
    const chain = [];
    let cursor = name;
    while (cursor) {
      const rec = this.#classes.get(cursor);
      if (!rec) break;
      chain.push(cursor);
      cursor = rec.baseClass;
    }
    return chain;
  }

  /** Direct subclasses of a base class name. */
  directChildrenOf(baseName) {
    return Array.from(this.#childrenByBase.get(baseName) ?? []);
  }

  /** All transitive descendants of a base class name. */
  allDescendantsOf(baseName) {
    const out = new Set();
    const queue = [...(this.#childrenByBase.get(baseName) ?? [])];
    while (queue.length) {
      const next = queue.shift();
      if (out.has(next)) continue;
      out.add(next);
      const kids = this.#childrenByBase.get(next);
      if (kids) queue.push(...kids);
    }
    return Array.from(out);
  }

  /** All class names known to the taxonomy. */
  allNames() {
    return Array.from(this.#classes.keys());
  }

  /** ItemType tag set from WorldObject.cs (the GetObjectClass dispatch values). */
  itemTypeTags() {
    return this.#classes.get('WorldObject')?.itemTypeTags ?? [];
  }

  /** ObjectClass tag set from WorldObject.cs. */
  objectClassTags() {
    return this.#classes.get('WorldObject')?.objectClassTags ?? [];
  }
}
