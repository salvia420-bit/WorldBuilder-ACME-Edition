// rynth/vt/cmd/quests.js — quest-flag cache for the meta functions
// testquestflag / getqueststatus / getquestktprogress / getquestktrequired /
// isrefreshingquests / refreshquests (PLAN W1-5 CMD §3.7; U5 §5.6 group M).
// Port of CS/Meta/QuestTracker.cs (RynthAi; itself UB QuestFlag semantics).
//
// Mechanism: refresh() sends `/myquests` through the injected runChat (the
// local command chain, which falls through to host.InvokeChatParser; the
// page router sends the unknown verb to ACE as `@myquests`). ACE answers one
// SystemChat line per quest (ace-server PlayerCommands.cs HandleQuests):
//     <key> - <solves> solves (<lastCompletedUnix>)"<message>" <maxSolves> <minDeltaSeconds>
// e.g. `blankaug - 1 solves (1609459200)"Blank Aug" 1 0`. The refresh ends 1 s
// after the last quest line, after 15 s with no quest line at all, or at once
// on "Quest list is empty." / "… is not currently enabled …" / the rate-limit
// line. No timers (C4): tick(nowMs) — and every read — re-checks the clock.
//
// Readiness (UB QuestFlag.IsReady): ready when completedOn + repeat <= now and
// it is not a once-only flag (maxSolves == 1 && solves <= 1 never repeats).
// A key that is not in the cache counts as READY (getqueststatus → 1).

export const QUEST_LINE_RE =
  /(?<key>\S+) - (?<solves>\d+) solves \((?<completedOn>\d{0,11})\)"?(?:(?<description>.*)" (?<maxSolves>\S*) (?<repeatTime>\d{0,11}))?.*$/;

const SILENCE_MS = 1000;
const TIMEOUT_MS = 15_000;
const END_LINES = [/Quest list is empty/, /The command "myquests" is not currently enabled/, /This command may only be run once every/];

/** Parse one /myquests line → {key, solves, maxSolves, completedOnS, repeatS, description} | null. */
export function parseQuestLine(text) {
  const s = String(text ?? "").replace(/[\r\n]+$/, "");
  const m = QUEST_LINE_RE.exec(s);
  if (!m || !m.groups) return null;
  const g = m.groups;
  const int = (v) => {
    const n = parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    key: g.key.toLowerCase(),
    solves: int(g.solves),
    maxSolves: g.maxSolves === undefined ? 0 : int(g.maxSolves),
    completedOnS: int(g.completedOn),
    repeatS: int(g.repeatTime),
    description: g.description ?? "",
  };
}

/** UB QuestFlag.IsReady at `nowMs`. */
export function questReady(rec, nowMs) {
  if (!rec) return true;
  const readyAtMs = (rec.completedOnS + rec.repeatS) * 1000;
  if (readyAtMs > nowMs) return false;
  return !(rec.maxSolves === 1 && rec.solves <= 1);
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}

export class QuestTracker {
  /**
   * @param {{subscribe?: (type:string, fn:(sig:object)=>void) => (() => void), runChat?: (line:string) => unknown,
   *          now?: () => number, log?: (msg:string) => void}} deps
   */
  constructor({ subscribe = null, runChat = null, now = Date.now, log } = {}) {
    this._now = typeof now === "function" ? now : Date.now;
    this._log = typeof log === "function" ? log : (m) => console.log(`[vt:quests] ${m}`);
    this._runChat = typeof runChat === "function" ? runChat : null;
    this._flags = new Map();
    this._refreshing = false;
    this._gotFirst = false;
    this._lastLineAt = 0;
    this._startedAt = 0;
    this._unsub = null;
    if (typeof subscribe === "function") {
      try {
        const u = subscribe("chat", (sig) => this.onChatLine(sig && typeof sig === "object" ? sig.text : sig));
        this._unsub = typeof u === "function" ? u : null;
      } catch (e) {
        this._log(`cannot subscribe to chat: ${errText(e)}`);
      }
    }
  }

  _t() {
    try {
      const v = Number(this._now());
      return Number.isFinite(v) ? v : 0;
    } catch (_) {
      return 0;
    }
  }

  /** Send /myquests (no-op while a refresh runs or without a chat path). → true when sent. */
  refresh() {
    try {
      this.tick(this._t());
      if (this._refreshing || !this._runChat) return false;
      this._refreshing = true;
      this._gotFirst = false;
      this._startedAt = this._t();
      this._lastLineAt = this._startedAt;
      this._runChat("/myquests");
      return true;
    } catch (e) {
      this._refreshing = false;
      this._log(`refresh failed: ${errText(e)}`);
      return false;
    }
  }

  /** Feed a chat line (the "chat" signal subscription does this). */
  onChatLine(text) {
    try {
      if (!this._refreshing) return;
      const s = String(text ?? "");
      if (END_LINES.some((re) => re.test(s))) {
        this._refreshing = false;
        return;
      }
      const rec = parseQuestLine(s);
      if (!rec) return;
      this._gotFirst = true;
      this._lastLineAt = this._t();
      this._flags.set(rec.key, rec);
    } catch (e) {
      this._log(`bad quest line: ${errText(e)}`);
    }
  }

  /** End-of-list detection by silence / timeout. */
  tick(nowMs) {
    if (!this._refreshing) return;
    const t = Number.isFinite(nowMs) ? nowMs : this._t();
    if (this._gotFirst ? t - this._lastLineAt >= SILENCE_MS : t - this._startedAt >= TIMEOUT_MS) this._refreshing = false;
  }

  isRefreshing() {
    this.tick(this._t());
    return this._refreshing;
  }

  _get(name) {
    return this._flags.get(String(name ?? "").trim().toLowerCase()) || null;
  }

  /** testquestflag: the key is in the cached list. */
  testFlag(name) {
    return this._get(name) !== null;
  }

  /** getqueststatus: 1 ready (or unknown), 0 not ready. */
  status(name) {
    const rec = this._get(name);
    return rec === null ? 1 : questReady(rec, this._t()) ? 1 : 0;
  }

  /** getquestktprogress: solves, 0 when unknown. */
  ktProgress(name) {
    const rec = this._get(name);
    return rec ? rec.solves : 0;
  }

  /** getquestktrequired: max solves, 0 when unknown. */
  ktRequired(name) {
    const rec = this._get(name);
    return rec ? rec.maxSolves : 0;
  }

  /** Read-only view of the cache (diagnostics / panel). */
  flags() {
    return [...this._flags.values()].map((r) => ({ ...r }));
  }

  dispose() {
    try {
      this._unsub?.();
    } catch (_) {
      /* already gone */
    }
    this._unsub = null;
    this._refreshing = false;
  }
}
