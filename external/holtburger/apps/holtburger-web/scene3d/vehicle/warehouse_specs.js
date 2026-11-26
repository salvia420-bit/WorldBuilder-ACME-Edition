/**
 * Pure deterministic specifications, reserved WCIDs, NE Flatland site metadata,
 * millimeter-locked dimensional tables, and Zones A-D layout/rack solvers for
 * the Intermodal Automated Warehouse Hub.
 *
 * 1:1 parity contract for future ACE C# promotion.
 * Zero external imports.
 */

export const WAREHOUSE_WCID = Object.freeze({
  SteelRackBay: 4000040,
  AgfForklift: 4000041,
  AmrUnderride: 4000042,
  TransferStand: 4000043,
  ScissorLiftTable: 4000044,
  ChargingDock: 4000045,
});

export const WAREHOUSE_DEPLOYABLE_KIND = Object.freeze({
  SteelRackBay: 17,
  AgfForklift: 18,
  AmrUnderride: 19,
  TransferStand: 20,
  ScissorLiftTable: 21,
  ChargingDock: 22,
});

export const NE_FLATLAND_SITE = Object.freeze({
  bx: Object.freeze([0xe4, 0xee]),
  by: Object.freeze([0xf2, 0xf6]),
  landblockWidthM: 192.0,
  slabWidthM: 2112.0,
  slabDepthM: 960.0,
  worldMinX: 43776.0,
  worldMaxX: 45888.0,
  worldMinY: 46464.0,
  worldMaxY: 47424.0,
  origin: Object.freeze([44832.0, 46944.0, 0.0]),
  landblock: 0xe9f4,
  teleCmd: "@tele 93.60N 84.80E",
  groundZ: 0.0,
  apronVisualZ: 0.004,
  bodyEdgeMin: 193.0,
  bodyEdgeMax: 48767.0,
});

// Mirrors deployable_models.js & container_models.js for 0-import specs/kinematics
export const PALLET_ENVELOPE_SPECS = Object.freeze({
  width: 1.100,
  depth: 1.100,
  height: 0.145,
  deckUndersideZ: 0.123,
  tunnelMinX: 0.090,
  tunnelMaxX: 0.390,
  tunnelWidth: 0.300,
  tunnelMinZ: 0.018,
  tunnelMaxZ: 0.123,
  tunnelHeight: 0.105,
  runnerInnerX: 0.390,
  runnerOuterX: 0.550,
  stowedMaxHeightM: 2.050,
  cargoWcids: Object.freeze([
    4000002,
    4000010,
    4000011,
    4000012,
    4000013,
    4000014,
    4000015,
    4000016,
    4000017,
  ]),
});

// Mirrors container_models.js ISO_CONTAINER_SPECS without external imports
export const CONTAINER_ENVELOPE_SPECS = Object.freeze({
  4000020: Object.freeze({
    wcid: 4000020,
    kind: 10,
    extW: 2.438,
    extL: 6.058,
    extH: 2.591,
    intW: 2.352,
    intL: 5.898,
    intH: 2.393,
    doorW: 2.340,
    doorH: 2.280,
    floorZ: 0.162,
    roofZ: 2.591,
    rampLen: 0.850,
  }),
  4000021: Object.freeze({
    wcid: 4000021,
    kind: 11,
    extW: 2.438,
    extL: 12.192,
    extH: 2.591,
    intW: 2.352,
    intL: 12.032,
    intH: 2.393,
    doorW: 2.340,
    doorH: 2.280,
    floorZ: 0.162,
    roofZ: 2.591,
    rampLen: 0.850,
  }),
  4000022: Object.freeze({
    wcid: 4000022,
    kind: 12,
    extW: 2.438,
    extL: 12.192,
    extH: 2.896,
    intW: 2.352,
    intL: 12.032,
    intH: 2.698,
    doorW: 2.340,
    doorH: 2.585,
    floorZ: 0.162,
    roofZ: 2.896,
    rampLen: 0.850,
  }),
});

export const RACK_SPECS = Object.freeze({
  wcid: WAREHOUSE_WCID.SteelRackBay,
  kind: WAREHOUSE_DEPLOYABLE_KIND.SteelRackBay,
  baySpanM: 2.700,
  uprightWidthM: 0.100,
  uprightDepthM: 0.080,
  bayPitchM: 2.800,
  frameDepthM: 1.100,
  rowSpacerM: 0.200,
  doubleRowDepthM: 2.400,
  sideCenterOffsetY: 0.650,
  slotsPerBay: 2,
  slotOffsetX: 0.650,
  sideClearanceM: 0.150,
  centerFlueGapM: 0.200,
  beamHeightM: 0.120,
  tierCount: 4,
  tierZ: Object.freeze([0.000, 2.350, 4.700, 7.050]),
  clearTierHeightM: 2.230,
  uprightHeightM: 7.600,
  aisleWidthM: 3.600,
  approachStandoffM: 1.450,
  liftClearanceM: 0.100,
  liftTravelM: 0.180,
});

