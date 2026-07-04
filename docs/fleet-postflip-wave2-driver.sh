#!/bin/bash
# WAVE-2 research fan-out driver — run ON the buildbox.
#
#   gcloud compute instances start buildbox --zone us-central1-a
#   gcloud compute ssh buildbox --zone us-central1-a
#   touch ~/.keep-awake
#   cd ~/WorldBuilder-ACME-Edition && git fetch origin && git reset --hard origin/master
#   chmod +x docs/fleet-postflip-wave2-driver.sh
#   setsid nohup docs/fleet-postflip-wave2-driver.sh > ~/wave2-driver.log 2>&1 &
#
# Poll from the laptop for ~/WAVE2-SENTINEL, then:
#   gcloud compute scp buildbox:~/wave2.tgz{,.sha256} . --zone us-central1-a
#   sha256sum -c wave2.tgz.sha256
#   rm -f ~/.keep-awake && sudo poweroff    # on the box
#
# 10 packets, CAP 16 not reached — all launch up front, 4 s stagger.
# stdout of each agent IS the deliverable (parts/pNN.md).
set -u
ROOT="$HOME/WorldBuilder-ACME-Edition"
SPEC="$ROOT/docs/fleet-postflip-wave2-spec-2026-07-03.md"
WORK="$HOME/wave2"
MODEL="claude-opus-4-8"
mkdir -p "$WORK/parts"
cd "$ROOT" || exit 1
command -v rg >/dev/null 2>&1 || sudo apt-get install -y ripgrep

[ -r "$SPEC" ] || { echo "spec missing: $SPEC"; exit 1; }
PRE="$(cat "$SPEC")"

for i in 01 02 03 04 05 06 07 08 09 10; do
  TASK="You are packet P${i}. Execute ONLY packet P${i} of the spec below, honoring its Sources, EXCLUSION LIST, Rules and Output contract. Begin your stdout with '# P${i}'."
  timeout 2400 claude -p --model "$MODEL" --dangerously-skip-permissions \
    "${TASK}

${PRE}" > "$WORK/parts/p${i}.md" 2> "$WORK/parts/p${i}.err" &
  sleep 4
done
wait

# Package + sentinel (integrity per runbook).
tar czf "$HOME/wave2.tgz" -C "$WORK" parts
( cd "$HOME" && sha256sum wave2.tgz > wave2.tgz.sha256 )
touch "$HOME/WAVE2-SENTINEL"
echo "wave2 done: $(ls -la "$HOME/wave2.tgz")"
