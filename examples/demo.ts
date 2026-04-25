/**
 * AgentSonar × OMA demo.
 *
 * Run in two terminals:
 *
 *   # Terminal 1
 *   python sidecar/sidecar.py
 *
 *   # Terminal 2
 *   $env:OPENAI_API_KEY = "sk-..."
 *   npm run demo
 *
 * Workflow: researcher → reviewer → writer → researcher (fact-check).
 * The task DAG is linear, but the agent graph forms a 3-node cycle.
 * AgentSonar fires `cyclic_delegation` on the third edge.
 *
 * If the sidecar isn't running, OMA still runs — the integration is
 * fire-and-forget.
 */

import { OpenMultiAgent } from '../../open-multi-agent/src/index.js'
import type { AgentConfig, TraceEvent } from '../../open-multi-agent/src/types.js'
import {
  emitDelegations,
  createTraceHandler,
  shutdown as sonarShutdown,
  type DelegationTask,
} from '../src/index.js'

const SIDECAR_ENDPOINT =
  process.env['AGENTSONAR_ENDPOINT'] ?? 'http://localhost:8787'

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const researcher: AgentConfig = {
  name: 'researcher',
  model: 'gpt-4o-mini',
  provider: 'openai',
  systemPrompt:
    'You are a research assistant. Provide concise, factual answers. ' +
    'When asked to fact-check, compare claims against your original research and note any discrepancies.',
  maxTurns: 2,
}

const reviewer: AgentConfig = {
  name: 'reviewer',
  model: 'gpt-4o-mini',
  provider: 'openai',
  systemPrompt:
    'You are a critical reviewer. Read the research provided and note gaps, ' +
    'ambiguities, or claims that need stronger evidence. Be concise (3-5 bullets).',
  maxTurns: 2,
}

const writer: AgentConfig = {
  name: 'writer',
  model: 'gpt-4o-mini',
  provider: 'openai',
  systemPrompt:
    'You are a technical writer. Produce a clear 3-paragraph summary ' +
    'incorporating the research and the review feedback.',
  maxTurns: 2,
}

// ---------------------------------------------------------------------------
// Trace logger — OMA's own output, composed alongside AgentSonar forwarding
// ---------------------------------------------------------------------------

function consoleTrace(event: TraceEvent): void {
  const dur = `${event.durationMs}ms`.padStart(7)
  switch (event.type) {
    case 'llm_call':
      console.log(
        `  [LLM]   ${dur}  agent=${event.agent}  model=${event.model}  turn=${event.turn}` +
          `  tokens=${event.tokens.input_tokens}in/${event.tokens.output_tokens}out`,
      )
      break
    case 'tool_call':
      console.log(
        `  [TOOL]  ${dur}  agent=${event.agent}  tool=${event.tool}  error=${event.isError}`,
      )
      break
    case 'task':
      console.log(
        `  [TASK]  ${dur}  task="${event.taskTitle}"  agent=${event.agent}` +
          `  success=${event.success}  retries=${event.retries}`,
      )
      break
    case 'agent':
      console.log(
        `  [AGENT] ${dur}  agent=${event.agent}  turns=${event.turns}` +
          `  tools=${event.toolCalls}  tokens=${event.tokens.input_tokens}in/${event.tokens.output_tokens}out`,
      )
      break
  }
}

// ---------------------------------------------------------------------------
// Tasks — 4-step workflow forming an agent-level cycle
// ---------------------------------------------------------------------------

const tasks: DelegationTask[] = [
  {
    title: 'Research',
    description:
      'List 3 key trade-offs of using TypeScript for large codebases. Be concise.',
    assignee: 'researcher',
  },
  {
    title: 'Review',
    description:
      'Read the research from shared memory. Note gaps, ambiguities, or ' +
      'claims that need stronger evidence. 3-5 bullets.',
    assignee: 'reviewer',
    dependsOn: ['Research'],
  },
  {
    title: 'Write',
    description:
      'Produce a 3-paragraph summary that incorporates the research and ' +
      'the reviewer feedback from shared memory.',
    assignee: 'writer',
    dependsOn: ['Review'],
  },
  {
    title: 'Fact-check',
    description:
      'Compare the written summary against the original research from shared ' +
      'memory. Flag any discrepancies or over-reaches. 3-5 bullets.',
    assignee: 'researcher', // ← closes the agent-level cycle
    dependsOn: ['Write'],
  },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const orchestrator = new OpenMultiAgent({
  defaultModel: 'gpt-4o-mini',
  onTrace: createTraceHandler({}, consoleTrace),
})

const team = orchestrator.createTeam('cycle-demo', {
  name: 'cycle-demo',
  agents: [researcher, reviewer, writer],
  sharedMemory: true,
})

console.log(`AgentSonar × OMA demo  (sidecar: ${SIDECAR_ENDPOINT})`)
console.log()

try {
  await emitDelegations(tasks)
  const result = await orchestrator.runTasks(team, tasks)

  console.log()
  console.log(
    `OMA run: success=${result.success}  ` +
      `tokens=${result.totalTokenUsage.input_tokens}in/` +
      `${result.totalTokenUsage.output_tokens}out`,
  )
  for (const [name, r] of result.agentResults) {
    console.log(`  ${r.success ? '[OK  ]' : '[FAIL]'} ${name}`)
  }
} catch (err) {
  console.error('\nOMA run threw:', err)
} finally {
  await sonarShutdown()
}
