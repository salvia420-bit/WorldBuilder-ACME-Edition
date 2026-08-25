# PII exposure — decisions only you can make

**Status:** the working tree is scrubbed and the build pipeline is gated (commits
`f467da35`..`HEAD`). Everything in this document is a decision that was
deliberately **not** executed, because each one is irreversible, destroys other
people's work, or changes what the world can see.

Nothing here has been done. No push, no history rewrite, no GitHub write of any
kind was performed.

---

## 0. The one-paragraph version

The repo is **public** and has been since 2026-02-27. Its git history — 3,538
commits before this remediation — contains an account name, three tailnet IP
addresses, two live test-account credentials, two people's Windows home
directories, and a personal e-mail address, in **file contents, in ~60 commit
messages, and in the author/committer identity of ~3,250 commits**. Scrubbing
HEAD (which is now done) removes none of that.

The good news, and it is genuinely good: **there are zero published release
artifacts, zero GitHub Actions artifacts, and zero forks.** The exposure is the
git repository itself and nothing else. That is the cheapest possible shape for
this problem, and it will stay cheap only for as long as nobody forks.

---

## 1. What is actually exposed

### 1a. Verified negative — nothing was ever published

| Check | Command | Result |
|---|---|---|
| Releases | `gh release list --limit 100` | **empty** |
| Releases (API) | `gh api …/releases --jq 'length'` | **0** |
| Actions artifacts | `gh api …/actions/artifacts --jq '.total_count'` | **0** |
| Successful workflow runs | `gh api '…/actions/runs?status=success' --jq '.total_count'` | **0** — out of 313 runs, none ever succeeded |
| Forks | `gh api …/forks --jq 'length'` | **0** |
| GitHub Pages | `gh api …/pages` | 404 — no site |

The reason no installer was ever published is the path bug fixed in `ea00d664`:
`Installer.nsi` moved to `installer/` in commit `10da18f1` and the workflows kept
invoking `${{ github.workspace }}/Installer.nsi`. Every `Build Edge` run got as
far as `dotnet publish` — producing a leaking `WorldBuilder.Shared.dll` inside
the runner — and then died at `makensis` before the upload step.

> **The one thing this cannot tell you.** Any installer that reached another
> person must have been built by hand on a developer machine and handed over
> directly. Those builds *did* contain the leak (see 1b). If you have sent an
> `ACME-WorldBuilderInstall-*.exe` to anyone, that copy is dirty and should be
> replaced. Only you know whether that happened.

### 1b. What was in the binaries (now fixed)

Proven, not inferred. Running the repo's own scanner over a pre-fix build:

```
$ python3 tools/leak_scan.py WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Shared.dll
   LEAK GATE FAILED: 28 hit(s) … (1 files, ASCII + UTF-16LE)
   LEAK  … [ascii    @ 0x11f0b4]  …RSDS…/home/<user>/WorldBuilder-ACME-Edition/Wor…
   LEAK  … [utf-16le @ 0xdc450]   …/mnt/<data-mount>/pbr-terrain/statics-x3/sets…
   … 26 more, all UTF-16LE
```

Two mechanisms, both fixed:

* four `const string` absolute paths in `WorldBuilder.Shared/Lib/TexturePicker/`.
  A C# `const` is copied into the assembly string heap as **UTF-16LE**, which is
  why an ASCII `grep` over the DLL found nothing for years.
* the build machine's home directory in every assembly's RSDS debug directory,
  plus four `.pdb` files that `Installer.nsi` was installing onto users' disks.

### 1c. What is still exposed, and where

