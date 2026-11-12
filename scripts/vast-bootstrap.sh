#!/usr/bin/env bash
# Runs on a fresh Vast.ai Ubuntu GPU/CPU instance to hydrate the full WorldBuilder /
# Holtburger high-RAM environment by streaming single .tar.zst archives directly from
# Google Drive (gdrive:wb-dev-pool) onto NVMe with zero temp archive copies + warm
# sccache snapshot + EGL Chromium + Antigravity CLI (agy).
#
# Flags:
#   --skip-dist    Skip streaming dist-hires.tar.zst when only running Rust/headless JS work
set -euo pipefail

SKIP_DIST=0
for arg in "$@"; do
  case "$arg" in
    --skip-dist) SKIP_DIST=1 ;;
  esac
done

POOL_REMOTE="${POOL_REMOTE:-gdrive:wb-dev-pool}"
if [[ -f /root/.pool.env ]]; then
  # shellcheck disable=SC1091
  source /root/.pool.env
fi

WORK_ROOT="/workspace/wb"
mkdir -p "${WORK_ROOT}/home" "${WORK_ROOT}/mnt1" "${WORK_ROOT}/hb-serve" \
         "${WORK_ROOT}/cargo-target" "${WORK_ROOT}/sccache" "${WORK_ROOT}/ms-playwright"
mkdir -p /home/wbterminal /mnt/wbterminal1

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git gh tmux jq zstd unzip xz-utils build-essential pkg-config libssl-dev \
  clang mold python3 python3-pip ripgrep fd-find iproute2 \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libegl1 libgles2 libgl1 libpango-1.0-0 libcairo2 libasound2t64 2>/dev/null \
|| apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git gh tmux jq zstd unzip xz-utils build-essential pkg-config libssl-dev \
  clang mold python3 python3-pip ripgrep fd-find iproute2 \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libegl1 libgles2 libgl1 libpango-1.0-0 libcairo2 libasound2

if ! command -v rclone >/dev/null 2>&1; then
  curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o /tmp/rc.zip
  python3 -c "import zipfile; z=zipfile.ZipFile('/tmp/rc.zip'); n=[x for x in z.namelist() if x.endswith('/rclone')][0]; open('/usr/local/bin/rclone','wb').write(z.read(n))"
  chmod +x /usr/local/bin/rclone && rm -f /tmp/rc.zip
fi

if ! command -v sccache >/dev/null 2>&1; then
  SCC_URL="https://github.com/mozilla/sccache/releases/download/v0.10.0/sccache-v0.10.0-x86_64-unknown-linux-musl.tar.gz"
  curl -fsSL "$SCC_URL" -o /tmp/sc.tgz
  python3 -c "import tarfile; t=tarfile.open('/tmp/sc.tgz'); m=[x for x in t.getmembers() if x.name.endswith('/sccache') or x.name=='sccache'][0]; open('/usr/local/bin/sccache','wb').write(t.extractfile(m).read())"
  chmod +x /usr/local/bin/sccache && rm -f /tmp/sc.tgz
fi

if [[ ! -x /usr/local/bin/gh ]]; then
  GH_URL="https://github.com/cli/cli/releases/download/v2.65.0/gh_2.65.0_linux_amd64.tar.gz"
  curl -fsSL "$GH_URL" -o /tmp/gh.tgz
  python3 -c "import tarfile; t=tarfile.open('/tmp/gh.tgz'); m=[x for x in t.getmembers() if x.name.endswith('/bin/gh')][0]; open('/usr/local/bin/gh','wb').write(t.extractfile(m).read())"
  chmod +x /usr/local/bin/gh && rm -f /tmp/gh.tgz
fi

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

if [[ ! -x /root/.cargo/bin/cargo ]]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
fi
export PATH="/root/.local/bin:/root/.cargo/bin:/usr/local/bin:${PATH}"
rustup target add wasm32-unknown-unknown
if ! command -v wasm-pack >/dev/null 2>&1; then
  curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
fi

# Install Google Antigravity CLI (agy) directly from official CDN (~2s on Vast gigabit)
if [[ ! -x /root/.local/bin/agy ]]; then
  echo "[agy] Installing Antigravity CLI..."
  curl -fsSL https://antigravity.google/cli/install.sh | bash
fi

stream_bundle() {
  local archive="$1"
  local dest="$2"
  local marker="${dest}/.${archive}.hydrated"
  if [[ -f "$marker" ]]; then
    echo "[stream] ${archive} already hydrated."
    return 0
  fi
  if ! rclone lsf "${POOL_REMOTE}/bundles/${archive}" | grep -q .; then
    echo "[stream] ${archive} not present in ${POOL_REMOTE}, skipping."
    return 0
  fi
  echo "[stream] Streaming ${archive} -> ${dest} (rclone cat | tar --zstd -xf -)..."
  rclone cat "${POOL_REMOTE}/bundles/${archive}" | tar --zstd -xf - -C "$dest"
  touch "$marker"
}

