# Google Compute Engine setup for Codex-driven population ML automation

This guide gives you a practical, low-ops setup where a VM:

1. Runs world-population ML training/evaluation workloads.
2. Every 30 minutes, checks progress and health.
3. On regressions/failures, asks Codex to generate a fix branch and test it.
4. Keeps costs down by right-sizing CPU/GPU (including dropping L4 when utilization is low).

---

## 1) Recommended target architecture

Use one orchestrator VM and (optionally) one worker VM:

- **Orchestrator (always on, small):**
  - Runs scheduler, metrics checks, Codex automation scripts, and Git operations.
  - Suggested shape: `e2-standard-4` or `n2-standard-4`.
- **Worker (on-demand, training):**
  - Runs heavy ML jobs only when needed.
  - Start CPU-first, only attach GPU when model throughput needs it.

If you have only used ~17% of an L4, begin with **CPU-only** training on a modern high-clock machine type. Good first options:

- `c3-highcpu-8` (fast per-core, no GPU)
- `n2-standard-8` (balanced)
- `c3-standard-8` (strong general-purpose)

Then benchmark 1 training epoch wall-time and cost. Add GPU only if CPU-only run misses your iteration SLA.

---

## 2) VM bootstrap (Ubuntu)

### Create VM (example)

```bash
gcloud compute instances create wb-ml-orchestrator \
  --zone=us-central1-a \
  --machine-type=n2-standard-4 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=200GB \
  --scopes=https://www.googleapis.com/auth/cloud-platform
```

### Base packages

```bash
sudo apt-get update
sudo apt-get install -y git python3 python3-venv python3-pip jq tmux build-essential
```

### Repo + venv

```bash
git clone <your-repo-url> /opt/worldbuilder
cd /opt/worldbuilder
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt || true
```

---

## 3) Codex automation model: safe autonomous loop

Use a 30-minute control loop with these phases:

1. **Observe:** Parse latest training logs, validation metrics, and job state.
2. **Decide:**
   - If progressing within thresholds: keep running.
   - If stalled/regressed/failed: create an “improvement task”.
3. **Act (Codex):**
   - Create a branch.
   - Apply constrained edits (scripts/configs only).
   - Run tests + smoke training.
4. **Verify:**
   - Compare baseline vs candidate metrics.
   - Auto-merge only if guardrails pass.
5. **Recover:**
   - If candidate fails, rollback and open issue.

### Guardrails you should enforce

- Max files changed per cycle (for example, <= 10).
- No secrets/config IAM edits by Codex.
- Mandatory test commands pass before merge.
- Hard stop after N failed cycles (for example, N=3) and page human.

---

## 4) Example scheduler implementation

Create `ops/check_and_adjust.sh` (or equivalent) and run every 30 min.

```bash
#!/usr/bin/env bash
set -euo pipefail

cd /opt/worldbuilder
source .venv/bin/activate

# 1) Capture state
python scripts/collect_training_status.py --out /tmp/wb_status.json

# 2) Evaluate health
python scripts/evaluate_progress.py \
  --status /tmp/wb_status.json \
  --max-loss-regression 0.02 \
  --max-no-improvement-minutes 90 \
  --out /tmp/wb_decision.json

ACTION=$(jq -r '.action' /tmp/wb_decision.json)

if [[ "$ACTION" == "healthy" ]]; then
  echo "Healthy: no action required"
  exit 0
fi

# 3) Create codex task payload
python scripts/build_codex_task.py \
  --decision /tmp/wb_decision.json \
  --status /tmp/wb_status.json \
  --out /tmp/wb_task.md

# 4) Run codex automation (replace with your codex CLI invocation)
codex run \
  --repo /opt/worldbuilder \
  --task-file /tmp/wb_task.md \
  --output /tmp/wb_codex_result.json

# 5) Validate patch
bash scripts/ci_smoke.sh

# 6) If validation passes, commit + PR via your standard workflow
# (Can be auto-merge only when metric gate improves over baseline.)
```

Install cron entry:

```bash
crontab -e
```

```cron
*/30 * * * * /opt/worldbuilder/ops/check_and_adjust.sh >> /var/log/wb_autoloop.log 2>&1
```

---

## 5) Better than cron: systemd timer (recommended)

Cron is simple, but a systemd timer gives stronger observability/restart behavior.

- `wb-autoloop.service`: runs one automation cycle.
- `wb-autoloop.timer`: triggers every 30 minutes.

This gives cleaner logs via `journalctl -u wb-autoloop.service` and better failure handling.

---

## 6) Cost/performance tuning (especially vs L4)

Since L4 utilization is only ~17%, do this:

1. Benchmark **CPU-only** and **GPU** for one fixed workload slice.
2. Compare **cost per successful epoch** (not just speed).
3. If GPU is idle most of the run, remove it and scale CPU/storage instead.
4. Use preemptible/spot workers for non-critical retraining.
5. Set budget alerts and auto-stop idle workers.

### Quick heuristic

- If GPU utilization stays <35% and CPU pipeline stages dominate, optimize data/input pipeline first and consider removing GPU.
- If GPU utilization rises >70% after pipeline fixes and time-to-iteration matters, reintroduce GPU.

---

## 7) Reliability checklist

- Structured logs for each cycle (`status`, `decision`, `action`, `result`).
- Metrics sink (Cloud Monitoring or Prometheus).
- Alerting on:
  - training crashed
  - no metric improvement over threshold window
  - repeated Codex patch failures
- Daily snapshot/backups of key artifacts/models.
- Pin dependency versions to avoid drift.

---

## 8) Security + access

- Use a dedicated service account for VM automation.
- Least-privilege IAM roles only.
- Keep repo credentials in Secret Manager (not plain env files).
- Restrict outbound network if possible.

---

## 9) Practical rollout plan

1. Stand up orchestrator VM (no GPU).
2. Implement monitor-only loop first (no auto-edit).
3. Enable Codex “suggest PR only” mode.
4. After 1-2 weeks of stable behavior, allow auto-merge for low-risk script/config changes.
5. Reassess machine type weekly using utilization + cost per epoch.

