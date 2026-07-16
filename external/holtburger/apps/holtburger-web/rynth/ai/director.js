// director.js — the LLM check-in loop over the grind bot: observe -> chat ->
// parse plan -> execute -> journal -> reschedule. Minute-cadence setTimeout
// chain; hard budgets; every failure path leaves the bot grinding untouched.
// INTERFACE FROZEN — see rynth/ai/SPEC.md §director (incl. the REPLY
// CONTRACT). STUB: implementation owned by fan-out agent A4.

export const DEFAULT_SYSTEM_PROMPT = "(A4: role + action catalog + reply contract + cost discipline)";

export class RynthAiDirector {
  constructor(bot, {
    client, journal, observe,
    intervalMinutes = 5, minIntervalMinutes = 1, maxIntervalMinutes = 30,
    maxCallsPerHour = 12, maxErrorsBeforeDisable = 5,
    systemPrompt = DEFAULT_SYSTEM_PROMPT, dryRun = false, log,
  } = {}) {
    throw new Error("not implemented (A4)");
  }
  start() { throw new Error("not implemented (A4)"); }
  stop() { throw new Error("not implemented (A4)"); }
  get status() { throw new Error("not implemented (A4)"); }
  /** One check-in (also the manual trigger). Serialized. -> { plan, results } */
  async checkNow() { throw new Error("not implemented (A4)"); }
}
