Put JS scripts in here.

## esbuild (T11 ST-SHELL)

`scripts/build-shell.mjs` bundles the holtburger-web app shell (SPEC.md §3 T11 /
pass-12 D-12.2) with the **standalone esbuild binary — no npm, no
package.json**. The binary is NOT committed; the build looks it up via

    $ESBUILD_BIN            (env override)
    /mnt/wbterminal2/reeng/T11/bin/esbuild   (documented default)

To (re)install on linux-x64, download the official tarball straight from the
npm registry (this is a plain HTTPS fetch — npm the tool is not involved):

    curl -fsSL https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.28.2.tgz | tar -xz
    install -m 0755 package/bin/esbuild /mnt/wbterminal2/reeng/T11/bin/esbuild

T11 was built and verified against **esbuild 0.28.2**, binary sha256
`e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4beb0b1884100`
(tarball shasum `268b36211c146ca54f8fe12c578a8d6ef8979485`, the registry's
published value). Other versions will build but change the hashed output —
pin 0.28.2 when reproducing byte-identical shells.

Related: `scripts/deploy-shell.mjs` (stages `shell/` into a dist tree with
pack-style CAS discipline), `apps/holtburger-web/harness/test_build_shell.mjs`
(determinism + entry coverage + request arithmetic).