export const AGF_SPECS = Object.freeze({
  wcid: WAREHOUSE_WCID.AgfForklift,
  kind: WAREHOUSE_DEPLOYABLE_KIND.AgfForklift,
  maxDrawCalls: 10,
  overallWidthM: 1.140,
  chassisLengthM: 2.080,
  rearOverhangY: -1.930,
  frontChassisY: 0.150,
  wheelbaseM: 1.550,
  rearAxleY: -1.550,
  frontAxleY: 0.000,
  frontWheelRadiusM: 0.240,
  rearWheelRadiusM: 0.195,
  maxSteerRad: 1.43117,
  collapsedMastHeightM: 2.160,
  canopyHeightM: 2.120,
  forkMinZ: 0.045,
  freeliftMaxZ: 1.700,
  forkMaxZ: 7.250,
  forkLengthM: 1.150,
  forkTipY: 1.300,
  cargoCenterY: 0.700,
  forkWidthM: 0.120,
  forkThicknessM: 0.045,
  forkCenterX: 0.2625,
  forkOuterSpanM: 0.645,
  forkSpread: 0.685,
  sideShiftMaxM: 0.100,
  mastTiltBackRad: (5.0 * Math.PI) / 180.0,
  mastTiltFwdRad: -(3.0 * Math.PI) / 180.0,
  vMaxEmptyMps: 3.2,
  vMaxLoadedMps: 2.2,
  vContainerMps: 1.2,
  vDockingMps: 0.5,
  vTipOverCappedMps: 0.6,
  tipOverForkHeightM: 0.500,
  containerMaxForkHeightM: 1.700,
  mastSpeedMps: 0.65,
  dockPosTolM: 0.015,
  dockYawTolRad: 0.01,
  hullRadiusM: 0.620,
});

export const AMR_SPECS = Object.freeze({
  wcid: WAREHOUSE_WCID.AmrUnderride,
  kind: WAREHOUSE_DEPLOYABLE_KIND.AmrUnderride,
  maxDrawCalls: 6,
  widthM: 0.780,
  lengthM: 1.040,
  hullHeightM: 0.245,
  loweredHeightM: 0.260,
  raisedHeightM: 0.450,
  turntableDiameterM: 0.720,
  turntableRadiusM: 0.360,
  wheelRadiusM: 0.080,
  wheelTrackM: 0.600,
  vMaxEmptyMps: 2.0,
  vMaxLoadedMps: 1.5,
  omegaMaxRadSec: 1.8,
  accelMaxMps2: 1.8,
  liftSpeedMps: 0.18,
  turntableMaxRadSec: 2.4,
  dockPosTolM: 0.015,
  dockYawTolRad: 0.01,
  hullRadiusM: 0.560,
});

export const STAND_SPECS = Object.freeze({
  wcid: WAREHOUSE_WCID.TransferStand,
  kind: WAREHOUSE_DEPLOYABLE_KIND.TransferStand,
  maxDrawCalls: 2,
  outerWidthM: 1.280,
  outerDepthM: 1.140,
  railHeightM: 0.380,
  railThicknessM: 0.020,
  railInnerX: 0.430,
  railOuterX: 0.560,
  railWidthM: 0.130,
  tunnelWidthM: 0.860,
  tunnelHeightM: 0.360,
  amrApproachDistM: 1.600,
  agfApproachDistM: 1.950,
});

export const LIFT_TABLE_SPECS = Object.freeze({
  wcid: WAREHOUSE_WCID.ScissorLiftTable,
  kind: WAREHOUSE_DEPLOYABLE_KIND.ScissorLiftTable,
  maxDrawCalls: 4,
  outerWidthM: 1.340,
  outerDepthM: 1.300,
  loweredZ: 0.000,
  raisedZ: 0.380,
  railInnerX: 0.430,
  railOuterX: 0.560,
  railWidthM: 0.130,
  railThicknessM: 0.020,
  tunnelWidthM: 0.860,
  tunnelHeightM: 0.360,
  entryBevelM: 0.015,
  liftSpeedMps: 0.16,
  jackApproachDistM: 1.450,
  amrApproachDistM: 1.650,
  loweredToleranceM: 0.020,
  raisedToleranceM: 0.015,
});

