<#
.SYNOPSIS
    Quick start for this project's Web GUI. Default port 3081.

.DESCRIPTION
    Pins the business-agent profile and the port, initializes its isolated
    local DSH_HOME when needed, and fails with a build instruction when the
    required artifacts are missing.

    By default it runs the built CLI (apps/cli/lib/bin.js), which skips
    tsx/esbuild and therefore also starts inside the DSH file sandbox. Pass
    -Source for the documented source form, equivalent to
    `pnpm dsh --profile business-agent --port 3081`.

    The port travels as a command-line flag instead of a config edit because the
    upstream value is `port: !!js ctx.webStartup.port ?? 3080`; the flag wins, so
    the webserver row's whole `config` does not need to be copied into a patch.

    -ReplaceExisting stops whatever process already listens on the target port
    before starting, which is how this project reclaims 3081 from an earlier run.

    ASCII only on purpose: Windows PowerShell 5.1 decodes a BOM-less script as
    ANSI, which garbles non-ASCII text and can break parsing.

.EXAMPLE
    powershell -File business-agent\start-dev.ps1
    Start on the default port 3081 and open the default browser.

.EXAMPLE
    powershell -File business-agent\start-dev.ps1 -ReplaceExisting -NoOpen
    Stop the instance already holding 3081, then start a fresh one.

.EXAMPLE
    powershell -File business-agent\start-dev.ps1 -NoOpen -Port 3099 -DshHome tmp\dsh-dev-home
    Start on another port with DSH_HOME inside the workspace, for verification
    from an agent file sandbox.
#>
[CmdletBinding()]
param(
    # Listen port; default 3081.
    [int]$Port = 3081,

    # Profile name; defaults to this workspace's custom Profile.
    [string]$Profile = 'business-agent',

    # Print the URL only; do not open the default browser.
    [switch]$NoOpen,

    # Launch through `pnpm dsh` (source form) instead of the built CLI.
    [switch]$Source,

    # Stop the process already listening on $Port before starting.
    [switch]$ReplaceExisting,

    # Override DSH_HOME; defaults to tmp/business-agent-dsh-home.
    [string]$DshHome
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$builtCli = Join-Path $repoRoot 'apps/cli/lib/bin.js'
$frontend = Join-Path $repoRoot 'apps/web/dist/index.html'

# PID of the process listening on a TCP port, or $null when the port is free.
function Get-PortListenerPid([int]$localPort) {
    $pattern = "^\s*TCP\s+\S+:$localPort\s+\S+\s+LISTENING\s+(\d+)\s*$"
    netstat -ano | ForEach-Object {
        if ($_ -match $pattern) { [int]$Matches[1] }
    } | Select-Object -First 1
}

Push-Location $repoRoot
try {
    if (-not (Test-Path $frontend)) {
        throw "Missing frontend artifacts (apps/web/dist). Run first: pnpm run build"
    }
    if (-not $Source -and -not (Test-Path $builtCli)) {
        throw "Missing build artifact apps/cli/lib/bin.js. Run first: pnpm run build (or pass -Source)"
    }

    if (-not $DshHome) { $DshHome = Join-Path $repoRoot 'tmp\business-agent-dsh-home' }
    if (-not [System.IO.Path]::IsPathRooted($DshHome)) { $DshHome = Join-Path $repoRoot $DshHome }
    $env:DSH_HOME = [System.IO.Path]::GetFullPath($DshHome)
    Write-Host "DSH_HOME = $env:DSH_HOME"
    & powershell -NoProfile -File (Join-Path $PSScriptRoot 'setup-profile.ps1') -DshHome $env:DSH_HOME
    if ($LASTEXITCODE -ne 0) { throw 'business-agent Profile setup failed' }

    if ($ReplaceExisting) {
        $existing = Get-PortListenerPid $Port
        if ($existing) {
            $name = (Get-Process -Id $existing -ErrorAction SilentlyContinue).ProcessName
            Write-Host "Stopping existing listener on port $Port (PID $existing, $name)"
            Stop-Process -Id $existing -Force
            Start-Sleep -Milliseconds 800
        }
        else {
            Write-Host "No existing listener on port $Port"
        }
    }

    $appArgs = @('--profile', $Profile, '--port', "$Port")
    if ($NoOpen) { $appArgs += '--no-open' }

    Write-Host "Starting http://127.0.0.1:$Port (profile=$Profile)"
    if ($Source) {
        & pnpm dsh @appArgs
    }
    else {
        & node $builtCli @appArgs
    }
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
