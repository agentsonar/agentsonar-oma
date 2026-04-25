/**
 * edges.test.ts — verify emitDelegations extracts the right edges.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { emitDelegations, type DelegationTask } from '../src/index.js'

type FetchImpl = typeof globalThis.fetch
const originalFetch: FetchImpl = globalThis.fetch

interface Capture {
  url: string
  method: string
  body: unknown
}

function captureFetch(): { calls: Capture[]; restore: () => void } {
  const calls: Capture[] = []
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      method: (init?.method ?? 'GET').toString(),
      body:
        init?.body && typeof init.body === 'string'
          ? JSON.parse(init.body)
          : null,
    })
    return new Response(null, { status: 204 })
  }) as FetchImpl
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

describe('emitDelegations: edge extraction', () => {
  let cleanup: (() => void) | undefined
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  test('emits one edge per dependsOn entry', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const tasks: DelegationTask[] = [
      { title: 'A', description: 'a', assignee: 'alice' },
      { title: 'B', description: 'b', assignee: 'bob', dependsOn: ['A'] },
      { title: 'C', description: 'c', assignee: 'carol', dependsOn: ['B'] },
    ]

    const count = await emitDelegations(tasks)

    assert.equal(count, 2)
    assert.equal(calls.length, 2)
    assert.ok(calls[0]!.url.endsWith('/ingest'))
    assert.equal(calls[0]!.method, 'POST')
    assert.equal((calls[0]!.body as { source: string }).source, 'alice')
    assert.equal((calls[0]!.body as { target: string }).target, 'bob')
    assert.equal((calls[1]!.body as { source: string }).source, 'bob')
    assert.equal((calls[1]!.body as { target: string }).target, 'carol')
  })

  test('fan-in: multiple dependsOn on one task emits multiple edges', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const tasks: DelegationTask[] = [
      { title: 'A', description: 'a', assignee: 'alice' },
      { title: 'B', description: 'b', assignee: 'bob' },
      {
        title: 'C',
        description: 'c',
        assignee: 'carol',
        dependsOn: ['A', 'B'],
      },
    ]
    const count = await emitDelegations(tasks)
    assert.equal(count, 2)
    const edges = calls.map((c) => {
      const b = c.body as { source: string; target: string }
      return `${b.source}->${b.target}`
    })
    assert.deepEqual(edges.sort(), ['alice->carol', 'bob->carol'])
  })

  test('fan-out: multiple tasks depending on one source emits multiple edges', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const tasks: DelegationTask[] = [
      { title: 'A', description: 'a', assignee: 'alice' },
      { title: 'B', description: 'b', assignee: 'bob', dependsOn: ['A'] },
      { title: 'C', description: 'c', assignee: 'carol', dependsOn: ['A'] },
    ]
    const count = await emitDelegations(tasks)
    assert.equal(count, 2)
    const targets = calls.map(
      (c) => (c.body as { target: string }).target,
    )
    assert.deepEqual(targets.sort(), ['bob', 'carol'])
  })

  test('cycle: 4 tasks forming agent cycle emits 3 edges', async () => {
    // This is the demo.ts pattern: researcher → reviewer → writer → researcher
    const { calls, restore } = captureFetch()
    cleanup = restore

    const tasks: DelegationTask[] = [
      {
        title: 'Research',
        description: 'r',
        assignee: 'researcher',
      },
      {
        title: 'Review',
        description: 'r',
        assignee: 'reviewer',
        dependsOn: ['Research'],
      },
      {
        title: 'Write',
        description: 'w',
        assignee: 'writer',
        dependsOn: ['Review'],
      },
      {
        title: 'Fact-check',
        description: 'f',
        assignee: 'researcher',
        dependsOn: ['Write'],
      },
    ]
    const count = await emitDelegations(tasks)
    assert.equal(count, 3)
    const edges = calls.map((c) => {
      const b = c.body as { source: string; target: string }
      return `${b.source}->${b.target}`
    })
    // Order matches task iteration order
    assert.deepEqual(edges, [
      'researcher->reviewer',
      'reviewer->writer',
      'writer->researcher',
    ])
  })

  test('skips edges when upstream task has no assignee', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const tasks: DelegationTask[] = [
      { title: 'A', description: 'a' }, // no assignee
      { title: 'B', description: 'b', assignee: 'bob', dependsOn: ['A'] },
    ]
    const count = await emitDelegations(tasks)
    assert.equal(count, 0)
    assert.equal(calls.length, 0)
  })

  test('skips edges when downstream task has no assignee', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const tasks: DelegationTask[] = [
      { title: 'A', description: 'a', assignee: 'alice' },
      { title: 'B', description: 'b', dependsOn: ['A'] }, // no assignee
    ]
    const count = await emitDelegations(tasks)
    assert.equal(count, 0)
    assert.equal(calls.length, 0)
  })

  test('silently drops unknown dependsOn references', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const tasks: DelegationTask[] = [
      { title: 'A', description: 'a', assignee: 'alice' },
      {
        title: 'B',
        description: 'b',
        assignee: 'bob',
        dependsOn: ['Nonexistent'],
      },
    ]
    const count = await emitDelegations(tasks)
    assert.equal(count, 0)
    assert.equal(calls.length, 0)
  })

  test('resolves dependsOn by id when title lookup fails', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const tasks: DelegationTask[] = [
      {
        id: 'task-alpha',
        title: 'A',
        description: 'a',
        assignee: 'alice',
      },
      {
        title: 'B',
        description: 'b',
        assignee: 'bob',
        dependsOn: ['task-alpha'], // references id, not title
      },
    ]
    const count = await emitDelegations(tasks)
    assert.equal(count, 1)
    assert.equal((calls[0]!.body as { source: string }).source, 'alice')
  })

  test('includes metadata identifying the source and target tasks', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const tasks: DelegationTask[] = [
      { title: 'Research', description: 'r', assignee: 'alice' },
      {
        title: 'Write',
        description: 'w',
        assignee: 'bob',
        dependsOn: ['Research'],
      },
    ]
    await emitDelegations(tasks)
    const body = calls[0]!.body as {
      metadata: { via: string; fromTask: string; toTask: string }
    }
    assert.equal(body.metadata.via, 'task_dependency')
    assert.equal(body.metadata.fromTask, 'Research')
    assert.equal(body.metadata.toTask, 'Write')
  })

  test('normalizes trailing slash on endpoint (no double-slash in URL)', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const tasks: DelegationTask[] = [
      { title: 'A', description: 'a', assignee: 'alice' },
      { title: 'B', description: 'b', assignee: 'bob', dependsOn: ['A'] },
    ]
    // Trailing slash on endpoint — must not produce //ingest
    await emitDelegations(tasks, { endpoint: 'http://localhost:8787/' })
    assert.equal(calls.length, 1)
    assert.ok(
      !calls[0]!.url.includes('//ingest'),
      `URL should not have double slash before path; got ${calls[0]!.url}`,
    )
    assert.ok(calls[0]!.url.endsWith('/ingest'))
  })

  test('normalizes multiple trailing slashes', async () => {
    const { calls, restore } = captureFetch()
    cleanup = restore

    const tasks: DelegationTask[] = [
      { title: 'A', description: 'a', assignee: 'alice' },
      { title: 'B', description: 'b', assignee: 'bob', dependsOn: ['A'] },
    ]
    await emitDelegations(tasks, { endpoint: 'http://localhost:8787///' })
    assert.equal(calls.length, 1)
    assert.ok(!calls[0]!.url.includes('//ingest'))
  })

  test('honors AGENTSONAR_ENDPOINT env var', async () => {
    const { calls, restore } = captureFetch()
    cleanup = () => {
      restore()
      delete process.env.AGENTSONAR_ENDPOINT
    }
    process.env.AGENTSONAR_ENDPOINT = 'http://custom-host:9000'

    const tasks: DelegationTask[] = [
      { title: 'A', description: 'a', assignee: 'alice' },
      { title: 'B', description: 'b', assignee: 'bob', dependsOn: ['A'] },
    ]
    await emitDelegations(tasks)
    assert.ok(calls[0]!.url.startsWith('http://custom-host:9000/'))
  })
})

describe('emitDelegations: warning semantics', () => {
  let cleanup: (() => void) | undefined

  function captureConsoleWarn(): {
    warnings: string[]
    restore: () => void
  } {
    const warnings: string[] = []
    const originalWarn = console.warn
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
    cleanup?.()
    cleanup = undefined
  })

  test('does NOT warn on independent tasks (no dependsOn anywhere)', async () => {
    const { restore: restoreFetchMock } = captureFetch()
    const { warnings, restore: restoreWarn } = captureConsoleWarn()
    cleanup = () => {
      restoreFetchMock()
      restoreWarn()
    }

    const tasks: DelegationTask[] = [
      { title: 'A', description: 'a', assignee: 'alice' },
      { title: 'B', description: 'b', assignee: 'bob' },
      // no dependsOn anywhere — legit shape, should not warn
    ]
    const count = await emitDelegations(tasks)
    assert.equal(count, 0)
    assert.equal(
      warnings.length,
      0,
      `should not warn on legal input; got: ${warnings.join('\n')}`,
    )
  })

  test('DOES warn when dependsOn references all fail to resolve', async () => {
    const { restore: restoreFetchMock } = captureFetch()
    const { warnings, restore: restoreWarn } = captureConsoleWarn()
    cleanup = () => {
      restoreFetchMock()
      restoreWarn()
    }

    const tasks: DelegationTask[] = [
      { title: 'A', description: 'a', assignee: 'alice' },
      {
        title: 'B',
        description: 'b',
        assignee: 'bob',
        dependsOn: ['NonExistent'], // will not resolve
      },
    ]
    const count = await emitDelegations(tasks)
    assert.equal(count, 0)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /dependsOn reference.*resolved/i)
  })

  test('does NOT warn when dependsOn partially resolves (mixed case)', async () => {
    const { restore: restoreFetchMock } = captureFetch()
    const { warnings, restore: restoreWarn } = captureConsoleWarn()
    cleanup = () => {
      restoreFetchMock()
      restoreWarn()
    }

    const tasks: DelegationTask[] = [
      { title: 'A', description: 'a', assignee: 'alice' },
      {
        title: 'B',
        description: 'b',
        assignee: 'bob',
        dependsOn: ['A', 'NonExistent'], // one valid, one invalid
      },
    ]
    const count = await emitDelegations(tasks)
    assert.equal(count, 1)
    // At least one resolved, so no warning
    assert.equal(warnings.length, 0)
  })
})
