// scene3d/vehicle/radar_scope.js — Combined Air/Ground Radar Scope HUD (M3)
// Features 20-mile Air Search (15 RPM) + 600m Ground Defense (30 RPM) dual-sweep PPI display.
// Supports directional air triangles, kind-based ground contact icons, and IFF standing classification.
// Fully backward compatible with legacy renderRadarScope for AN/TPS-1 radar station callers.

export const RADAR_SCOPE_SPECS = Object.freeze({
  maxRangeM: 32187.0,          // 20 statute miles
  dishRpm: 15.0,               // 15 RPM (90 deg/s)
  dishPeriodSec: 4.0,          // 4.0 seconds per revolution
  ringsMiles: Object.freeze([5, 10, 15, 20]), // Concentric range rings
  colors: Object.freeze({
    scopeBg: "#021408",
    scopeBorder: "#2a7040",
    gridLines: "rgba(50, 180, 80, 0.35)",
    sweepLine: "rgba(80, 255, 120, 0.95)",
    sweepTrail: "rgba(50, 220, 90, ",
    friendly: "#00ff66",       // Standing 1 (Green)
    neutral: "#ffaa00",        // Standing 2 (Amber)
    hostile: "#ff3333",        // Standing 3 (Red)
    unknown: "#00e5ff",        // Standing 0 (Cyan)
  }),
});

export const COMBINED_RADAR_SPECS = Object.freeze({
  airMaxRangeM: 32187.0,          // 20 statute miles
  airRpm: 15.0,                   // 15 RPM (90 deg/s, period 4.0s)
  airPeriodSec: 4.0,
  groundMaxRangeM: 600.0,         // 600m surface defense perimeter
  groundRpm: 30.0,                // 30 RPM (180 deg/s, period 2.0s)
  groundPeriodSec: 2.0,
  ringsMiles: Object.freeze([5, 10, 15, 20]),
  colors: Object.freeze({
    scopeBg: "#021408",
    scopeBorder: "#2a7040",
    gridLines: "rgba(50, 180, 80, 0.35)",
    groundRing: "rgba(255, 170, 0, 0.5)",
    airSweepLine: "rgba(80, 255, 120, 0.9)",
    groundSweepLine: "rgba(255, 180, 50, 0.95)",
    friendly: "#00ff66",          // Standing 1 (Green)
    neutral: "#ffaa00",           // Standing 2 (Amber)
    hostile: "#ff3333",           // Standing 3 (Red)
    unknown: "#00e5ff",           // Standing 0 (Cyan)
  }),
});

/**
 * Legacy single-channel circular PPI radar scope.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {object} state
 */
