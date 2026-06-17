$ErrorActionPreference = 'SilentlyContinue'

$connections = Get-NetTCPConnection -LocalPort 3100 -State Listen
$processIds = $connections.OwningProcess | Sort-Object -Unique

foreach ($processId in $processIds) {
  if ($processId) {
    Stop-Process -Id $processId -Force
  }
}

Start-Sleep -Seconds 1

$remaining = Get-NetTCPConnection -LocalPort 3100 -State Listen
if ($remaining) {
  Write-Output 'Gemini proxy is still running on port 3100.'
  exit 1
}

Write-Output 'Gemini proxy stopped.'
