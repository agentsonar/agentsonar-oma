/**
 * prevent.test.ts — Prevent Mode contract for the TS client.
 *
 * Verifies the narrow exception path: when the sidecar reports a
 * trip via 409 + application/problem+json + an `agentsonar` body
 * extension, emitDelegations() throws PreventError. Every other
 * failure mode (plain 409, wrong content-type, missing body
 * extension, network errors, garbage responses) must STILL be
 * silently swallowed — only PreventError ever escapes.
 *
 * If any test here fails, our host-safety contract or our
 * Prevent Mode UX is broken.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  emitDelegations,
  PreventError,
  type DelegationTask,
} from '../src/index.js'

type FetchImpl = typeof globalThis.fetch
const originalFetch: FetchImpl = globalThis.fetch

function mockFetch(impl: FetchImpl): void {
  globalThis.fetch = impl
}
function restoreFetch(): void {
  globalThis.fetch = originalFetch
}

/** Build a Response with the given status, headers, and JSON body. */
function jsonResponse(
  status: number,
  body: unknown,
  contentType = 'application/json',
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  })
}

/** A canonical RFC 7807 + agentsonar prevent body for tests. */
const VALID_PREVENT_BODY = {
  type: 'https://github.com/agentsonar/agentsonar/blob/main/docs/problems/coordination-prevented.md',
  title: 'Coordination Failure Prevented',
  status: 409,
  detail: 'cyclic_delegation prevented after 15 rotations: a -> b -> c',
  instance: '/ingest',
  agentsonar: {
    failure_class: 'cyclic_delegation',
    severity: 'CRITICAL',
    rotations: 15,
    cycle_path: ['a', 'b', 'c'],
    reason: 'cyclic_delegation prevented after 15 rotations: a -> b -> c',
    timestamp: 1714089600.123,
  },
}

/** A 3-task chain whose dependsOn structure forces a delegation edge. */
const TWO_TASKS: DelegationTask[] = [
  { title: 'planner', description: '...', assignee: 'alice' },
  { title: 'writer', description: '...', assignee: 'bob', dependsOn: ['planner'] },
]


describe('PreventError class', () => {
  test('extends Error and exposes mirrored fields', () => {
    const e = new PreventError({
      failureClass: 'cyclic_delegation',
      severity: 'CRITICAL',
      rotations: 15,
      cyclePath: ['a', 'b', 'c'],
      reason: 'test reason',
      timestamp: 1234.5,
    })
    assert.ok(e instanceof Error)
    assert.ok(e instanceof PreventError)
    assert.equal(e.name, 'PreventError')
    assert.equal(e.message, 'test reason')
    assert.equal(e.failureClass, 'cyclic_delegation')
    assert.equal(e.severity, 'CRITICAL')
    assert.equal(e.rotations, 15)
    assert.deepEqual(e.cyclePath, ['a', 'b', 'c'])
    assert.equal(e.reason, 'test reason')
    assert.equal(e.timestamp, 1234.5)
  })
})


describe('emitDelegations: trip detection', () => {
  afterEach(restoreFetch)

  test('throws PreventError on 409 + problem+json + agentsonar body', async () => {
    mockFetch((async () =>
      jsonResponse(409, VALID_PREVENT_BODY, 'application/problem+json')
    ) as FetchImpl)

    let caught: PreventError | null = null
    try {
      await emitDelegations(TWO_TASKS)
    } catch (e) {
      if (e instanceof PreventError) caught = e
      else throw e
    }
    assert.ok(caught, 'expected PreventError')
    assert.equal(caught!.failureClass, 'cyclic_delegation')
    assert.equal(caught!.severity, 'CRITICAL')
    assert.equal(caught!.rotations, 15)
    assert.deepEqual([...caught!.cyclePath], ['a', 'b', 'c'])
    assert.equal(caught!.reason, VALID_PREVENT_BODY.agentsonar.reason)
    assert.equal(caught!.timestamp, 1714089600.123)
  })

  test('PreventError message defaults to reason', async () => {
    mockFetch((async () =>
      jsonResponse(409, VALID_PREVENT_BODY, 'application/problem+json')
    ) as FetchImpl)
    try {
      await emitDelegations(TWO_TASKS)
      assert.fail('expected throw')
    } catch (e) {
      assert.ok(e instanceof PreventError)
      assert.equal((e as Error).message, VALID_PREVENT_BODY.agentsonar.reason)
    }
  })

  test('aborts remaining deps after first 409 (no extra fetches)', async () => {
    let calls = 0
    mockFetch((async () => {
      calls++
      return jsonResponse(409, VALID_PREVENT_BODY, 'application/problem+json')
    }) as FetchImpl)

    // 3 deps -> 3 potential POSTs. After the first throws, the loop
    // aborts and we expect exactly 1 fetch call.
    const tasks: DelegationTask[] = [
      { title: 'a', description: '.', assignee: 'A' },
      { title: 'b', description: '.', assignee: 'B', dependsOn: ['a'] },
      { title: 'c', description: '.', assignee: 'C', dependsOn: ['b'] },
      { title: 'd', description: '.', assignee: 'D', dependsOn: ['c'] },
    ]
    try {
      await emitDelegations(tasks)
    } catch (e) {
      assert.ok(e instanceof PreventError)
    }
    assert.equal(calls, 1, 'expected loop to abort after first 409')
  })
})


