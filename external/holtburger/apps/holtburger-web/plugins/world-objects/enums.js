/**
 * Loads + exposes the Chorizite.Common enum tables emitted by
 * WorldBuilder.Terminal's chorizite-dump-enum-values command.
 *
 * Data shape (per ../../data/chorizite/chorizite-common-enums.json):
 *   { enums: { EnumName: { name, underlyingType, isFlags, members: [{name, valueHex, valueDecimal}, ...] } } }
 *
 * Source of truth: external/chorizite/Chorizite.Common/Enums/*.cs (vendored)
 */

export class ChoriziteEnums {
  #enums = new Map();              // enumName → record
  #nameByValue = new Map();        // enumName → Map<int, name>
  #valueByName = new Map();        // enumName → Map<name, int>

  async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`enums load failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!data.enums || typeof data.enums !== 'object') {
      throw new Error(`enums malformed: expected .enums object`);
    }
    for (const [name, rec] of Object.entries(data.enums)) {
      this.#enums.set(name, rec);
      const n2v = new Map();
      const v2n = new Map();
      for (const m of rec.members) {
        n2v.set(m.name, m.valueDecimal);
        // For non-flags enums, value → name is unambiguous.
        // For flags, the value may collide (e.g. AllTrue = 0xFFFF). Keep first.
        if (!v2n.has(m.valueDecimal)) v2n.set(m.valueDecimal, m.name);
      }
      this.#valueByName.set(name, n2v);
      this.#nameByValue.set(name, v2n);
    }
  }

  /** Look up the symbol name for an enum value. */
  nameOf(enumName, value) {
    return this.#nameByValue.get(enumName)?.get(value) ?? null;
  }

  /** Look up the value for an enum symbol name. */
  valueOf(enumName, memberName) {
    return this.#valueByName.get(enumName)?.get(memberName) ?? null;
  }

  /** Raw enum record (for iteration / introspection). */
  describe(enumName) {
    return this.#enums.get(enumName) ?? null;
  }

  knownEnumNames() {
    return Array.from(this.#enums.keys());
  }

  /** Decode a flags-enum bitmask into the contributing member names. */
  flagsOf(enumName, value) {
    const rec = this.#enums.get(enumName);
    if (!rec || !rec.isFlags) return null;
    const out = [];
    for (const m of rec.members) {
      if (m.valueDecimal === 0) continue;
      if ((value & m.valueDecimal) === m.valueDecimal) out.push(m.name);
    }
    return out;
  }
}
