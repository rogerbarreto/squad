/**
 * Workflow Pipeline — Node Executors
 *
 * Per-type execution strategies for workflow nodes:
 *   - AgentExecutor:     spawn a squad member session
 *   - HumanExecutor:     pause and prompt the user
 *   - DecisionExecutor:  spawn orchestrator to choose a transition
 *   - ForkExecutor:      fan-out parallel branches
 *   - CompositeExecutor: recursively execute sub-workflow
 */

import type { EventBus, SquadEvent } from '../client/event-bus.js';
import type {
  WorkflowNode,
  WorkflowNodeExecution,
  WorkflowEventPayload,
} from './types.js';
import type { WorkflowStateMachine } from './state-machine.js';

// ---------------------------------------------------------------------------
// Dependencies injected by the engine
// ---------------------------------------------------------------------------

export interface AgentSpawnFn {
  (agentName: string, task: string, context?: string): Promise<{
    sessionId: string;
    output: string;
  }>;
}

export interface HumanPromptFn {
  (prompt: string, options: string[]): Promise<{
    choice: string;
    comment?: string;
  }>;
}

export interface DecisionEvalFn {
  (
    context: string,
    transitionLabels: string[],
    previousOutputs: readonly WorkflowNodeExecution[],
  ): Promise<string>;
}

export interface ExecutorDependencies {
  readonly spawnAgent: AgentSpawnFn;
  readonly promptHuman: HumanPromptFn;
  readonly evaluateDecision: DecisionEvalFn;
  readonly eventBus: EventBus;
}

// ---------------------------------------------------------------------------
// Executor result
// ---------------------------------------------------------------------------

export interface ExecutorResult {
  readonly output?: string;
  readonly sessionId?: string;
  readonly chosenTransition?: string;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Agent executor
// ---------------------------------------------------------------------------

export async function executeAgentNode(
  node: WorkflowNode,
  workflowId: string,
  context: string,
  deps: ExecutorDependencies,
): Promise<ExecutorResult> {
  if (!node.agentName) {
    throw new Error(`Agent node '${node.id}' has no agentName`);
  }

  await emitWorkflowEvent(deps.eventBus, 'workflow.node_started', {
    workflowId,
    definitionName: '',
    nodeId: node.id,
    nodeType: node.type,
    agentName: node.agentName,
  });

  const result = await deps.spawnAgent(
    node.agentName,
    node.task ?? `Execute workflow node: ${node.id}`,
    context,
  );

  await emitWorkflowEvent(deps.eventBus, 'workflow.node_completed', {
    workflowId,
    definitionName: '',
    nodeId: node.id,
    nodeType: node.type,
    agentName: node.agentName,
    output: result.output,
  });

  return { output: result.output, sessionId: result.sessionId };
}

// ---------------------------------------------------------------------------
// Human executor
// ---------------------------------------------------------------------------

export async function executeHumanNode(
  node: WorkflowNode,
  workflowId: string,
  sm: WorkflowStateMachine,
  deps: ExecutorDependencies,
): Promise<ExecutorResult> {
  const prompt = node.prompt ?? `Workflow requires your input at node: ${node.id}`;
  const transitionLabels = sm.getTransitionLabels();

  await emitWorkflowEvent(deps.eventBus, 'workflow.human_prompt', {
    workflowId,
    definitionName: '',
    nodeId: node.id,
    nodeType: node.type,
    output: prompt,
  });

  const response = await deps.promptHuman(
    prompt,
    transitionLabels as string[],
  );

  await emitWorkflowEvent(deps.eventBus, 'workflow.human_response', {
    workflowId,
    definitionName: '',
    nodeId: node.id,
    nodeType: node.type,
    output: response.comment ?? response.choice,
    transitionLabel: response.choice,
  });

  return {
    output: response.comment ?? response.choice,
    chosenTransition: response.choice,
  };
}

// ---------------------------------------------------------------------------
// Decision executor (Ralph / Orchestrator evaluates)
// ---------------------------------------------------------------------------

export async function executeDecisionNode(
  node: WorkflowNode,
  workflowId: string,
  sm: WorkflowStateMachine,
  history: readonly WorkflowNodeExecution[],
  deps: ExecutorDependencies,
): Promise<ExecutorResult> {
  const transitionLabels = sm.getTransitionLabels();

  if (transitionLabels.length === 0) {
    throw new Error(
      `Decision node '${node.id}' has no labeled transitions to choose from`,
    );
  }

  // Build context for the orchestrator
  const contextParts = [
    `You are evaluating a workflow decision point.`,
    `Current node: '${node.id}'${node.label ? ` (${node.label})` : ''}.`,
    `Available transitions: [${transitionLabels.join(', ')}].`,
    '',
    'Previous workflow steps:',
  ];

  for (const entry of history) {
    contextParts.push(
      `  - Node '${entry.nodeId}' (${entry.nodeType}): ${entry.status}` +
        (entry.output ? ` → ${entry.output.slice(0, 200)}` : ''),
    );
  }

  contextParts.push(
    '',
    `Based on the workflow context above, which transition should be taken?`,
    `Reply with EXACTLY one of: ${transitionLabels.join(', ')}`,
  );

  const context = contextParts.join('\n');

  const chosen = await deps.evaluateDecision(
    context,
    transitionLabels as string[],
    history,
  );

  // Validate the choice
  if (!transitionLabels.includes(chosen)) {
    throw new Error(
      `Decision node '${node.id}': orchestrator returned '${chosen}' ` +
        `which is not in [${transitionLabels.join(', ')}]`,
    );
  }

  await emitWorkflowEvent(deps.eventBus, 'workflow.decision_made', {
    workflowId,
    definitionName: '',
    nodeId: node.id,
    nodeType: node.type,
    transitionLabel: chosen,
  });

  return { chosenTransition: chosen };
}

// ---------------------------------------------------------------------------
// Fork executor
// ---------------------------------------------------------------------------

export async function executeForkNode(
  node: WorkflowNode,
  workflowId: string,
  sm: WorkflowStateMachine,
  context: string,
  deps: ExecutorDependencies,
): Promise<{ branchResults: Map<string, ExecutorResult> }> {
  const branches = sm.beginFork();

  const results = new Map<string, ExecutorResult>();
  const promises = branches.map(async (branchNode) => {
    try {
      let result: ExecutorResult;
      if (branchNode.type === 'agent' && branchNode.agentName) {
        result = await executeAgentNode(branchNode, workflowId, context, deps);
      } else {
        result = { output: `Node '${branchNode.id}' executed (non-agent branch)` };
      }
      results.set(branchNode.id, result);
    } catch (err) {
      results.set(branchNode.id, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await Promise.allSettled(promises);
  return { branchResults: results };
}

// ---------------------------------------------------------------------------
// Event helper
// ---------------------------------------------------------------------------

async function emitWorkflowEvent(
  eventBus: EventBus,
  type: SquadEvent['type'],
  payload: WorkflowEventPayload,
): Promise<void> {
  await eventBus.emit({
    type,
    sessionId: undefined,
    agentName: payload.agentName,
    payload,
    timestamp: new Date(),
  });
}
