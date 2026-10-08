document.getElementById("gfx-lab")?.remove();
const el = document.createElement("div");
el.id = "gfx-lab";
el.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;background:rgba(10,12,16,.82);color:#e8e8e8;font:13px/1.35 system-ui,sans-serif;padding:10px 12px;border-radius:8px;border:1px solid #444;min-width:230px;user-select:none";
el.innerHTML = `<div style="font-weight:600;margin-bottom:6px">Graphics lab <span id="gl-x" style="float:right;cursor:pointer;opacity:.7">✕</span></div>
<div>Time of day</div><div id="gl-tod" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div>
<div>Compare</div><div id="gl-ab" style="display:flex;gap:6px;flex-wrap:wrap"></div>
<div id="gl-msg" style="margin-top:8px;opacity:.75;font-size:12px">Temporary panel from Claude — nothing is saved.</div>`;
for (const ev of ["mousedown", "mouseup", "click", "wheel", "keydown", "pointerdown", "pointerup", "contextmenu"]) el.addEventListener(ev, (e) => e.stopPropagation());
document.body.appendChild(el);
const btn = (parent, name, fn) => { const b = document.createElement("button"); b.textContent = name; b.style.cssText = "padding:4px 8px;border:1px solid #555;border-radius:5px;background:#2a2d33;color:#fff;cursor:pointer"; b.onclick = () => { fn(b); window.__gfxLabLog = (window.__gfxLabLog || []).concat([{ t: Date.now(), b: b.textContent }]); }; parent.appendChild(b); return b; };
const tod = el.querySelector("#gl-tod");
for (const [name, t] of [["Dawn", 0.21], ["Morning", 0.33], ["Noon", 0.5], ["Dusk", 0.89], ["Night", 0.0]]) btn(tod, name, () => window.__sessionHandle.setSkyTimeOverride(t));
const ab = el.querySelector("#gl-ab");
btn(ab, "AO: ON", (b) => { window.__ssao.off = !window.__ssao.off; b.textContent = "AO: " + (window.__ssao.off ? "OFF" : "ON"); });
btn(ab, "Grade: ON", (b) => { window.__grade.off = !window.__grade.off; b.textContent = "Grade: " + (window.__grade.off ? "OFF" : "ON"); });
btn(ab, "Grass: ON", (b) => { let g = null; window.liveScene3d.scene.traverse((o) => { if (!g && o.name === "terrainGrass") g = o; }); if (g) { g.visible = !g.visible; b.textContent = "Grass: " + (g.visible ? "ON" : "OFF"); } });
btn(ab, "Night glow fix: ON", (b) => { const on = b.textContent.endsWith("ON"); const u = new URL(location.href); if (on) u.searchParams.set("lumNight", "off"); else u.searchParams.delete("lumNight"); history.replaceState(null, "", u); b.textContent = "Night glow fix: " + (on ? "OFF" : "ON"); });
btn(ab, "Wall fill: ON", (b) => { const on = b.textContent.endsWith("ON"); window.__retailFill.setGain(on ? 0 : 4.5); b.textContent = "Wall fill: " + (on ? "OFF" : "ON"); });
el.querySelector("#gl-x").onclick = () => el.remove();
return "panel up";
