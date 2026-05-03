/**
 * record.test.ts: verify recordDelegation's contract.
 *
 * recordDelegation is the event-stream-oriented sibling of
 * emitDelegations. Where emitDelegations walks a task DAG, this one
 * fires a single edge directly. Used from Node buses where the user
 * knows in real time that agent A just talked to agent B.
 *
 * Same safety contract as every other public function: never throws on
 * bad input, never blocks longer than the timeout, never propagates
 * network errors. The ONE exception type that's allowed to escape is
 * PreventError, and only when the sidecar replies with a 409 Problem
 * Details body that carries the agentsonar prevent extension.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  recordDelegation,
  PreventError,
  _resetSidecarUnreachableWarning,
} from '../src/index.js'

type FetchImpl = typeof globalThis.fetch
const originalFetch: FetchImpl = globalThis.fetch

interface Capture {
  url: string
  method: string
  body: unknown
}

function captureFetch(
  status = 204,
  responseBody: unknown = null,
  contentType?: string,
): { calls: Capture[]; restore: () => void } {
  const calls: Capture[] = []
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      method: (init?.method ?? 'GET').toString(),
      body:
        init?.body && typeof init.body === 'string'
          ? JSON.parse(init.body as string)
          : null,
    })
    const headers = new Headers()
    if (contentType) headers.set('content-type', contentType)
    return new Response(
      responseBody === null ? null : JSON.stringify(responseBody),
      { status, headers },
    )
  }) as FetchImpl
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

describe('recordDelegation: happy path', () => {
  let cleanup: (() => void) | undefined
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  test('posts a single edge to /ingest with the right shape', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const ok = await recordDelegation('alice', 'bob')

    assert.equal(ok, true)
    assert.equal(calls.length, 1)
    const call = calls[0]!
    assert.ok(call.url.endsWith('/ingest'))
    assert.equal(call.method, 'POST')

    const body = call.body as {
      source: string
      target: string
      timestamp: number
      metadata: Record<string, unknown>
    }
    assert.equal(body.source, 'alice')
    assert.equal(body.target, 'bob')
    assert.equal(typeof body.timestamp, 'number')
    assert.ok(body.timestamp > 0)
    assert.ok(body.metadata)
    // The default `via` tag distinguishes direct calls from edges
    // derived by emitDelegations (which uses `via: 'task_dependency'`).
    assert.equal(body.metadata.via, 'direct')
  })

  test('forwards user-supplied metadata', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    await recordDelegation('reviewer', 'builder', {
      metadata: { taskId: 'task-42', sessionId: 'sess-01' },
    })

    const body = calls[0]!.body as {
      metadata: Record<string, unknown>
    }
    assert.equal(body.metadata.taskId, 'task-42')
    assert.equal(body.metadata.sessionId, 'sess-01')
    // The default via tag is still applied
    assert.equal(body.metadata.via, 'direct')
  })

  test('user metadata.via overrides the default', async () => {
    // If the user explicitly tags an edge with their own `via` value,
    // honor it. The default is just a fallback for diagnostics.
    const { calls, restore } = captureFetch()
    cleanup = restore

    await recordDelegation('alice', 'bob', {
      metadata: { via: 'electron_bus' },
    })

    const body = calls[0]!.body as { metadata: Record<string, unknown> }
    assert.equal(body.metadata.via, 'electron_bus')
  })

  test('respects the endpoint option', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    await recordDelegation('a', 'b', {
      endpoint: 'http://10.0.0.5:9000',
    })

    assert.ok(calls[0]!.url.startsWith('http://10.0.0.5:9000/'))
  })
})

describe('recordDelegation: input validation', () => {
  let cleanup: (() => void) | undefined
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  test('returns false on empty source', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const ok = await recordDelegation('', 'bob')

    assert.equal(ok, false)
    assert.equal(calls.length, 0, 'no POST should have been issued')
  })

  test('returns false on empty target', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const ok = await recordDelegation('alice', '')

    assert.equal(ok, false)
    assert.equal(calls.length, 0)
  })

  test('returns false on non-string source', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    // We deliberately bypass TypeScript here to test the runtime guard.
    // Real callers can pass anything from JS; the function must not
    // throw on garbage input.
    const ok = await recordDelegation(
      123 as unknown as string,
      'bob',
    )

    assert.equal(ok, false)
    assert.equal(calls.length, 0)
  })

  test('returns false on null target', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const ok = await recordDelegation(
      'alice',
      null as unknown as string,
    )

    assert.equal(ok, false)
    assert.equal(calls.length, 0)
  })

  test('returns false on undefined inputs', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const ok = await recordDelegation(
      undefined as unknown as string,
      undefined as unknown as string,
    )

    assert.equal(ok, false)
    assert.equal(calls.length, 0)
  })
})

describe('recordDelegation: defensive coercion of bad opts shapes', () => {
  let cleanup: (() => void) | undefined
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  test('opts = null: posts with default settings, never throws', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    // JS callers can pass null even though TypeScript types disallow it.
    // The function must coerce silently and continue.
    const ok = await recordDelegation(
      'a',
      'b',
      null as unknown as undefined,
    )

    assert.equal(ok, true, 'should attempt POST even when opts is null')
    assert.equal(calls.length, 1)
    const body = calls[0]!.body as { metadata: Record<string, unknown> }
    // Default metadata still applies
    assert.equal(body.metadata.via, 'direct')
  })

  test('opts = "string": coerced to {}, posts with defaults', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const ok = await recordDelegation(
      'a',
      'b',
      'not-an-object' as unknown as undefined,
    )

    assert.equal(ok, true)
    assert.equal(calls.length, 1)
  })

  test('opts.metadata as array: filtered, defaults to { via: direct }', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    // Arrays are typeof "object" in JS; we explicitly reject them.
    // Spreading an array into an object would produce numeric-string keys.
    await recordDelegation('a', 'b', {
      metadata: ['x', 'y', 'z'] as unknown as Record<string, unknown>,
    })

    const body = calls[0]!.body as { metadata: Record<string, unknown> }
    // Must NOT have keys "0", "1", "2" from a bad array spread.
    assert.equal(body.metadata['0'], undefined)
    assert.equal(body.metadata['1'], undefined)
    // Default `via` applies; nothing else.
    assert.equal(body.metadata.via, 'direct')
    assert.equal(Object.keys(body.metadata).length, 1)
  })

  test('opts.metadata as string: filtered, defaults to { via: direct }', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    await recordDelegation('a', 'b', {
      metadata: 'oops' as unknown as Record<string, unknown>,
    })

    const body = calls[0]!.body as { metadata: Record<string, unknown> }
    assert.equal(body.metadata.via, 'direct')
    assert.equal(Object.keys(body.metadata).length, 1)
  })

  test('opts.metadata as Map: filtered, defaults to { via: direct }', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const map = new Map([
      ['key1', 'value1'],
      ['key2', 'value2'],
    ])

    await recordDelegation('a', 'b', {
      metadata: map as unknown as Record<string, unknown>,
    })

    const body = calls[0]!.body as { metadata: Record<string, unknown> }
    // Map shouldn't smuggle its entries into the metadata
    assert.equal(body.metadata.via, 'direct')
    assert.equal(Object.keys(body.metadata).length, 1)
  })
})

describe('recordDelegation: host-safety contract', () => {
  let cleanup: (() => void) | undefined
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    _resetSidecarUnreachableWarning()
  })

  test('never throws when the sidecar is unreachable', async () => {
    // Simulate connection refused by injecting a fetch that throws an
    // error with the same shape undici uses for ECONNREFUSED.
    globalThis.fetch = (async () => {
      const err = new Error('fetch failed') as Error & { cause?: unknown }
      err.cause = { code: 'ECONNREFUSED' }
      throw err
    }) as FetchImpl
    cleanup = () => {
      globalThis.fetch = originalFetch
    }

    // Suppress the one-time warning so test output stays quiet.
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      // Must complete without throwing.
      const ok = await recordDelegation('a', 'b')
      // We attempted the POST with valid inputs. The network failure
      // is silent, so we still return `true`; "attempted" is the
      // contract, not "delivered".
      assert.equal(ok, true)
    } finally {
      console.warn = originalWarn
    }
  })

  test('never throws when fetch hangs past timeout', async () => {
    globalThis.fetch = (async (_url, init) => {
      // Honor the AbortSignal so AbortSignal.timeout fires correctly.
      return await new Promise((_, reject) => {
        const sig = init?.signal as AbortSignal | undefined
        sig?.addEventListener('abort', () => {
          const err = new Error('aborted') as Error & { name: string }
          err.name = 'AbortError'
          reject(err)
        })
      })
    }) as FetchImpl
    cleanup = () => {
      globalThis.fetch = originalFetch
    }

    // Tight 50ms timeout so the test runs fast.
    const ok = await recordDelegation('a', 'b', { timeoutMs: 50 })
    assert.equal(ok, true) // attempted; network failure is silent
  })

  test('never throws when sidecar returns 500', async () => {
    const { restore } = captureFetch(500)
    cleanup = restore

    const ok = await recordDelegation('a', 'b')
    assert.equal(ok, true) // attempted; sidecar error is silent
  })

  test('never throws on weird input that gets validated out', async () => {
    // If validation triggers, we must return false WITHOUT throwing
    // even when fetch would have thrown if reached.
    globalThis.fetch = (() => {
      throw new Error('fetch should never be called')
    }) as FetchImpl
    cleanup = () => {
      globalThis.fetch = originalFetch
    }

    // Empty string -> false, no fetch
    assert.equal(await recordDelegation('', 'bob'), false)
    assert.equal(await recordDelegation('alice', ''), false)
  })
})

describe('recordDelegation: PreventError propagation', () => {
  let cleanup: (() => void) | undefined
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    _resetSidecarUnreachableWarning()
  })

  test('throws PreventError when sidecar returns 409 + RFC 7807 body with agentsonar key', async () => {
    const preventBody = {
      type: 'https://github.com/agentsonar/...',
      title: 'Coordination Failure Prevented',
      status: 409,
      detail: 'cyclic_delegation prevented after 15 rotations',
      instance: '/ingest',
      agentsonar: {
        failure_class: 'cyclic_delegation',
        severity: 'CRITICAL',
        rotations: 15,
        cycle_path: ['reviewer', 'builder', 'reviewer'],
        reason: 'cyclic_delegation prevented after 15 rotations',
        timestamp: 1714000000.0,
      },
    }
    const { restore } = captureFetch(
      409,
      preventBody,
      'application/problem+json',
    )
    cleanup = restore

    await assert.rejects(
      () => recordDelegation('builder', 'reviewer'),
      (err: unknown) => {
        assert.ok(err instanceof PreventError)
        const e = err as PreventError
        assert.equal(e.failureClass, 'cyclic_delegation')
        assert.equal(e.severity, 'CRITICAL')
        assert.equal(e.rotations, 15)
        assert.deepEqual(e.cyclePath, ['reviewer', 'builder', 'reviewer'])
        return true
      },
    )
  })

  test('does NOT throw on plain 409 without the agentsonar extension', async () => {
    // A misconfigured proxy or a CORS preflight could return 409 for
    // unrelated reasons. We only throw PreventError when ALL three
    // guards (status, content-type, body shape) line up.
    const { restore } = captureFetch(
      409,
      { error: 'rate limited' },
      'application/json',
    )
    cleanup = restore

    // Should NOT throw. A plain 409 is treated like any other failed
    // POST: silent, returns true (attempt was made with valid inputs).
    const ok = await recordDelegation('a', 'b')
    assert.equal(ok, true)
  })

  test('does NOT throw on 409 with problem+json but missing agentsonar key', async () => {
    const { restore } = captureFetch(
      409,
      {
        type: 'https://example.com/some-other-problem',
        title: 'Unrelated 409',
        status: 409,
      },
      'application/problem+json',
    )
    cleanup = restore

    const ok = await recordDelegation('a', 'b')
    assert.equal(ok, true) // no throw, attempted
  })
})
