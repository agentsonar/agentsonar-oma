/**
 * @agentsonar/oma — AgentSonar integration for Open Multi-Agent (OMA).
 *
 * Bridges OMA's task graph and trace events to a local AgentSonar Python
 * sidecar over HTTP JSON. Three exports:
 *
 *   - emitDelegations(tasks, opts?)
 *       Walk task.dependsOn and emit one delegation edge per dep into the
 *       sidecar before runTasks() starts.
 *   - createTraceHandler(opts?, existing?)
 *       Returns an onTrace handler that forwards OMA's `agent` and `task`
 *       trace events to the sidecar. Composes with an existing handler.
 *   - shutdown(opts?)
 *       Tell the sidecar to write its final report and exit.
 *
 * Every public function is fire-and-forget: HTTP calls are bounded by a
 * 2-second timeout (configurable), all errors are swallowed, and bad
 * input returns a no-op instead of throwing. The OMA run is never
 * blocked or crashed by the integration.
 *
 * See README.md for installation, quickstart, and configuration.
 */

import type { TraceEvent } from '@jackchen_me/open-multi-agent'

const DEFAULT_ENDPOINT = 'http://localhost:8787'
const DEFAULT_TIMEOUT_MS = 2000

/**
 * Thrown by `emitDelegations()` (and only `emitDelegations()`) when the
 * Python sidecar reports that Prevent Mode has tripped. Mirrors the Python
 * SDK's `agentsonar.PreventError`: same field shape, same intent — stop
 * the user's loop with one specific exception type while every other SDK
 * failure mode stays swallowed.
 *
 * To enable Prevent Mode, start the sidecar with:
 *
 *     python sidecar/sidecar.py --prevent-cyclic-delegation
 *
 * Then catch in your code:
 *
 *     try {
 *       await emitDelegations(tasks)
 *       await orchestrator.runTasks(team, tasks)
 *     } catch (e) {
 *       if (e instanceof PreventError) {
 *         console.log(`Stopped: ${e.reason}`)
 *         console.log(`Cycle:   ${e.cyclePath.join(' -> ')}`)
 *       } else {
 *         throw e
 *       }
 *     }
 *
 * Once raised, the sidecar's tracked state stays tripped — subsequent
 * `emitDelegations()` calls on the same sidecar will keep throwing. To
 * reset, restart the sidecar.
 */
export class PreventError extends Error {
  readonly failureClass: string
  readonly severity: string
  readonly rotations: number
  readonly cyclePath: readonly string[]
  readonly reason: string
  readonly timestamp: number

  constructor(data: {
    failureClass: string
    severity: string
    rotations: number
    cyclePath: readonly string[]
    reason: string
    timestamp: number
  }) {
    super(data.reason)
    // Restore prototype chain so `instanceof PreventError` works after
    // transpilation to ES5 — common gotcha when extending built-ins.
    Object.setPrototypeOf(this, PreventError.prototype)
    this.name = 'PreventError'
    this.failureClass = data.failureClass
    this.severity = data.severity
    this.rotations = data.rotations
    this.cyclePath = data.cyclePath
    this.reason = data.reason
    this.timestamp = data.timestamp
  }
}

/**
 * Parse a Problem Details body (RFC 7807) into a PreventError, IF and
 * only if it carries the agentsonar prevent extension. Returns null
 * for any other shape — including a plain 409 from a misconfigured
 * proxy or a JSON body that just happens to share the content type.
 *
 * The three guards (status, content-type, agentsonar key) all have to
 * line up. This keeps the throw path tight: only an actual sidecar
 * trip triggers an exception in the user's code.
 */
