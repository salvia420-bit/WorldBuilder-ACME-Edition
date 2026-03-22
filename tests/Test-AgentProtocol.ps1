<#
.SYNOPSIS
    Quick smoke test for the WorldBuilder.Terminal --stdin JSON protocol.

.DESCRIPTION
    Spawns WorldBuilder.Terminal in stdin mode, sends a sequence of JSON
    commands, and validates the responses. This is the PowerShell equivalent
    of the Python test suite -- faster to run for quick sanity checks.

    Uses ReadLineAsync() with Task.Wait(timeout) to avoid the deadlock
    that occurs with synchronous StandardOutput.ReadLine() on Windows
    when .NET redirected pipes use block buffering.

.PARAMETER Binary
    Path to a prebuilt WorldBuilder.Terminal binary. If not specified,
    uses 'dotnet run' against the project.

.PARAMETER ProjectPath
    Path to a .wbproj file to test with. Defaults to TestProject/TestProject.wbproj.

.PARAMETER ShowResponses
    Show full JSON responses.

.PARAMETER ReadTimeoutMs
    Timeout in milliseconds waiting for a response line. Default: 60000 (60s).
    Increase for slow machines or large DAT loads.

.EXAMPLE
    .\tests\Test-AgentProtocol.ps1
    .\tests\Test-AgentProtocol.ps1 -Binary "bin\WorldBuilder.Terminal.exe"
    .\tests\Test-AgentProtocol.ps1 -ProjectPath "C:\MyWorld\project.wbproj"
#>

