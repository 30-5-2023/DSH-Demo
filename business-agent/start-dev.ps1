<#
.SYNOPSIS
    Quick start for this project's Web GUI and A2A listener.

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

    -ReplaceExisting stops the exact processes listening on the selected Web and
    A2A ports before starting.

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

.EXAMPLE
    powershell -File business-agent\start-dev.ps1 -A2AHost 0.0.0.0 -A2APublicBaseUrl http://192.168.1.10:3082
    Accept A2A calls from the intranet and advertise the host address supplied
    at runtime. The address is not written into the profile or image.
#>
[CmdletBinding()]
param(
    # Listen port; default 3081.
    [int]$Port = 3081,

    # A2A-only bind address; use 0.0.0.0 for intranet access.
    [ValidateSet('127.0.0.1', '0.0.0.0')]
    [string]$A2AHost = '127.0.0.1',

    # Dedicated A2A listener port; default 3082.
    [ValidateRange(1, 65535)]
    [int]$A2APort = 3082,

    # Reachable HTTP(S) base URL advertised to A2A peers.
    [string]$A2APublicBaseUrl,

    # Profile name; defaults to this workspace's custom Profile.
    [string]$Profile = 'business-agent',

    # Print the URL only; do not open the default browser.
    [switch]$NoOpen,

    # Launch through `pnpm dsh` (source form) instead of the built CLI.
    [switch]$Source,

    # Stop the exact processes already listening on $Port or $A2APort.
    [switch]$ReplaceExisting,

    # Override DSH_HOME; defaults to tmp/business-agent-dsh-home.
    [string]$DshHome
)

$ErrorActionPreference = 'Stop'
if ($A2APublicBaseUrl) { $A2APublicBaseUrl = $A2APublicBaseUrl.TrimEnd('/') }
if ($A2AHost -eq '0.0.0.0' -and -not $A2APublicBaseUrl) {
    throw 'A2APublicBaseUrl is required with -A2AHost 0.0.0.0. Example: -A2APublicBaseUrl http://192.168.1.10:3082'
}
if ($A2APublicBaseUrl) {
    $parsedA2ABase = $null
    if (-not [Uri]::TryCreate($A2APublicBaseUrl, [UriKind]::Absolute, [ref]$parsedA2ABase) -or
        ($parsedA2ABase.Scheme -ne 'http' -and $parsedA2ABase.Scheme -ne 'https') -or
        $parsedA2ABase.Host -eq '0.0.0.0') {
        throw 'A2APublicBaseUrl must be an absolute HTTP(S) URL whose host is not 0.0.0.0'
    }
}
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

# Stop only the process currently owning one exact TCP listener.
function Stop-PortListener([int]$localPort) {
    $existing = Get-PortListenerPid $localPort
    if ($existing) {
        $name = (Get-Process -Id $existing -ErrorAction SilentlyContinue).ProcessName
        Write-Host "Stopping existing listener on port $localPort (PID $existing, $name)"
        Stop-Process -Id $existing -Force
        Start-Sleep -Milliseconds 800
    }
    else {
        Write-Host "No existing listener on port $localPort"
    }
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
        Stop-PortListener $Port
        if ($A2APort -ne $Port) { Stop-PortListener $A2APort }
    }

    $appArgs = @('--profile', $Profile, '--port', "$Port")
    if ($NoOpen) { $appArgs += '--no-open' }

    $advertisedA2ABase = if ($A2APublicBaseUrl) { $A2APublicBaseUrl } else { "http://127.0.0.1:$A2APort" }
    Write-Host "Web URL: http://127.0.0.1:$Port (profile=$Profile)"
    Write-Host "A2A Agent Card: $advertisedA2ABase/.well-known/agent-card.json"
    Write-Host "A2A JSON-RPC: $advertisedA2ABase/a2a"

    $priorA2AHost = [Environment]::GetEnvironmentVariable('A2A_LISTEN_HOST', 'Process')
    $priorA2APort = [Environment]::GetEnvironmentVariable('A2A_LISTEN_PORT', 'Process')
    $priorA2APublicBaseUrl = [Environment]::GetEnvironmentVariable('A2A_PUBLIC_BASE_URL', 'Process')
    try {
        $env:A2A_LISTEN_HOST = $A2AHost
        $env:A2A_LISTEN_PORT = "$A2APort"
        if ($A2APublicBaseUrl) { $env:A2A_PUBLIC_BASE_URL = $A2APublicBaseUrl }
        else { Remove-Item Env:A2A_PUBLIC_BASE_URL -ErrorAction SilentlyContinue }

        if ($Source) {
            & pnpm dsh @appArgs
        }
        else {
            & node $builtCli @appArgs
        }
        $applicationExitCode = $LASTEXITCODE
    }
    finally {
        [Environment]::SetEnvironmentVariable('A2A_LISTEN_HOST', $priorA2AHost, 'Process')
        [Environment]::SetEnvironmentVariable('A2A_LISTEN_PORT', $priorA2APort, 'Process')
        [Environment]::SetEnvironmentVariable('A2A_PUBLIC_BASE_URL', $priorA2APublicBaseUrl, 'Process')
    }
    exit $applicationExitCode
}
finally {
    Pop-Location
}