function tryParsePreventBody(body: unknown): PreventError | null {
  if (!body || typeof body !== 'object') return null
  const data = body as Record<string, unknown>
  const ext = data['agentsonar']
  if (!ext || typeof ext !== 'object') return null
  const e = ext as Record<string, unknown>
  // Defensive coercion — sidecar should always populate these but a
  // bad body shouldn't crash the client. Default sensibly.
  const failureClass = typeof e['failure_class'] === 'string'
    ? (e['failure_class'] as string) : 'unknown'
  const severity = typeof e['severity'] === 'string'
    ? (e['severity'] as string) : 'CRITICAL'
  const rotations = typeof e['rotations'] === 'number'
    ? (e['rotations'] as number) : 0
  const cyclePathRaw = e['cycle_path']
  const cyclePath = Array.isArray(cyclePathRaw)
    ? cyclePathRaw.filter((x): x is string => typeof x === 'string')
    : []
  const reason = typeof e['reason'] === 'string'
    ? (e['reason'] as string)
    : (typeof data['detail'] === 'string'
        ? (data['detail'] as string) : 'coordination prevented')
  const timestamp = typeof e['timestamp'] === 'number'
    ? (e['timestamp'] as number) : Date.now() / 1000
  return new PreventError({
    failureClass, severity, rotations, cyclePath, reason, timestamp,
  })
}

// Module-level state for the "sidecar unreachable" one-time warning.
// We print a friendly note on the FIRST connection-refused error so users
// who forgot to start the sidecar get a clear heads-up, then stay quiet
// so subsequent calls don't flood the terminal.
let _sidecarUnreachableWarned = false

/**
 * Minimal task shape consumed by `emitDelegations`.
 *
 * Structurally compatible with OMA's `runTasks` input — you can pass the
 * same array to both functions without any cast:
 *
 *     const tasks: DelegationTask[] = [
 *       { title: 'A', description: '...', assignee: 'planner' },
 *       { title: 'B', description: '...', assignee: 'writer',
 *         dependsOn: ['A'] },
 *     ]
 *     await emitDelegations(tasks)
 *     await orchestrator.runTasks(team, tasks)
 */
export interface DelegationTask {
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
  /** Framework-generated task ID; usually set by OMA internally. */
  id?: string
  // Preserved for structural compatibility with OMA's runTasks input —
  // not used by the AgentSonar integration itself.
  memoryScope?: 'dependencies' | 'all'
  maxRetries?: number
  retryDelayMs?: number
  retryBackoff?: number
}

export interface AgentSonarOptions {
  /**
   * Base URL of the Python sidecar. Default: http://localhost:8787.
   * Override via env var AGENTSONAR_ENDPOINT if deploying elsewhere.
   */
  readonly endpoint?: string
  /**
   * If true, log wire activity to console.error. Default: false.
   * Useful during first-time setup.
   */
  readonly debug?: boolean
  /**
   * Per-request timeout in milliseconds. Default: 2000.
   * If the sidecar doesn't respond within this window, the fetch aborts
   * and we move on — the OMA run is never blocked on our telemetry.
   */
  readonly timeoutMs?: number
}

function resolveEndpoint(opts: AgentSonarOptions): string {
  // Env var wins over explicit option so ops can reconfigure without
  // touching code. Falls back to localhost:8787.
  //
  // We access `process.env` through `globalThis` so this module type-checks
  // even when @types/node isn't loaded (keeps the package portable if
  // anyone ever wants to bundle it for non-Node environments).
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    const envValue = proc?.env?.['AGENTSONAR_ENDPOINT']
    const raw = envValue || opts.endpoint || DEFAULT_ENDPOINT
    // Normalize: strip trailing slashes so `${endpoint}/ingest` doesn't
    // become `${endpoint}//ingest` when the user configured a trailing /.
    return raw.replace(/\/+$/, '')
  } catch {
    return DEFAULT_ENDPOINT
  }
}

function resolveTimeout(opts: AgentSonarOptions): number {
  const t = opts.timeoutMs
  if (typeof t === 'number' && t > 0 && Number.isFinite(t)) return t
  return DEFAULT_TIMEOUT_MS
}

/**
 * Check whether an error is a connection-refused from undici's fetch.
 * Returns true for the `ECONNREFUSED` case so we can print a one-time
 * friendly note about the missing sidecar.
 */