param(
    [string]$Binary = "",
    [string]$ProjectPath = "",
    [switch]$ShowResponses,
    [int]$ReadTimeoutMs = 60000
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$TerminalProject = Join-Path $RepoRoot "WorldBuilder.Terminal"

if (-not $ProjectPath) {
    $ProjectPath = Join-Path $RepoRoot "TestProject\TestProject.wbproj"
}

# ---------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------

$script:PassCount = 0
$script:FailCount = 0
$script:SkipCount = 0

function Write-TestResult($Name, $Passed, $Message = "") {
    if ($Passed) {
        $script:PassCount++
        Write-Host "  [PASS] $Name" -ForegroundColor Green
    }
    else {
        $script:FailCount++
        Write-Host "  [FAIL] $Name -- $Message" -ForegroundColor Red
    }
}

function Write-Skip($Name, $Reason) {
    $script:SkipCount++
    Write-Host "  [SKIP] $Name -- $Reason" -ForegroundColor Yellow
}

# ---------------------------------------------------------------
# Async read helper using ReadLineAsync + Task.Wait(timeout)
# ---------------------------------------------------------------

function Read-LineWithTimeout($Proc, [int]$TimeoutMs = $ReadTimeoutMs) {
    $task = $Proc.StandardOutput.ReadLineAsync()
    $completed = $task.Wait($TimeoutMs)
    if (-not $completed) {
        return $null
    }
    return $task.Result
}

function Start-Terminal([switch]$WithProject) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    if ($Binary) {
        $psi.FileName = $Binary
        $psi.Arguments = "--stdin"
        if ($WithProject) {
            $psi.Arguments += " --project `"$ProjectPath`""
        }
    }
    else {
        $psi.FileName = "dotnet"
        $args_str = "run --project `"$TerminalProject`" -- --stdin"
        if ($WithProject) {
            $args_str += " --project `"$ProjectPath`""
        }
        $psi.Arguments = $args_str
    }

    $proc = [System.Diagnostics.Process]::Start($psi)

    # Read the ready message with timeout
    $readyLine = Read-LineWithTimeout $proc
    if ($null -eq $readyLine) {
        try { $proc.Kill() } catch {}
        throw "Timed out waiting for ready message from terminal process."
    }

    $ready = $readyLine | ConvertFrom-Json

    if ($ShowResponses) {
        Write-Host "    << $readyLine" -ForegroundColor DarkCyan
    }

    return @{ Process = $proc; Ready = $ready }
}

function Send-Command($Session, $Command) {
    $json = $Command | ConvertTo-Json -Compress -Depth 10
    $proc = $Session.Process
    $proc.StandardInput.WriteLine($json)
    $proc.StandardInput.Flush()
    $line = Read-LineWithTimeout $proc
    if ($ShowResponses) {
        Write-Host "    >> $json" -ForegroundColor DarkGray
        Write-Host "    << $line" -ForegroundColor DarkCyan
    }
    if ($null -eq $line) {
        throw "Timed out waiting for response to command: $json"
    }
    return $line | ConvertFrom-Json
}

function Send-Raw($Session, $RawLine) {
    $proc = $Session.Process
    $proc.StandardInput.WriteLine($RawLine)
    $proc.StandardInput.Flush()
    $line = Read-LineWithTimeout $proc
    if ($ShowResponses) {
        Write-Host "    >> $RawLine" -ForegroundColor DarkGray
        Write-Host "    << $line" -ForegroundColor DarkCyan
    }
    if ($null -eq $line) {
        throw "Timed out waiting for response to raw input: $RawLine"
    }
    return $line | ConvertFrom-Json
}

function Stop-Terminal($Session) {
    $proc = $Session.Process
    try {
        $proc.StandardInput.Close()
        $proc.WaitForExit(5000) | Out-Null
    }
    catch {}
    try {
        if (-not $proc.HasExited) {
            $proc.Kill()
        }
    }
    catch {}
}

# ---------------------------------------------------------------
# Test Suite 1: Protocol Tests (no project needed)
# ---------------------------------------------------------------

Write-Host ""
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host "  WorldBuilder.Terminal -- Agent Protocol Smoke Test" -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "[Protocol Tests]" -ForegroundColor White

try {
    $session = Start-Terminal
    $ready = $session.Ready

    # Test 1: Ready message
    Write-TestResult "Startup ready message" `
    ($ready.success -eq $true -and $ready.command -eq "ready") `
        "Got: $($ready | ConvertTo-Json -Compress)"

    # Test 2: Version present
    Write-TestResult "Version field present" `
    ([bool]$ready.version) `
        "Missing version"

    # Test 3: Unknown command
    $resp = Send-Command $session @{ command = "nonexistent_xyz" }
    Write-TestResult "Unknown command -> failure" `
    ($resp.success -eq $false -and $resp.error -like "*unknown*") `
        "Got: success=$($resp.success)"

    # Test 4: Missing 'command' field
    $resp = Send-Command $session @{ action = "test" }
    Write-TestResult "Missing command field -> parse_error" `
    ($resp.success -eq $false -and $resp.command -eq "parse_error") `
        "Got: command=$($resp.command)"

    # Test 5: Invalid JSON
    $resp = Send-Raw $session "{this is bad json!}"
    Write-TestResult "Invalid JSON -> parse_error" `
    ($resp.success -eq $false -and $resp.command -eq "parse_error") `
        "Got: $($resp | ConvertTo-Json -Compress)"

    # Test 6: Empty object
    $resp = Send-Command $session @{}
    Write-TestResult "Empty object -> parse_error" `
    ($resp.success -eq $false -and $resp.command -eq "parse_error") `
        "Got: $($resp | ConvertTo-Json -Compress)"

    # Test 7: Info without project
    $resp = Send-Command $session @{ command = "info" }
    Write-TestResult "Info (no project) -> loaded=false" `
    ($resp.success -eq $true -and $resp.loaded -eq $false) `
        "Got: loaded=$($resp.loaded)"

    # Test 8: Help command
    $resp = Send-Command $session @{ command = "help" }
    Write-TestResult "Help -> has commands list" `
    ($resp.success -eq $true -and $resp.commands.Count -gt 10) `
        "Got: $($resp.commands.Count) commands"

    # Test 9: Case insensitive
    $resp = Send-Command $session @{ command = "INFO" }
    Write-TestResult "Case insensitive commands" `
    ($resp.success -eq $true -and $resp.command -eq "info") `
        "Got: command=$($resp.command)"

    # Test 10: Load nonexistent project
    $resp = Send-Command $session @{ command = "load"; path = "C:\nonexistent\fake.wbproj" }
    Write-TestResult "Load nonexistent -> failure" `
    ($resp.success -eq $false) `
        "Got: success=$($resp.success)"

    # Test 11: Command requiring project
    $resp = Send-Command $session @{ command = "get-world-info" }
    Write-TestResult "Command before load -> failure" `
    ($resp.success -eq $false) `
        "Got: success=$($resp.success)"

    # Test 12: Extra fields ignored
    $resp = Send-Command $session @{ command = "info"; extra = "hello"; nested = @{ a = 1 } }
    Write-TestResult "Extra fields silently ignored" `
    ($resp.success -eq $true) `
        "Got: success=$($resp.success)"

    # Test 13: Quit
    $resp = Send-Command $session @{ command = "quit" }
    Write-TestResult "Quit -> success" `
    ($resp.success -eq $true -and ($resp.command -eq "quit")) `
        "Got: $($resp | ConvertTo-Json -Compress)"

    Stop-Terminal $session

}
catch {
    Write-Host "  [FAIL] FATAL: Protocol tests failed -- $_" -ForegroundColor Red
    Write-Host "         at $($_.ScriptStackTrace)" -ForegroundColor DarkRed
    $script:FailCount++
}

# ---------------------------------------------------------------
# Test Suite 2: Project Tests (require TestProject)
# ---------------------------------------------------------------

Write-Host ""
Write-Host "[Project Tests]" -ForegroundColor White

if (-not (Test-Path $ProjectPath)) {
    Write-Skip "All project tests" "TestProject not found at $ProjectPath"
}
else {
    try {
        $session = Start-Terminal

        # Load the project
        $resp = Send-Command $session @{ command = "load"; path = $ProjectPath }
        Write-TestResult "Load TestProject" `
        ($resp.success -eq $true -and [bool]$resp.projectName) `
            "Got: $($resp | ConvertTo-Json -Compress)"

        # Info after load
        $resp = Send-Command $session @{ command = "info" }
        Write-TestResult "Info after load -> loaded=true" `
        ($resp.loaded -eq $true -and [bool]$resp.projectName) `
            "Got: loaded=$($resp.loaded)"

        # World info
        $resp = Send-Command $session @{ command = "get-world-info" }
        Write-TestResult "Get world info" `
        ($resp.success -eq $true) `
            "Got: success=$($resp.success)"

        # Region data
        $resp = Send-Command $session @{ command = "get-region" }
        Write-TestResult "Get region -> has height table" `
        ($resp.success -eq $true -and $resp.heightTable.Count -gt 0) `
            "Got: heightTable.Count=$($resp.heightTable.Count)"

        # List landblocks
        $resp = Send-Command $session @{ command = "list-landblocks"; limit = 5 }
        Write-TestResult "List landblocks" `
        ($resp.success -eq $true -and $null -ne $resp.landblocks) `
            "Got: success=$($resp.success)"

        # Terrain info
        $resp = Send-Command $session @{ command = "terrain-info"; lbX = 100; lbY = 100 }
        Write-TestResult "Terrain info" `
        ($resp.success -eq $true -and $null -ne $resp.found) `
            "Got: found=$($resp.found)"

        # Get heightmap
        $resp = Send-Command $session @{ command = "get-heightmap"; lbX = 100; lbY = 100 }
        Write-TestResult "Get heightmap" `
        ($resp.success -eq $true) `
            "Got: success=$($resp.success)"

        # List objects
        $resp = Send-Command $session @{ command = "list-objects"; lbX = 100; lbY = 100 }
        Write-TestResult "List objects" `
        ($resp.success -eq $true -and $null -ne $resp.count) `
            "Got: count=$($resp.count)"

        # Validate landblock
        $resp = Send-Command $session @{ command = "validate-landblock"; lbX = 100; lbY = 100 }
        Write-TestResult "Validate landblock -> has diagnostics" `
        ($resp.success -eq $true -and $null -ne $resp.isValid -and $null -ne $resp.diagnostics) `
            "Got: isValid=$($resp.isValid)"

        # Validate all
        $resp = Send-Command $session @{ command = "validate-all"; lbX = 100; lbY = 100 }
        Write-TestResult "Validate all -> combined report" `
        ($resp.success -eq $true -and $null -ne $resp.errorCount) `
            "Got: errors=$($resp.errorCount) warnings=$($resp.warningCount)"

        # Query radius
        $resp = Send-Command $session @{ command = "query-radius"; x = 19200.0; y = 19200.0; radius = 200.0 }
        Write-TestResult "Query radius" `
        ($resp.success -eq $true -and $null -ne $resp.totalFound) `
            "Got: totalFound=$($resp.totalFound)"

        # Add/Remove roundtrip
        $addResp = Send-Command $session @{
            command = "add-object"; lbX = 100; lbY = 100;
            modelId = "0x02000001"; x = 19296.0; y = 19296.0; z = 0.0
        }
        $addOk = $addResp.success -eq $true
        if ($addOk) {
            $rmResp = Send-Command $session @{
                command = "remove-object"; lbX = 100; lbY = 100;
                index = $addResp.index
            }
            Write-TestResult "Add/Remove object roundtrip" `
            ($rmResp.success -eq $true) `
                "Remove failed: $($rmResp | ConvertTo-Json -Compress)"
        }
        else {
            Write-TestResult "Add/Remove object roundtrip" $false `
                "Add failed: $($addResp | ConvertTo-Json -Compress)"
        }

        Stop-Terminal $session

    }
    catch {
        Write-Host "  [FAIL] FATAL: Project tests failed -- $_" -ForegroundColor Red
        Write-Host "         at $($_.ScriptStackTrace)" -ForegroundColor DarkRed
        $script:FailCount++
    }
}

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------

Write-Host ""
Write-Host "=======================================================" -ForegroundColor Cyan
$total = $PassCount + $FailCount + $SkipCount
Write-Host "  Results: $PassCount passed, $FailCount failed, $SkipCount skipped (of $total)" -ForegroundColor $(
    if ($FailCount -gt 0) { "Red" }
    elseif ($SkipCount -gt 0) { "Yellow" }
    else { "Green" }
)
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host ""

exit $FailCount
