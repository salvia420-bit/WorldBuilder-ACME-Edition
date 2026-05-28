
import { pathToFileURL } from "node:url";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB = pathToFileURL(resolvePath(__dirname, "_three_stub_palette.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "three") {
    return { url: STUB, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