export const CHARGER_SPECS = Object.freeze({
  wcid: WAREHOUSE_WCID.ChargingDock,
  kind: WAREHOUSE_DEPLOYABLE_KIND.ChargingDock,
  widthM: 1.240,
  depthM: 0.900,
  heightM: 0.650,
  padWidthM: 0.900,
  padLengthM: 0.700,
  dockStandOffM: 0.620,
  approachDistM: 1.600,
  chargeRatePerSec: 0.12,
});

export function headingForward(h) {
  const angle = Number.isFinite(h) ? h : 0.0;
  return [Math.sin(angle), Math.cos(angle)];
}

export function headingRight(h) {
  const angle = Number.isFinite(h) ? h : 0.0;
  return [Math.cos(angle), -Math.sin(angle)];
}

export function localToWorld2D(lx, ly, originX = 0.0, originY = 0.0, h = 0.0) {
  const angle = Number.isFinite(h) ? h : 0.0;
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return [originX + lx * c + ly * s, originY - lx * s + ly * c];
}

export function computeRackSlotLocalPose(
  bayIndex,
  tierIndex,
  slotInBay,
  rackSpec = RACK_SPECS,
  options = {}
) {
  const spec = rackSpec || RACK_SPECS;
  if (!Number.isInteger(bayIndex) || bayIndex < 0) {
    throw new RangeError(`computeRackSlotLocalPose: invalid bayIndex ${bayIndex}`);
  }
  if (!Number.isInteger(tierIndex) || tierIndex < 0 || tierIndex >= spec.tierCount) {
    throw new RangeError(`computeRackSlotLocalPose: invalid tierIndex ${tierIndex}`);
  }
  if (slotInBay !== 0 && slotInBay !== 1) {
    throw new RangeError(`computeRackSlotLocalPose: invalid slotInBay ${slotInBay}`);
  }

  const bayCenterX =
    spec.uprightWidthM + bayIndex * spec.bayPitchM + spec.baySpanM * 0.5;
  const x = bayCenterX + (slotInBay === 0 ? -spec.slotOffsetX : +spec.slotOffsetX);
  const z = spec.tierZ[tierIndex];

  const isDouble = Boolean(
    typeof options === "object" && options !== null ? options.doubleSided : spec.doubleSided
  );
  const side =
    typeof options === "number"
      ? options === 1
        ? 1
        : 0
      : options && options.side === 1
        ? 1
        : 0;

  let y;
  let approachY;
  let approachHeading;
  if (!isDouble) {
    y = 0.0;
    approachY = -(spec.frameDepthM * 0.5 + spec.approachStandoffM);
    approachHeading = 0.0;
  } else if (side === 0) {
    y = -spec.sideCenterOffsetY;
    approachY = -(spec.doubleRowDepthM * 0.5 + spec.approachStandoffM);
    approachHeading = 0.0;
  } else {
    y = +spec.sideCenterOffsetY;
    approachY = +(spec.doubleRowDepthM * 0.5 + spec.approachStandoffM);
    approachHeading = Math.PI;
  }

  return {
    x,
    y,
    z,
    approachX: x,
    approachY,
    approachHeading,
  };
}

export function computeRackRowBounds(
  bayCount = 8,
  doubleSided = false,
  rackSpec = RACK_SPECS
) {
  const spec = rackSpec || RACK_SPECS;
  const bays = Math.max(1, Math.trunc(Number.isFinite(bayCount) ? bayCount : 8));
  const width = bays * spec.bayPitchM + spec.uprightWidthM;
  const depth = doubleSided ? spec.doubleRowDepthM : spec.frameDepthM;
  const height = spec.uprightHeightM;
  return {
    minX: 0.0,
    maxX: width,
    minY: -depth * 0.5,
    maxY: +depth * 0.5,
    minZ: 0.0,
    maxZ: height,
    width,
    depth,
    height,
  };
}

function transformBounds2D(localBounds, originX, originY, heading) {
  const xs = [localBounds.minX, localBounds.maxX];
  const ys = [localBounds.minY, localBounds.maxY];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const [wx, wy] = localToWorld2D(xs[i], ys[j], originX, originY, heading);
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    minZ: localBounds.minZ,
    maxZ: localBounds.maxZ,
    width: maxX - minX,
    depth: maxY - minY,
    height: localBounds.height,
  };
}

