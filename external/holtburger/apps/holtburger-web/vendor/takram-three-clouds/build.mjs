#!/usr/bin/env node
// build.mjs — esbuild-driven bundler for vendor/takram-three-clouds.
//
// Why: the upstream package ships a Vite-built bundle that inlines its
// GLSL shaders via Vite's `?raw` import syntax. Our holtburger-web app
// has no Vite. To modify the source (Clouds-B onward), we need a way
// to rebuild after edits. This script is the smallest viable rebuilder:
//
//   - tsc-strip the TypeScript (esbuild handles this natively)
//   - inline `import x from './shaders/y.glsl?raw'` as a text string
//   - external all peer deps so the importmap continues to resolve them
//   - emit one ES module at build/index.js
//
// Run: node build.mjs        (writes build/index.js + build/index.js.map)
//      node build.mjs --watch (rebuild on src/ changes)

import { readFile } from 'node:fs/promises';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));

// esbuild is loaded via the npx cache (we don't install a package.json
// in vendor/ to avoid polluting it with node_modules). The cache path
// is fixed once npx -p esbuild has been run once. Override with
// CLAUDE_ESBUILD_PATH if your cache lives elsewhere.
const ESBUILD_PATH = process.env.CLAUDE_ESBUILD_PATH
  || '/home/wbterminal/.npm/_npx/beb367dfa21eb3f5/node_modules/esbuild';
const localRequire = createRequire(import.meta.url);
const esbuild = localRequire(ESBUILD_PATH);

// `?raw` import plugin. Catches `./shaders/foo.glsl?raw` (and .frag/.vert)
// — strips the suffix, loads the file as a UTF-8 string, and exposes it
// as the default export. Mirrors Vite's behaviour for our subset of
// usages.
const rawImportPlugin = {
  name: 'raw-import',
  setup(build) {
    build.onResolve({ filter: /\.(glsl|frag|vert)\?raw$/ }, (args) => ({
      path: pathResolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-text',
    }));
    build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => {
      const contents = await readFile(args.path, 'utf8');
      return {
        // Emit as an ES module that default-exports the file's text.
        contents: `export default ${JSON.stringify(contents)};`,
        loader: 'js',
      };
    });
  },
};

// tiny-invariant is the one non-trivial transitive dep that the takram
// source imports directly (`import invariant from 'tiny-invariant'`).
// We can't external it (its ESM has top-level `process.env.NODE_ENV`),
// and we don't want a node_modules dir in vendor/. Stub it inline.
const tinyInvariantPlugin = {
  name: 'tiny-invariant',
  setup(build) {
    build.onResolve({ filter: /^tiny-invariant$/ }, () => ({
      path: 'tiny-invariant',
      namespace: 'tiny-invariant-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'tiny-invariant-stub' }, () => ({
      // Production-mode tiny-invariant: throws a generic message, no
      // string concat to avoid leaking detail. Matches behaviour of the
      // upstream package when bundled with NODE_ENV=production.
      contents: `
        export default function invariant(condition, _message) {
          if (!condition) {
            throw new Error('Invariant failed');
          }
        }
      `,
      loader: 'js',
    }));
  },
};

const buildOpts = {
  entryPoints: [pathResolve(HERE, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  // 'esnext' — let modern Chrome consume native class fields, optional
  // chaining, etc. without esbuild down-leveling them. This matters
  // because some takram classes use `static accessor` patterns where
  // esbuild's polyfills (`__create`, `__defProp`) drift from native
  // semantics under our actual r184 + Chromium environment.
  target: 'esnext',
  outfile: pathResolve(HERE, 'build/index.js'),
  sourcemap: true,
  // These resolve through the page's importmap. Marking external keeps
  // them as bare specifiers in the output (`import 'three'` etc.) rather
  // than getting inlined.
  external: [
    'three',
    'three/addons/*',
    'postprocessing',
    '@takram/three-atmosphere',
    '@takram/three-atmosphere/shaders/bruneton',
    '@takram/three-geospatial',
    '@takram/three-geospatial/shaders',
    // tiny-invariant intentionally NOT external — its ESM has a
    // top-level `process.env.NODE_ENV` reference that breaks in the
    // browser. Inlining lets esbuild substitute the define below.
  ],
  define: {
    // tiny-invariant + any future deps gating on NODE_ENV need this
    // for browser execution. Match the CDN's takram bundle, which
    // was Vite-built with NODE_ENV='production'.
    'process.env.NODE_ENV': '"production"',
  },
  // takram uses legacy TypeScript decorators (see upstream
  // tsconfig.base.json: experimentalDecorators=true,
  // emitDecoratorMetadata=true). Mirror that here so esbuild
  // transpiles `@defineInt(...)` properties down to property
  // descriptors at build time.
  tsconfigRaw: {
    compilerOptions: {
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      // 'bundler' mirrors takram's tsconfig.base. esbuild treats this
      // as 'node-like with bundler relaxations'.
      moduleResolution: 'bundler',
      useDefineForClassFields: false,
    },
  },
  plugins: [rawImportPlugin, tinyInvariantPlugin],
  // Preserve TS class decorators / metadata is not needed here — the
  // takram code is plain TS without decorators. JSX/TSX is also absent
  // outside the r3f/ directory which we exclude via index.ts.
  logLevel: 'info',
};

const watch = process.argv.includes('--watch');
if (watch) {
  const ctx = await esbuild.context(buildOpts);
  await ctx.watch();
  console.log('build.mjs: watching src/ for changes…');
} else {
  const start = Date.now();
  const result = await esbuild.build(buildOpts);
  const dur = Date.now() - start;
  console.log(`build.mjs: build/index.js (${dur}ms, ${result.warnings.length} warnings)`);
  if (result.warnings.length) {
    for (const w of result.warnings) console.warn(JSON.stringify(w, null, 2));
  }
}
