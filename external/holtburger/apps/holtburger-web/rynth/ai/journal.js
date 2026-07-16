// journal.js — bounded rolling journal of director decisions/outcomes/notes;
// localStorage-persisted in a page, pure-memory under node; never throws on
// quota or corrupt storage. INTERFACE FROZEN — see rynth/ai/SPEC.md §journal.
// STUB: implementation owned by fan-out agent A5.

export class AiJournal {
  constructor({ storageKey = "holtburger_ai_journal_v1", maxEntries = 200 } = {}) {
    throw new Error("not implemented (A5)");
  }
  add(kind, text) { throw new Error("not implemented (A5)"); }
  tail(n = 10) { throw new Error("not implemented (A5)"); }
  renderTail(n = 10, maxChars = 2000) { throw new Error("not implemented (A5)"); }
  export() { throw new Error("not implemented (A5)"); }
  import(json) { throw new Error("not implemented (A5)"); }
  clear() { throw new Error("not implemented (A5)"); }
}
