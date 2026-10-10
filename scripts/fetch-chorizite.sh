#!/usr/bin/env bash
# Fetch the Chorizite repos WorldBuilder.Terminal builds against.
#
# external/ is gitignored (apart from external/holtburger), but
# WorldBuilder.Terminal.csproj has ProjectReferences into
# external/chorizite/Chorizite.Common and external/chorizite/Chorizite.ACProtocol,
# so a fresh clone cannot build the Terminal until these exist. This makes a
# shallow clone of each at the commit the tree is known to build with (see
# external/chorizite/VENDORED.md). A directory that already exists is left
# alone, so running this on a provisioned machine is a no-op.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fetch() {  # <dir name> <repo url> <commit>
    local dir="$root/external/chorizite/$1"
    if [ -e "$dir" ]; then
        echo "external/chorizite/$1 exists; leaving it alone"
        return
    fi
    git init --quiet "$dir"
    git -C "$dir" remote add origin "$2"
    git -C "$dir" fetch --quiet --depth 1 origin "$3"
    # A branch, not a detached HEAD: both projects run GitVersion at build time,
    # and it fails with "No base versions determined" on a detached HEAD.
    git -C "$dir" checkout --quiet -B master FETCH_HEAD
    echo "external/chorizite/$1 @ $3"
}

fetch Chorizite.Common     https://github.com/Chorizite/Chorizite.Common.git     e3b3bd203b50cf1f38677e340a3e430caa264051
fetch Chorizite.ACProtocol https://github.com/Chorizite/Chorizite.ACProtocol.git ff7dffd6afa53c4e2b2ba14bd89962258ebd4371