export function renderRadarScope(ctx, width, height, state = {}) {
  const { simTimeSec = 0, contacts = [] } = state;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(cx, cy) - 10;
  if (radius <= 0) return;

  // 1. CRT Background
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
  ctx.fillStyle = RADAR_SCOPE_SPECS.colors.scopeBg;
  ctx.fill();
  ctx.strokeStyle = RADAR_SCOPE_SPECS.colors.scopeBorder;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.clip();

  // 2. Range Rings & Crosshairs
  ctx.strokeStyle = RADAR_SCOPE_SPECS.colors.gridLines;
  ctx.lineWidth = 1;
  for (const mi of RADAR_SCOPE_SPECS.ringsMiles) {
    const r = (mi / 20.0) * radius;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy); // vfx-lint-allow: canvas 2d moveTo
  ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius); // vfx-lint-allow: canvas 2d moveTo
  ctx.stroke();

  // 3. 15 RPM Rotating Sweep Line: (simTimeSec * 15 * 2 * PI / 60) % (2 * PI)
  const safeSimTime = Number.isFinite(simTimeSec) ? simTimeSec : 0;
  const omega = (RADAR_SCOPE_SPECS.dishRpm * 2 * Math.PI) / 60.0;
  const azimuth = (safeSimTime * omega) % (2 * Math.PI);

  // Sweep phosphor trail (30 deg fading sector)
  const trailAngle = (30 * Math.PI) / 180;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  grad.addColorStop(0, "rgba(50, 220, 90, 0.35)");
  grad.addColorStop(1, "rgba(50, 220, 90, 0.0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(cx, cy); // vfx-lint-allow: canvas 2d moveTo
  ctx.arc(cx, cy, radius, azimuth - Math.PI / 2 - trailAngle, azimuth - Math.PI / 2);
  ctx.closePath();
  ctx.fill();

  // Sweep Line
  const sweepX = cx + radius * Math.sin(azimuth);
  const sweepY = cy - radius * Math.cos(azimuth);
  ctx.strokeStyle = RADAR_SCOPE_SPECS.colors.sweepLine;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy); // vfx-lint-allow: canvas 2d moveTo
  ctx.lineTo(sweepX, sweepY);
  ctx.stroke();

  // 4. Contact Blips
  for (const c of contacts) {
    const dx = c.dx !== undefined ? c.dx : (c.dxM !== undefined ? c.dxM : 0);
    const dy = c.dy !== undefined ? c.dy : (c.dyM !== undefined ? c.dyM : 0);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    const dist = Math.hypot(dx, dy);
    if (!Number.isFinite(dist) || dist > RADAR_SCOPE_SPECS.maxRangeM) continue;

    const bx = cx + (dx / RADAR_SCOPE_SPECS.maxRangeM) * radius;
    const by = cy - (dy / RADAR_SCOPE_SPECS.maxRangeM) * radius;

    // Contact color by Standing
    let color = RADAR_SCOPE_SPECS.colors.unknown;
    if (c.standing === 1) color = RADAR_SCOPE_SPECS.colors.friendly;
    else if (c.standing === 2) color = RADAR_SCOPE_SPECS.colors.neutral;
    else if (c.standing === 3) color = RADAR_SCOPE_SPECS.colors.hostile;

    // Blip decay based on sweep distance
    const contactAz = Math.atan2(dx, dy);
    const normAz = contactAz < 0 ? contactAz + 2 * Math.PI : contactAz;
    let delta = (azimuth - normAz) % (2 * Math.PI);
    if (delta < 0) delta += 2 * Math.PI;
    const alpha = Math.max(0.25, 1.0 - (delta / (2 * Math.PI)) * 0.75);

    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(bx, by, 3.5, 0, 2 * Math.PI);
    ctx.fill();

    // Heading velocity vector
    if (c.heading !== undefined || c.headingU8 !== undefined) {
      const hdg = typeof c.heading === "number" && Number.isFinite(c.heading)
        ? c.heading
        : ((Number.isFinite(c.headingU8) ? c.headingU8 : 0) / 255) * 2 * Math.PI;
      const rawSpeed = c.speed !== undefined ? c.speed : (c.speedMps !== undefined ? c.speedMps : (c.speedMpsU8 || 15));
      const speedVal = Number.isFinite(rawSpeed) ? rawSpeed : 15;
      const vLen = Math.min(16, Math.max(5, speedVal * 0.15));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(bx, by); // vfx-lint-allow: canvas 2d moveTo
      ctx.lineTo(bx + vLen * Math.sin(hdg), by - vLen * Math.cos(hdg));
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * Renders the combined Air/Ground dual-sweep PPI radar scope onto a 2D canvas context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {object} state
 */
export function renderCombinedRadarScope(ctx, width, height, state = {}) {
  const { simTimeSec = 0, airContacts = [], groundContacts = [], contacts = [] } = state;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(cx, cy) - 10;
  if (radius <= 0) return;

  const airList = airContacts.length > 0 ? airContacts : contacts;

  ctx.save();

  // 1. CRT Base
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
  ctx.fillStyle = COMBINED_RADAR_SPECS.colors.scopeBg;
  ctx.fill();
  ctx.strokeStyle = COMBINED_RADAR_SPECS.colors.scopeBorder;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.clip();

  // 2. Air Search 20-mile concentric rings (5, 10, 15, 20 mi) & crosshairs
  ctx.strokeStyle = COMBINED_RADAR_SPECS.colors.gridLines;
  ctx.lineWidth = 1;
  for (const mi of COMBINED_RADAR_SPECS.ringsMiles) {
    const r = (mi / 20.0) * radius;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy); // vfx-lint-allow: canvas 2d moveTo
  ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius); // vfx-lint-allow: canvas 2d moveTo
  ctx.stroke();

  // 3. Inner Tactical Disc (600m Ground Defense Perimeter, 25% radius)
  const rGround = radius * 0.25;
  ctx.strokeStyle = COMBINED_RADAR_SPECS.colors.groundRing;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, rGround, 0, 2 * Math.PI);
  ctx.stroke();

  // 4. Dual Sweeps:
  // Air Sweep: 15 RPM (period 4.0s)
  const safeSimTime = Number.isFinite(simTimeSec) ? simTimeSec : 0;
  const omegaAir = (COMBINED_RADAR_SPECS.airRpm * 2 * Math.PI) / 60.0;
  const azAir = (safeSimTime * omegaAir) % (2 * Math.PI);

  // Air Phosphor Trail (30 deg sector)
  const trailAngleAir = (30 * Math.PI) / 180;
  const gradAir = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradAir.addColorStop(0, "rgba(50, 220, 90, 0.35)");
  gradAir.addColorStop(1, "rgba(50, 220, 90, 0.0)");
  ctx.fillStyle = gradAir;
  ctx.beginPath();
  ctx.moveTo(cx, cy); // vfx-lint-allow: canvas 2d moveTo
  ctx.arc(cx, cy, radius, azAir - Math.PI / 2 - trailAngleAir, azAir - Math.PI / 2);
  ctx.closePath();
  ctx.fill();

  // Air Sweep Line
  ctx.strokeStyle = COMBINED_RADAR_SPECS.colors.airSweepLine;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy); // vfx-lint-allow: canvas 2d moveTo
  ctx.lineTo(cx + radius * Math.sin(azAir), cy - radius * Math.cos(azAir));
  ctx.stroke();

  // Ground Sweep: 30 RPM (period 2.0s) — exactly 2x angular velocity of Air sweep
  const omegaGround = (COMBINED_RADAR_SPECS.groundRpm * 2 * Math.PI) / 60.0;
  const azGround = (safeSimTime * omegaGround) % (2 * Math.PI);

  // Ground Phosphor Trail (30 deg amber sector within rGround)
  const trailAngleGround = (30 * Math.PI) / 180;
  const gradGround = ctx.createRadialGradient(cx, cy, 0, cx, cy, rGround);
  gradGround.addColorStop(0, "rgba(255, 170, 40, 0.4)");
  gradGround.addColorStop(1, "rgba(255, 170, 40, 0.0)");
  ctx.fillStyle = gradGround;
  ctx.beginPath();
  ctx.moveTo(cx, cy); // vfx-lint-allow: canvas 2d moveTo
  ctx.arc(cx, cy, rGround, azGround - Math.PI / 2 - trailAngleGround, azGround - Math.PI / 2);
  ctx.closePath();
  ctx.fill();

  // Ground Sweep Line
  ctx.strokeStyle = COMBINED_RADAR_SPECS.colors.groundSweepLine;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy); // vfx-lint-allow: canvas 2d moveTo
  ctx.lineTo(cx + rGround * Math.sin(azGround), cy - rGround * Math.cos(azGround));
  ctx.stroke();

  // 5. Air Contacts (Directional Triangle `^` + altitude)
  for (const ac of airList) {
    const dx = ac.dxM !== undefined ? ac.dxM : (ac.dx || 0);
    const dy = ac.dyM !== undefined ? ac.dyM : (ac.dy || 0);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    const dist = Math.hypot(dx, dy);
    if (!Number.isFinite(dist) || dist > COMBINED_RADAR_SPECS.airMaxRangeM) continue;

    const bx = cx + (dx / COMBINED_RADAR_SPECS.airMaxRangeM) * radius;
    const by = cy - (dy / COMBINED_RADAR_SPECS.airMaxRangeM) * radius;

    let col = COMBINED_RADAR_SPECS.colors.unknown;
    if (ac.standing === 1) col = COMBINED_RADAR_SPECS.colors.friendly;
    else if (ac.standing === 2) col = COMBINED_RADAR_SPECS.colors.neutral;
    else if (ac.standing === 3) col = COMBINED_RADAR_SPECS.colors.hostile;

    const contactAz = Math.atan2(dx, dy);
    const normAz = contactAz < 0 ? contactAz + 2 * Math.PI : contactAz;
    let delta = (azAir - normAz) % (2 * Math.PI);
    if (delta < 0) delta += 2 * Math.PI;
    const alpha = Math.max(0.25, 1.0 - (delta / (2 * Math.PI)) * 0.75);

    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.globalAlpha = alpha;

    ctx.beginPath();
    ctx.moveTo(bx, by - 4); // vfx-lint-allow: canvas 2d moveTo
    ctx.lineTo(bx - 3, by + 3);
    ctx.lineTo(bx + 3, by + 3);
    ctx.closePath();
    ctx.fill();

    const altAgl = ac.altAglM !== undefined ? ac.altAglM : ac.altAgl;
    if (Number.isFinite(altAgl)) {
      ctx.font = "8px sans-serif";
      ctx.fillText(`${Math.round(altAgl)}m`, bx + 5, by);
    }

    if (ac.heading !== undefined || ac.headingU8 !== undefined) {
      const hdg = typeof ac.heading === "number" && Number.isFinite(ac.heading)
        ? ac.heading
        : ((Number.isFinite(ac.headingU8) ? ac.headingU8 : 0) / 255) * 2 * Math.PI;
      const rawSpeed = ac.speed !== undefined ? ac.speed : (ac.speedMps !== undefined ? ac.speedMps : (ac.speedMpsU8 || 15));
      const speedVal = Number.isFinite(rawSpeed) ? rawSpeed : 15;
      const vLen = Math.min(16, Math.max(5, speedVal * 0.15));
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(bx, by); // vfx-lint-allow: canvas 2d moveTo
      ctx.lineTo(bx + vLen * Math.sin(hdg), by - vLen * Math.cos(hdg));
      ctx.stroke();
    }
  }

  // 6. Ground Contacts (Player=Circle, Vehicle=Diamond, Monster=Inverted Triangle)
  for (const gc of groundContacts) {
    const dx = gc.dxM !== undefined ? gc.dxM : (gc.dx || 0);
    const dy = gc.dyM !== undefined ? gc.dyM : (gc.dy || 0);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    const dist = Math.hypot(dx, dy);
    if (!Number.isFinite(dist) || dist > COMBINED_RADAR_SPECS.groundMaxRangeM) continue;

    const bx = cx + (dx / COMBINED_RADAR_SPECS.groundMaxRangeM) * rGround;
    const by = cy - (dy / COMBINED_RADAR_SPECS.groundMaxRangeM) * rGround;

    let col = COMBINED_RADAR_SPECS.colors.neutral;
    if (gc.standing === 1) col = COMBINED_RADAR_SPECS.colors.friendly;
    else if (gc.standing === 3) col = COMBINED_RADAR_SPECS.colors.hostile;

    const contactAz = Math.atan2(dx, dy);
    const normAz = contactAz < 0 ? contactAz + 2 * Math.PI : contactAz;
    let delta = (azGround - normAz) % (2 * Math.PI);
    if (delta < 0) delta += 2 * Math.PI;
    const alpha = Math.max(0.25, 1.0 - (delta / (2 * Math.PI)) * 0.75);

    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.globalAlpha = alpha;

    if (gc.kind === 1) {
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(bx, by, 3, 0, 2 * Math.PI);
      ctx.stroke();
    } else if (gc.kind === 2) {
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(bx, by - 4); // vfx-lint-allow: canvas 2d moveTo
      ctx.lineTo(bx + 4, by);
      ctx.lineTo(bx, by + 4);
      ctx.lineTo(bx - 4, by);
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(bx - 3, by - 3); // vfx-lint-allow: canvas 2d moveTo
      ctx.lineTo(bx + 3, by - 3);
      ctx.lineTo(bx, by + 4);
      ctx.closePath();
      ctx.fill();
    }

    if (gc.heading !== undefined || gc.headingU8 !== undefined) {
      const hdg = typeof gc.heading === "number" && Number.isFinite(gc.heading)
        ? gc.heading
        : ((Number.isFinite(gc.headingU8) ? gc.headingU8 : 0) / 255) * 2 * Math.PI;
      const rawSpeed = gc.speed !== undefined ? gc.speed : (gc.speedMps !== undefined ? gc.speedMps : (gc.speedMpsU8 || 5));
      const speedVal = Number.isFinite(rawSpeed) ? rawSpeed : 5;
      const vLen = Math.min(12, Math.max(4, speedVal * 0.2));
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(bx, by); // vfx-lint-allow: canvas 2d moveTo
      ctx.lineTo(bx + vLen * Math.sin(hdg), by - vLen * Math.cos(hdg));
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * DOM container manager for the Combined Air/Ground Radar Scope HUD.
 */
export class RadarScopeHud {
  constructor(opts = {}) {
    this.width = opts.width || 256;
    this.height = opts.height || 256;
    this.mode = opts.mode || "combined"; // "combined" | "air" | "ground"
    this.container = null;
    this.canvas = null;
    this.ctx = null;
    this.contacts = [];
    this.airContacts = [];
    this.groundContacts = [];
    this.visible = true; // vfx-lint-allow: hud visibility initial
  }
  mount(parent = (typeof document !== "undefined" ? document.body : null)) {
    if (!parent || typeof document === "undefined") return;
    if (this.container) {
      this.dispose();
    }
    this.container = document.createElement("div");
    this.container.id = "hb-radar-scope-hud";
    this.container.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:65;pointer-events:none;";
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    parent.appendChild(this.container);
  }
  update({ simTimeSec = 0, contacts = null, airContacts = null, groundContacts = null, visible = undefined } = {}) {
    if (visible !== undefined) {
      this.visible = Boolean(visible); // vfx-lint-allow: hud visibility toggle
      if (this.container) this.container.style.display = this.visible ? "block" : "none";
    }
    if (contacts) this.contacts = contacts;
    if (airContacts) {
      this.airContacts = airContacts;
      this.contacts = [];
    }
    if (groundContacts) this.groundContacts = groundContacts;
    if (this.ctx && this.visible) {
      this.ctx.clearRect(0, 0, this.width, this.height);
      if (this.mode === "air" && !airContacts && !groundContacts) {
        renderRadarScope(this.ctx, this.width, this.height, { simTimeSec, contacts: this.contacts });
      } else {
        renderCombinedRadarScope(this.ctx, this.width, this.height, {
          simTimeSec,
          airContacts: this.airContacts.length > 0 ? this.airContacts : this.contacts,
          groundContacts: this.groundContacts,
        });
      }
    }
  }
  dispose() {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
    this.canvas = null;
    this.ctx = null;
    this.contacts = [];
    this.airContacts = [];
    this.groundContacts = [];
  }
}

export const CombinedRadarScopeHud = RadarScopeHud;
