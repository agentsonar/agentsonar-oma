/**
 * safety.test.ts — the observability-must-never-break contract.
 *
 * Every test here verifies that when something goes wrong (sidecar down,
 * network hangs, handler throws, input is garbage), our public API NEVER
 * throws and the user's code can continue executing.
 *
 * If any test in this file fails, the integration is not safe to ship
 * and we risk breaking our users' OMA runs.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  emitDelegations,
  createTraceHandler,
  shutdown,
  _resetSidecarUnreachableWarning,
  type DelegationTask,
  type TraceEvent,
} from '../src/index.js'

type FetchImpl = typeof globalThis.fetch
const originalFetch: FetchImpl = globalThis.fetch

function mockFetch(impl: FetchImpl): void {
  globalThis.fetch = impl
}
function restoreFetch(): void {
  globalThis.fetch = originalFetch
}

/**
 * A mock that accepts the connection but NEVER responds — unless the
 * caller passes an AbortSignal, in which case we reject when aborted.
 * This mimics real fetch(sidecar) behavior when the sidecar is hung:
 * the signal from AbortSignal.timeout eventually fires and aborts.
 */
function hangingFetch(): FetchImpl {
  return ((_input: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        signal.addEventListener(
          'abort',
          () => {
            reject(new DOMException('aborted', 'AbortError'))
          },
          { once: true },
        )
      }
      // If no signal, the promise hangs forever — that would be a bug
      // in our code (we always pass a signal). The tests verify we do.
    })
  }) as FetchImpl
}

const sampleAgentEvent: TraceEvent = {
  type: 'agent',
  runId: 'test-run',
  agent: 'researcher',
  turns: 1,
  toolCalls: 0,
  tokens: { input_tokens: 10, output_tokens: 5 },
  startMs: 0,
  endMs: 100,
  durationMs: 100,
} as TraceEvent

const sampleTasks: DelegationTask[] = [
  { title: 'Research', description: 'r', assignee: 'researcher' },
  { title: 'Write', description: 'w', assignee: 'writer', dependsOn: ['Research'] },
]

