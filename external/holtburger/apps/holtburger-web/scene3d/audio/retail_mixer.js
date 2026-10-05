// Retail positional sound mix — pure math, no Web Audio.
//
// Ported from OpenAC src/AcDream.Core/Audio/RetailSoundMixer.cs (MIT,
// Copyright (c) 2026 Erik Nihlén and OpenAC contributors), checked line by
// line against the retail decomp (acclient.c, read 2026-10-05):
//
// SoundManager::GetAttenuation(distance, volume, *attenuation, is_ambient)
// (acclient.c:383079-383118):
//   v = distance >= 5 ? 25 * volume / distance^2 : volume   (VOL_MIN_DIST_SQ)
//   v = min(v, 1)                                           (clamp BEFORE slider)
//   v *= is_ambient ? ambient_sound_volume : effect_sound_volume
//   v <= 0            -> attenuation = VOL_MIN, do not play
//   dB = ceil(log2(v) * 6.0206)
//   dB <  VOL_MIN(-50) -> do not play
//
// SoundManager::PlaySoundInternal(ref, Position*, volume, is_ambient)
// (acclient.c:383152-383180) — the pan:
//   player_heading = Frame::get_heading(listener frame)
//   angle = Position::heading(source, listener)    (bearing source->listener)
//   d = fmod(angle - player_heading, 360); if (d > 180) d -= 360
//   pan = (int)|dist| >= 5 ? (int)(sin(d deg) * -15) : 0
// Yaw only: Position::heading zeroes direction.z and returns 0 when the
// horizontal offset is too small to normalize (acclient.c:467051-467062).
// The pan and the attenuation are computed ONCE, when the sound starts, and
// handed to SoundBuf::Play (383179) — nothing re-mixes a playing voice.
//
// Divergence from the OpenAC port: OpenAC computes dB as 20*log10(g);
// retail uses log2(g)*6.0206 (383098) and so do we. OpenAC's degenerate
// purely-vertical bearing goes through atan2(0,0); retail returns heading 0
// for a too-small horizontal offset (467058-467059) and so do we.

export const VOL_MIN_DISTANCE = 5.0;
export const VOL_MIN_DISTANCE_SQ = 25.0;
export const VOL_MIN_DECIBELS = -50;
export const PAN_SCALE = -15.0;
export const PAN_DEADZONE_METRES = 5;
// Retail multiplies by a 0.017453292 constant (acclient.c:383173). Using it
// verbatim in doubles makes sin(90 deg) land a hair under 1, so a source
// exactly abeam pans 14 instead of 15; OpenAC's float port lands on 15. The
// x87 extended-precision result for exactly +-90 deg is unverified, so we
// keep the exact pi/180 (pans 15 abeam, identical everywhere else).
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 57.29577951308232; // acclient.c:467061

/**
 * Retail GetAttenuation. Returns { play, decibels }.
 * @param {number} distance metres
 * @param {number} volume   per-sound volume (wire / SoundTable row / hook)
 * @param {number} master   effect or ambient slider (0..1)
 */
export function getAttenuation(distance, volume, master = 1.0) {
  let g = distance >= VOL_MIN_DISTANCE
    ? (VOL_MIN_DISTANCE_SQ * volume) / (distance * distance)
    : volume;
  if (g > 1.0) g = 1.0;
  g *= master;
  if (!(g > 0.0)) return { play: false, decibels: VOL_MIN_DECIBELS };
  const db = Math.ceil(Math.log2(g) * 6.0206);
  if (db >= VOL_MIN_DECIBELS) return { play: true, decibels: db };
  return { play: false, decibels: VOL_MIN_DECIBELS };
}

/**
 * Retail compass heading from `from` to `to` in the AC frame (+X east,
 * +Y north): 0 = north, 90 = east. Z ignored; 0 when horizontally coincident.
 */
export function compassHeadingDegrees(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < 1e-4) return 0;
  let h = (450 - Math.atan2(dy, dx) * RAD2DEG) % 360;
  if (h < 0) h += 360;
  return h;
}

/** Retail `fmod(x, 360); if (x > 180) x -= 360` (large negatives kept). */
export function normalizeSignedDegrees(deg) {
  let d = deg % 360;
  if (!(d <= 180)) d -= 360;
  return d;
}

/** Retail integer pan in dB-ish units, -15 (left) .. +15 (right). */
export function getPan(bearingSourceToListener, listenerHeading, distance, panningEnabled = true) {
  if (!panningEnabled) return 0;
  if (Math.abs(Math.trunc(distance)) < PAN_DEADZONE_METRES) return 0;
  const d = normalizeSignedDegrees(bearingSourceToListener - listenerHeading);
  const pan = Math.trunc(Math.sin(d * DEG2RAD) * PAN_SCALE);
  return Math.max(PAN_SCALE, Math.min(-PAN_SCALE, pan)) | 0;
}

/**
 * Full retail voice mix for a positional sound (AC frame).
 * @returns {{play:boolean, decibels:number, pan:number, distance:number}}
 */
export function mix(listenerPos, listenerHeading, sourcePos, volume, master = 1.0, panningEnabled = true) {
  const dx = sourcePos.x - listenerPos.x;
  const dy = sourcePos.y - listenerPos.y;
  const dz = sourcePos.z - listenerPos.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const bearing = compassHeadingDegrees(sourcePos, listenerPos);
  const pan = getPan(bearing, listenerHeading, distance, panningEnabled);
  const { play, decibels } = getAttenuation(distance, volume, master);
  return { play, decibels, pan, distance };
}

/** Linear gain for an integer dB attenuation. */
export function linearGain(decibels) {
  return Math.pow(10, decibels / 20);
}

/**
 * StereoPannerNode position for a retail pan. DirectSound SetPan is a dB
 * difference between channels; an equal-power panner at position p gives
 * right/left = tan((p+1)*pi/4), so p = (4/pi)*atan(10^(pan/20)) - 1.
 */
export function stereoPositionFromPan(pan) {
  const diff = Math.pow(10, pan / 20);
  const p = (4 / Math.PI) * Math.atan(diff) - 1;
  return Math.max(-1, Math.min(1, p));
}

/** Largest distance (m) at which a sound of `volume` still plays. */
export function audibleRadius(volume, master = 1.0) {
  const scale = volume * master;
  if (!(scale > 0)) return 0;
  // dB >= -50 <=> log2(g)*6.0206 > -51  <=> g > 2^(-51/6.0206)
  const minGain = Math.pow(2, -51 / 6.0206);
  return Math.sqrt((VOL_MIN_DISTANCE_SQ * scale) / minGain);
}

// ── three.js <-> AC frame (worldRoot rotation.x = -pi/2; adapter.js acToThree
//    maps AC (x,y,z) -> three (x, z, -y)). The AudioContext lives in the
//    three.js frame (index.js setListener feeds camera.position/quaternion).
export function threeToAc(p) {
  return { x: p.x, y: -p.z, z: p.y };
}

/**
 * Listener compass heading from a three.js camera quaternion: rotate the
 * camera forward (0,0,-1), map to AC (x, -z), heading = 90 - atan2(y, x).
 */
export function headingFromThreeQuaternion(q) {
  const { w, x, y, z } = q;
  const fx = -2 * (x * z + w * y);
  const fz = -(1 - 2 * (x * x + y * y));
  const acX = fx;
  const acY = -fz;
  if (Math.hypot(acX, acY) < 1e-6) return 0;
  let h = (90 - Math.atan2(acY, acX) * RAD2DEG) % 360;
  if (h < 0) h += 360;
  return h;
}
