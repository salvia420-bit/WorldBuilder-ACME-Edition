using System.Numerics;
using WorldBuilder.Shared.Lib.Geometry;

namespace WorldBuilder.Shared.Lib.Container;

public class ContainerInteriorLogic {
    public float CameraNearPlane { get; set; } = 0.1f;
    public float CameraFarPlane { get; set; } = 100.0f;
    
    public bool IsCameraInside(Vector3 cameraPosition, OBB containerBounds) {
        return OBBCollision.PointInOBB(cameraPosition, containerBounds);
    }
}