describe('safety: emitDelegations never throws', () => {
  afterEach(() => {
    restoreFetch()
  })

  test('completes when sidecar is unreachable (connection refused)', async () => {
    // port 1 is reserved; nothing listens there. Real fetch returns ECONNREFUSED.
    const count = await emitDelegations(sampleTasks, {
      endpoint: 'http://127.0.0.1:1',
      timeoutMs: 500,
    })
    assert.equal(count, 1, 'edge count is unchanged even when POST fails')
  })

  test('completes when fetch throws synchronously', async () => {
    mockFetch((() => {
      throw new Error('synthetic sync error')
    }) as FetchImpl)
    const count = await emitDelegations(sampleTasks)
    assert.equal(count, 1)
  })

  test('completes when fetch rejects asynchronously', async () => {
    mockFetch((async () => {
      throw new Error('synthetic async error')
    }) as FetchImpl)
    const count = await emitDelegations(sampleTasks)
    assert.equal(count, 1)
  })

  test('completes when sidecar returns 500', async () => {
    mockFetch((async () => new Response(null, { status: 500 })) as FetchImpl)
    const count = await emitDelegations(sampleTasks)
    assert.equal(count, 1)
  })

  test('completes when sidecar returns malformed response', async () => {
    mockFetch(
      (async () =>
        new Response('{"not":"what we expect"}', { status: 200 })) as FetchImpl,
    )
    const count = await emitDelegations(sampleTasks)
    assert.equal(count, 1)
  })

  test('times out when sidecar hangs (does NOT block indefinitely)', async () => {
    // This is THE safety test. If AbortSignal.timeout isn't wired correctly,
    // this test hangs forever and reveals a production-breaking bug.
    mockFetch(hangingFetch())

    const start = Date.now()
    const count = await emitDelegations(sampleTasks, { timeoutMs: 500 })
    const elapsed = Date.now() - start

    // One edge to emit, so one fetch attempt, timing out at ~500ms.
    assert.equal(count, 1, 'should still count the attempt even if POST times out')
    assert.ok(
      elapsed < 3000,
      `elapsed ${elapsed}ms — fetch must NOT hang indefinitely; timeout must bound it`,
    )
  })

  test('returns 0 and never throws on null input', async () => {
    // @ts-expect-error — deliberately passing invalid input
    const count = await emitDelegations(null)
    assert.equal(count, 0)
  })

  test('returns 0 and never throws on undefined input', async () => {
    // @ts-expect-error — deliberately passing invalid input
    const count = await emitDelegations(undefined)
    assert.equal(count, 0)
  })

  test('returns 0 and never throws on non-array input', async () => {
    // @ts-expect-error — deliberately passing invalid input
    const count = await emitDelegations({ notAnArray: true })
    assert.equal(count, 0)
  })

  test('returns 0 and never throws on empty array', async () => {
    const count = await emitDelegations([])
    assert.equal(count, 0)
  })

  test('skips malformed task entries without throwing', async () => {
    mockFetch((async () => new Response(null, { status: 204 })) as FetchImpl)
    const tasks = [
      null as unknown as DelegationTask,
      undefined as unknown as DelegationTask,
      'not an object' as unknown as DelegationTask,
      { title: 'Research', description: 'r', assignee: 'researcher' },
      {
        title: 'Write',
        description: 'w',
        assignee: 'writer',
        dependsOn: ['Research'],
      },
    ]
    const count = await emitDelegations(tasks)
    assert.equal(count, 1)
  })

  test('handles malformed dependsOn without throwing', async () => {
    mockFetch((async () => new Response(null, { status: 204 })) as FetchImpl)
    const tasks: DelegationTask[] = [
      { title: 'Research', description: 'r', assignee: 'researcher' },
      {
        title: 'Write',
        description: 'w',
        assignee: 'writer',
        // @ts-expect-error — dependsOn should be string[], testing with garbage
        dependsOn: [null, undefined, 42, 'Research'],
      },
    ]
    const count = await emitDelegations(tasks)
    // Only the valid 'Research' string resolves → 1 edge emitted
    assert.equal(count, 1)
  })

  test('handles tasks with circular references without throwing', async () => {
    mockFetch((async () => new Response(null, { status: 204 })) as FetchImpl)
    const a: DelegationTask = {
      title: 'A',
      description: 'a',
      assignee: 'researcher',
    }
    const b: DelegationTask = {
      title: 'B',
      description: 'b',
      assignee: 'writer',
      dependsOn: ['A'],
    }
    ;(a as unknown as { self: unknown }).self = a
    const count = await emitDelegations([a, b])
    // JSON.stringify throws on circular, caught inside post(), still counts
    assert.equal(count, 1)
  })
})

describe('safety: createTraceHandler never throws', () => {
  afterEach(() => {
    restoreFetch()
  })

  test('handler completes when sidecar is unreachable', async () => {
    const handler = createTraceHandler({
      endpoint: 'http://127.0.0.1:1',
      timeoutMs: 500,
    })
    await handler(sampleAgentEvent) // must not throw
  })

  test('handler completes when fetch throws', async () => {
    mockFetch((() => {
      throw new Error('synthetic')
    }) as FetchImpl)
    const handler = createTraceHandler()
    await handler(sampleAgentEvent)
  })

  test('handler completes when fetch rejects', async () => {
    mockFetch((async () => {
      throw new Error('synthetic')
    }) as FetchImpl)
    const handler = createTraceHandler()
    await handler(sampleAgentEvent)
  })

  test('handler swallows throws from user-provided existing handler', async () => {
    let postCalled = false
    mockFetch((async () => {
      postCalled = true
      return new Response(null, { status: 204 })
    }) as FetchImpl)
    const throwing = () => {
      throw new Error('user handler exploded')
    }
    const handler = createTraceHandler({}, throwing)
    await handler(sampleAgentEvent) // must not throw
    // And we still POST to sidecar despite existing handler's throw
    assert.equal(postCalled, true)
  })

  test('handler swallows async rejections from existing handler', async () => {
    mockFetch((async () => new Response(null, { status: 204 })) as FetchImpl)
    const rejecting = async () => {
      throw new Error('user async rejection')
    }
    const handler = createTraceHandler({}, rejecting)
    await handler(sampleAgentEvent)
  })

  test('handler tolerates malformed event objects', async () => {
    mockFetch((async () => new Response(null, { status: 204 })) as FetchImpl)
    const handler = createTraceHandler()
    // @ts-expect-error — deliberately malformed
    await handler(null)
    // @ts-expect-error — deliberately malformed
    await handler(undefined)
    // @ts-expect-error — deliberately malformed
    await handler({ not: 'a trace event' })
    // @ts-expect-error — deliberately malformed
    await handler('string')
  })

  test('handler times out when sidecar hangs', async () => {
    mockFetch(hangingFetch())
    const handler = createTraceHandler({ timeoutMs: 500 })
    const start = Date.now()
    await handler(sampleAgentEvent)
    const elapsed = Date.now() - start
    assert.ok(
      elapsed < 3000,
      `trace handler timed out in ${elapsed}ms — should be bounded`,
    )
  })
})

