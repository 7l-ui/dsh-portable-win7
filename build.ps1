param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot 'artifacts\DSH-Portable-Windows-x64'),
  [string]$PrimaryRuntimeSource = '',
  [string]$GitSource = '',
  [string]$BridgeSource = (Join-Path $PSScriptRoot 'bridge-source'),
  [string]$SevenZipExecutable = '7z.exe',
  [string]$ArchivePath = (Join-Path $PSScriptRoot 'downloads\DeepSeek-Harness-Portable-0.2.0-rc.2.zip'),
  [string]$UpstreamDirectory = (Join-Path $PSScriptRoot 'downloads\upstream-0.2.0-rc.2'),
  [switch]$NoArchive
)
$ErrorActionPreference = 'Stop'
$sevenZip = $SevenZipExecutable
$expectedHash = 'D9B6ABEADEA953A1974F90CE59DE61D47EF366A3B8F60A21C6FC256C9AAF1923'
if ([string]::IsNullOrWhiteSpace($PrimaryRuntimeSource) -or [string]::IsNullOrWhiteSpace($GitSource)) {
  throw '请显式提供 PrimaryRuntimeSource 和 GitSource。外部依赖与许可范围见 BUILDING.zh-CN.md；本源码不附办公技能。'
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw '输出目录已经存在，请指定新目录。' }
foreach ($inputDirectory in @($PrimaryRuntimeSource,$GitSource,$BridgeSource,$UpstreamDirectory,(Join-Path $PSScriptRoot 'template'))) {
  $inputFull = [System.IO.Path]::GetFullPath($inputDirectory).TrimEnd('\')
  if ($OutputDirectory.Equals($inputFull,[System.StringComparison]::OrdinalIgnoreCase) -or $OutputDirectory.StartsWith($inputFull + '\',[System.StringComparison]::OrdinalIgnoreCase)) {
    throw '输出目录不能位于构建输入目录内。'
  }
}
foreach ($requiredPath in @((Join-Path $PrimaryRuntimeSource 'runtime.json'),(Join-Path $PrimaryRuntimeSource 'dependencies\node\bin\node.exe'),(Join-Path $PrimaryRuntimeSource 'dependencies\python\python.exe'),(Join-Path $PrimaryRuntimeSource 'dependencies\pnpm'),(Join-Path $GitSource 'cmd\git.exe'),(Join-Path $BridgeSource 'connection.mjs'),(Join-Path $BridgeSource 'node_modules'))) {
  if (-not (Test-Path -LiteralPath $requiredPath)) { throw "缺少外部构建输入：$requiredPath。请先按 BUILDING.zh-CN.md 准备。" }
}
if (-not (Get-Command $sevenZip -ErrorAction SilentlyContinue)) { throw '未找到 7-Zip；使用 SevenZipExecutable 指定可执行文件。' }
if (-not (Test-Path -LiteralPath $archivePath)) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $archivePath) -Force | Out-Null
  Invoke-WebRequest -Uri 'https://github.com/sqs404/dsh-portable/releases/download/v0.2.0-rc.2/DeepSeek-Harness-Portable-0.2.0-rc.2.zip' -OutFile $archivePath -UseBasicParsing
}
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $expectedHash) { throw '基础包 SHA256 不匹配。' }
if (-not (Test-Path -LiteralPath (Join-Path $upstreamDirectory 'node_modules\@deepseek-ai\dsh\package.json'))) {
  & $sevenZip x $archivePath "-o$upstreamDirectory" -y -bso0 -bsp0
  if ($LASTEXITCODE -ne 0) { throw '基础包解压失败。' }
}
if (Test-Path -LiteralPath $OutputDirectory) { throw '输出目录已经存在，请指定新的 OutputDirectory，避免覆盖已有数据。' }
foreach ($requiredPath in @((Join-Path $PrimaryRuntimeSource 'runtime.json'),(Join-Path $GitSource 'cmd\git.exe'))) {
  if (-not (Test-Path -LiteralPath $requiredPath)) { throw "缺少构建输入：$requiredPath" }
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
function Copy-Distribution([string]$source,[string]$destination,[string[]]$extra = @()) {
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  & robocopy.exe $source $destination /E /XJ /R:2 /W:1 /NFL /NDL /NJH /NJS /NP @extra | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "复制发行组件失败：$source" }
}
Copy-Distribution (Join-Path $upstreamDirectory 'node_modules') (Join-Path $OutputDirectory 'app\node_modules')
foreach ($fileName in @('package.json','package-lock.json')) {
  Copy-Item -LiteralPath (Join-Path $upstreamDirectory $fileName) -Destination (Join-Path $OutputDirectory "app\$fileName")
}
New-Item -ItemType Directory -Path (Join-Path $OutputDirectory 'runtime\primary-runtime') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PrimaryRuntimeSource 'runtime.json') -Destination (Join-Path $OutputDirectory 'runtime\primary-runtime\runtime.json')
foreach ($dependencyName in @('node','python','pnpm')) {
  Copy-Distribution (Join-Path $PrimaryRuntimeSource "dependencies\$dependencyName") (Join-Path $OutputDirectory "runtime\primary-runtime\dependencies\$dependencyName") @('/XD','__pycache__')
}
# Do not copy desktop office-skills or other application assets with unverified redistribution rights.
New-Item -ItemType Directory -Path (Join-Path $OutputDirectory 'runtime\node') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PrimaryRuntimeSource 'dependencies\node\bin\node.exe') -Destination (Join-Path $OutputDirectory 'runtime\node\node.exe')
Copy-Item -LiteralPath (Join-Path $PrimaryRuntimeSource 'dependencies\node\LICENSE') -Destination (Join-Path $OutputDirectory 'runtime\node\LICENSE')
foreach ($directoryName in @('bin','cmd','etc','mingw64','usr')) {
  Copy-Distribution (Join-Path $GitSource $directoryName) (Join-Path $OutputDirectory "runtime\git\$directoryName")
}
foreach ($fileName in @('LICENSE.txt','ReleaseNotes.html')) {
  Copy-Item -LiteralPath (Join-Path $GitSource $fileName) -Destination (Join-Path $OutputDirectory "runtime\git\$fileName")
}
Copy-Distribution (Join-Path $BridgeSource 'node_modules') (Join-Path $OutputDirectory 'bridge\node_modules')
foreach ($fileName in @('connection.mjs','core.mjs','server.mjs','package.json','package-lock.json','LICENSE')) {
  $sourceFile = if ($fileName -in @('core.mjs','server.mjs')) { Join-Path $PSScriptRoot "template\bridge\$fileName" } else { Join-Path $BridgeSource $fileName }
  Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $OutputDirectory "bridge\$fileName")
}
Copy-Distribution (Join-Path $PSScriptRoot 'template') $OutputDirectory @('/XF','*.test.mjs')
New-Item -ItemType Directory -Path (Join-Path $OutputDirectory 'licenses\sqs404'),(Join-Path $OutputDirectory 'data\dsh-home'),(Join-Path $OutputDirectory 'data\agents-home'),(Join-Path $OutputDirectory 'data\runtime'),(Join-Path $OutputDirectory 'logs') -Force | Out-Null
foreach ($fileName in @('LICENSE','THIRD_PARTY_NOTICES.md')) {
  Copy-Item -LiteralPath (Join-Path $upstreamDirectory $fileName) -Destination (Join-Path $OutputDirectory "licenses\sqs404\$fileName")
}
& (Join-Path $OutputDirectory 'runtime\node\node.exe') (Join-Path $PSScriptRoot 'scripts\manifest.mjs') $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw '构建清单检查失败。' }
if (-not $NoArchive) {
  & (Join-Path $PSScriptRoot 'package.ps1') -PackageDirectory $OutputDirectory
  if ($LASTEXITCODE -ne 0) { throw '压缩包制作失败。' }
}
Write-Output "便携目录已构建：$OutputDirectory"
