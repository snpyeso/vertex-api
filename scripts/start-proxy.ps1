$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\Axzo\Documents\vertex-api'
$npm = 'C:\nvm4w\nodejs\npm.cmd'

$env:HOST = '0.0.0.0'
$env:PORT = '3100'
$env:VERTEX_MIN_INTERVAL_MS = '60000'
Set-Location $repo

& $npm run dev *> "$repo\server.log"
