using System.Collections.Generic;
using System.Numerics;
using WorldBuilder.Shared.Lib.Geometry;
using WorldBuilder.Shared.Lib.Container;

namespace WorldBuilder.Shared.Lib.Vehicle;

public class Chassis40ft : SemiTrailerBase
{
    public Chassis40ft()
    {
        // Define 40ft bay configuration (approx 40ft container dimensions)
        Bays = new List<ContainerBay> {
            new ContainerBay { 
                Bounds = new OBB(Vector3.Zero, new Vector3(6.095f, 1.295f, 1.22f), new[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ }), 
                SillHeight = 1.2f, 
                HeaderHeight = 3.8f 
            }
        };
    }
}
