using System.Collections.Generic;
using System.Numerics;
using WorldBuilder.Shared.Lib.Geometry;

namespace WorldBuilder.Shared.Lib.Container;

public class IsoContainerDeployable {
    // Basic properties for a container bay/slot
    public struct ContainerBay {
        public OBB Bounds;
        public float SillHeight;
        public float HeaderHeight;
    }

    public List<ContainerBay> Bays { get; set; } = new();

    /// <summary>
    /// Checks if a pallet (represented as OBB) can be deployed into any bay.
    /// Selects the best fit (minimum clearance) bay.
    /// </summary>
    public bool CanDeployPallet(OBB palletBounds, out string obstructionReason, out ContainerBay? selectedBay) {
        List<string> obstructionReasons = new();
        bool foundFit = false;
        float minClearance = float.MaxValue;
        selectedBay = null;
        
        foreach (var bay in Bays) {
            // Check if this bay is relevant
            if (!OBBCollision.Intersects(palletBounds, bay.Bounds)) continue;
            
            // Check if the pallet fits
            if (palletBounds.Center.Y - palletBounds.Extents.Y < bay.SillHeight) {
                obstructionReasons.Add($"Bay at {bay.Bounds.Center}: Obstructed by sill");
                continue;
            }
            
            if (palletBounds.Center.Y + palletBounds.Extents.Y > bay.HeaderHeight) {
                obstructionReasons.Add($"Bay at {bay.Bounds.Center}: Exceeds header height");
                continue;
            }
            
            // Fits! Calculate clearance (vertical space remaining)
            float verticalSpace = bay.HeaderHeight - (palletBounds.Center.Y + palletBounds.Extents.Y);
            if (verticalSpace < minClearance) {
                minClearance = verticalSpace;
                foundFit = true;
                selectedBay = bay;
            }
        }
        
        if (foundFit) {
            obstructionReason = string.Empty;
            return true;
        }
        
        obstructionReason = obstructionReasons.Count > 0 ? string.Join(", ", obstructionReasons) : "No compatible bay found";
        return false;
    }
}
