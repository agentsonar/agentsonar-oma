/**
 * sidecar.test.ts: contract tests for the bundled Python sidecar.
 *
 * The npm package ships sidecar/sidecar.py inside the tarball (per the
 * `files` array in package.json). When users run `python sidecar.py`,
 * it constructs an AgentSonar engine and posts telemetry on session
 * start. The attribution string is what tells our analytics backend
 * "this is an OMA sidecar session, not a generic custom-python one."
 *
 * If the sidecar's call to monitor_orchestrator() loses its
 * `adapter="oma_sidecar"` kwarg (regression, refactor mistake, merge
 * accident), every OMA user's telemetry would be misattributed as
 * `custom_python` and we'd lose the ability to count OMA usage.
 *
 * These tests are static checks: they read the bundled sidecar.py file
 * and verify the contract holds without spawning a Python interpreter.
 * Cheap, fast, deterministic. The actual telemetry behavior is covered
 * by the Python-side tests in agentsonar-sdk/tests/test_telemetry.py.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR_PATH = join(__dirname, '..', 'sidecar', 'sidecar.py')

describe('bundled sidecar.py', () => {
  test('exists at the expected location for the npm tarball', () => {
    assert.ok(
      existsSync(SIDECAR_PATH),
      `sidecar.py must exist at ${SIDECAR_PATH}; the npm "files" array ` +
        `references "sidecar/" so this path is what end users get.`,
    )
  })

  test('imports monitor_orchestrator from agentsonar', () => {
    const source = readFileSync(SIDECAR_PATH, 'utf-8')
    // The sidecar relies on the SDK's public API. If this import line
    // changes, the sidecar startup will break for end users.
    assert.match(
      source,
      /from\s+agentsonar\s+import\s+[^\n]*monitor_orchestrator/,
      'sidecar.py must import monitor_orchestrator from agentsonar',
    )
  })

  test('passes adapter="oma_sidecar" to monitor_orchestrator for telemetry attribution', () => {
    const source = readFileSync(SIDECAR_PATH, 'utf-8')
    // Regex matches monitor_orchestrator(...) calls that pass adapter
    // as either a positional or keyword argument with the value
    // "oma_sidecar". This is the load-bearing attribution string;
    // changing it would silently misattribute every OMA user's
    // sessions to the custom_python adapter in our telemetry.
    assert.match(
      source,
      /monitor_orchestrator\([^)]*adapter\s*=\s*["']oma_sidecar["']/,
      'sidecar must construct the engine with adapter="oma_sidecar" so ' +
        'OMA-bundled sessions are attributed correctly. If you removed this ' +
        'kwarg, telemetry will misattribute OMA sessions as custom_python.',
    )
  })

  test('does not pass adapter="custom_python" (the default) explicitly', () => {
    const source = readFileSync(SIDECAR_PATH, 'utf-8')
    // Defensive check: catches the regression where someone "fixes" by
    // passing the SDK default explicitly. The SDK default IS
    // custom_python, but the sidecar must override to "oma_sidecar".
    assert.doesNotMatch(
      source,
      /monitor_orchestrator\([^)]*adapter\s*=\s*["']custom_python["']/,
      'sidecar must NOT pass adapter="custom_python"; that would ' +
        'misattribute OMA sessions as generic custom Python adapter use.',
    )
  })

  test('exposes a sonar variable that the HTTP handlers can call into', () => {
    const source = readFileSync(SIDECAR_PATH, 'utf-8')
    // The handlers call sonar.delegation(...) and sonar.shutdown().
    // If the variable name changes, those calls break at runtime.
    assert.match(
      source,
      /^sonar\s*=\s*monitor_orchestrator\(/m,
      'sidecar must bind the engine to a top-level `sonar` variable ' +
        'that handlers reference.',
    )
  })
})
