[CmdletBinding()]
param(
    [string]$AceRoot = "C:\ACE",
    [string]$ClientRoot = "C:\Asheron's Call",
    [string]$MariaDbBin = "C:\Program Files\MariaDB 12.2\bin",
    [string]$DbUser = "root",
    [string]$DbPassword = "baltic",
    [string]$DbName = "ace_world",
    [switch]$SkipClientDat
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Path {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Label not found: $Path"
    }
}

$kitRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$payloadRoot = Join-Path $kitRoot "files"
$payloadDat = Join-Path $payloadRoot "dat\client_cell_1.dat"
$payloadSqlDir = Join-Path $payloadRoot "sql"
$payloadSql = Get-ChildItem -Path $payloadSqlDir -Filter "*.sql" | Sort-Object Name

$aceDatPath = Join-Path $AceRoot "Dats\client_cell_1.dat"
$clientDatPath = Join-Path $ClientRoot "client_cell_1.dat"
$configPath = Join-Path $AceRoot "Server\Config.js"

$mysqlExe = Join-Path $MariaDbBin "mysql.exe"
$mysqldumpExe = Join-Path $MariaDbBin "mysqldump.exe"

Assert-Path -Path $payloadDat -Label "Payload DAT"
Assert-Path -Path $payloadSqlDir -Label "Payload SQL directory"
Assert-Path -Path $aceDatPath -Label "ACE server DAT"
Assert-Path -Path $configPath -Label "ACE Config.js"
Assert-Path -Path $mysqlExe -Label "mysql.exe"
Assert-Path -Path $mysqldumpExe -Label "mysqldump.exe"
if (-not $SkipClientDat) {
    Assert-Path -Path $clientDatPath -Label "AC client DAT"
}

Write-Step "Stopping AC client and ACE server processes"
Get-Process -Name "acclient" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "ACE.Server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$backupRoot = Join-Path $AceRoot "vanquishkit_backups"
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupDir = Join-Path $backupRoot $stamp
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$logPath = Join-Path $backupDir "install.log"

Start-Transcript -Path $logPath -Force | Out-Null
try {
    Write-Step "Backing up existing files"
    Copy-Item -LiteralPath $aceDatPath -Destination (Join-Path $backupDir "ace_client_cell_1.dat.bak") -Force
    Copy-Item -LiteralPath $configPath -Destination (Join-Path $backupDir "Config.js.bak") -Force
    if (-not $SkipClientDat) {
        Copy-Item -LiteralPath $clientDatPath -Destination (Join-Path $backupDir "acclient_client_cell_1.dat.bak") -Force
    }

    Write-Step "Backing up core DB tables (landblock_instance/link, portal positions, encounter)"
    $dbBackupPath = Join-Path $backupDir "ace_world_pre_vanquishkit.sql"
    & $mysqldumpExe --skip-ssl -u $DbUser "-p$DbPassword" $DbName landblock_instance landblock_instance_link weenie_properties_position encounter | Out-File -FilePath $dbBackupPath -Encoding utf8
    if ($LASTEXITCODE -ne 0) {
        throw "mysqldump failed with exit code $LASTEXITCODE"
    }

    Write-Step "Patching Config.js to prevent auto-overwrite with retail data"
    $configText = Get-Content -LiteralPath $configPath -Raw
    $configText = [regex]::Replace($configText, '"AutoUpdateWorldDatabase"\s*:\s*(true|false)', '"AutoUpdateWorldDatabase": false')
    $configText = [regex]::Replace($configText, '"AutoApplyWorldCustomizations"\s*:\s*(true|false)', '"AutoApplyWorldCustomizations": false')
    Set-Content -LiteralPath $configPath -Value $configText -Encoding utf8

    Write-Step "Copying Vanquish DAT payload"
    Copy-Item -LiteralPath $payloadDat -Destination $aceDatPath -Force
    if (-not $SkipClientDat) {
        Copy-Item -LiteralPath $payloadDat -Destination $clientDatPath -Force
    }

    Write-Step "Applying SQL patches in order"
    foreach ($sqlFile in $payloadSql) {
        Write-Host "  Applying $($sqlFile.Name) ..."
        Get-Content -LiteralPath $sqlFile.FullName -Raw | & $mysqlExe --skip-ssl -u $DbUser "-p$DbPassword" $DbName
        if ($LASTEXITCODE -ne 0) {
            throw "mysql apply failed for $($sqlFile.Name) with exit code $LASTEXITCODE"
        }
    }

    Write-Step "Install complete"
    Write-Host "Backup folder : $backupDir"
    Write-Host "Install log   : $logPath"
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "1. Start ACE server."
    Write-Host "2. Launch AC client and log in."
    Write-Host "3. Keep AutoUpdateWorldDatabase and AutoApplyWorldCustomizations set to false."
}
finally {
    Stop-Transcript | Out-Null
}