stream_bundle "ac-headers.tar.zst" "${WORK_ROOT}/home"
stream_bundle "ac-refs.tar.zst" "${WORK_ROOT}/mnt1"
stream_bundle "ace-dats.tar.zst" "${WORK_ROOT}/home"
stream_bundle "ace-server.tar.zst" "${WORK_ROOT}/home"
stream_bundle "sccache-warm.tar.zst" "${WORK_ROOT}"
stream_bundle "ms-playwright.tar.zst" "${WORK_ROOT}"
if [[ "$SKIP_DIST" -eq 0 ]]; then
  stream_bundle "dist-hires.tar.zst" "${WORK_ROOT}/hb-serve"
fi

# Mirror exact Dell paths via symlinks into /workspace/wb
for d in ac-headers ace-dats-ssd ac_base_dats ace-server; do
  [[ -e "${WORK_ROOT}/home/${d}" ]] && ln -sfn "${WORK_ROOT}/home/${d}" "/home/wbterminal/${d}"
done
ln -sfn "${WORK_ROOT}/hb-serve" "/home/wbterminal/hb-serve"
[[ -e "${WORK_ROOT}/mnt1/ac-refs" ]] && ln -sfn "${WORK_ROOT}/mnt1/ac-refs" "/mnt/wbterminal1/ac-refs"

git config --global user.name "salvia420-bit"
git config --global user.email "salvia420@gmail.com"
if [[ -f /root/.config/gh/hosts.yml ]] && command -v gh >/dev/null 2>&1; then
  gh auth setup-git || true
fi

if [[ ! -d "${WORK_ROOT}/home/WorldBuilder-ACME-Edition/.git" ]]; then
  git clone https://github.com/salvia420-bit/WorldBuilder-ACME-Edition.git "${WORK_ROOT}/home/WorldBuilder-ACME-Edition"
fi
ln -sfn "${WORK_ROOT}/home/WorldBuilder-ACME-Edition" "/home/wbterminal/WorldBuilder-ACME-Edition"
ln -sfn "/home/wbterminal/WorldBuilder-ACME-Edition/external" "/home/wbterminal/external"

# Vast-specific CLAUDE.md so Claude & Antigravity agents know this machine is unlocked
cat > /home/wbterminal/CLAUDE.md <<'EOF'
# Vast.ai High-RAM Cloud GPU Workstation — Agent Environment Notes

You are running on an ephemeral Vast.ai NVMe GPU workstation (18–24+ CPU cores, 62+ GiB RAM,
local NVIDIA RTX GPU via `/dev/nvidia0` + `/dev/dri/renderD128`) hydrated from `gdrive:wb-dev-pool`:
- Repo: `/home/wbterminal/WorldBuilder-ACME-Edition`
- AC references: `/mnt/wbterminal1/ac-refs` and `/home/wbterminal/ac-headers`
- DATs / server / dist: `/home/wbterminal/ac_base_dats`, `/home/wbterminal/ace-dats-ssd`, `/home/wbterminal/ace-server`, `/home/wbterminal/hb-serve`
- Caches: `CARGO_TARGET_DIR=/workspace/wb/cargo-target`, `SCCACHE_DIR=/workspace/wb/sccache` (`mold` + `sccache` active), `PLAYWRIGHT_BROWSERS_PATH=/workspace/wb/ms-playwright`

## Unlocked Compute & Local EGL GPU Rules (NOT the 8 GB Dell or 16 GB Windows 1070 laptop)
- `CARGO_BUILD_JOBS=$(nproc)`, `HB_TEST_JOBS=$(nproc)`, and `HB_TEST_HEAP_MB=3072` are pre-exported in `/etc/profile.d/wb-dev-pool.sh`.
- Parallel subagents (`/boost`, `/teamwork`), multi-core `cargo test`, `wasm-pack build`, and parallel headless JS gates (`node harness/run-js-headless.mjs`) may run at full native CPU/RAM speed.
- Real-GPU WebGL2 tests run locally on the host NVIDIA GPU via headless EGL Chromium (`--headless=new --use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --mute-audio --window-position=-32000,-32000`).
- IMPORTANT: This NVMe disk is ephemeral! Always commit & `git push` finished code changes to `origin` and run `save-sccache-to-pool` before tearing down the instance.
EOF
cp -f /home/wbterminal/CLAUDE.md /root/CLAUDE.md