describe('safety: sidecar-unreachable warning fires only once', () => {
  let originalWarn: typeof console.warn

  function captureWarn(): {
    warnings: string[]
    restore: () => void
  } {
    const warnings: string[] = []
    originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(
        args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
      )
    }
    return {
      warnings,
      restore: () => {
        console.warn = originalWarn
      },
    }
  }

  afterEach(() => {
    restoreFetch()
    _resetSidecarUnreachableWarning()
  })

  test('prints one warning on first ECONNREFUSED, silent after', async () => {
    const { warnings, restore: restoreWarn } = captureWarn()
    try {
      // Simulate ECONNREFUSED by mocking fetch to throw the exact shape
      mockFetch((() => {
        const err = new TypeError('fetch failed') as Error & { cause: unknown }
        err.cause = Object.assign(new Error('ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        })
        throw err
      }) as FetchImpl)

      // Multiple calls across multiple public functions
      await emitDelegations(sampleTasks)
      await emitDelegations(sampleTasks)
      await shutdown()

      // Only one warning, regardless of how many calls failed
      assert.equal(warnings.length, 1)
      assert.match(warnings[0]!, /Cannot reach sidecar/)
      assert.match(warnings[0]!, /python sidecar/)
    } finally {
      restoreWarn()
    }
  })

  test('still silent in non-refused failures (other errors)', async () => {
    const { warnings, restore: restoreWarn } = captureWarn()
    try {
      // Generic fetch failure, NOT ECONNREFUSED
      mockFetch((async () => {
        throw new Error('some other error')
      }) as FetchImpl)

      await emitDelegations(sampleTasks)
      await shutdown()

      // No "sidecar unreachable" warning — this error shape isn't one
      assert.equal(
        warnings.filter((w) => w.includes('Cannot reach sidecar')).length,
        0,
      )
    } finally {
      restoreWarn()
    }
  })
})

describe('safety: shutdown never throws', () => {
  afterEach(() => {
    restoreFetch()
  })

  test('completes when sidecar is unreachable', async () => {
    await shutdown({ endpoint: 'http://127.0.0.1:1', timeoutMs: 500 })
  })

  test('completes when fetch throws', async () => {
    mockFetch((() => {
      throw new Error('synthetic')
    }) as FetchImpl)
    await shutdown()
  })

  test('completes when sidecar returns 500', async () => {
    mockFetch((async () => new Response(null, { status: 500 })) as FetchImpl)
    await shutdown()
  })

  test('times out when sidecar hangs', async () => {
    mockFetch(hangingFetch())
    const start = Date.now()
    await shutdown({ timeoutMs: 500 })
    const elapsed = Date.now() - start
    assert.ok(
      elapsed < 3000,
      `shutdown timed out in ${elapsed}ms — should be bounded`,
    )
  })
})
