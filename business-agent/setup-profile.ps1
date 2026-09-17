<#
.SYNOPSIS
    Initialize the isolated business-agent DSH Profile and install its Bundle.
#>
[CmdletBinding()]
param(
    [string]$DshHome,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$builtCli = Join-Path $repoRoot 'apps\cli\lib\bin.js'
$bundleRoot = Join-Path $PSScriptRoot 'bundle'
if (-not $DshHome) { $DshHome = Join-Path $repoRoot 'tmp\business-agent-dsh-home' }
if (-not [System.IO.Path]::IsPathRooted($DshHome)) { $DshHome = Join-Path $repoRoot $DshHome }
$env:DSH_HOME = [System.IO.Path]::GetFullPath($DshHome)
$profileDir = Join-Path $env:DSH_HOME 'profiles\business-agent'
$manifestPath = Join-Path $profileDir 'package.json'

if (-not (Test-Path $builtCli)) {
    throw 'Missing apps/cli/lib/bin.js. Run first: pnpm run build'
}

Push-Location $repoRoot
try {
    if (-not (Test-Path $manifestPath)) {
        & node $builtCli --profile business-agent --from-default-profile web --dump-config | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the business-agent Profile.' }
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $installed = $null -ne $manifest.dependencies.'@deepseek-ai/dsh-business-agent'
    if ($Force -or -not $installed) {
        & node $builtCli plugin --profile business-agent add --save-exact $bundleRoot
        if ($LASTEXITCODE -ne 0) { throw 'Could not install the business-agent Bundle.' }
    }

    Write-Host "business-agent profile: $profileDir"
}
finally {
    Pop-Location
}
