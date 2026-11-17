using System.Collections.Generic;
using System.Numerics;
using WorldBuilder.Shared.Lib.Geometry;
using WorldBuilder.Shared.Lib.Container;

namespace WorldBuilder.Shared.Lib.Vehicle;

public class Chassis20ft : SemiTrailerBase
{
    public Chassis20ft()
    {
        // Define 20ft bay configuration (approx 20ft container dimensions)
        Bays = new List<ContainerBay> {
            new ContainerBay { 
                Bounds = new OBB(Vector3.Zero, new Vector3(3.025f, 1.295f, 1.22f), new[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ }), 
                SillHeight = 1.2f, 
                HeaderHeight = 3.8f 
            }
        };
    }
}