function isConnectionRefused(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  // undici's fetch wraps the underlying error in `cause`
  const cause = (err as { cause?: unknown }).cause
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: string }).code
    if (code === 'ECONNREFUSED') return true
    // AggregateError with nested per-family errors (IPv4/IPv6 both refused)
    const errors = (cause as { errors?: Array<{ code?: string }> }).errors
    if (Array.isArray(errors) && errors.some((e) => e?.code === 'ECONNREFUSED')) {
      return true
    }
  }
  return false
}

/**
 * Print the one-time "sidecar unreachable" note. Subsequent ECONNREFUSEDs
 * are silenced (unless debug=true) so the terminal isn't flooded.
 */
function warnSidecarUnreachableOnce(endpoint: string): void {
  if (_sidecarUnreachableWarned) return
  _sidecarUnreachableWarned = true
  try {
    console.warn(
      `[agentsonar-oma] Cannot reach sidecar at ${endpoint}. ` +
        'Continuing without observability — your OMA run is unaffected. ' +
        'To enable detection, start the sidecar:\n' +
        '  python sidecar/sidecar.py',
    )
  } catch {
    /* swallow */
  }
}

/**
 * POST a JSON body, fire-and-forget. Never throws — if the sidecar is
 * unreachable, hung, slow, or returns an error, we log (in debug mode)
 * and return. The OMA run is never blocked on our telemetry.
 */
async function post(
  url: string,
  body: unknown,
  debug: boolean,
  timeoutMs: number,
  endpoint: string,
): Promise<void> {
  let bodyConsumed = false
  try {
    // JSON.stringify could theoretically throw on a circular reference.
    // Do it inside the try so any such throw is swallowed.
    const payload = JSON.stringify(body)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      // Bound the wait so a hung sidecar can never block the OMA run.
      signal: AbortSignal.timeout(timeoutMs),
    })

    // Prevent Mode trip detection. Three guards must ALL line up
    // (status + content-type + body shape) so a generic 409 from a
    // misconfigured proxy can't accidentally throw into user code.
    if (res.status === 409) {
      const ct = res.headers.get('content-type') || ''
      if (ct.includes('application/problem+json')) {
        let parsed: unknown = null
        try {
          parsed = await res.json()
          bodyConsumed = true
        } catch {
          // Body wasn't valid JSON despite the content-type. Treat as
          // a non-prevent 409 — fall through to the normal log path.
        }
        const preventError = tryParsePreventBody(parsed)
        if (preventError !== null) {
          throw preventError
        }
      }
    }

    if (debug && !res.ok) {
      try {
        console.error(`[agentsonar-oma] POST ${url} -> ${res.status}`)
      } catch {
        // console can throw in exotic environments; swallow.
      }
    }
    // Drain the response body even though we don't use it. Without this,
    // undici keeps the underlying socket in its connection pool waiting
    // for the body to be consumed — that keeps the Node event loop alive
    // for several seconds after the last call, so the user's script
    // appears to hang after `await shutdown()`. Consuming the body
    // returns the connection to the idle pool and lets the process exit.
    if (!bodyConsumed) {
      try {
        await res.text()
      } catch {
        // If body read fails (connection closed mid-stream), that's fine —
        // we didn't need the body anyway.
      }
    }
  } catch (err) {
    // PreventError is the ONE exception type intentionally allowed to
    // propagate. Every other failure (network, parsing, sidecar bug)
    // stays caught — host-safety contract preserved.
    if (err instanceof PreventError) {
      throw err
    }
    // Sidecar unreachable: print ONE friendly warning, then stay quiet
    // (unless debug=true). This is the common "user forgot to start
    // the sidecar" case — we want them to notice, not to get flooded.
    if (isConnectionRefused(err)) {
      warnSidecarUnreachableOnce(endpoint)
    } else if (debug) {
      try {
        console.error(`[agentsonar-oma] POST ${url} failed:`, err)
      } catch {
        // Swallow console errors too — we must never throw from here.
      }
    }
    // Silent otherwise. Observability must never break the observed.
  }
}

