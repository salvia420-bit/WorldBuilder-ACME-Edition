// rynth/vt/expr/index.js — barrel of the shared VTank/UB expression engine
// (W1-1 EXPR, PLAN §3.4). Monster expressions (CMB, mode "monster") and the
// meta engine (META, mode "meta") share this one language. No side effects.

export { parse } from "./parser.js";
export { ExprRuntime, FunctionRegistry } from "./evaluator.js";
export { VarStore } from "./vars.js";
export { V, truthy, toStr, toNum, equals, typeName, isErr } from "./values.js";
export { translateRegex, getRegex } from "./regex.js";
export { registerPureStdlib, PURE_FUNCTION_NAMES } from "./stdlib_pure.js";
