using System.Collections.Generic;
using WorldBuilder.Shared.Lib.Container;

namespace WorldBuilder.Shared.Lib.Vehicle;

public enum TwistlockState
{
    Unlocked,
    Locked,
    Transitioning
}

public abstract class SemiTrailerBase : IsoContainerDeployable
{
    public uint TrailerId { get; set; }
    public TwistlockState CurrentTwistlockState { get; set; } = TwistlockState.Unlocked;
    public uint ChassisTypeID { get; set; }
    
    // v6 protocol telemetry fields
    public byte LiftNormU8 { get; set; }
    public byte PumpPhaseU8 { get; set; }
    public byte ForkStressU8 { get; set; }
    public uint CarriedPalletGuid { get; set; }
}
