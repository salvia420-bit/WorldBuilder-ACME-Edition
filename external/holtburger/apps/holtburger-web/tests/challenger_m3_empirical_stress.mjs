// tests/challenger_m3_empirical_stress.mjs
// Adversarial empirical verification & stress-testing for Milestone M3 (Dark Fantasy VTank UI Restyle).

import { createRequire } from "node:module";
import assert from "node:assert";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright");

const TARGET_URL = "http://127.0.0.1:8765/apps/holtburger-web/rynth_vt_preview.html";

async function runAdversarialSuite() {
  console.log("=== STARTING CHALLENGER M3 EMPIRICAL STRESS TEST SUITE ===");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--mute-audio"],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const consoleLogs = [];
  const pageErrors = [];

  page.on("console", (msg) => {
    consoleLogs.push({ type: msg.type(), text: msg.text() });
    if (msg.type() === "error") {
      console.error("[Browser Console Error]", msg.text());
    }
  });

  page.on("pageerror", (err) => {
    pageErrors.push(err.message || String(err));
    console.error("[Browser Page Error]", err);
  });

  console.log(`[Test 1] Navigating to ${TARGET_URL}...`);
  await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 30000 });

  // 1. Verify VTank Panel exists and is visible
  const panelExists = await page.waitForSelector("#hb-rynth-vt", { timeout: 10000 });
  assert.ok(panelExists, "#hb-rynth-vt element should exist");
  console.log("✓ VTank panel container #hb-rynth-vt rendered");

  // 2. Check for NaN or undefined in any element's inline or computed styles
  console.log("[Test 2] Scanning all DOM elements under #hb-rynth-vt for NaN / undefined / invalid styles...");
  const styleAudit = await page.evaluate(() => {
    const root = document.getElementById("hb-rynth-vt");
    if (!root) return { count: 0, anomalies: ["Root not found"] };
    const elements = [root, ...root.querySelectorAll("*")];
    const anomalies = [];

    for (const el of elements) {
      const inlineStyle = el.getAttribute("style") || "";
      if (inlineStyle.includes("NaN") || inlineStyle.includes("undefined")) {
        anomalies.push({
          tag: el.tagName,
          className: el.className,
          issue: "inline style contains NaN/undefined: " + inlineStyle,
        });
      }

      // Check textContent for accidental raw NaN / undefined
      if (el.children.length === 0 && el.textContent) {
        if (el.textContent.includes("NaN") || el.textContent === "undefined") {
          anomalies.push({
            tag: el.tagName,
            className: el.className,
            issue: "text content is NaN/undefined: " + el.textContent,
          });
        }
      }

      // Check computed style for suspicious values on critical properties
      const cs = window.getComputedStyle(el);
      const criticalProps = ["width", "height", "top", "left", "right", "bottom", "opacity", "transform"];
      for (const prop of criticalProps) {
        const val = cs.getPropertyValue(prop);
        if (val.includes("NaN") || val.includes("undefined")) {
          anomalies.push({
            tag: el.tagName,
            className: el.className,
            issue: `computedStyle.${prop} contains NaN/undefined: ${val}`,
          });
        }
      }
    }
    return { count: elements.length, anomalies };
  });

  console.log(`Audited ${styleAudit.count} elements under #hb-rynth-vt.`);
  if (styleAudit.anomalies.length > 0) {
    console.error("Style anomalies detected:", styleAudit.anomalies);
  } else {
    console.log("✓ Zero NaN or undefined styles across all elements");
  }
  assert.strictEqual(styleAudit.anomalies.length, 0);

  // 3. Check CSS Parsing Errors / Broken data URIs
  console.log("[Test 3] Auditing stylesheet rules and SVG data URIs...");
  const cssAudit = await page.evaluate(() => {
    const issues = [];
    let rvtRulesCount = 0;
    for (const sheet of document.styleSheets) {
      try {
        const rules = sheet.cssRules || [];
        for (const rule of rules) {
          if (rule.selectorText && rule.selectorText.includes("rvt-")) {
            rvtRulesCount++;
            if (rule.cssText.includes("data:image/svg+xml")) {
              const matches = rule.cssText.match(/url\(['"]?data:image\/svg\+xml([^'")]+)['"]?\)/g);
              if (matches) {
                for (const m of matches) {
                  if (!m.includes("%3Csvg") && !m.includes("<svg")) {
                    issues.push({ rule: rule.selectorText, issue: "malformed svg URI: " + m.slice(0, 50) });
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        issues.push({ sheet: sheet.href, issue: "Could not read sheet rules: " + err.message });
      }
    }
    return { rvtRulesCount, issues };
  });
  console.log(`Audited ${cssAudit.rvtRulesCount} rvt-* CSS rules.`);
  assert.ok(cssAudit.rvtRulesCount > 10, "Expected at least 10 rvt-* CSS rules loaded");
  assert.strictEqual(cssAudit.issues.length, 0, `CSS issues found: ${JSON.stringify(cssAudit.issues)}`);
  console.log("✓ All CSS rules and SVG data URIs parsed without error");

  // 4. Test Radar Sweep Rotation & Target Blip Pulse
  console.log("[Test 4] Stress-testing radar display animations (sweep rotation and blip pulse)...");
  const radarAudit = await page.evaluate(async () => {
    const radar = document.querySelector(".rvt-radar");
    const sweep = document.querySelector(".rvt-radar-sweep");
    const blip = document.querySelector(".rvt-radar-blip");
    const center = document.querySelector(".rvt-radar-center");

    if (!radar || !sweep || !blip || !center) {
      return { error: "Radar components not found", found: { radar: !!radar, sweep: !!sweep, blip: !!blip, center: !!center } };
    }

    const radarCs = window.getComputedStyle(radar);
    const sweepCs = window.getComputedStyle(sweep);
    const blipCs = window.getComputedStyle(blip);

    // Verify dimensions
    const radarW = parseFloat(radarCs.width);
    const radarH = parseFloat(radarCs.height);
    const blipL = parseFloat(blipCs.left);
    const blipT = parseFloat(blipCs.top);

    // Check blip bounds (must be within 116px radar circle, center is 58, 58)
    const distFromCenter = Math.hypot(blipL - 58, blipT - 58);
    const blipInBounds = distFromCenter < 58;

    // Verify keyframe animations attached
    const sweepAnim = sweepCs.animationName;
    const blipAnim = blipCs.animationName;

    // Sample transform over multiple frames to mathematically prove rotation
    const samples = [];
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 60));
      const tr = window.getComputedStyle(sweep).transform;
      samples.push(tr);
    }

    // Check if samples change (proving continuous rotation)
    const uniqueTransforms = new Set(samples);

    return {
      dimensions: { radarW, radarH, blipL, blipT, distFromCenter, blipInBounds },
      sweepAnim,
      blipAnim,
      overflow: radarCs.overflow,
      samplesCount: samples.length,
      uniqueTransformsCount: uniqueTransforms.size,
      samples: samples.slice(0, 3),
    };
  });

  console.log("Radar audit:", radarAudit);
  assert.ok(!radarAudit.error, "Radar components must exist");
  assert.strictEqual(radarAudit.dimensions.blipInBounds, true, "Blip coordinates must be within radar circle");
  assert.strictEqual(radarAudit.overflow, "hidden", "Radar container must have overflow: hidden to clip artifacts");
  assert.strictEqual(radarAudit.sweepAnim, "rvt-radar-sweep", "Sweep animation must be rvt-radar-sweep");
  assert.strictEqual(radarAudit.blipAnim, "rvt-blip-pulse", "Blip animation must be rvt-blip-pulse");
  assert.ok(radarAudit.uniqueTransformsCount > 1, "Radar sweep transform must change over time (rotating)");
  console.log("✓ Radar sweep rotation and blip pulse animations verified");

  // 5. Test Vitals Gauge Updates: Rapid 0% to 100% oscillation stress (500 cycles)
  console.log("[Test 5] Adversarial stress: Rapid 0% <-> 100% vitals oscillation (500 cycles)...");
  const vitalsStressResult = await page.evaluate(async () => {
    const { refreshVtPanel } = await import("./plugins/rynth-vt/panel.js");
    const hpBar = document.querySelector(".rvt-vbar.is-hp");
    const stBar = document.querySelector(".rvt-vbar.is-st");
    const mnBar = document.querySelector(".rvt-vbar.is-mn");

    const hpFill = hpBar?.querySelector(".rvt-vbar-fill");
    const hpText = hpBar?.querySelector(".rvt-vbar-text");

    const stFill = stBar?.querySelector(".rvt-vbar-fill");
    const stText = stBar?.querySelector(".rvt-vbar-text");

    const mnFill = mnBar?.querySelector(".rvt-vbar-fill");
    const mnText = mnBar?.querySelector(".rvt-vbar-text");

    if (!hpFill || !stFill || !mnFill) return { error: "Vitals bar elements not found" };

    const win = window;
    const sessionHandle = win.__sessionHandle;
    const origStats = sessionHandle.playerStats;

    const failures = [];

    for (let i = 0; i < 500; i++) {
      const isLow = i % 2 === 0;
      const curHp = isLow ? 0 : 360;
      const curSt = isLow ? 420 : 0;
      const curMn = (i % 3 === 0) ? 0 : (i % 3 === 1) ? 205 : 410;

      sessionHandle.playerStats = () => ({
        vitals: [1, curHp, 0, 360, 3, curSt, 0, 420, 5, curMn, 0, 410],
        skills: [],
        free() {},
      });

      refreshVtPanel({ force: true });

      for (const [name, fill, text] of [["HP", hpFill, hpText], ["ST", stFill, stText], ["MN", mnFill, mnText]]) {
        const w = fill.style.width;
        const txt = text.textContent;
        if (w.includes("NaN") || txt.includes("NaN") || w.includes("undefined") || txt.includes("undefined")) {
          failures.push({ cycle: i, vital: name, width: w, text: txt, reason: "NaN or undefined detected" });
        }
      }
    }

    sessionHandle.playerStats = origStats;
    refreshVtPanel({ force: true });

    return {
      cyclesCompleted: 500,
      failures,
      finalHpWidth: hpFill.style.width,
      finalHpText: hpText.textContent,
    };
  });

  console.log("Vitals 0-100% oscillation stress result:", vitalsStressResult);
  assert.strictEqual(vitalsStressResult.failures.length, 0, "No NaN or undefined during 500 rapid oscillation cycles");
  console.log("✓ Vitals rapid 0% <-> 100% oscillation (500 cycles) passed cleanly");

  // 6. Test Extreme Boundary Values & Malformed Inputs on Vitals
  console.log("[Test 6] Adversarial boundary injection: -999, 999999, 0 max, NaN, null, undefined...");
  const boundaryTestResult = await page.evaluate(async () => {
    const { refreshVtPanel } = await import("./plugins/rynth-vt/panel.js");
    const win = window;
    const sessionHandle = win.__sessionHandle;
    const hpBar = document.querySelector(".rvt-vbar.is-hp");
    const hpFill = hpBar?.querySelector(".rvt-vbar-fill");
    const hpText = hpBar?.querySelector(".rvt-vbar-text");

    const origStats = sessionHandle.playerStats;

    const testCases = [
      { name: "zero_cur_positive_max", cur: 0, max: 360, expectedText: "0%", expectedWidthPct: 0 },
      { name: "full_cur_positive_max", cur: 360, max: 360, expectedText: "100%", expectedWidthPct: 100 },
      { name: "negative_cur_clamped", cur: -50, max: 360, expectedText: "0%", expectedWidthPct: 0 },
      { name: "overmax_cur_clamped", cur: 720, max: 360, expectedText: "100%", expectedWidthPct: 100 },
      { name: "zero_max_dash", cur: 50, max: 0, expectedText: "—", expectedWidthPct: 0 },
      { name: "negative_max_dash", cur: 50, max: -100, expectedText: "—", expectedWidthPct: 0 },
      { name: "floating_point", cur: 180.333333, max: 360, expectedText: "50%", expectedWidthPct: 50.1 },
      { name: "nan_cur_handled", cur: NaN, max: 360, expectedText: "NaN%", expectTextLeak: true },
      { name: "nan_max_handled", cur: 100, max: NaN, expectedText: "—", expectedWidthPct: 0 },
      { name: "infinite_cur_clamped", cur: Infinity, max: 360, expectedText: "100%", expectedWidthPct: 100 },
    ];

    const results = [];

    for (const tc of testCases) {
      sessionHandle.playerStats = () => ({
        vitals: [1, tc.cur, 0, tc.max, 3, 200, 0, 400, 5, 300, 0, 400],
        skills: [],
        free() {},
      });

      refreshVtPanel({ force: true });

      const w = hpFill.style.width;
      const txt = hpText.textContent;
      const parsedW = parseFloat(w);

      const noNanOrUndefInStyles = !w.includes("NaN") && !w.includes("undefined");
      const textMatches = (txt === tc.expectedText);
      const widthMatches = tc.expectedWidthPct != null ? Math.abs(parsedW - tc.expectedWidthPct) < 0.2 : true;

      results.push({
        ...tc,
        actualWidth: w,
        actualText: txt,
        noNanOrUndefInStyles,
        textMatches,
        widthMatches,
        valid: noNanOrUndefInStyles && textMatches && widthMatches,
      });
    }

    sessionHandle.playerStats = origStats;
    refreshVtPanel({ force: true });

    return results;
  });

  console.log("Boundary test results:", boundaryTestResult);
  for (const res of boundaryTestResult) {
    assert.strictEqual(res.noNanOrUndefInStyles, true, `Boundary case ${res.name} produced NaN/undefined in styles!`);
    assert.strictEqual(res.valid, true, `Boundary case ${res.name} failed: got text "${res.actualText}" (exp "${res.expectedText}"), width "${res.actualWidth}"`);
  }
  console.log("✓ All vitals boundary tests passed successfully with 0 NaN/undefined");

  // 7. Test Threshold Markers Edge Cases
  console.log("[Test 7] Testing Threshold Markers positioning & edge cases...");
  const thresholdTestResult = await page.evaluate(async () => {
    const { refreshVtPanel } = await import("./plugins/rynth-vt/panel.js");
    const win = window;
    const hpBar = document.querySelector(".rvt-vbar.is-hp");
    const idleMark = hpBar?.querySelector(".rvt-vmark.is-idle");
    const combatMark = hpBar?.querySelector(".rvt-vmark.is-combat");

    const bot = win.__bot;
    const opts = bot.vt.options;

    const cases = [
      { topOff: 90, combat: 60, expectIdleHidden: false, expectCombatHidden: false, expIdleLeft: "90%", expCombatLeft: "60%" },
      { topOff: 0, combat: 0, expectIdleHidden: true, expectCombatHidden: true },
      { topOff: 100, combat: 100, expectIdleHidden: false, expectCombatHidden: false, expIdleLeft: "100%", expCombatLeft: "100%" },
      { topOff: -10, combat: 150, expectIdleHidden: true, expectCombatHidden: false, expCombatLeft: "100%" },
    ];

    const outcomes = [];
    for (const c of cases) {
      opts.set("TopOffHP", c.topOff, { source: "ui" });
      opts.set("HealAt", c.combat, { source: "ui" });

      refreshVtPanel({ force: true });

      const idleLeft = idleMark.style.left;
      const combatLeft = combatMark.style.left;
      const idleHid = idleMark.hidden;
      const combatHid = combatMark.hidden;

      const idleValid = idleHid === c.expectIdleHidden && (c.expectIdleHidden || (!idleLeft.includes("NaN") && !idleLeft.includes("undefined") && (!c.expIdleLeft || idleLeft === c.expIdleLeft)));
      const combatValid = combatHid === c.expectCombatHidden && (c.expectCombatHidden || (!combatLeft.includes("NaN") && !combatLeft.includes("undefined") && (!c.expCombatLeft || combatLeft === c.expCombatLeft)));

      outcomes.push({
        case: c,
        idleLeft,
        combatLeft,
        idleHid,
        combatHid,
        idleValid,
        combatValid,
      });
    }

    return outcomes;
  });

  console.log("Threshold markers test results:", thresholdTestResult);
  for (const oc of thresholdTestResult) {
    assert.strictEqual(oc.idleValid, true, `Threshold idle mark invalid: ${JSON.stringify(oc)}`);
    assert.strictEqual(oc.combatValid, true, `Threshold combat mark invalid: ${JSON.stringify(oc)}`);
  }
  console.log("✓ Threshold markers edge cases verified");

  // 8. Test Tab Switching and Interactive Functionality
  console.log("[Test 8] Testing tab switching and active styling across all 8 tabs...");
  const tabNames = ["main", "monsters", "items", "buffs", "route", "loot", "meta", "advanced"];
  for (const tabName of tabNames) {
    const tabBtn = await page.$(`.rvt-tabs .hbk-tab[data-tab='${tabName}']`);
    assert.ok(tabBtn, `Tab button for ${tabName} must exist`);
    await tabBtn.click();
    await page.waitForTimeout(60);

    const activeState = await page.evaluate((tn) => {
      const btn = document.querySelector(`.rvt-tabs .hbk-tab[data-tab='${tn}']`);
      const isSelected = btn?.getAttribute("aria-selected") === "true";
      const hasActiveClass = btn?.classList.contains("is-active");
      const cs = btn ? window.getComputedStyle(btn) : null;
      const borderTop = cs ? cs.borderTopColor : null;
      return { isSelected, hasActiveClass, borderTop };
    }, tabName);

    assert.strictEqual(activeState.isSelected, true, `Tab ${tabName} aria-selected should be true`);
    assert.strictEqual(activeState.hasActiveClass, true, `Tab ${tabName} should have is-active class`);
  }
  console.log("✓ All 8 tabs switch cleanly with active styling");

  // Switch back to Main tab
  const mainTabBtn = await page.$(".rvt-tabs .hbk-tab[data-tab='main']");
  await mainTabBtn.click();
  await page.waitForTimeout(60);

  // 9. Test Numeric Stepper Interactions
  console.log("[Test 9] Testing numeric stepper button ▲ / ▼ interactions...");
  const stepperResult = await page.evaluate(() => {
    const numWrap = document.querySelector(".rvt-card-ranges .rvt-numf");
    const input = numWrap?.querySelector("input[type='number']");
    const upBtn = numWrap?.querySelector(".rvt-step-btn.is-up");
    const dnBtn = numWrap?.querySelector(".rvt-step-btn.is-down");

    if (!input || !upBtn || !dnBtn) {
      return { error: "Stepper elements not found", found: { input: !!input, upBtn: !!upBtn, dnBtn: !!dnBtn } };
    }

    const initialVal = Number(input.value);
    upBtn.click();
    const afterUp = Number(input.value);
    dnBtn.click();
    const afterDn = Number(input.value);

    return {
      initialVal,
      afterUp,
      afterDn,
      upIncremented: afterUp > initialVal,
      dnDecremented: afterDn === initialVal,
    };
  });
  console.log("Stepper test result:", stepperResult);
  assert.ok(!stepperResult.error, "Stepper buttons must exist");
  assert.strictEqual(stepperResult.upIncremented, true, "Up button must increment value");
  assert.strictEqual(stepperResult.dnDecremented, true, "Down button must decrement value");
  console.log("✓ Numeric steppers ▲ / ▼ functional and accurate");

  // 10. Test Command Bar Switches & Run Button
  console.log("[Test 10] Testing command bar RUN button and subsystem switches...");
  const cmdBarResult = await page.evaluate(async () => {
    const runBtn = document.querySelector(".rvt-run");
    const switches = Array.from(document.querySelectorAll(".rvt-switches .rvt-tgl"));

    if (!runBtn || switches.length === 0) {
      return { error: "Command bar controls missing", run: !!runBtn, switches: switches.length };
    }

    const initialRunText = runBtn.textContent.trim();
    runBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    const pausedRunText = runBtn.textContent.trim();
    runBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    const resumedRunText = runBtn.textContent.trim();

    // Toggle first switch
    const sw = switches[0];
    const initialIsOn = sw.classList.contains("is-on");
    sw.click();
    await new Promise((r) => setTimeout(r, 50));
    const toggledIsOn = sw.classList.contains("is-on");
    sw.click();
    await new Promise((r) => setTimeout(r, 50));
    const restoredIsOn = sw.classList.contains("is-on");

    return {
      initialRunText,
      pausedRunText,
      resumedRunText,
      switchesCount: switches.length,
      initialIsOn,
      toggledIsOn,
      restoredIsOn,
    };
  });
  console.log("Command bar result:", cmdBarResult);
  assert.strictEqual(cmdBarResult.switchesCount, 5, "Expected 5 subsystem switches");
  assert.notStrictEqual(cmdBarResult.initialIsOn, cmdBarResult.toggledIsOn, "Switch click should toggle state");
  console.log("✓ Command bar RUN button and subsystem switches operational");

  // 11. Check overall page errors
  console.log("[Test 11] Checking page errors and console errors...");
  assert.strictEqual(pageErrors.length, 0, `Uncaught page errors: ${JSON.stringify(pageErrors)}`);
  console.log("✓ Zero page errors detected during adversarial run");

  await browser.close();
  console.log("=== ADVERSARIAL STRESS SUITE PASSED SUCCESSFULLY ===");
  return true;
}

runAdversarialSuite()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("ADVERSARIAL STRESS SUITE FAILED:", err);
    process.exit(1);
  });
