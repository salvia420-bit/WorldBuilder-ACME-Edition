using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Tests;

public class HardwareInfoTests {
    // ── /proc/cpuinfo parser ──────────────────────────────────────────

    [Fact]
    public void ParseLinuxCpuInfo_HyperthreadedDualCore_Returns2() {
        // Real /proc/cpuinfo from a 2-physical-core, 4-logical-core Intel i5 (HT on).
        // Two CPUs share each (physical id, core id) pair, giving 2 distinct pairs.
        var text = """
            processor	: 0
            physical id	: 0
            core id	: 0
            cpu cores	: 2

            processor	: 1
            physical id	: 0
            core id	: 1
            cpu cores	: 2

            processor	: 2
            physical id	: 0
            core id	: 0
            cpu cores	: 2

            processor	: 3
            physical id	: 0
            core id	: 1
            cpu cores	: 2

            """;

        Assert.True(HardwareInfo.TryParseLinuxCpuInfoText(text, out var n));
        Assert.Equal(2, n);
    }

    [Fact]
    public void ParseLinuxCpuInfo_NonHyperthreaded_LogicalEqualsPhysical() {
        // 4-core, no HT: each processor is its own (phys,core) pair.
        var text = """
            processor	: 0
            physical id	: 0
            core id	: 0

            processor	: 1
            physical id	: 0
            core id	: 1

            processor	: 2
            physical id	: 0
            core id	: 2

            processor	: 3
            physical id	: 0
            core id	: 3
            """;

        Assert.True(HardwareInfo.TryParseLinuxCpuInfoText(text, out var n));
        Assert.Equal(4, n);
    }

    [Fact]
    public void ParseLinuxCpuInfo_DualSocketDualCorePerSocket_Returns4() {
        // 2 sockets × 2 cores × 2 threads = 8 logical, 4 physical.
        var text = """
            processor	: 0
            physical id	: 0
            core id	: 0

            processor	: 1
            physical id	: 0
            core id	: 1

            processor	: 2
            physical id	: 1
            core id	: 0

            processor	: 3
            physical id	: 1
            core id	: 1

            processor	: 4
            physical id	: 0
            core id	: 0

            processor	: 5
            physical id	: 0
            core id	: 1

            processor	: 6
            physical id	: 1
            core id	: 0

            processor	: 7
            physical id	: 1
            core id	: 1
            """;

        Assert.True(HardwareInfo.TryParseLinuxCpuInfoText(text, out var n));
        Assert.Equal(4, n);
    }

    [Fact]
    public void ParseLinuxCpuInfo_NoCoreIdFields_ReturnsFalse() {
        // Fields missing — parser shouldn't pretend it found anything.
        var text = """
            processor	: 0
            cpu MHz		: 2400.000
            """;

        Assert.False(HardwareInfo.TryParseLinuxCpuInfoText(text, out var n));
        Assert.Equal(0, n);
    }

    [Fact]
    public void ParseLinuxCpuInfo_EmptyText_ReturnsFalse() {
        Assert.False(HardwareInfo.TryParseLinuxCpuInfoText("", out var n));
        Assert.Equal(0, n);
    }

    [Fact]
    public void ParseLinuxCpuInfo_TrailingProcessorWithoutBlankLine_StillCounted() {
        // Final block isn't terminated with a blank line — parser must still record it.
        var text = "processor\t: 0\nphysical id\t: 0\ncore id\t: 0\n";

        Assert.True(HardwareInfo.TryParseLinuxCpuInfoText(text, out var n));
        Assert.Equal(1, n);
    }

    // ── PhysicalCoreCount property ────────────────────────────────────

    [Fact]
    public void PhysicalCoreCount_AlwaysAtLeastOne() {
        Assert.True(HardwareInfo.PhysicalCoreCount >= 1);
    }

    [Fact]
    public void PhysicalCoreCount_NeverExceedsLogical() {
        Assert.True(HardwareInfo.PhysicalCoreCount <= System.Environment.ProcessorCount);
    }
}
