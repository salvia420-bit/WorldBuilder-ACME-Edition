// scene3d/vehicle/radar_scope.js — 20-Mile PPI Radar Scope HUD (Milestone 5 Feature 41)
// Plan Position Indicator (PPI) circular radar scope HUD overlay rendered via Canvas2D.
// Features 20-mile range rings (5, 10, 15, 20 mi), 15 RPM sweep line synchronized with 3D dish,
// and contact blips from S2C 0x090A VehicleRadarContacts with IFF color classification.

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

/**
 * Renders the circular PPI radar scope onto a 2D canvas context.
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
  ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  // 3. 15 RPM Rotating Sweep Line: (simTimeSec * 15 * 2 * PI / 60) % (2 * PI)
  const omega = (RADAR_SCOPE_SPECS.dishRpm * 2 * Math.PI) / 60.0;
  const azimuth = (simTimeSec * omega) % (2 * Math.PI);

  // Sweep phosphor trail (30 deg fading sector)
  const trailAngle = (30 * Math.PI) / 180;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  grad.addColorStop(0, "rgba(50, 220, 90, 0.35)");
  grad.addColorStop(1, "rgba(50, 220, 90, 0.0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, radius, azimuth - Math.PI / 2 - trailAngle, azimuth - Math.PI / 2);
  ctx.closePath();
  ctx.fill();

  // Sweep Line
  const sweepX = cx + radius * Math.sin(azimuth);
  const sweepY = cy - radius * Math.cos(azimuth);
  ctx.strokeStyle = RADAR_SCOPE_SPECS.colors.sweepLine;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(sweepX, sweepY);
  ctx.stroke();

  // 4. Contact Blips
  for (const c of contacts) {
    const dx = c.dx !== undefined ? c.dx : (c.dxM !== undefined ? c.dxM : 0);
    const dy = c.dy !== undefined ? c.dy : (c.dyM !== undefined ? c.dyM : 0);
    const dist = Math.hypot(dx, dy);
    if (dist > RADAR_SCOPE_SPECS.maxRangeM) continue;

    const bx = cx + (dx / RADAR_SCOPE_SPECS.maxRangeM) * radius;
    const by = cy - (dy / RADAR_SCOPE_SPECS.maxRangeM) * radius;

    // Contact color by Standing
    let color = RADAR_SCOPE_SPECS.colors.unknown;
    if (c.standing === 1) color = RADAR_SCOPE_SPECS.colors.friendly;
    else if (c.standing === 2) color = RADAR_SCOPE_SPECS.colors.neutral;
    else if (c.standing === 3) color = RADAR_SCOPE_SPECS.colors.hostile;

    // Blip decay based on sweep distance
    const contactAz = Math.atan2(dx, dy); // [ -PI, PI ]
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
      const hdg = typeof c.heading === "number" ? c.heading : (c.headingU8 / 255) * 2 * Math.PI;
      const speedVal = c.speed !== undefined ? c.speed : (c.speedMps !== undefined ? c.speedMps : (c.speedMpsU8 || 15));
      const vLen = Math.min(16, Math.max(5, speedVal * 0.15));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + vLen * Math.sin(hdg), by - vLen * Math.cos(hdg));
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * DOM container manager for the PPI Radar Scope HUD.
 */
export class RadarScopeHud {
  constructor(opts = {}) {
    this.width = opts.width || 256;
    this.height = opts.height || 256;
    this.container = null;
    this.canvas = null;
    this.ctx = null;
    this.contacts = [];
    this.visible = true;
  }
  mount(parent = (typeof document !== "undefined" ? document.body : null)) {
    if (!parent || typeof document === "undefined") return;
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
  update({ simTimeSec = 0, contacts = null, visible = undefined }) {
    if (visible !== undefined) {
      this.visible = Boolean(visible);
      if (this.container) this.container.style.display = this.visible ? "block" : "none";
    }
    if (contacts) this.contacts = contacts;
    if (this.ctx && this.visible) {
      this.ctx.clearRect(0, 0, this.width, this.height);
      renderRadarScope(this.ctx, this.width, this.height, { simTimeSec, contacts: this.contacts });
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
  }
}