/**
 * Emit delegation events derived from a task list's `dependsOn` structure.
 *
 * Call this once, right before `orchestrator.runTasks(team, tasks)`.
 * Each `dependsOn` entry on a task creates one delegation edge: the
 * upstream task's assignee delegates to the downstream task's assignee.
 *
 * Matching is by task.title (that's what `dependsOn` contains in the
 * canonical OMA examples). If a task has an explicit `id`, that's also
 * checked as a fallback.
 *
 * Edges where either source or target has no assignee are skipped
 * silently (with a debug log when `opts.debug` is true).
 *
 * This function NEVER throws — on bad input it returns 0, on network
 * failures it logs (debug only) and continues.
 *
 * @returns The number of valid delegation edges that were attempted.
 *          Counts the attempt, NOT whether the sidecar received it — a
 *          fire-and-forget POST that fails (e.g. sidecar down) still
 *          counts. Zero when input is invalid or no valid edges existed.
 */
export async function emitDelegations(
  tasks: readonly DelegationTask[],
  opts: AgentSonarOptions = {},
): Promise<number> {
  // Outer try/catch: defense in depth. If anything inside goes wrong,
  // we still return a number and never propagate.
  try {
    const debug = opts?.debug ?? false

    // Input guard: accept only arrays. Anything else is a silent no-op.
    if (!Array.isArray(tasks)) {
      if (debug) {
        try {
          console.error(
            '[agentsonar-oma] emitDelegations: tasks must be an array ' +
              `(received ${typeof tasks}). Returning 0.`,
          )
        } catch {
          /* swallow */
        }
      }
      return 0
    }
    if (tasks.length === 0) return 0

    const endpoint = resolveEndpoint(opts)
    const timeoutMs = resolveTimeout(opts)

    // Map by title first, then by id (OMA allows either in dependsOn).
    const byKey = new Map<string, DelegationTask>()
    for (const t of tasks) {
      if (!t || typeof t !== 'object') continue
      if (typeof t.title === 'string' && t.title) byKey.set(t.title, t)
      if (typeof t.id === 'string' && t.id) byKey.set(t.id, t)
    }

    const timestamp = Date.now() / 1000 // AgentSonar uses float seconds
    let emitted = 0
    let attempted = 0 // count of depKey lookups we tried, valid or not

    for (const task of tasks) {
      if (!task || typeof task !== 'object') continue
      const deps = Array.isArray(task.dependsOn) ? task.dependsOn : []
      for (const depKey of deps) {
        if (typeof depKey !== 'string') continue
        attempted++
        const upstream = byKey.get(depKey)
        if (!upstream) {
          if (debug) {
            try {
              console.error(
                `[agentsonar-oma] dependsOn reference "${depKey}" not found; skipping edge`,
              )
            } catch {
              /* swallow */
            }
          }
          continue
        }
        const source = upstream.assignee
        const target = task.assignee
        if (!source || !target) {
          if (debug) {
            try {
              console.error(
                `[agentsonar-oma] skipping edge with unassigned task: ${
                  source ?? '?'
                } -> ${target ?? '?'}`,
              )
            } catch {
              /* swallow */
            }
          }
          continue
        }
        await post(
          `${endpoint}/ingest`,
          {
            source,
            target,
            timestamp,
            metadata: {
              via: 'task_dependency',
              fromTask: upstream.title ?? upstream.id,
              toTask: task.title ?? task.id,
            },
          },
          debug,
          timeoutMs,
          endpoint,
        )
        emitted++
      }
    }

    if (debug) {
      try {
        console.error(
          `[agentsonar-oma] emitted ${emitted} delegation edge(s)`,
        )
      } catch {
        /* swallow */
      }
    }
    // Quiet warning (visible even without debug mode) for a common setup
    // error: user declared dependsOn but none of them resolved into edges.
    // We DO NOT warn when there's simply no dependsOn anywhere — that's a
    // legal shape (independent tasks), not a misconfiguration.
    if (emitted === 0 && attempted > 0) {
      try {
        console.warn(
          '[agentsonar-oma] emitDelegations: you declared ' +
            `${attempted} dependsOn reference(s) but none resolved into ` +
            'edges. Check that referenced titles match, and that both ' +
            'upstream and downstream tasks have `assignee` set.',
        )
      } catch {
        /* swallow */
      }
    }
    return emitted
  } catch (err) {
    // PreventError is the ONE exception type emitDelegations is allowed
    // to throw — only when the sidecar was started with
    // --prevent-cyclic-delegation AND a tracked failure has tripped.
    // The user's `try/catch (e instanceof PreventError)` block catches it.
    if (err instanceof PreventError) {
      throw err
    }
    // Absolute belt-and-suspenders. We should have caught everything by
    // now, but any remaining surprise never propagates to the user.
    try {
      if (opts?.debug) {
        console.error('[agentsonar-oma] emitDelegations: unexpected error:', err)
      }
    } catch {
      /* swallow */
    }
    return 0
  }
}