# Helper to push warm sccache (+ optional Playwright Chromium bundle & bootstrap script) back to Google Drive
cat > /usr/local/bin/save-sccache-to-pool <<EOF
#!/usr/bin/env bash
set -euo pipefail
sccache --stop-server >/dev/null 2>&1 || true
echo "[pool] Uploading warm sccache snapshot to ${POOL_REMOTE}/bundles/sccache-warm.tar.zst..."
tar -C "${WORK_ROOT}" -cf - sccache | zstd -T0 -3 | rclone rcat "${POOL_REMOTE}/bundles/sccache-warm.tar.zst" --drive-chunk-size 128M
if [[ -d "${WORK_ROOT}/ms-playwright" ]] && [[ -n "\$(ls -A "${WORK_ROOT}/ms-playwright" 2>/dev/null)" ]] && ! rclone lsf "${POOL_REMOTE}/bundles/ms-playwright.tar.zst" | grep -q .; then
  echo "[pool] Uploading Playwright Chromium cache to ${POOL_REMOTE}/bundles/ms-playwright.tar.zst..."
  tar -C "${WORK_ROOT}" -cf - ms-playwright | zstd -T0 -3 | rclone rcat "${POOL_REMOTE}/bundles/ms-playwright.tar.zst" --drive-chunk-size 128M
fi
if [[ -f /root/vast-bootstrap.sh ]]; then
  rclone copyto /root/vast-bootstrap.sh "${POOL_REMOTE}/vast-bootstrap.sh"
fi
echo "[pool] Saved warm sccache + bootstrap state to ${POOL_REMOTE}."
EOF
chmod +x /usr/local/bin/save-sccache-to-pool

# Tmux launcher used by `agyyvast` from Termux / wbterminal
cat > /usr/local/bin/agyy-tmux <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
[[ -f /etc/profile.d/wb-dev-pool.sh ]] && source /etc/profile.d/wb-dev-pool.sh
export PATH="/root/.local/bin:/root/.cargo/bin:/usr/local/bin:${PATH}"
cd /home/wbterminal/WorldBuilder-ACME-Edition 2>/dev/null || cd /root
if [[ $# -eq 0 ]]; then
  exec tmux new-session -A -s agy "/root/.local/bin/agy --dangerously-skip-permissions"
else
  printf -v ESC_ARGS '%q ' "$@"
  exec tmux new-session -A -s agy "/root/.local/bin/agy --dangerously-skip-permissions ${ESC_ARGS}"
fi
EOF
chmod +x /usr/local/bin/agyy-tmux

# Mobile-friendly tmux config (mouse/touch scroll + 50k scrollback for Termux on Redmi)
cat > /root/.tmux.conf <<'EOF'
set -g mouse on
set -g history-limit 50000
set -g default-terminal "screen-256color"
set -sg escape-time 10
EOF

cat > /etc/profile.d/wb-dev-pool.sh <<EOF
export PATH="/root/.local/bin:/root/.cargo/bin:/usr/local/bin:\$PATH"
export RUSTC_WRAPPER=/usr/local/bin/sccache
export SCCACHE_DIR="${WORK_ROOT}/sccache"
export SCCACHE_CACHE_SIZE="25G"
export CARGO_TARGET_DIR="${WORK_ROOT}/cargo-target"
export CARGO_BUILD_JOBS="\$(nproc)"
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS="-C link-arg=-fuse-ld=mold"
unset RUSTFLAGS
export HB_TEST_JOBS="\$(nproc)"
export HB_TEST_HEAP_MB="3072"
export HB_MIN_FREE_MB="4096"
export HOLTBURGER_DIST="${WORK_ROOT}/hb-serve/dist/current"
export HOLTBURGER_PORTAL_DAT="${WORK_ROOT}/home/ac_base_dats/client_portal.dat"
export HOLTBURGER_CELL_DAT="${WORK_ROOT}/home/ac_base_dats/client_cell_1.dat"
export HOLTBURGER_HIGHRES_DAT="${WORK_ROOT}/home/ac_base_dats/client_highres.dat"
export PLAYWRIGHT_BROWSERS_PATH="${WORK_ROOT}/ms-playwright"
export POOL_REMOTE="${POOL_REMOTE}"
alias agyy='/root/.local/bin/agy --dangerously-skip-permissions'
alias agyt='/usr/local/bin/agyy-tmux'
EOF
chmod 0600 /etc/profile.d/wb-dev-pool.sh

if ! grep -q 'wb-dev-pool.sh' /root/.bashrc 2>/dev/null; then
  cat >> /root/.bashrc <<'EOF'

[[ -f /etc/profile.d/wb-dev-pool.sh ]] && source /etc/profile.d/wb-dev-pool.sh
EOF
fi

export PLAYWRIGHT_BROWSERS_PATH="${WORK_ROOT}/ms-playwright"
(cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && npm install --no-audit --no-fund)
if [[ -z "$(ls -A "${WORK_ROOT}/ms-playwright" 2>/dev/null)" ]]; then
  (cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && npx playwright install chromium) || true
fi

echo "=== Vast Tier B + Antigravity CLI Ready (Backed by Google Drive) ==="
df -h /workspace
sccache --show-stats || true
