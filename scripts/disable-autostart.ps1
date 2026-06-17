$ErrorActionPreference = 'SilentlyContinue'

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$entryName = 'GeminiOpenAIProxy'

Remove-ItemProperty -Path $runKey -Name $entryName

if ((Get-ItemProperty -Path $runKey -Name $entryName).$entryName) {
  Write-Output 'Gemini proxy autostart is still enabled.'
  exit 1
}

Write-Output 'Gemini proxy autostart disabled.'
