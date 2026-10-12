// rynth/vt/meta/meta_fns.js — the meta-state expression functions (PLAN
// §3.12; U5 §5.6 group P; UB/RynthAi names). Registered by INT-2 on the
// shared EXPR FunctionRegistry; the engine is read through a getter so the
// functions survive an engine rebind.
//
//   vtgetmetastate[] ragetmetastate[] getmetastate[]   → the current state
//   vtsetmetastate[s] rasetmetastate[s] setmetastate[s] → enterState(s, "expr");
//                                                         1 (0 for an empty name)
// A same-state set re-arms the state (the corpus idiom
// vtsetmetastate[vtgetmetastate[]], U5 §2.3). No imports (C2).

export const META_FUNCTION_NAMES = Object.freeze([
  "vtgetmetastate",
  "ragetmetastate",
  "getmetastate",
  "vtsetmetastate",
  "rasetmetastate",
  "setmetastate",
]);

function argText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "object") return v.t === "wobj" ? String(v.name ?? "") : "";
  return String(v);
}

export function registerMetaFunctions(registry, getEngine) {
  if (!registry || typeof registry.define !== "function") return;
  const engine = () => {
    try {
      return typeof getEngine === "function" ? getEngine() || null : null;
    } catch {
      return null;
    }
  };
  const getState = () => {
    const e = engine();
    return e ? String(e.state ?? "") : "";
  };
  const setState = (a) => {
    const e = engine();
    if (!e) return { t: "err", msg: "setmetastate: the meta engine is not available" };
    const s = argText(a[0]).trim();
    if (!s) return 0;
    return e.enterState(s, "expr") === false ? 0 : 1;
  };
  for (const n of ["vtgetmetastate", "ragetmetastate", "getmetastate"]) registry.define(n, () => getState(), { maxArgs: 1 });
  for (const n of ["vtsetmetastate", "rasetmetastate", "setmetastate"]) registry.define(n, (a) => setState(a), { minArgs: 1, maxArgs: 1 });
}
