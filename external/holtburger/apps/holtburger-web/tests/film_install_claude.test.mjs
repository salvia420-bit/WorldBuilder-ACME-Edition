// tests/film_install_claude.test.mjs
//
// WHY: film mode (`?filmMode=on`, flag filmMode, DEFAULT OFF) is directed by a Claude Code session whose skill
// (`film-mode`) and agent (`film-director`) live in the repo and are symlinked into ~/.claude by
// tools/film/install-claude.sh. The owner runs that script against their real home, so it must be idempotent,
// must never clobber a real file or directory, must honour --dry-run exactly, and --uninstall must remove only
// links that point into the repo. This suite RUNS the real script (bash) with HOME set to fresh os.tmpdir()
// directories — never the real home:
//   A  install into a fresh HOME (links + parent dirs), install twice (idempotent), replace a foreign symlink,
//      accept a relative link into the repo
//   B  refuse a real directory / a real file (exit 1, NOTHING changed — not even the other link)
//   C  --dry-run (fresh and installed homes) changes nothing
//   D  --uninstall removes only our links (foreign symlinks, real files and siblings stay), idempotent, --dry-run
//   E  usage errors; the in-place script resolves this checkout's repo root; the real ~/.claude is untouched
// Hermetic: sections A–D copy the script into a fake repo layout under os.tmpdir()
// (<tmp>/repo/external/holtburger/apps/holtburger-web/tools/film/install-claude.sh) with fake skill/agent sources.
//
// Run from apps/holtburger-web/: node tests/film_install_claude.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(HB, "tools", "film", "install-claude.sh");
const REAL_REPO = fs.realpathSync(path.resolve(HB, "..", "..", "..", ".."));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e?.stack ?? e}`);
  }
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "film-install-claude-")));

// ── a fake repo with the script copied into the real relative position ─────────────────────────────────────
const FAKE_REPO = path.join(TMP, "repo");
const FAKE_SCRIPT = path.join(FAKE_REPO, "external", "holtburger", "apps", "holtburger-web", "tools", "film", "install-claude.sh");
const SKILL_SRC = path.join(FAKE_REPO, ".claude", "skills", "film-mode");
const AGENT_SRC = path.join(FAKE_REPO, ".claude", "agents", "film-director.md");
fs.mkdirSync(path.dirname(FAKE_SCRIPT), { recursive: true });
fs.copyFileSync(SCRIPT, FAKE_SCRIPT);
fs.mkdirSync(path.join(SKILL_SRC, "reference"), { recursive: true });
fs.writeFileSync(path.join(SKILL_SRC, "SKILL.md"), "---\nname: film-mode\n---\n");
fs.writeFileSync(path.join(SKILL_SRC, "reference", "workflow.md"), "# workflow\n");
fs.mkdirSync(path.dirname(AGENT_SRC), { recursive: true });
fs.writeFileSync(AGENT_SRC, "---\nname: film-director\n---\n");

let homeSeq = 0;
function freshHome() {
  const h = path.join(TMP, `home-${++homeSeq}`);
  fs.mkdirSync(h);
  return h;
}

function run(home, args = [], script = FAKE_SCRIPT) {
  const r = spawnSync("bash", [script, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const skillDest = (home) => path.join(home, ".claude", "skills", "film-mode");
const agentDest = (home) => path.join(home, ".claude", "agents", "film-director.md");
const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Every entry under `dir` as [relpath, kind, link target | file text], sorted — a full snapshot. */
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.push([rel, "link", fs.readlinkSync(p)]);
      else if (st.isDirectory()) {
        out.push([rel, "dir", ""]);
        walk(p);
      } else out.push([rel, "file", fs.readFileSync(p, "utf8")]);
    }
  };
  if (exists(dir)) walk(dir);
  return out;
}

function realHomeState() {
  const home = os.homedir();
  return [path.join(home, ".claude", "skills", "film-mode"), path.join(home, ".claude", "agents", "film-director.md")].map((p) => {
    try {
      const st = fs.lstatSync(p);
      return [p, st.isSymbolicLink() ? `link:${fs.readlinkSync(p)}` : st.isDirectory() ? "dir" : "file", st.mtimeMs];
    } catch {
      return [p, "absent", 0];
    }
  });
}
const REAL_HOME_BEFORE = realHomeState();

// ── A: install ────────────────────────────────────────────────────────────────────────────────────────────

console.log("A  install");

check("install into a fresh HOME creates both links and their parent directories", () => {
  const home = freshHome();
  const r = run(home);
  assert.equal(r.code, 0, r.err);
  assert.ok(isLink(skillDest(home)) && isLink(agentDest(home)));
  assert.equal(fs.readlinkSync(skillDest(home)), SKILL_SRC);
  assert.equal(fs.readlinkSync(agentDest(home)), AGENT_SRC);
  assert.equal(fs.readFileSync(path.join(skillDest(home), "SKILL.md"), "utf8"), "---\nname: film-mode\n---\n");
  assert.equal(fs.readFileSync(agentDest(home), "utf8"), "---\nname: film-director\n---\n");
  assert.match(r.out, /^link {4}.*film-mode -> /m);
  assert.match(r.out, /^link {4}.*film-director\.md -> /m);
});

check("a second install is idempotent (exit 0, 'already linked', identical tree)", () => {
  const home = freshHome();
  assert.equal(run(home).code, 0);
  const before = snapshot(home);
  const r = run(home);
  assert.equal(r.code, 0, r.err);
  assert.equal((r.out.match(/already linked/g) ?? []).length, 2);
  assert.deepEqual(snapshot(home), before);
});

check("an existing symlink pointing elsewhere is replaced (relink), dangling or not", () => {
  const home = freshHome();
  fs.mkdirSync(path.dirname(skillDest(home)), { recursive: true });
  fs.mkdirSync(path.dirname(agentDest(home)), { recursive: true });
  fs.symlinkSync(path.join(TMP, "nowhere", "film-mode"), skillDest(home)); // dangling
  const other = path.join(TMP, "other-agent.md");
  fs.writeFileSync(other, "other\n");
  fs.symlinkSync(other, agentDest(home)); // live, foreign
  const r = run(home);
  assert.equal(r.code, 0, r.err);
  assert.equal((r.out.match(/^relink /gm) ?? []).length, 2);
  assert.equal(fs.readlinkSync(skillDest(home)), SKILL_SRC);
  assert.equal(fs.readlinkSync(agentDest(home)), AGENT_SRC);
  assert.equal(fs.readFileSync(other, "utf8"), "other\n", "the foreign link's target is not touched");
});

check("a relative symlink into the repo counts as already linked", () => {
  const home = freshHome();
  fs.mkdirSync(path.dirname(skillDest(home)), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(skillDest(home)), SKILL_SRC), skillDest(home));
  const r = run(home);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ok {6}.*film-mode -> .*\(already linked\)$/m);
  assert.ok(!path.isAbsolute(fs.readlinkSync(skillDest(home))), "the relative link was left as it was");
  assert.equal(fs.readlinkSync(agentDest(home)), AGENT_SRC);
});

// ── B: refusals ───────────────────────────────────────────────────────────────────────────────────────────

console.log("B  refusals");

check("a real directory at the skill destination is refused (exit 1) and NOTHING changes", () => {
  const home = freshHome();
  fs.mkdirSync(skillDest(home), { recursive: true });
  fs.writeFileSync(path.join(skillDest(home), "SKILL.md"), "mine\n");
  const before = snapshot(home);
  const r = run(home);
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing to replace .*film-mode/);
  assert.match(r.err, /real file or directory/);
  assert.deepEqual(snapshot(home), before, "no link created, the real dir untouched");
  assert.ok(!exists(agentDest(home)), "the agent link was not created either");
});

check("a real file at the agent destination is refused (exit 1) and NOTHING changes", () => {
  const home = freshHome();
  fs.mkdirSync(path.dirname(agentDest(home)), { recursive: true });
  fs.writeFileSync(agentDest(home), "my own agent\n");
  const before = snapshot(home);
  const r = run(home);
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing to replace .*film-director\.md/);
  assert.deepEqual(snapshot(home), before);
  assert.ok(!exists(skillDest(home)));
});

check("--dry-run with a real directory in the way also refuses (exit 1)", () => {
  const home = freshHome();
  fs.mkdirSync(skillDest(home), { recursive: true });
  const before = snapshot(home);
  const r = run(home, ["--dry-run"]);
  assert.equal(r.code, 1);
  assert.deepEqual(snapshot(home), before);
});

check("a missing source is reported (exit 1) and nothing is linked", () => {
  const repo2 = path.join(TMP, "repo-nosrc");
  const script2 = path.join(repo2, path.relative(FAKE_REPO, FAKE_SCRIPT));
  fs.mkdirSync(path.dirname(script2), { recursive: true });
  fs.copyFileSync(SCRIPT, script2);
  fs.mkdirSync(path.join(repo2, ".claude", "skills", "film-mode"), { recursive: true }); // agent missing
  const home = freshHome();
  const r = run(home, [], script2);
  assert.equal(r.code, 1);
  assert.match(r.err, /source missing: .*film-director\.md/);
  assert.deepEqual(snapshot(home), []);
});

// ── C: dry run ────────────────────────────────────────────────────────────────────────────────────────────

console.log("C  dry run");

check("--dry-run on a fresh HOME prints the plan and creates nothing (not even ~/.claude)", () => {
  const home = freshHome();
  const r = run(home, ["--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.equal((r.out.match(/^\[dry-run\] link /gm) ?? []).length, 2);
  assert.deepEqual(snapshot(home), []);
});

check("--dry-run on a home with a foreign link prints 'relink' and changes nothing", () => {
  const home = freshHome();
  fs.mkdirSync(path.dirname(skillDest(home)), { recursive: true });
  fs.symlinkSync("/nonexistent/elsewhere", skillDest(home));
  const before = snapshot(home);
  const r = run(home, ["--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\[dry-run\] relink .*film-mode/m);
  assert.match(r.out, /^\[dry-run\] link .*film-director\.md/m);
  assert.deepEqual(snapshot(home), before);
});

// ── D: uninstall ──────────────────────────────────────────────────────────────────────────────────────────

console.log("D  uninstall");

check("--uninstall removes our two links and leaves parents and siblings alone; a second run is a no-op", () => {
  const home = freshHome();
  assert.equal(run(home).code, 0);
  fs.mkdirSync(path.join(home, ".claude", "skills", "other-skill"));
  fs.writeFileSync(path.join(home, ".claude", "skills", "other-skill", "SKILL.md"), "other\n");
  fs.writeFileSync(path.join(home, ".claude", "agents", "other-agent.md"), "other\n");
  const r = run(home, ["--uninstall"]);
  assert.equal(r.code, 0, r.err);
  assert.equal((r.out.match(/^remove /gm) ?? []).length, 2);
  assert.ok(!exists(skillDest(home)) && !exists(agentDest(home)));
  assert.equal(fs.readFileSync(path.join(home, ".claude", "skills", "other-skill", "SKILL.md"), "utf8"), "other\n");
  assert.equal(fs.readFileSync(path.join(home, ".claude", "agents", "other-agent.md"), "utf8"), "other\n");
  assert.ok(fs.lstatSync(SKILL_SRC).isDirectory() && fs.lstatSync(AGENT_SRC).isFile(), "the repo sources are intact");
  const r2 = run(home, ["--uninstall"]);
  assert.equal(r2.code, 0, r2.err);
  assert.equal((r2.out.match(/^absent /gm) ?? []).length, 2);
});

check("--uninstall keeps a symlink that points outside the repo and a real file", () => {
  const home = freshHome();
  fs.mkdirSync(path.dirname(skillDest(home)), { recursive: true });
  fs.mkdirSync(path.dirname(agentDest(home)), { recursive: true });
  fs.symlinkSync(path.join(TMP, "someone-elses-skill"), skillDest(home));
  fs.writeFileSync(agentDest(home), "a real agent file\n");
  const before = snapshot(home);
  const r = run(home, ["--uninstall"]);
  assert.equal(r.code, 0, r.err);
  assert.equal((r.out.match(/^keep /gm) ?? []).length, 2);
  assert.deepEqual(snapshot(home), before);
});

check("--uninstall removes a relative link into the repo", () => {
  const home = freshHome();
  fs.mkdirSync(path.dirname(agentDest(home)), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(agentDest(home)), AGENT_SRC), agentDest(home));
  const r = run(home, ["--uninstall"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!exists(agentDest(home)));
});

check("--uninstall --dry-run changes nothing", () => {
  const home = freshHome();
  assert.equal(run(home).code, 0);
  const before = snapshot(home);
  const r = run(home, ["--uninstall", "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.equal((r.out.match(/^\[dry-run\] remove /gm) ?? []).length, 2);
  assert.deepEqual(snapshot(home), before);
});

// ── E: usage, the in-place script, the real home ─────────────────────────────────────────────────────────

console.log("E  usage and the real tree");

check("an unknown argument is a usage error (exit 2) and changes nothing", () => {
  const home = freshHome();
  const r = run(home, ["--force"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown argument '--force'/);
  assert.deepEqual(snapshot(home), []);
});

check("--help prints the header (exit 0) and changes nothing", () => {
  const home = freshHome();
  const r = run(home, ["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /--uninstall removes only symlinks that point into this repo/);
  assert.deepEqual(snapshot(home), []);
});

check("the in-place script is executable, strict, and resolves this checkout's repo root", () => {
  assert.ok((fs.statSync(SCRIPT).mode & 0o111) !== 0, "install-claude.sh must be executable");
  assert.match(fs.readFileSync(SCRIPT, "utf8"), /^set -euo pipefail$/m);
  const home = freshHome();
  const r = run(home, ["--dry-run"], SCRIPT);
  const skill = path.join(REAL_REPO, ".claude", "skills", "film-mode");
  const agent = path.join(REAL_REPO, ".claude", "agents", "film-director.md");
  if (exists(skill) && exists(agent)) {
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(`-> ${skill}`) && r.out.includes(`-> ${agent}`), r.out);
  } else {
    assert.equal(r.code, 1);
    assert.match(r.err, /source missing/);
  }
  assert.deepEqual(snapshot(home), [], "dry run against a temp HOME");
});

check("the real ~/.claude film entries were never touched", () => {
  assert.deepEqual(realHomeState(), REAL_HOME_BEFORE);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nfilm install-claude: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
