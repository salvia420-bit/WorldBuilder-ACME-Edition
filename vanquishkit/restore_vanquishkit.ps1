[CmdletBinding()]
param(
    [string]$AceRoot = "C:\ACE",
    [string]$ClientRoot = "C:\Asheron's Call",
    [string]$MariaDbBin = "C:\Program Files\MariaDB 12.2\bin",
    [string]$DbUser = "root",
    [string]$DbPassword = "baltic",
    [string]$DbName = "ace_world",
    [string]$BackupPath = ""
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Yellow
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

if ([string]::IsNullOrWhiteSpace($BackupPath)) {
    $backupRoot = Join-Path $AceRoot "vanquishkit_backups"
    Assert-Path -Path $backupRoot -Label "Backup root"
    $latest = Get-ChildItem -Path $backupRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) {
        throw "No backups found in $backupRoot"
    }
    $BackupPath = $latest.FullName
}

Assert-Path -Path $BackupPath -Label "Backup folder"

$aceDatPath = Join-Path $AceRoot "Dats\client_cell_1.dat"
$clientDatPath = Join-Path $ClientRoot "client_cell_1.dat"
$configPath = Join-Path $AceRoot "Server\Config.js"

$mysqlExe = Join-Path $MariaDbBin "mysql.exe"
Assert-Path -Path $mysqlExe -Label "mysql.exe"

$backupAceDat = Join-Path $BackupPath "ace_client_cell_1.dat.bak"
$backupClientDat = Join-Path $BackupPath "acclient_client_cell_1.dat.bak"
$backupConfig = Join-Path $BackupPath "Config.js.bak"
$backupDb = Join-Path $BackupPath "ace_world_pre_vanquishkit.sql"

Assert-Path -Path $backupAceDat -Label "ACE DAT backup"
Assert-Path -Path $backupConfig -Label "Config.js backup"
Assert-Path -Path $backupDb -Label "DB backup SQL"

Write-Step "Stopping AC client and ACE server processes"
Get-Process -Name "acclient" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "ACE.Server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Step "Restoring DAT and Config.js backups"
Copy-Item -LiteralPath $backupAceDat -Destination $aceDatPath -Force
Copy-Item -LiteralPath $backupConfig -Destination $configPath -Force
if (Test-Path -LiteralPath $backupClientDat) {
    Copy-Item -LiteralPath $backupClientDat -Destination $clientDatPath -Force
}

Write-Step "Restoring database backup"
Get-Content -LiteralPath $backupDb -Raw | & $mysqlExe --skip-ssl -u $DbUser "-p$DbPassword" $DbName
if ($LASTEXITCODE -ne 0) {
    throw "mysql restore failed with exit code $LASTEXITCODE"
}

Write-Step "Restore complete"
Write-Host "Restored backup: $BackupPath"