export function buildDefaultHubLayout(origin = NE_FLATLAND_SITE.origin, options = {}) {
  const ox = Array.isArray(origin) && Number.isFinite(origin[0]) ? origin[0] : NE_FLATLAND_SITE.origin[0];
  const oy = Array.isArray(origin) && Number.isFinite(origin[1]) ? origin[1] : NE_FLATLAND_SITE.origin[1];
  const oz = Array.isArray(origin) && Number.isFinite(origin[2]) ? origin[2] : NE_FLATLAND_SITE.origin[2];

  const bayCount = Number.isInteger(options.bayCount) && options.bayCount > 0 ? options.bayCount : 8;
  const includeRackRowSlots = Boolean(options.includeRackRowSlots);

  const slabBounds = {
    minX: ox - 60.0,
    maxX: ox + 60.0,
    minY: oy - 45.0,
    maxY: oy + 45.0,
    localMinX: -60.0,
    localMaxX: +60.0,
    localMinY: -45.0,
    localMaxY: +45.0,
    width: 120.0,
    depth: 90.0,
    groundZ: oz,
    visualZ: oz + NE_FLATLAND_SITE.apronVisualZ,
    zones: {
      zoneA: { minX: ox - 52.0, maxX: ox + 54.0, minY: oy + 24.0, maxY: oy + 44.0 },
      crossAisle: { minX: ox - 52.0, maxX: ox + 54.0, minY: oy + 16.0, maxY: oy + 24.0 },
      zoneB: { minX: ox - 52.0, maxX: ox - 28.0, minY: oy - 22.0, maxY: oy + 16.0 },
      zoneC: { minX: ox - 26.0, maxX: ox + 54.0, minY: oy - 22.0, maxY: oy + 16.0 },
      zoneD: { minX: ox - 52.0, maxX: ox + 54.0, minY: oy - 40.0, maxY: oy - 22.0 },
    },
  };

  const dropPads = [
    {
      id: "C1",
      containerKind: "40ft",
      wcid: 4000021,
      kind: 11,
      localPos: [-40.0, +32.5, 0.0],
      pos: [ox - 40.0, oy + 32.5, oz],
      heading: 0.0,
      doorSillY: oy + 32.5 - CONTAINER_ENVELOPE_SPECS[4000021].extL * 0.5,
      rampToeY:
        oy +
        32.5 -
        CONTAINER_ENVELOPE_SPECS[4000021].extL * 0.5 -
        CONTAINER_ENVELOPE_SPECS[4000021].rampLen,
      approachNodeId: "pad_C1_approach",
    },
    {
      id: "C2",
      containerKind: "40HC",
      wcid: 4000022,
      kind: 12,
      localPos: [-24.0, +32.5, 0.0],
      pos: [ox - 24.0, oy + 32.5, oz],
      heading: 0.0,
      doorSillY: oy + 32.5 - CONTAINER_ENVELOPE_SPECS[4000022].extL * 0.5,
      rampToeY:
        oy +
        32.5 -
        CONTAINER_ENVELOPE_SPECS[4000022].extL * 0.5 -
        CONTAINER_ENVELOPE_SPECS[4000022].rampLen,
      approachNodeId: "pad_C2_approach",
    },
    {
      id: "C3",
      containerKind: "20ft",
      wcid: 4000020,
      kind: 10,
      localPos: [-8.0, +29.43, 0.0],
      pos: [ox - 8.0, oy + 29.43, oz],
      heading: 0.0,
      doorSillY: oy + 29.43 - CONTAINER_ENVELOPE_SPECS[4000020].extL * 0.5,
      rampToeY:
        oy +
        29.43 -
        CONTAINER_ENVELOPE_SPECS[4000020].extL * 0.5 -
        CONTAINER_ENVELOPE_SPECS[4000020].rampLen,
      approachNodeId: "pad_C3_approach",
    },
  ];

  const stagingRowYs = [+10.0, +7.0, +4.0, +1.0, -2.0, -5.0];
  const stagingBays = [];
  for (let r = 0; r < stagingRowYs.length; r++) {
    const ly = stagingRowYs[r];
    for (let c = 0; c < 2; c++) {
      const lx = c === 0 ? -48.5 : -41.5;
      const heading = c === 0 ? 1.5 * Math.PI : 0.5 * Math.PI;
      stagingBays.push({
        id: `SB_${r}_${c}`,
        row: r,
        col: c,
        localPos: [lx, ly, 0.0],
        pos: [ox + lx, oy + ly, oz],
        heading,
        width: PALLET_ENVELOPE_SPECS.width,
        depth: PALLET_ENVELOPE_SPECS.depth,
        approachNodeId: `zoneB_row_${r}`,
      });
    }
  }

  const liftTables = [
    {
      id: "L1",
      wcid: WAREHOUSE_WCID.ScissorLiftTable,
      kind: WAREHOUSE_DEPLOYABLE_KIND.ScissorLiftTable,
      localPos: [-46.0, -14.0, 0.0],
      pos: [ox - 46.0, oy - 14.0, oz],
      heading: 0.0,
      jackNodeId: "L1_north",
      amrNodeId: "L1_south",
    },
    {
      id: "L2",
      wcid: WAREHOUSE_WCID.ScissorLiftTable,
      kind: WAREHOUSE_DEPLOYABLE_KIND.ScissorLiftTable,
      localPos: [-38.0, -14.0, 0.0],
      pos: [ox - 38.0, oy - 14.0, oz],
      heading: 0.0,
      jackNodeId: "L2_north",
      amrNodeId: "L2_south",
    },
  ];

  const rackRowDefs = [
    { id: "R1", doubleSided: false, faces: [1], localPos: [-16.0, +5.350, 0.0], heading: 0.0 },
    { id: "R2_3", doubleSided: true, faces: [2, 3], localPos: [-16.0, 0.000, 0.0], heading: 0.0 },
    { id: "R4_5", doubleSided: true, faces: [4, 5], localPos: [-16.0, -6.000, 0.0], heading: 0.0 },
    { id: "R6", doubleSided: false, faces: [6], localPos: [+6.500, -11.350, 0.0], heading: Math.PI },
  ];

  let totalRackSlots = 0;
  const rackRows = rackRowDefs.map((def) => {
    const localBounds = computeRackRowBounds(bayCount, def.doubleSided, RACK_SPECS);
    const wx = ox + def.localPos[0];
    const wy = oy + def.localPos[1];
    const wz = oz + def.localPos[2];
    const bounds = transformBounds2D(localBounds, wx, wy, def.heading);
    const sideCount = def.doubleSided ? 2 : 1;
    const slotCount = bayCount * RACK_SPECS.tierCount * RACK_SPECS.slotsPerBay * sideCount;
    totalRackSlots += slotCount;

    const rowObj = {
      id: def.id,
      wcid: WAREHOUSE_WCID.SteelRackBay,
      kind: WAREHOUSE_DEPLOYABLE_KIND.SteelRackBay,
      doubleSided: def.doubleSided,
      faces: def.faces,
      bayCount,
      tiers: RACK_SPECS.tierCount,
      slotCount,
      slotsPerRow: slotCount,
      localPos: def.localPos,
      pos: [wx, wy, wz],
      heading: def.heading,
      localBounds,
      bounds,
    };

    if (includeRackRowSlots) {
      const slots = [];
      for (let side = 0; side < sideCount; side++) {
        for (let b = 0; b < bayCount; b++) {
          for (let t = 0; t < RACK_SPECS.tierCount; t++) {
            for (let s = 0; s < RACK_SPECS.slotsPerBay; s++) {
              const lp = computeRackSlotLocalPose(b, t, s, RACK_SPECS, {
                side,
                doubleSided: def.doubleSided,
              });
              const [sx, sy] = localToWorld2D(lp.x, lp.y, wx, wy, def.heading);
              const [ax, ay] = localToWorld2D(lp.approachX, lp.approachY, wx, wy, def.heading);
              const ah = ((def.heading + lp.approachHeading) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
              slots.push({
                side,
                bayIndex: b,
                tierIndex: t,
                slotInBay: s,
                localPose: lp,
                x: sx,
                y: sy,
                z: wz + lp.z,
                approachX: ax,
                approachY: ay,
                approachHeading: ah,
              });
            }
          }
        }
      }
      rowObj.slots = slots;
    }

    return rowObj;
  });

  const aisles = [
    { id: "A1", y: oy + 3.0, localY: 3.0, widthM: RACK_SPECS.aisleWidthM },
    { id: "A2", y: oy - 3.0, localY: -3.0, widthM: RACK_SPECS.aisleWidthM },
    { id: "A3", y: oy - 9.0, localY: -9.0, widthM: RACK_SPECS.aisleWidthM },
  ];

  const zoneCStandYs = [+4.2, +1.8, -1.8, -4.2, -7.8, -10.2];
  const stands = [];
  for (let i = 0; i < zoneCStandYs.length; i++) {
    const lx = 14.0;
    const ly = zoneCStandYs[i];
    const id = `S${i + 1}`;
    stands.push({
      id,
      zone: "zoneC",
      wcid: WAREHOUSE_WCID.TransferStand,
      kind: WAREHOUSE_DEPLOYABLE_KIND.TransferStand,
      localPos: [lx, ly, 0.0],
      pos: [ox + lx, oy + ly, oz],
      heading: Math.PI * 0.5,
      agfApproachPos: [ox + 12.05, oy + ly, oz],
      amrApproachPos: [ox + 15.60, oy + ly, oz],
      agfNodeId: `${id}_agf`,
      amrNodeId: `${id}_amr`,
    });
  }
  for (let i = 0; i < 12; i++) {
    const lx = -16.5 + i * 3.0;
    const ly = -24.0;
    const id = `S${i + 7}`;
    stands.push({
      id,
      zone: "zoneD",
      wcid: WAREHOUSE_WCID.TransferStand,
      kind: WAREHOUSE_DEPLOYABLE_KIND.TransferStand,
      localPos: [lx, ly, 0.0],
      pos: [ox + lx, oy + ly, oz],
      heading: 0.0,
      agfApproachPos: [ox + lx, oy - 22.05, oz],
      amrApproachPos: [ox + lx, oy - 25.60, oz],
      agfNodeId: `${id}_agf`,
      amrNodeId: `${id}_amr`,
    });
  }

  const chargers = [];
  for (let i = 0; i < 8; i++) {
    const lx = -14.0 + i * 4.0;
    const ly = -38.0;
    const id = `CH${i + 1}`;
    chargers.push({
      id,
      wcid: WAREHOUSE_WCID.ChargingDock,
      kind: WAREHOUSE_DEPLOYABLE_KIND.ChargingDock,
      localPos: [lx, ly, 0.0],
      pos: [ox + lx, oy + ly, oz],
      heading: 0.0,
      dockPos: [ox + lx, oy + ly + CHARGER_SPECS.dockStandOffM, oz],
      approachPos: [ox + lx, oy - 34.5, oz],
      dockNodeId: `${id}_dock`,
    });
  }

  // Build connected bidirectional waypoint graph for AGFs, AMRs, and Pallet Jacks
  const nodes = [];
  const nodeMap = new Map();
  const edges = [];
  const edgeKeys = new Set();

  function addNode(id, lx, ly, zone, kind, allowedModes) {
    if (nodeMap.has(id)) return nodeMap.get(id);
    const node = {
      id,
      x: ox + lx,
      y: oy + ly,
      z: oz,
      localPos: [lx, ly, 0.0],
      zone,
      kind,
      allowedModes: Object.freeze([...allowedModes]),
    };
    nodes.push(node);
    nodeMap.set(id, node);
    return node;
  }

  function addEdge(fromId, toId, allowedModes, laneWidthM = 3.6) {
    const a = nodeMap.get(fromId);
    const b = nodeMap.get(toId);
    if (!a || !b || fromId === toId) return;
    const key = fromId < toId ? `${fromId}__${toId}` : `${toId}__${fromId}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    const lengthM = Math.hypot(b.x - a.x, b.y - a.y);
    edges.push({
      id: `E_${fromId}_${toId}`,
      from: fromId,
      to: toId,
      lengthM,
      allowedModes: Object.freeze([...allowedModes]),
      laneWidthM,
    });
  }

  function linkChain(ids, allowedModes, laneWidthM) {
    for (let i = 0; i < ids.length - 1; i++) {
      addEdge(ids[i], ids[i + 1], allowedModes, laneWidthM);
    }
  }

  // 1. Main Cross-Aisle (y = +20.0) & Drop Pads (Zone A)
  const crossXs = [
    ["cross_n45", -45.0],
    ["cross_c1", -40.0],
    ["cross_c2", -24.0],
    ["cross_n21", -21.0],
    ["cross_c3", -8.0],
    ["cross_p10", +10.0],
  ];
  for (const [id, lx] of crossXs) {
    addNode(id, lx, 20.0, "crossAisle", "junction", ["agf", "jack"]);
  }
  linkChain(
    crossXs.map(([id]) => id),
    ["agf", "jack"],
    8.0
  );

  addNode("pad_C1_approach", -40.0, 24.5, "zoneA", "pad_approach", ["agf", "jack"]);
  addNode("pad_C2_approach", -24.0, 24.5, "zoneA", "pad_approach", ["agf", "jack"]);
  addNode("pad_C3_approach", -8.0, 24.5, "zoneA", "pad_approach", ["agf", "jack"]);
  addEdge("cross_c1", "pad_C1_approach", ["agf", "jack"], 4.0);
  addEdge("cross_c2", "pad_C2_approach", ["agf", "jack"], 4.0);
  addEdge("cross_c3", "pad_C3_approach", ["agf", "jack"], 4.0);

  // 2. Zone B Spine (x = -45.0), Staging Bays & Lift Tables
  const zoneBChain = ["cross_n45"];
  for (let r = 0; r < stagingRowYs.length; r++) {
    const ly = stagingRowYs[r];
    const rowId = `zoneB_row_${r}`;
    addNode(rowId, -45.0, ly, "zoneB", "junction", ["agf", "jack"]);
    zoneBChain.push(rowId);

    addNode(`SB_${r}_0`, -48.5, ly, "zoneB", "staging", ["agf", "jack"]);
    addNode(`SB_${r}_1`, -41.5, ly, "zoneB", "staging", ["agf", "jack"]);
    addEdge(rowId, `SB_${r}_0`, ["agf", "jack"], 2.4);
    addEdge(rowId, `SB_${r}_1`, ["agf", "jack"], 2.4);
  }
  addNode("zoneB_n10", -43.5, -10.0, "zoneB", "junction", ["agf", "jack"]);
  addNode("zoneB_s_buf", -43.5, -18.5, "zoneB", "junction", ["agf"]);
  zoneBChain.push("zoneB_n10");
  linkChain(zoneBChain, ["agf", "jack"], 3.0);
  addEdge("zoneB_n10", "zoneB_s_buf", ["agf"], 3.0);

  // Lift Tables North (Jack/AGF) and South (AMR)
  addNode("L1_north", -46.0, -10.5, "zoneB", "lift_jack", ["agf", "jack"]);
  addNode("L2_north", -38.0, -10.5, "zoneB", "lift_jack", ["agf", "jack"]);
  addEdge("zoneB_n10", "L1_north", ["agf", "jack"], 2.4);
  addEdge("zoneB_n10", "L2_north", ["agf", "jack"], 2.4);

  addNode("L1_south", -46.0, -15.65, "zoneB", "lift_amr", ["amr"]);
  addNode("L2_south", -38.0, -15.65, "zoneB", "lift_amr", ["amr"]);

  // 3. West AGF Spine (x = -21.0) & East AGF Spine (x = +10.0) + Zone C Aisles
  const aisleYs = [
    ["A1", +3.0],
    ["A2", -3.0],
    ["A3", -9.0],
  ];
  const westSpineIds = ["cross_n21"];
  const eastSpineIds = ["cross_p10"];
  for (const [aid, ly] of aisleYs) {
    const wId = `west_${aid}`;
    const eId = `east_${aid}`;
    const aWestId = `${aid}_west`;
    const aEastId = `${aid}_east`;
    addNode(wId, -21.0, ly, "zoneC", "junction", ["agf"]);
    addNode(aWestId, -16.0, ly, "zoneC", "aisle", ["agf"]);
    addNode(aEastId, +6.5, ly, "zoneC", "aisle", ["agf"]);
    addNode(eId, +10.0, ly, "zoneC", "junction", ["agf"]);
    westSpineIds.push(wId);
    eastSpineIds.push(eId);
    linkChain([wId, aWestId, aEastId, eId], ["agf"], RACK_SPECS.aisleWidthM);
  }
  addNode("agf_s_n21", -21.0, -18.5, "zoneC", "junction", ["agf", "amr"]);
  addNode("agf_s_p10", +10.0, -18.5, "zoneC", "junction", ["agf"]);
  westSpineIds.push("agf_s_n21");
  eastSpineIds.push("agf_s_p10");
  linkChain(westSpineIds, ["agf"], 4.0);
  linkChain(eastSpineIds, ["agf"], 4.0);

  // Zone C Aisle-End Stands S1..S6 (AGF side on West, AMR side on East)
  addNode("amr_trunk_bot", +19.0, -29.0, "zoneD", "junction", ["amr"]);
  const aisleEastJunctions = ["east_A1", "east_A1", "east_A2", "east_A2", "east_A3", "east_A3"];
  for (let i = 0; i < 6; i++) {
    const st = stands[i];
    const ly = st.localPos[1];
    addNode(st.agfNodeId, 12.05, ly, "zoneC", "stand_agf", ["agf"]);
    addEdge(aisleEastJunctions[i], st.agfNodeId, ["agf"], 2.4);

    const trunkId = `amr_trunk_${st.id}`;
    addNode(trunkId, 19.0, ly, "zoneC", "junction", ["amr"]);
    addNode(st.amrNodeId, 15.60, ly, "zoneC", "stand_amr", ["amr"]);
    addEdge(trunkId, st.amrNodeId, ["amr"], 2.0);
  }
  // Link East AMR trunk bottom (-29.0) ascending through S6 (-10.2) up to S1 (+4.2)
  linkChain(
    [
      "amr_trunk_bot",
      "amr_trunk_S6",
      "amr_trunk_S5",
      "amr_trunk_S4",
      "amr_trunk_S3",
      "amr_trunk_S2",
      "amr_trunk_S1",
    ],
    ["amr"],
    3.0
  );

  // 4. Zone C/D AGF South Buffer (y = -18.5) feeding Zone D Stands S7..S18
  const agfSouthStops = [
    ["zoneB_s_buf", -43.5],
    ["agf_s_n21", -21.0],
  ];
  const zoneDSortedX = [];
  for (let i = 0; i < 12; i++) {
    const st = stands[6 + i];
    const lx = st.localPos[0];
    const jId = `agf_s_${st.id}`;
    addNode(jId, lx, -18.5, "zoneD", "junction", ["agf"]);
    addNode(st.agfNodeId, lx, -22.05, "zoneD", "stand_agf", ["agf"]);
    addEdge(jId, st.agfNodeId, ["agf"], 2.4);
    zoneDSortedX.push({ id: jId, lx });
  }
  zoneDSortedX.push({ id: "agf_s_p10", lx: +10.0 });
  zoneDSortedX.sort((a, b) => a.lx - b.lx);
  for (const item of zoneDSortedX) {
    agfSouthStops.push([item.id, item.lx]);
  }
  linkChain(
    agfSouthStops.map(([id]) => id),
    ["agf"],
    4.0
  );

  // 5. Zone D AMR Highway (y = -29.0) & S7..S18 AMR side + Outbound Buffer + L1/L2 south
  const hwyNodes = [
    { id: "amr_hwy_n46", lx: -46.0 },
    { id: "amr_hwy_n38", lx: -38.0 },
    { id: "amr_hwy_n21", lx: -21.0 },
    { id: "amr_hwy_n14", lx: -14.0 },
    { id: "amr_hwy_0", lx: 0.0 },
    { id: "amr_hwy_p14", lx: +14.0 },
    { id: "amr_trunk_bot", lx: +19.0 },
    { id: "outbound_buffer", lx: +30.0 },
  ];
  for (const hn of hwyNodes) {
    addNode(
      hn.id,
      hn.lx,
      -29.0,
      "zoneD",
      hn.id === "outbound_buffer" ? "staging" : "junction",
      hn.id === "amr_hwy_n21" ? ["amr", "agf"] : ["amr"]
    );
  }
  for (let i = 0; i < 12; i++) {
    const st = stands[6 + i];
    const lx = st.localPos[0];
    const hwyId = `amr_hwy_${st.id}`;
    addNode(hwyId, lx, -29.0, "zoneD", "junction", ["amr"]);
    addNode(st.amrNodeId, lx, -25.60, "zoneD", "stand_amr", ["amr"]);
    addEdge(hwyId, st.amrNodeId, ["amr"], 2.0);
    hwyNodes.push({ id: hwyId, lx });
  }
  hwyNodes.sort((a, b) => a.lx - b.lx);
  linkChain(
    hwyNodes.map((n) => n.id),
    ["amr"],
    4.0
  );
  addEdge("amr_hwy_n46", "L1_south", ["amr"], 2.4);
  addEdge("amr_hwy_n38", "L2_south", ["amr"], 2.4);
  // Cross-connector linking AGF South Buffer and AMR Highway into one combined connected graph
  addEdge("agf_s_n21", "amr_hwy_n21", ["agf", "amr"], 3.6);

  // 6. Zone D Charger Lane (y = -34.5) & CH1..CH8 Docks
  const chargerLaneNodes = [];
  for (let i = 0; i < chargers.length; i++) {
    const ch = chargers[i];
    const lx = ch.localPos[0];
    const laneId = `chg_lane_${ch.id}`;
    addNode(laneId, lx, -34.5, "zoneD", "junction", ["amr"]);
    addNode(ch.dockNodeId, lx, ch.localPos[1] + CHARGER_SPECS.dockStandOffM, "zoneD", "charger", ["amr"]);
    addEdge(laneId, ch.dockNodeId, ["amr"], 2.0);
    chargerLaneNodes.push({ id: laneId, lx });
  }
  addNode("chg_lane_0", 0.0, -34.5, "zoneD", "junction", ["amr"]);
  chargerLaneNodes.push({ id: "chg_lane_0", lx: 0.0 });
  chargerLaneNodes.sort((a, b) => a.lx - b.lx);
  linkChain(
    chargerLaneNodes.map((n) => n.id),
    ["amr"],
    3.0
  );
  addEdge("amr_hwy_n14", "chg_lane_CH1", ["amr"], 3.0);
  addEdge("amr_hwy_0", "chg_lane_0", ["amr"], 3.0);
  addEdge("amr_hwy_p14", "chg_lane_CH8", ["amr"], 3.0);

  return {
    origin: [ox, oy, oz],
    slabBounds,
    dropPads,
    stagingBays,
    liftTables,
    rackRows,
    aisles,
    totalRackSlots,
    stands,
    chargers,
    graph: {
      nodes,
      edges,
    },
  };
}
