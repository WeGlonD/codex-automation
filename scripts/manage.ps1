param([ValidateSet('doctor','schema','test','start','status','stop','enable-startup','disable-startup','smoke','install','remote','backup','browser-test','file-smoke','route-smoke')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$nodeCandidates = @((Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'), 'C:\Program Files\nodejs\node.exe')
$nodeExe = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $nodeExe) { $nodeExe = (Get-Command node -ErrorAction Stop).Source }
Set-Location -LiteralPath $projectRoot
$dataPath = Join-Path $projectRoot 'data'
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
switch ($Action) {
  'file-smoke' { & $nodeExe scripts/file-smoke.mjs; exit $LASTEXITCODE }
  'route-smoke' { & $nodeExe scripts/route-smoke.mjs; exit $LASTEXITCODE }
  'install' {
    $pnpmFile = Join-Path (Split-Path (Split-Path $nodeExe -Parent) -Parent) 'node_modules\pnpm\bin\pnpm.cjs'
    $env:PATH = (Split-Path $nodeExe -Parent) + ';' + $env:PATH
    & $nodeExe $pnpmFile install --ignore-scripts
    exit $LASTEXITCODE
  }
  'remote' {
    $tailscaleExe = 'C:\Program Files\Tailscale\tailscale.exe'
    $tailStatus = (& $tailscaleExe status --json | ConvertFrom-Json)
    if ($tailStatus.BackendState -ne 'Running') { throw 'Tailscale must be connected first.' }
    $remoteOrigin = 'https://' + $tailStatus.Self.DNSName.TrimEnd('.') + ':8443'
    & $nodeExe scripts/remote.mjs $remoteOrigin
    & $tailscaleExe serve --bg --https=8443 http://127.0.0.1:4317
    exit $LASTEXITCODE
  }
  'browser-test' { & $nodeExe scripts/browser-test.mjs; exit $LASTEXITCODE }
  'backup' { & $nodeExe scripts/backup.mjs; exit $LASTEXITCODE }
  'doctor' { & $nodeExe --version; & codex --version; & codex login status }
  'schema' { & codex app-server generate-json-schema --out (Join-Path $projectRoot 'protocol') }
  'test' { & $nodeExe --check src/server.mjs; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & $nodeExe --test test/engine.test.mjs test/recovery.test.mjs test/rate-limits.test.mjs test/provider-contract.test.mjs test/artifacts.test.mjs test/messages.test.mjs test/maintenance-requests.test.mjs test/claude-provider.test.mjs test/task-delete.test.mjs test/workspace-picker.test.mjs; exit $LASTEXITCODE }
  'smoke' { & $nodeExe scripts/smoke.mjs; exit $LASTEXITCODE }
  'start' {
    $pidPath = Join-Path $dataPath 'server.pid'
    if (Test-Path -LiteralPath $pidPath) {
      $savedPid = [int](Get-Content -LiteralPath $pidPath)
      $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid"
      if ($existing -and $existing.CommandLine -like '*codex-automation*supervisor.mjs*') { Write-Output "Already running: $savedPid"; break }
    }
    $entryPoint = Join-Path $projectRoot 'scripts\supervisor.mjs'
    $serverProcess = Start-Process -FilePath $nodeExe -ArgumentList ('"' + $entryPoint + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath 'server.log') -RedirectStandardError (Join-Path $dataPath 'server-error.log') -PassThru
    Set-Content -LiteralPath $pidPath -Value $serverProcess.Id
    Write-Output "Started: $($serverProcess.Id) http://127.0.0.1:4317"
  }
  'status' { Invoke-RestMethod 'http://127.0.0.1:4317/health' | ConvertTo-Json -Depth 5 }
  'stop' {
    $pidPath = Join-Path $dataPath 'server.pid'
    if (Test-Path -LiteralPath $pidPath) {
      $savedPid = [int](Get-Content -LiteralPath $pidPath)
      $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid"
      if ($existing -and $existing.CommandLine -like '*codex-automation*supervisor.mjs*') {
        & $nodeExe scripts/control.mjs stop
      }
    }
  }
  'enable-startup' {
    $startupPath = [Environment]::GetFolderPath('Startup')
    $shortcutPath = Join-Path $startupPath 'Codex Automation.lnk'
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
    $shortcut.TargetPath = (Get-Command powershell.exe).Source
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'manage.ps1') + '" -Action start'
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    Write-Output 'Enabled start at user sign-in.'
  }
  'disable-startup' {
    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Automation.lnk'
    if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
  }
}
