$ErrorActionPreference = 'Stop'
$packageDirectory = Split-Path -Parent $PSScriptRoot
$bundledNode = Join-Path $packageDirectory 'runtime\node\node.exe'
$keyModule = Join-Path $PSScriptRoot 'keys.mjs'
$providerLabels = @{
  'deepseek-official' = 'DeepSeek 官方'
  'opencode-go' = 'OpenCode Go'
}

function Invoke-KeyTool {
  param(
    [Parameter(Mandatory = $true)][string[]]$ToolArguments,
    [AllowNull()][AllowEmptyString()][string]$InputText = $null
  )
  $processInfo = New-Object Diagnostics.ProcessStartInfo
  $processInfo.FileName = $bundledNode
  # Arguments contain only fixed command, slot and provider identifiers; never a key.
  $processInfo.Arguments = '"' + $keyModule + '" ' + ($ToolArguments -join ' ')
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $processInfo.RedirectStandardInput = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $processInfo.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
  $processInfo.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
  $keyProcess = New-Object Diagnostics.Process
  $keyProcess.StartInfo = $processInfo
  try {
    if (-not $keyProcess.Start()) { throw '无法启动包内配置工具。' }
    if ($ToolArguments[0] -eq 'set') { $keyProcess.StandardInput.WriteLine($InputText) }
    $keyProcess.StandardInput.Close()
    $safeOutput = $keyProcess.StandardOutput.ReadToEnd()
    $null = $keyProcess.StandardError.ReadToEnd()
    $keyProcess.WaitForExit()
    if ($keyProcess.ExitCode -ne 0) { throw '配置操作失败，请检查槽位和服务后重试。' }
    return ($safeOutput | ConvertFrom-Json)
  } finally {
    $keyProcess.Dispose()
  }
}

function Show-KeySummary {
  param($Summary)
  foreach ($entry in $Summary.slots) {
    $configured = if ($entry.configured) { '已配置' } else { '未配置' }
    $selected = if ($entry.id -eq $Summary.active) { ' [当前默认]' } else { '' }
    Write-Host ('{0}（{1}）：{2}，{3}{4}' -f $entry.id, $entry.label, $providerLabels[$entry.provider], $configured, $selected)
  }
}

function Read-KeySlot {
  $slotChoice = Read-Host '槽位名称（primary / backup1 / backup2）'
  if ($slotChoice -notin @('primary', 'backup1', 'backup2')) { throw '槽位名称无效。' }
  return $slotChoice
}

function Read-KeyProvider {
  param([string]$CurrentProvider)
  $providerChoice = Read-Host ('服务：1 DeepSeek 官方，2 OpenCode Go；回车保留 {0}' -f $providerLabels[$CurrentProvider])
  if ($providerChoice -eq '') { return $CurrentProvider }
  if ($providerChoice -eq '1') { return 'deepseek-official' }
  if ($providerChoice -eq '2') { return 'opencode-go' }
  throw '服务选择无效。'
}

Write-Host '三个密钥槽位可分别关联服务；选择当前槽位会切换默认模型服务。'
Write-Host '各服务分别使用自己的密钥，故障后不会自动切换服务或密钥。'
$summary = Invoke-KeyTool -ToolArguments @('status')
Show-KeySummary $summary
$choice = Read-Host '输入 1 设置密钥及服务，2 选择当前默认槽位，3 更改槽位服务；直接回车退出'
if ($choice -notin @('1', '2', '3')) { exit 0 }
$slot = Read-KeySlot
if ($choice -eq '2') {
  $summary = Invoke-KeyTool -ToolArguments @('select', $slot)
} else {
  $entry = $summary.slots | Where-Object { $_.id -eq $slot } | Select-Object -First 1
  $provider = Read-KeyProvider -CurrentProvider $entry.provider
  if ($provider -ne $entry.provider) {
    Write-Host '更换服务会清除此槽原密钥，避免将旧密钥发送给另一个服务。'
    $summary = Invoke-KeyTool -ToolArguments @('provider', $slot, $provider)
  }
  if ($choice -eq '1') {
    $secretInput = Read-Host ('输入 {0} 的 API key（不会显示）；留空可清除此槽位' -f $providerLabels[$provider]) -AsSecureString
    $secretPointer = [IntPtr]::Zero
    $secretValue = $null
    try {
      $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretInput)
      $secretValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
      $summary = Invoke-KeyTool -ToolArguments @('set', $slot) -InputText $secretValue
    } finally {
      if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
      $secretValue = $null
      $secretInput.Dispose()
    }
  }
}
Show-KeySummary $summary
Write-Host '配置已保存。已经运行的便携 DSH 请在任务结束后停止并重新启动，以使用新的密钥与默认服务。'
