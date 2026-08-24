<#
  acme-patch-client.ps1 - ACME r8 kit client patcher (Windows PowerShell 5.1+).

  Patches YOUR OWN retail End-of-Retail acclient.exe (2015-06-12 build 6096)
  in place.  The ACME kit ships NO client executable - the community norm is
  patch-over-your-own-install - so this script carries only the byte deltas.

  Doctrine (mirrors the ACME repo's patch registry, tools/dat-patch/ac-eor-patch):
    * every site is located by a UNIQUE byte SIGNATURE (invariant context
      around the needle), never by a quoted address;
    * a signature that is missing, or found more than once, REFUSES;
    * idempotent - a site already carrying the replacement is a no-op;
    * fail-loud - nothing is written unless every enabled patch resolves;
    * the PE checksum is recomputed so the on-disk artifact is correct.

  Usage:
    .\acme-patch-client.ps1                 patch .\acclient.exe in place (backup first)
    .\acme-patch-client.ps1 -Verify         report patch state, write nothing
    .\acme-patch-client.ps1 -Exe <path> [-Out <path>] [-NoBackup] [-Quiet]

  Exit codes: 0 ok / already patched | 1 refused (nothing written) | 2 usage.
#>
[CmdletBinding()]
param(
  [string]$Exe = "acclient.exe",
  [string]$Out = "",
  [switch]$Verify,
  [switch]$NoBackup,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"

# --- the shipped patch set (generated from patch_client.py PATCHES, enabled=True)
# sig = invariant context window present in the pristine exe; needle_at = byte
# offset of the rewritten slice inside sig; needle -> replace, same length.
$PATCHES = @(
  @{ key='palette-leak'; title="notan's EOR palette-leak fix (site 1 of 3)";
     sig='66feffff85c07403ff4024c3'; at=8;
     needle='ff4024'; replace='909090' },
  @{ key='palette-leak-2'; title="notan's EOR palette-leak fix (site 2 of 3)";
     sig='85f6743cff46248b06538bce'; at=4;
     needle='ff4624'; replace='909090' },
  @{ key='palette-double-free'; title="releasePalette double-free fix (site 3 of 3 - MANDATORY companion)";
     sig='066a018bceff50188b166a018bceff52185ec38b068bce5eff'; at=8;
     needle='8b166a018bceff5218'; replace='909090909090909090' },
  @{ key='dat-version-preserve'; title="preserve BTEntry version through DiskController::Decompress (compressed DATs)";
     sig='e81853d9ff8d4c2424e80f53d9ff5f5e5d'; at=5;
     needle='8d4c2424e80f53d9ff'; replace='0fb745028946049090' },
  @{ key='highres-force-mount'; title="CLCache::OnServerInterrogation - mount client_highres.dat regardless of the server DDD bit";
     sig='89bef402000089bef8020000f64510047405e840feffff8b45088b16'; at=16;
     needle='7405'; replace='9090' },
  @{ key='highres-advertise-cap'; title="CLCache::OnServerInterrogation - advertise only dats 0-2 to the server";
     sig='84c0750232db8b86e8010000473bf872b5'; at=6;
     needle='8b86e8010000'; replace='b80300000090' },
  @{ key='res-4k-unlock'; title="4K-res unlock 1/2: UIElement::MouseResizeElement clamps";
     sig='8bcb8944241c03f7e8a3f8ffff8d54242c526a3d8bcb88442440e891f8ffff884424118d442420506a3e8bcbe87ff8ffff8d4c2424516a3c8bcb8844243ce86df8ffff8b8b800400004983f9078ad0885424120f87b3020000'; at=13;
     needle='8d54242c526a3d8bcb88442440e891f8ffff884424118d442420506a3e8bcbe87ff8ffff8d4c2424516a3c8bcb8844243ce86df8ffff8b8b800400004983f9078ad088542412';
     replace='c744242c000f00009088442438c644241100909090908d442420506a3e8bcbe87ff8ffffc7442424700800009088442434c6442412008b8b800400004933c033d283f9079090' },
  @{ key='res-4k-unlock-2'; title="4K-res unlock 2/2: UIElement::ResizeTo clamps";
     sig='8bcee89ecdffff84c0740a8b44240c3be87e028be88d4c2410516a3e8bcee882cdffff84c0740a8b4424103be87d028be88d542414526a3d8bcee866cdffff84c0740c8b442414394424547e028bd88d442418506a3f8bcee848cdffff84c0740a8b4424183bd87d028bd8'; at=9;
     needle='740a8b44240c3be87e028be88d4c2410516a3e8bcee882cdffff84c0740a8b4424103be87d028be88d542414526a3d8bcee866cdffff84c0740c8b442414394424547e028bd88d442418506a3f8bcee848cdffff84c074';
     replace='eb0a8b44240c3be87e028be88d4c2410516a3e8bcee882cdffff84c0eb0a8b4424103be87d028be88d542414526a3d8bcee866cdffff84c0eb0c8b442414394424547e028bd88d442418506a3f8bcee848cdffff84c0eb' }
)

$EXPECTED_SIZE = 4841472   # retail EOR acclient.exe

function Say([string]$m) { if (-not $Quiet) { Write-Host $m } }
function Die([string]$m) { Write-Host ""; Write-Host "REFUSED: $m" -ForegroundColor Red; exit 1 }

# byte<->latin1 string: bytes 0..255 map 1:1 to chars, so .NET Ordinal string
# search (native, fast) can do the byte scanning.
$L1 = [System.Text.Encoding]::GetEncoding(28591)
function HexToStr([string]$hex) {
  $n = $hex.Length / 2
  $b = New-Object byte[] $n
  for ($i = 0; $i -lt $n; $i++) { $b[$i] = [Convert]::ToByte($hex.Substring($i*2,2),16) }
  return ,$L1.GetString($b)
}
function HexToBytes([string]$hex) {
  $n = $hex.Length / 2
  $b = New-Object byte[] $n
  for ($i = 0; $i -lt $n; $i++) { $b[$i] = [Convert]::ToByte($hex.Substring($i*2,2),16) }
  return ,$b
}

function PeChecksumOffset([byte[]]$b) {
  $lfanew = [BitConverter]::ToInt32($b, 0x3C)
  if ($b[$lfanew] -ne 0x50 -or $b[$lfanew+1] -ne 0x45 -or $b[$lfanew+2] -ne 0 -or $b[$lfanew+3] -ne 0) {
    Die "not a PE file (no PE\0\0 at e_lfanew)"
  }
  return $lfanew + 4 + 20 + 64
}

$csharp = @'
public static class AcmePe {
  public static uint Checksum(byte[] b, int csumOff) {
    ulong total = 0; int limit = b.Length; int i = 0;
    while (i + 1 < limit) {
      if (i == csumOff) { i += 4; continue; }
      total += (ulong)(b[i] | (b[i+1] << 8));
      total = (total & 0xFFFF) + (total >> 16);
      i += 2;
    }
    if (i < limit) { total += b[i]; total = (total & 0xFFFF) + (total >> 16); }
    total = (total & 0xFFFF) + (total >> 16);
    return (uint)((total + (ulong)limit) & 0xFFFFFFFF);
  }
}
'@
# Add-Type is compiled LAZILY: play.bat calls -Verify -Quiet on every launch and
# never needs the checksum, and a csc invocation there would cost seconds.
$script:fastChecksum = $null

function PeChecksum([byte[]]$b, [int]$csumOff) {
  if ($null -eq $script:fastChecksum) {
    $script:fastChecksum = $true
    try { Add-Type -TypeDefinition $csharp -ErrorAction Stop } catch { $script:fastChecksum = $false }
  }
  if ($script:fastChecksum) { return [AcmePe]::Checksum($b, $csumOff) }
  # pure-PowerShell fallback (slower, same arithmetic)
  [uint64]$total = 0; $limit = $b.Length; $i = 0
  while ($i + 1 -lt $limit) {
    if ($i -eq $csumOff) { $i += 4; continue }
    $total += [uint64]($b[$i] -bor ($b[$i+1] -shl 8))
    $total = ($total -band 0xFFFF) + ($total -shr 16)
    $i += 2
  }
  if ($i -lt $limit) { $total += $b[$i]; $total = ($total -band 0xFFFF) + ($total -shr 16) }
  $total = ($total -band 0xFFFF) + ($total -shr 16)
  return [uint32](($total + [uint64]$limit) -band 0xFFFFFFFF)
}

# --- load ------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $Exe)) {
  Die "$Exe not found. Run this from your Asheron's Call install folder, or pass -Exe <path>."
}
$ExeFull = (Resolve-Path -LiteralPath $Exe).Path
$bytes = [IO.File]::ReadAllBytes($ExeFull)
Say ""
Say "ACME client patcher - $ExeFull"
Say ("  size {0:N0} bytes" -f $bytes.Length)
if ($bytes.Length -ne $EXPECTED_SIZE) {
  Die ("unexpected size {0:N0} (expected {1:N0} for the retail End-of-Retail acclient.exe). This patcher targets that build only; nothing was written." -f $bytes.Length, $EXPECTED_SIZE)
}
$text = $L1.GetString($bytes)

# --- locate every site BEFORE writing anything -----------------------------
$sites = @()
foreach ($p in $PATCHES) {
  $sig     = $p.sig
  $prefix  = HexToStr $sig.Substring(0, $p.at * 2)
  $needle  = HexToStr $p.needle
  $replace = HexToStr $p.replace
  $sufHex  = $sig.Substring(($p.at + $p.needle.Length/2) * 2)
  $suffix  = if ($sufHex.Length -gt 0) { HexToStr $sufHex } else { "" }
  $n = $needle.Length

  $hits = @()
  $i = -1
  while ($true) {
    if ($prefix.Length -gt 0) {
      $i = $text.IndexOf($prefix, $i + 1, [StringComparison]::Ordinal)
      if ($i -lt 0) { break }
      $mid = $i + $prefix.Length
    } else {
      # zero-length prefix: scan on the needle/replacement itself
      $i = $text.IndexOf($needle, $i + 1, [StringComparison]::Ordinal)
      if ($i -lt 0) { break }
      $mid = $i
    }
    if ($mid + $n + $suffix.Length -gt $text.Length) { continue }
    $cur = $text.Substring($mid, $n)
    if ($cur -cne $needle -and $cur -cne $replace) { continue }
    if ($suffix.Length -gt 0 -and $text.Substring($mid + $n, $suffix.Length) -cne $suffix) { continue }
    $hits += $mid
  }

  if ($hits.Count -eq 0) {
    Die ("[{0}] signature not found. This is not the retail End-of-Retail acclient.exe (or it was patched by another tool). Nothing was written." -f $p.key)
  }
  if ($hits.Count -gt 1) {
    Die ("[{0}] signature is NOT unique ({1} matches) - refusing. Nothing was written." -f $p.key, $hits.Count)
  }
  $off = $hits[0]
  $cur = $text.Substring($off, $n)
  $state = if ($cur -ceq $needle) { "orig" } else { "patched" }
  $sites += @{ p = $p; off = $off; state = $state }
}

# --- dat-align-lfa: the many-site DAT-parser alignment patch ---------------
# Retail's archive 4-byte alignment idiom computes `(signed int)ptr % 4`
# (`and r32, 0x80000003` + sign fixup).  acclient is large-address-aware, so
# above 2 GB the modulo returns the wrong pad, the read cursor desyncs, and
# the DAT parsers AV.  Fix: clear the imm sign bit at EVERY idiom site
# (signed %4 -> unsigned &3).  Ported from the lane registry AlignIdiomPatch;
# the site filter (AND opcode before the imm + `mov r32,4` + `or r32,-4`
# within 28 bytes) skips the file's non-idiom uses of the constant.
# Fail-loud: exactly $ALIGN_SITES sites of one form, or nothing is written.
$ALIGN_KEY   = 'dat-align-lfa'
$ALIGN_SITES = 189
function AlignScan([string]$t, [string]$imm) {
  $hits = New-Object System.Collections.Generic.List[int]
  $movFour = HexToStr '04000000'
  $j = 1   # need 2 bytes of lookbehind
  while ($true) {
    $j = $t.IndexOf($imm, $j + 1, [StringComparison]::Ordinal)
    if ($j -lt 0) { break }
    if ($j -lt 2) { continue }
    $b1 = [int][char]$t[$j - 1]
    $b2 = [int][char]$t[$j - 2]
    if (-not ($b1 -eq 0x25 -or ($b2 -eq 0x81 -and $b1 -ge 0xE0 -and $b1 -le 0xE7))) { continue }
    $wStart = $j + 4
    $wLen = [Math]::Min(28, $t.Length - $wStart)
    if ($wLen -lt 3) { continue }
    $w = $t.Substring($wStart, $wLen)
    if ($w.IndexOf($movFour, [StringComparison]::Ordinal) -lt 0) { continue }
    $fix = $false
    for ($k = 0; $k -le $w.Length - 3; $k++) {
      $c1 = [int][char]$w[$k + 1]
      if ([int][char]$w[$k] -eq 0x83 -and $c1 -ge 0xC8 -and $c1 -le 0xCF -and [int][char]$w[$k + 2] -eq 0xFC) { $fix = $true; break }
    }
    if (-not $fix) { continue }
    [void]$hits.Add($j)
  }
  return ,$hits
}
$alignOrig = AlignScan $text (HexToStr '03000080')
$alignLfa  = AlignScan $text (HexToStr '03000000')
if ($alignOrig.Count -eq $ALIGN_SITES -and $alignLfa.Count -eq 0) {
  $alignState = 'orig'; $alignSites = $alignOrig
} elseif ($alignLfa.Count -eq $ALIGN_SITES -and $alignOrig.Count -eq 0) {
  $alignState = 'patched'; $alignSites = $alignLfa
} else {
  Die ("[{0}] found {1} original + {2} patched alignment-idiom sites, expected exactly {3} of one form. This is not the retail End-of-Retail acclient.exe (or another tool partially changed it). Nothing was written." -f $ALIGN_KEY, $alignOrig.Count, $alignLfa.Count, $ALIGN_SITES)
}
$sites += @{ p = @{ key = $ALIGN_KEY }; off = $alignSites[0]; state = $alignState; align = $true }

# --- report ----------------------------------------------------------------
$todo = @($sites | Where-Object { $_.state -eq "orig" })
$nAll = $sites.Count
foreach ($s in $sites) {
  if ($s.align) { Say ("  [{0,-22}] 0x{1:X6}  {2} ({3} idiom sites)" -f $s.p.key, $s.off, $s.state, $alignSites.Count) }
  else { Say ("  [{0,-22}] 0x{1:X6}  {2}" -f $s.p.key, $s.off, $s.state) }
}
$csumOff = PeChecksumOffset $bytes
$stored  = [BitConverter]::ToUInt32($bytes, $csumOff)

if ($Verify) {
  # -Quiet skips the checksum recompute: play.bat calls this on every launch and
  # only needs the site states (rc 0/1), not the report line.
  if (-not $Quiet) {
    $correct = PeChecksum $bytes $csumOff
    Say ("  PE checksum stored 0x{0:X8} / computed 0x{1:X8}{2}" -f $stored, $correct, $(if ($stored -eq $correct) { "" } else { " (STALE)" }))
  }
  if ($todo.Count -eq 0) { Say ""; Say ("VERIFY: fully patched ({0}/{0} patches)." -f $nAll); exit 0 }
  Say ""
  Say ("VERIFY: {0} of {1} sites still original - run this script without -Verify to patch." -f $todo.Count, $sites.Count)
  exit 1
}

if ($todo.Count -eq 0) {
  Say ""
  Say ("Already patched ({0}/{0} patches) - nothing to do." -f $nAll)
  exit 0
}

# --- apply -----------------------------------------------------------------
$Target = if ($Out) { $Out } else { $ExeFull }
if (-not $Out -and -not $NoBackup) {
  $bak = "$ExeFull.acme-orig.bak"
  if (-not (Test-Path -LiteralPath $bak)) {
    Copy-Item -LiteralPath $ExeFull -Destination $bak
    Say "  backup -> $bak"
  } else {
    Say "  backup already exists -> $bak (kept)"
  }
}
foreach ($s in $sites) {
  if ($s.state -eq "patched") { continue }
  if ($s.align) {
    foreach ($j in $alignSites) { $bytes[$j + 3] = 0 }
    Say ("  applied [{0}] at {1} idiom sites (1 byte each)" -f $s.p.key, $alignSites.Count)
    continue
  }
  $rep = HexToBytes $s.p.replace
  [Array]::Copy($rep, 0, $bytes, $s.off, $rep.Length)
  Say ("  applied [{0}] at 0x{1:X6} ({2} bytes)" -f $s.p.key, $s.off, $rep.Length)
}
# zero the checksum field, recompute, store
for ($k = 0; $k -lt 4; $k++) { $bytes[$csumOff + $k] = 0 }
$val = PeChecksum $bytes $csumOff
[Array]::Copy([BitConverter]::GetBytes([uint32]$val), 0, $bytes, $csumOff, 4)
[IO.File]::WriteAllBytes($Target, $bytes)

$sha = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLower()
Say ("  PE checksum 0x{0:X8} (was 0x{1:X8})" -f $val, $stored)
Say ""
Say "PATCHED: $Target"
Say "  sha256 $sha"
Say "  (expected for the ACME r8 shipping set: see kit-manifest.txt)"
exit 0
