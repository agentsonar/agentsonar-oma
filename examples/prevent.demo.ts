/**
 * AgentSonar × OMA Prevent Mode demo.
 *
 * The TypeScript counterpart to `agentsonar-sdk/examples/prevent_mode_demo.py`
 * and `langgraph_prevent_mode_demo.py`. Runs in <1 second, no LLM calls,
 * no API key required — just verifies the end-to-end Prevent Mode wire
 * format works:
 *
 *   1. Start the sidecar with --prevent-cyclic-delegation.
 *   2. This script repeatedly emits the same 2-edge cycle pattern
 *      (researcher → reviewer → researcher).
 *   3. After a few rotations, the sidecar's engine trips Prevent Mode
 *      and answers the next /ingest with HTTP 409 + RFC 7807 body.
 *   4. The TS client throws PreventError, which the try/catch below
 *      catches and prints.
 *
 * Run in two terminals:
 *
 *   # Terminal 1 — sidecar with Prevent Mode enabled
 *   python sidecar/sidecar.py --prevent-cyclic-delegation \
 *       --warning-threshold 2 --critical-threshold 5 --no-console --no-report
 *
 *   # Terminal 2 — this demo
 *   npm run prevent-demo
 *
 * What you should see:
 *
 *   - A handful of "iteration N: ok" lines from /ingest 204s
 *   - Then a single "PreventError caught" block with cycle_path,
 *     rotations, severity, and reason fields populated from the 409
 *     response the sidecar sent.
 *
 * What this proves:
 *
 *   - The sidecar correctly detects cycles in the cumulative delegation
 *     graph it sees over multiple POSTs (not just within a single call).
 *   - The 409 + application/problem+json + agentsonar body extension
 *     wire format round-trips cleanly into a typed JS exception.
 *   - emitDelegations() carves out PreventError from its
 *     fire-and-forget contract correctly — the user can rely on the
 *     try/catch to terminate their loop.
 *
 * If the sidecar isn't running, the script prints a friendly
 * "sidecar unreachable" warning once and exits without throwing —
 * preserving the host-safety contract.
 */

import {
  emitDelegations,
  shutdown as sonarShutdown,
  PreventError,
  type DelegationTask,
} from '../src/index.js'

// A 2-node cycle: researcher → reviewer → researcher.
// On every emitDelegations() call, this layout produces TWO delegation
// edges:
//   research → review   (researcher → reviewer)
//   review   → fact-check (reviewer → researcher)
// After ~5 calls, the engine has seen 5 full rotations of that cycle
// and Prevent Mode trips on the next ingest.
const cycleTasks: DelegationTask[] = [
  { title: 'research',   description: 'gather facts',    assignee: 'researcher' },
  { title: 'review',     description: 'review result',   assignee: 'reviewer',
    dependsOn: ['research'] },
  { title: 'fact-check', description: 'verify facts',    assignee: 'researcher',
    dependsOn: ['review'] },
]

async function main(): Promise<void> {
  console.log('='.repeat(72))
  console.log('OMA PREVENT MODE DEMO -- 2-node cycle, fake delegations')
  console.log('='.repeat(72))
  console.log()
  console.log('Cycle pattern: researcher -> reviewer -> researcher.')
  console.log('Each iteration adds 1 rotation. Trip expected around rotation 5.')
  console.log()

  let caught: PreventError | null = null
  let lastSuccessfulIteration = 0

  // Cap at a generous 30 iterations so this script terminates even if
  // the sidecar is down (in which case we print the unreachable warning
  // and the loop completes without throwing).
  for (let i = 1; i <= 30; i++) {
    try {
      await emitDelegations(cycleTasks)
      lastSuccessfulIteration = i
      console.log(`  iteration ${i}: ok`)
    } catch (e) {
      if (e instanceof PreventError) {
        caught = e
        break
      }
      // Anything else is unexpected — emitDelegations is fire-and-forget,
      // PreventError is the ONLY exception type that should escape it.
      throw e
    }
  }

  // Always call shutdown so the sidecar writes its final report
  // (if --no-report wasn't passed) and closes cleanly.
  await sonarShutdown()

  console.log()
  console.log('-'.repeat(72))
  console.log('OUTCOME')
  console.log('-'.repeat(72))

  if (caught === null) {
    console.log('  Loop finished without a Prevent Mode trip.')
    console.log()
    console.log('  Possible reasons:')
    console.log('  - Sidecar is not running (check Terminal 1)')
    console.log('  - Sidecar started without --prevent-cyclic-delegation')
    console.log('  - Sidecar thresholds are higher than 30 iterations')
    console.log('  - Network blocking localhost:8787')
    console.log()
    console.log(`  Last successful iteration: ${lastSuccessfulIteration}`)
    process.exit(1)
  }

  console.log('  Loop terminated by:    PreventError')
  console.log(`  failure_class:         ${caught.failureClass}`)
  console.log(`  severity:              ${caught.severity}`)
  console.log(`  rotations at trip:     ${caught.rotations}`)
  console.log(`  cycle path:            ${caught.cyclePath.join(' -> ')}`)
  console.log(`  reason:                ${caught.reason}`)
  console.log()
  console.log('Without Prevent Mode, this loop would have continued posting')
  console.log('delegations to the sidecar until the script hit its 30-iteration')
  console.log('cap. AgentSonar caught it after just a few rotations.')
}

main().catch((err) => {
  // Final safety net. Should never be reached in practice — emitDelegations
  // never throws non-PreventError, and we explicitly re-throw inside main().
  // If it IS reached, surface the error so the user can debug.
  console.error('Unexpected error:', err)
  process.exit(1)
})