| Class | Working tree (after this remediation) | Git history | Commit messages | Author/committer fields |
|---|---|---|---|---|
| Account name (`<user>`) | **0** in `docs/`, `AcmeRedline/`, `review/`, `tools/`, `WorldBuilder*` | 44 commits | 0 | — |
| Tailnet IPs (`<server-ip>`, `<gpu-box-ip>`, `<tailnet-ip>`) | **0** (same scope) | 81 / 45 / 1 commits | 14 messages | — |
| Test credentials (`<account>`, `<test-account>`) | **0** (same scope) | 196 / 56 commits | 30 / 11 messages | — |
| Windows homes (two people) | **0** (same scope) | 7 / 3 commits | 0 | — |
| Personal e-mail | **0** (same scope) | 2 commits | 0 | **~3,250 commits** |
| Dev home + data-mount paths | **921 occurrences** still in `docs/` | 313 / 288 commits | 62 messages | — |
| All of the above | **742 files** still in `external/holtburger/` | — | — | — |

The last two rows are the deliberate scope cut — see §5.

---

## 2. Decision 1 — the git history

**The problem.** `git log -S` proves every one of these strings was introduced by
a real commit and is reachable from `--all`. Cleaning HEAD does not remove a
single byte of that. Anyone can `git clone` and read it today.

Three honest options.

### Option A — rewrite history with `git filter-repo`, then force-push

*What it buys:* the strings stop being reachable from any ref. After GitHub's
garbage collection (which you should request explicitly via support — GitHub
does **not** GC unreachable objects on its own schedule, and old commits stay
addressable by SHA for a long time), the exposure is genuinely gone.

*What it costs, honestly:*

* **Every existing clone breaks.** Every collaborator must re-clone or do a hard
  reset. There are 165 refs here and ~90 branches on `origin`, including a lot of
  `codex/*` and agent branches. All of their SHAs change.
* **Every commit SHA changes.** Any SHA quoted in an issue, a PR, a handoff note,
  or a Discord message becomes a dangling reference. This repo's docs quote SHAs
  heavily.
* **GitHub caches and forks may retain the data regardless.** There are zero
  forks *right now*, which is the single thing that makes this option viable —
  but a fork made between now and the rewrite would keep the old objects
  permanently and outside your control. If you are going to do this, the fork
  count being 0 is a window, not a permanent condition.
* **It is not a one-pass job.** A naive `--replace-text` misses three things this
  repo actually has:
  1. **commit messages** — 62 of them carry the dev paths, 30 carry a test
     account, 14 carry the server IP. Needs `--replace-message` as well.
  2. **the author/committer e-mail** — your personal address is the author or
     committer of **~3,250 of 3,538 commits**. `--replace-text` does not touch
     identity fields at all; that needs `--mailmap` or `--email-callback`.
     (This file does not spell any address out — it would just be one more
     public, greppable copy. To see the full list:
     `git log --all --format='%an <%ae> | %cn <%ce>' | sort -u`.)
  3. **escape forms** — the Windows path is stored as `C:\\Users\\…` (JS/JSON
     escaped) in the `.mjs` harnesses. A pattern written for the single-backslash
     form matches **zero** of them. Write patterns that are escape-agnostic, the
     way `tools/leak_scan.py`'s drive-letter-agnostic `:\Users\` literal is.
* **Rewriting other people's identities is its own decision.** Six other real
  people's personal addresses are in the author fields — four `@gmail`-class
  addresses plus a `@live.com` and a `@protonmail.com`; the command above lists
  them. Rewriting those changes their attribution on work they contributed. That
  is a courtesy question, not a security one, and it is not yours to answer
  unilaterally.

### Option B — make the repository private

*What it buys:* immediate. One click. Stops all further exposure, keeps every
SHA, breaks no clone, and buys unlimited time to decide about a rewrite.

*What it costs:* the project stops being publicly visible. Note that **making a
repo private does not retract what has already been cloned or cached**, and if
you later make it public again the full history comes back with it. This is
containment, not remediation.

### Option C — accept the exposure

*Defensible for parts of it.* Realistically: what is exposed is a hobby dev box's
tailnet IPs (RFC 6598 CGNAT space, reachable only from inside your tailnet), two
test-account credentials on a local ACE server, a first name, and an e-mail
address that is already the public author identity on nearly every commit and is
therefore *already* visible to anyone who runs `git log`.

