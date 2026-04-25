/**
 * trace.test.ts — verify createTraceHandler filtering and composition.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTraceHandler,
  type TraceEvent,
} from '../src/index.js'

type FetchImpl = typeof globalThis.fetch
const originalFetch: FetchImpl = globalThis.fetch

function captureFetch(): { urls: string[]; restore: () => void } {
  const urls: string[] = []
  globalThis.fetch = (async (input, _init) => {
    urls.push(typeof input === 'string' ? input : input.toString())
    return new Response(null, { status: 204 })
  }) as FetchImpl
  return {
    urls,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

const llmEvent: TraceEvent = {
  type: 'llm_call',
  runId: 'r',
  agent: 'a',
  model: 'gpt-4o-mini',
  turn: 1,
  tokens: { input_tokens: 1, output_tokens: 1 },
  startMs: 0,
  endMs: 1,
  durationMs: 1,
} as TraceEvent

const toolEvent: TraceEvent = {
  type: 'tool_call',
  runId: 'r',
  agent: 'a',
  tool: 'bash',
  isError: false,
  startMs: 0,
  endMs: 1,
  durationMs: 1,
} as TraceEvent

const taskEvent: TraceEvent = {
  type: 'task',
  runId: 'r',
  agent: 'a',
  taskId: 't',
  taskTitle: 'T',
  success: true,
  retries: 0,
  startMs: 0,
  endMs: 1,
  durationMs: 1,
} as TraceEvent

const agentEvent: TraceEvent = {
  type: 'agent',
  runId: 'r',
  agent: 'a',
  turns: 1,
  toolCalls: 0,
  tokens: { input_tokens: 1, output_tokens: 1 },
  startMs: 0,
  endMs: 1,
  durationMs: 1,
} as TraceEvent

describe('createTraceHandler: filtering', () => {
  let cleanup: (() => void) | undefined
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  test('forwards agent events to /trace', async () => {
    const { urls, restore } = captureFetch()
    cleanup = restore
    const handler = createTraceHandler()
    await handler(agentEvent)
    assert.equal(urls.length, 1)
    assert.ok(urls[0]!.endsWith('/trace'))
  })

  test('forwards task events to /trace', async () => {
    const { urls, restore } = captureFetch()
    cleanup = restore
    const handler = createTraceHandler()
    await handler(taskEvent)
    assert.equal(urls.length, 1)
    assert.ok(urls[0]!.endsWith('/trace'))
  })

  test('does NOT forward llm_call events', async () => {
    const { urls, restore } = captureFetch()
    cleanup = restore
    const handler = createTraceHandler()
    await handler(llmEvent)
    assert.equal(urls.length, 0)
  })

  test('does NOT forward tool_call events', async () => {
    const { urls, restore } = captureFetch()
    cleanup = restore
    const handler = createTraceHandler()
    await handler(toolEvent)
    assert.equal(urls.length, 0)
  })

  test('mixed events: only agent+task cross the wire', async () => {
    const { urls, restore } = captureFetch()
    cleanup = restore
    const handler = createTraceHandler()
    await handler(llmEvent)
    await handler(toolEvent)
    await handler(agentEvent)
    await handler(llmEvent)
    await handler(taskEvent)
    await handler(toolEvent)
    assert.equal(urls.length, 2) // only agent + task
  })
})

describe('createTraceHandler: composition with existing handler', () => {
  let cleanup: (() => void) | undefined
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  test('existing handler receives ALL event types (not filtered)', async () => {
    const { restore } = captureFetch()
    cleanup = restore

    const seen: string[] = []
    const existing = (event: TraceEvent): void => {
      seen.push(event.type)
    }
    const handler = createTraceHandler({}, existing)

    await handler(llmEvent)
    await handler(toolEvent)
    await handler(agentEvent)
    await handler(taskEvent)

    assert.deepEqual(seen, ['llm_call', 'tool_call', 'agent', 'task'])
  })

  test('existing handler is awaited before our POST', async () => {
    // Verify ordering: user handler completes first, then our forward.
    let existingCompleted = false
    let postStartedAfterExisting: boolean | undefined

    globalThis.fetch = (async () => {
      postStartedAfterExisting = existingCompleted
      return new Response(null, { status: 204 })
    }) as FetchImpl
    cleanup = () => {
      globalThis.fetch = originalFetch
    }

    const existing = async (_event: TraceEvent): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      existingCompleted = true
    }
    const handler = createTraceHandler({}, existing)
    await handler(agentEvent)

    assert.equal(existingCompleted, true)
    assert.equal(postStartedAfterExisting, true)
  })

  test('existing handler can be sync (non-promise return)', async () => {
    const { urls, restore } = captureFetch()
    cleanup = restore

    let synced = false
    const existing = (_event: TraceEvent): void => {
      synced = true
    }
    const handler = createTraceHandler({}, existing)
    await handler(agentEvent)

    assert.equal(synced, true)
    assert.equal(urls.length, 1)
  })
})