/**
 * Return an onTrace handler that forwards trace events to the sidecar.
 *
 * Usage — compose with an existing handler if you have one:
 *
 *     const orchestrator = new OpenMultiAgent({
 *       defaultModel: 'gpt-4o-mini',
 *       onTrace: createTraceHandler({}, existingHandler),
 *     })
 *
 * Forwards only `agent` and `task` events — those carry aggregate
 * cost/timing per agent / per task. `llm_call` (per-turn LLM detail)
 * and `tool_call` (intra-agent) are ignored in v1; they're noisy for
 * detection and the aggregate `agent`/`task` events carry the same
 * totals for future per-agent cost rollup.
 *
 * The returned handler NEVER throws — failures in the user's existing
 * handler, JSON serialization problems, or sidecar errors are all
 * swallowed.
 */
export function createTraceHandler(
  opts: AgentSonarOptions = {},
  existing?: (event: TraceEvent) => void | Promise<void>,
): (event: TraceEvent) => Promise<void> {
  const endpoint = resolveEndpoint(opts)
  const debug = opts?.debug ?? false
  const timeoutMs = resolveTimeout(opts)

  return async (event: TraceEvent) => {
    // Outer try/catch: absolute guarantee we never throw.
    try {
      // Preserve whatever the user was already doing with traces.
      if (typeof existing === 'function') {
        try {
          await existing(event)
        } catch (err) {
          if (debug) {
            try {
              console.error(
                `[agentsonar-oma] existing onTrace threw:`,
                err,
              )
            } catch {
              /* swallow */
            }
          }
          // Never rethrow — preserve our own sidecar POST even if the
          // user's handler broke.
        }
      }

      if (
        event &&
        typeof event === 'object' &&
        (event.type === 'agent' || event.type === 'task')
      ) {
        await post(`${endpoint}/trace`, event, debug, timeoutMs, endpoint)
      }
    } catch (err) {
      try {
        if (debug) {
          console.error('[agentsonar-oma] trace handler: unexpected error:', err)
        }
      } catch {
        /* swallow */
      }
    }
  }
}

/**
 * Signal the sidecar to write its final reports (report.json + report.html)
 * and exit. Call after your last `runTasks` completes.
 *
 * Safe to call multiple times — never throws. Note that the sidecar
 * process exits after the first successful call, so subsequent calls
 * silently no-op (their POST hits a non-existent server).
 */
export async function shutdown(opts: AgentSonarOptions = {}): Promise<void> {
  try {
    const endpoint = resolveEndpoint(opts)
    const debug = opts?.debug ?? false
    const timeoutMs = resolveTimeout(opts)
    await post(`${endpoint}/shutdown`, {}, debug, timeoutMs, endpoint)
  } catch (err) {
    try {
      if (opts?.debug) {
        console.error('[agentsonar-oma] shutdown: unexpected error:', err)
      }
    } catch {
      /* swallow */
    }
  }
}

// Re-export TraceEvent so consumers have a single import surface.
export type { TraceEvent }

/**
 * Test helper — resets the module-level "already warned" flag so tests
 * can verify the one-time warning behavior fires fresh each time.
 * Not part of the public API contract; may be removed in a future
 * version. Prefixed with an underscore by convention.
 */
export function _resetSidecarUnreachableWarning(): void {
  _sidecarUnreachableWarned = false
}