*What makes it indefensible as a blanket answer:* the two test credentials are
live on a server you run, another person's Windows username is in there, and the
e-mail is a real one you presumably use elsewhere.

### The recommendation

**Do Option B today** (one click, zero cost, stops the bleeding), then decide A
at your leisure with the release out of the way. If you would rather stay public,
then rotate first and rewrite second:

1. **Rotate the two ACE test-account passwords now.** That is the only item here
   with a live security consequence, it takes a minute, and it is worth doing
   whichever option you pick — a rewrite does not un-publish a credential that
   has been readable for months.
2. Then A, with `--replace-message` and `--email-callback`, before anyone forks.

---

## 3. Decision 2 — the published installers

**There are none.** See §1a. There is nothing to delete, nothing to revoke, and
no `gh release delete` to run.

The only action here is the question in §1a: if you hand-built and shared an
installer, that binary contains the mount path and the build machine's home
directory. Rebuild from `HEAD` and re-send. The gate now added to both workflows
means a leaking installer cannot be produced by CI again, and running
`python3 tools/leak_scan.py <publish-dir>` before any hand-build gives you the
same guarantee locally.

---

## 4. Decision 3 — should the repo be public right now?

Three things argue for "not yet":

1. **The history is dirty and will stay dirty until a rewrite.** Public + dirty
   history is the worst of the combinations; private + dirty is fine.
2. **Zero forks is a fragile asset.** It is what makes a future rewrite actually
   effective. Every day the repo stays public is a day someone might fork it and
   freeze the old objects beyond your reach. A single star already exists, so it
   is not unobserved.
3. **`BuildEdge.yml` triggers on push to `'**'`.** Every branch, including
   experimental and agent branches, now runs a pipeline that — with the makensis
   path fixed in `ea00d664` — will *succeed* for the first time and publish a
   prerelease installer to a public `latest` tag. That is a real behaviour change
   landing at the same moment as a release. The leak gate protects the contents,
   but you should decide on purpose whether you want every branch push publishing
   a public prerelease.

Against: the project is a public open-source AC emulation effort and visibility
has value.

**Suggested sequence:** private → rotate credentials → rewrite history → verify
with `tools/leak_scan.py` over a fresh clone → public again. Steps 1 and 2 cost
minutes; only step 3 needs a quiet afternoon.

---

## 5. What was deliberately left alone

Not oversights. Each is a judgement call flagged for you.

### 5a. Dev paths in `docs/` — 921 occurrences

`/home/<user>` (252) and `/mnt/<data-mount>` (669) still appear across ~250 files
in `docs/`. These are a hostname and a mount name, not a person, and the notes
are full of real commands that only make sense with real paths. Scrubbing them
mechanically would leave 250 handoff documents you can no longer follow, which is
a large cost for a small marginal gain over what §2 has to fix anyway. If you
want it done, the tooling is straightforward and the same
markdown-structure-preserving approach used in `30061d94` applies.

### 5b. `external/holtburger/` — 742 files

This vendored tree carries the same PII at greater volume than `docs/` did:
`<account>` in 407 places, the dev home in 874, `<user>@<gpu-box-ip>` in 40. It
was left alone because unlike `docs/`, it contains **live source** (`.js`, `.rs`,
`.mjs`) where a path may be a functional default, and a blind sed there risks
breaking the client. It needs a pass of its own, file-class by file-class.

### 5c. Author/committer identities

Untouched for the reasons in §2 Option A — rewriting six other people's
attribution is not a call to make on someone's behalf.

### 5d. `tools/dat-patch/finish_fill.sh` pushes on its own

While removing the hard-coded identity from this script I noticed it ends with
`git push origin integ/all-20260813`. The identity leak is fixed; the
self-pushing behaviour is left exactly as it was, because changing what a script
pushes is your call. Worth a look.

---

## 6. Placeholder legend

The mapping used by commit `30061d94`, for reading the scrubbed notes:

| Placeholder | Was | Occurrences replaced |
|---|---|---|
| `<user>` | the dev account / Windows username | 61 + 12 |
| `<server-ip>` | the laptop's tailnet address (ACE, wsbridge) | 168 |
| `<gpu-box-ip>` | the GTX-1070 box's tailnet address | 64 |
| `<tailnet-ip>` | a third tailnet address | 1 |
| `<account>` | the Developer-promoted ACE test account | 490 |
| `<test-account>` | the second ACE test account | 151 |
| `<owner-email>` | a personal e-mail address | 2 |

One of the two Windows home directories belonged to a **different person**
(`docs/PopulationPipelineStrategy.md`); both now read `C:\Users\<user>`.

Not replaced, on purpose: the same surname is also an Asheron's Call
creature-name and flavour-text word ("Young Banderling", "a young drudge
slinker"). 98 such occurrences in `docs/sample-dist/`, `pipeline_data/`,
`town_kits/` and `AcmeRagdoll/ragdoll_profiles.json` are shipped game content and
were left untouched. `tools/leak_scan.py` therefore catches the name
*structurally* — via the home-directory prefixes and the e-mail sweep — and never
as a bare literal, which would reject the game data on every release.

---

## 7. Two hazards worth knowing about

**ripgrep silently skips files containing a NUL byte.** Found during this audit:
`WorldBuilder/ViewModels/TexturePickerPanelViewModel.cs` contains one literal NUL
(line 464, `private string _gainTintKey = "\0";` written as a raw NUL rather than
an escape). ripgrep classifies the whole file as binary and **omits it from every
directory walk** — `rg -l TexturePickerPanelViewModel .` does not find the file
that defines the class. Any repo-wide audit done with `rg` has a blind spot of
unknown size. `tests/test_leak_scan.py` now pins that `tools/leak_scan.py` itself
never acquires a NUL, and `leak_scan.py` reads raw bytes rather than walking with
ripgrep, so the gate is not affected. The `.cs` file is worth fixing (`"\0"` as
an escape) so it stops hiding from greps.

**Changing `Directory.Build.props` does not trigger a rebuild.** Modern .NET SDKs
trimmed props files out of `$(MSBuildAllProjects)`, so the `PathMap` added in
`f467da35` does **not** take effect on an incremental build — the first
verification pass here showed clean-looking assemblies that were simply stale.
Delete `obj/` and `bin/` after any change to that file, or the leak gate is
measuring the wrong binaries.

---

## 8. Verification you can re-run

```bash
# unit tests for the gate itself (35 cases)
python3 tests/test_leak_scan.py

# the shipped library
DOTNET_ROLL_FORWARD=LatestMajor dotnet build WorldBuilder.Shared -c Release
python3 tools/leak_scan.py WorldBuilder.Shared/bin/Release/net8.0/

# the full installer payload -- what a user actually gets on disk
rm -rf WorldBuilder/obj WorldBuilder/bin WorldBuilder.Windows/obj WorldBuilder.Windows/bin
DOTNET_ROLL_FORWARD=LatestMajor dotnet publish WorldBuilder.Windows/WorldBuilder.Windows.csproj \
  -r win-x64 -p:DebugType=none
python3 tools/leak_scan.py WorldBuilder.Windows/bin/Release/net8.0/win-x64/publish/

# TexturePicker behaviour is unchanged
DOTNET_ROLL_FORWARD=LatestMajor dotnet test WorldBuilder.Tests -c Release \
  --filter "FullyQualifiedName~TexturePicker"
```

All four pass as of `HEAD`. The publish step is the one that matters: it is the
exact directory `Installer.nsi` packs with `File "${BUILDPATH}\*.*"`.

> Note: running `leak_scan.py` over **this file** reports six hits. They are all
> the generic prefixes in the placeholders above (`/home/<user>`,
> `/mnt/<data-mount>`, `:\Users\`) — no real value. `tools/leak_scan.py` fails
> its own scan for the same reason: it has to contain the literals it looks for.
> Neither file is ever in a shipped artifact, and no pipeline scans `docs/`.
