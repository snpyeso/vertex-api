$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\Axzo\Documents\gemini-CG'
$node = 'C:\nvm4w\nodejs\node.exe'

$env:PORT = '3100'
Set-Location $repo

& $node "$repo\src\server\index.js" *> "$repo\server.log"
