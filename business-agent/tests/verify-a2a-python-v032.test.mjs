import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const verifierUrl = new URL('../verify-a2a-python-v032.ps1', import.meta.url)

test('PowerShell 5.1 reaches installation when exact package metadata is absent', { skip: process.platform !== 'win32' }, async (context) => {
  const source = await readFile(verifierUrl, 'utf8')
  const match = /& \$venvPython -c "([^"]*a2a-sdk[^"]*)" 2>\$null/.exec(source)
  assert.ok(match, 'verifier must contain the exact a2a-sdk metadata probe')

  const python = process.env.DSH_PYTHON ?? 'python'
  const available = spawnSync(python, ['--version'], { encoding: 'utf8' })
  if (available.error || available.status !== 0) {
    context.skip(`Python is unavailable: ${available.error?.message ?? available.stderr}`)
    return
  }

  const probe = match[1].replace('a2a-sdk', 'dsh-guaranteed-absent-distribution')
  const escapedPython = python.replaceAll("'", "''")
  const escapedProbe = probe.replaceAll("'", "''")
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `& '${escapedPython}' -c '${escapedProbe}' 2>$null`,
    "if ($LASTEXITCODE -eq 0) { throw 'missing distribution unexpectedly exists' }",
    "Write-Output 'installation-branch-reached'",
  ].join('; ')
  const result = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', command,
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /installation-branch-reached/)
})
