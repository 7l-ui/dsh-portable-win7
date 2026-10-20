param(
  [string]$PackageDirectory = (Join-Path $PSScriptRoot 'artifacts\DSH-Portable-Windows-x64'),
  [switch]$IncludeKeys
)
$ErrorActionPreference = 'Stop'
$packagePath = (Resolve-Path -LiteralPath $PackageDirectory).Path
$bundledNode = Join-Path $packagePath 'runtime\node\node.exe'
$manifestArguments = @((Join-Path $PSScriptRoot 'scripts\manifest.mjs'), $packagePath)
if ($IncludeKeys) { $manifestArguments += '--include-keys' }
& $bundledNode @manifestArguments
if ($LASTEXITCODE -ne 0) { throw '分发前检查失败。' }
$packageName = Split-Path -Leaf $packagePath
$manifest = Get-Content -LiteralPath (Join-Path $packagePath 'manifest.json') -Raw | ConvertFrom-Json
$editionSuffix = if ($IncludeKeys) { 'private' } else { 'no-key' }
if ($manifest.packageVersion -notin @('0.1.0', '0.2.0') -or $manifest.credentialValuesIncluded -ne [bool]$IncludeKeys -or
  ($IncludeKeys -and ($manifest.packageVersion -ne '0.2.0' -or $manifest.edition -ne 'windows-x64-private'))) {
  throw '分发清单与请求的分发模式不一致。'
}
$archivePath = Join-Path (Split-Path -Parent $packagePath) ($packageName + '-' + $manifest.packageVersion + '-' + $editionSuffix + '.zip')
if ((Test-Path -LiteralPath $archivePath) -or (Test-Path -LiteralPath ($archivePath + '.sha256'))) { throw '目标 ZIP 或校验文件已经存在，请保留旧版本并选择新的输出位置。' }
$stagingArchive = Join-Path (Split-Path -Parent $packagePath) ('.dsh-archive-' + [guid]::NewGuid().ToString('N') + '.zip')
Push-Location -LiteralPath (Split-Path -Parent $packagePath)
try {
  & 'C:\Program Files\7-Zip\7z.exe' a -tzip $stagingArchive $packageName -mx=3 -mmt=on -bso0 -bsp0
  if ($LASTEXITCODE -ne 0) { throw 'ZIP 归档失败。' }
  & 'C:\Program Files\7-Zip\7z.exe' t $stagingArchive -bso0 -bsp0
  if ($LASTEXITCODE -ne 0) { throw 'ZIP 完整性检查失败。' }
  # Two-argument Move refuses an existing destination even if it appeared after
  # the earlier check. Never let 7-Zip update an existing archive in place.
  if (Test-Path -LiteralPath ($archivePath + '.sha256')) { throw '校验文件已存在，未发布 ZIP。' }
  [IO.File]::Move($stagingArchive, $archivePath)
} finally {
  Pop-Location
  if (Test-Path -LiteralPath $stagingArchive) { Remove-Item -LiteralPath $stagingArchive -Force }
}
$digest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumStream = [IO.File]::Open($archivePath + '.sha256', [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  $checksumBytes = (New-Object Text.UTF8Encoding($false)).GetBytes($digest + '  ' + (Split-Path -Leaf $archivePath) + [Environment]::NewLine)
  $checksumStream.Write($checksumBytes, 0, $checksumBytes.Length)
} finally { $checksumStream.Dispose() }
Write-Output "ZIP：$archivePath"
Write-Output "SHA256：$digest"