describe('emitDelegations: safety carve-out (no false-positive throws)', () => {
  afterEach(restoreFetch)

  test('plain 409 with application/json (NOT problem+json) does NOT throw', async () => {
    // Misconfigured proxy or unrelated server returns 409. Without the
    // problem+json content-type, we MUST NOT throw.
    mockFetch((async () =>
      jsonResponse(409, { error: 'something else' }, 'application/json')
    ) as FetchImpl)
    // Must complete normally
    const n = await emitDelegations(TWO_TASKS)
    assert.equal(typeof n, 'number')
  })

  test('409 with problem+json but NO agentsonar key does NOT throw', async () => {
    // A different problem details response (e.g. from another middleware)
    // must NOT trigger PreventError.
    mockFetch((async () =>
      jsonResponse(
        409,
        { type: 'https://example.com/problem', title: 'Other', status: 409 },
        'application/problem+json',
      )
    ) as FetchImpl)
    const n = await emitDelegations(TWO_TASKS)
    assert.equal(typeof n, 'number')
  })

  test('409 with malformed body does NOT throw', async () => {
    // Server claims problem+json but body is invalid JSON
    mockFetch((async () =>
      new Response('not-valid-json{{{', {
        status: 409,
        headers: { 'content-type': 'application/problem+json' },
      })
    ) as FetchImpl)
    const n = await emitDelegations(TWO_TASKS)
    assert.equal(typeof n, 'number')
  })

  test('200 OK never throws even with agentsonar-shaped body', async () => {
    // Defense in depth: even if a malicious/buggy server returns the
    // body shape with status 200, we must NOT throw (status guard).
    mockFetch((async () =>
      jsonResponse(200, VALID_PREVENT_BODY, 'application/problem+json')
    ) as FetchImpl)
    const n = await emitDelegations(TWO_TASKS)
    assert.equal(typeof n, 'number')
  })

  test('500 with agentsonar-shaped body does NOT throw', async () => {
    // Server error - status guard prevents misinterpretation
    mockFetch((async () =>
      jsonResponse(500, VALID_PREVENT_BODY, 'application/problem+json')
    ) as FetchImpl)
    const n = await emitDelegations(TWO_TASKS)
    assert.equal(typeof n, 'number')
  })

  test('network error never throws PreventError', async () => {
    mockFetch((async () => {
      throw new TypeError('network failure')
    }) as FetchImpl)
    const n = await emitDelegations(TWO_TASKS)
    assert.equal(typeof n, 'number')
  })

  test('garbage agent_sonar field types do NOT crash parsing', async () => {
    // Sidecar sends a partially-broken body (e.g. integers as strings,
    // null cycle_path). We should still build a PreventError with
    // sensible defaults rather than crash.
    const partial = {
      type: 'urn:agentsonar:problem',
      title: 'Prevented',
      status: 409,
      detail: 'partial body test',
      agentsonar: {
        failure_class: 'cyclic_delegation',
        severity: null,                     // wrong type
        rotations: 'fifteen' as unknown,    // wrong type
        cycle_path: 'not-an-array',         // wrong type
        // reason missing
        // timestamp missing
      },
    }
    mockFetch((async () =>
      jsonResponse(409, partial, 'application/problem+json')
    ) as FetchImpl)
    let caught: PreventError | null = null
    try {
      await emitDelegations(TWO_TASKS)
    } catch (e) {
      if (e instanceof PreventError) caught = e
      else throw e
    }
    assert.ok(caught, 'expected PreventError despite garbage fields')
    assert.equal(caught!.failureClass, 'cyclic_delegation')
    assert.equal(typeof caught!.severity, 'string')
    assert.equal(typeof caught!.rotations, 'number')
    assert.ok(Array.isArray(caught!.cyclePath))
    assert.equal(typeof caught!.reason, 'string')
    assert.equal(typeof caught!.timestamp, 'number')
  })
})


describe('emitDelegations: normal flow when prevent NOT configured', () => {
  afterEach(restoreFetch)

  test('204 No Content (default sidecar response) never throws', async () => {
    let calls = 0
    mockFetch((async () => {
      calls++
      return new Response(null, { status: 204 })
    }) as FetchImpl)
    const n = await emitDelegations(TWO_TASKS)
    assert.equal(n, 1)
    assert.equal(calls, 1)
  })
})
