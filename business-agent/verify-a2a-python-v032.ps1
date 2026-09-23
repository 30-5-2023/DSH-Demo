<#
.SYNOPSIS
    Verify bidirectional interoperability with a2a-sdk 0.3.2.

.DESCRIPTION
    Creates an isolated workspace venv, installs the exact Python A2A parser,
    builds the JavaScript bridge, and runs only the exact-version smoke test.

.PARAMETER Python
    Python 3.10+ interpreter used to create the venv. Defaults to DSH_PYTHON or
    python from PATH.
#>
[CmdletBinding()]
param(
    [string]$Python = $(if ($env:DSH_PYTHON) { $env:DSH_PYTHON } else { 'python' })
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$requirements = Join-Path $PSScriptRoot 'tests\fixtures\a2a-python-v032-requirements.txt'
$venv = Join-Path $repoRoot 'tmp\a2a-python-v032-venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'

Push-Location $repoRoot
try {
    if (-not (Test-Path $venvPython)) {
        & $Python -m venv $venv
        if ($LASTEXITCODE -ne 0) { throw "Failed to create Python venv with $Python" }
    }

    & $venvPython -c "import importlib.metadata, sys; version = next((item.version for item in importlib.metadata.distributions(name='a2a-sdk')), None); sys.exit(0 if version == '0.3.2' else 1)" 2>$null
    if ($LASTEXITCODE -ne 0) {
        & $venvPython -m pip install -r $requirements
        if ($LASTEXITCODE -ne 0) { throw 'Failed to install a2a-sdk 0.3.2' }
    }
    & $venvPython -c "import importlib.metadata, sys; version = next((item.version for item in importlib.metadata.distributions(name='uvicorn')), None); sys.exit(0 if version == '0.37.0' else 1)" 2>$null
    if ($LASTEXITCODE -ne 0) {
        & $venvPython -m pip install uvicorn==0.37.0
        if ($LASTEXITCODE -ne 0) { throw 'Failed to install uvicorn 0.37.0' }
    }

    $version = & $venvPython -c "import importlib.metadata; print(importlib.metadata.version('a2a-sdk'))"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to read the installed a2a-sdk version' }
    Write-Host "a2a-sdk $version"

    & pnpm --filter '@deepseek-ai/dsh-business-a2a-bridge' build
    if ($LASTEXITCODE -ne 0) { throw 'A2A bridge build failed' }

    $priorPython = [Environment]::GetEnvironmentVariable('DSH_A2A_PYTHON032', 'Process')
    $priorInteropTmp = [Environment]::GetEnvironmentVariable('DSH_A2A_INTEROP_TMP', 'Process')
    $interopTmp = Join-Path $repoRoot (Join-Path 'tmp\a2a-python-v032-interop' ([Guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Path $interopTmp -Force | Out-Null
    try {
        $env:DSH_A2A_PYTHON032 = $venvPython
        $env:DSH_A2A_INTEROP_TMP = $interopTmp
        & node --test business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Python A2A 0.3.2 interoperability smoke failed' }
    }
    finally {
        [Environment]::SetEnvironmentVariable('DSH_A2A_PYTHON032', $priorPython, 'Process')
        [Environment]::SetEnvironmentVariable('DSH_A2A_INTEROP_TMP', $priorInteropTmp, 'Process')
        Remove-Item -LiteralPath $interopTmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
finally {
    Pop-Location
}
