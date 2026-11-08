# Start the BiasPoint backend (auto-reload) and the Vite dev server.
# Usage: ./scripts/dev.ps1    -> open http://127.0.0.1:5173
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\.local\bin;$env:Path"
if (-not $env:BPT_NGSPICE_LIB) {
    $env:BPT_NGSPICE_LIB = [Environment]::GetEnvironmentVariable('BPT_NGSPICE_LIB', 'User')
}

$backend = Start-Process -FilePath 'uv' -ArgumentList 'run', 'bpt', 'serve', '--dev', '--reload' `
    -WorkingDirectory (Join-Path $root 'backend') -NoNewWindow -PassThru
try {
    Push-Location (Join-Path $root 'apps\web')
    pnpm dev
}
finally {
    Pop-Location
    if (-not $backend.HasExited) {
        # uvicorn --reload spawns a child worker; stop the whole tree.
        taskkill /PID $backend.Id /T /F | Out-Null
    }
}
