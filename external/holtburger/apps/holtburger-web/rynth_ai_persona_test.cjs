#!/usr/bin/env node
// Persona prompt wiring — text-level smoke (module-level coverage of the
// director lives in rynth_ai_director_test.cjs; this guards the explorer
// persona's load-bearing sections and the two wiring sites).
const fs = require("node:fs");
const path = require("node:path");

let fails = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails += 1;
};

const director = fs.readFileSync(path.join(__dirname, "rynth/ai/director.js"), "utf8");
const bot = fs.readFileSync(path.join(__dirname, "rynth/bot.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

check("EXPLORER_SYSTEM_PROMPT exported", /export const EXPLORER_SYSTEM_PROMPT/.test(director));

// The harness-load-bearing sections must exist in BOTH prompts.
const explorerBlock = director.split("EXPLORER_SYSTEM_PROMPT")[1] || "";
for (const section of ["ACTIONS", "REPLY CONTRACT", "MEMORY", "GROUND TRUTH", "_catalog"]) {
  check(`explorer prompt carries ${section}`, explorerBlock.includes(section));
}
check("explorer prompt has MISSION framing", explorerBlock.includes("Discovery is the score"));
check("explorer prompt demotes combat/shopping", explorerBlock.includes("NOT goals"));
check("explorer prompt forbids healing/vitals", explorerBlock.includes("NEVER heal"));
check("explorer prompt has no survival section", !explorerBlock.includes("SURVIVAL FLOOR"));
check("explorer reply contract identical", explorerBlock.includes('"next_check_minutes": <1..30>'));
check("bot.js kernel off-switch", /config\.kernel !== false\) kernel\.start\(\)/.test(bot));
check("index.html reads ?botKernel", /botParams\.get\("botKernel"\)/.test(html));

check("bot.js persona -> EXPLORER_SYSTEM_PROMPT branch",
  /persona === "explorer"/.test(bot) && /EXPLORER_SYSTEM_PROMPT/.test(bot));
check("bot.js explicit systemPrompt wins", /!aiCfg\.systemPrompt && aiCfg\.persona/.test(bot));
check("index.html reads ?botPersona", /botParams\.get\("botPersona"\)/.test(html));

console.log(fails === 0 ? "persona: all checks passed" : `persona: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
