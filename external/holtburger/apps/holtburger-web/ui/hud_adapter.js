// external/holtburger/apps/holtburger-web/ui/hud_adapter.js
// Listener for VehicleWire v6 telemetry
// Integrates specialized trailer models and HUD adaptation for twistlock state tracking.

export function initHudAdapter(api) {
  // Assuming api provides a way to subscribe to events
  if (typeof api.on === 'function') {
    api.on("VehicleWire", (data) => {
      // Logic to listen for VehicleWire v6 telemetry
      if (data.version === 6) {
        if (data.twistlockState !== undefined || data.chassisTypeID !== undefined) {
          updateHud(data);
        }
      }
    });
  }
}

function updateHud(data) {
  // Use the global HUD UI if available
  const hud = window.liveScene3d?.hud;
  if (hud && typeof hud.setTrailerStatus === 'function') {
    // Update the HUD with the latest telemetry from the trailer
    hud.setTrailerStatus(data.twistlockState, data.chassisTypeID);
  } else {
    console.warn("HUD trailer status integration not available or setTrailerStatus not found.");
  }
}
