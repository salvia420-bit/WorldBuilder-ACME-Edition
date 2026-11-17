using WorldBuilder.Shared.Lib.Container;
using Xunit;

namespace WorldBuilder.Tests;

public class TrailerTests
{
    [Fact]
    public void Chassis20ft_HasCorrectBayDimensions()
    {
        var chassis = new Chassis20ft();
        Assert.Single(chassis.Bays);
        Assert.Equal(3.025f, chassis.Bays[0].Bounds.Extents.X);
    }

    [Fact]
    public void Chassis40ft_HasCorrectBayDimensions()
    {
        var chassis = new Chassis40ft();
        Assert.Single(chassis.Bays);
        Assert.Equal(6.095f, chassis.Bays[0].Bounds.Extents.X);
    }

    [Fact]
    public void SemiTrailerBase_InitialStateIsUnlocked()
    {
        var trailer = new DummyTrailer();
        Assert.Equal(TwistlockState.Unlocked, trailer.CurrentTwistlockState);
    }

    private class DummyTrailer : SemiTrailerBase { }
}
