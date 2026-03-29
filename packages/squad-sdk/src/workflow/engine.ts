/**
 * Workflow Pipeline — Engine
 *
 * Orchestrates the execution of a workflow definition. Advances the state
 * machine node by node, delegates to per-type executors, and persists
 * checkpoints for crash recovery.
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '../client/event-bus.js';
import type {
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowExecutionStatus,
  WorkflowNodeExecution,
  WorkflowNodeExecutionStatus,
  WorkflowCheckpoint,
  WorkflowEventPayload,
} from './types.js';
import { DEFAULT_NODE_TIMEOUT_MS } from './types.js';
import { parseStateDiagram } from './parser.js';
import { WorkflowStateMachine } from './state-machine.js';
import type { ExecutorDependencies, ExecutorResult } from './executors.js';
import {
  executeAgentNode,
  executeHumanNode,
  executeDecisionNode,
  executeForkNode,
} from './executors.js';

// ---------------------------------------------------------------------------
// Persistence interface (implemented externally)
// ---------------------------------------------------------------------------

export interface WorkflowPersistence {
  saveCheckpoint(checkpoint: WorkflowCheckpoint): Promise<void>;
  loadCheckpoint(executionId: string): Promise<WorkflowCheckpoint | null>;
  deleteCheckpoint(executionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Engine configuration
// ---------------------------------------------------------------------------

export interface WorkflowEngineConfig {
  readonly deps: ExecutorDependencies;
  readonly persistence?: WorkflowPersistence;
  readonly eventBus: EventBus;
}

// ---------------------------------------------------------------------------
// Workflow Engine
// ---------------------------------------------------------------------------

export class WorkflowEngine {
  private readonly deps: ExecutorDependencies;
  private readonly persistence?: WorkflowPersistence;
  private readonly eventBus: EventBus;

  constructor(config: WorkflowEngineConfig) {
    this.deps = config.deps;
    this.persistence = config.persistence;
    this.eventBus = config.eventBus;
  }

  /**
   * Execute a workflow definition from start to completion.
   *
   * @param definition The workflow to execute.
   * @param triggerContext Optional context string from the trigger.
   * @returns The completed execution record.
   */
  async execute(
    definition: WorkflowDefinition,
    triggerContext?: string,
  ): Promise<WorkflowExecution> {
    const executionId = randomUUID();
    const graph = definition.graph ?? parseStateDiagram(definition.diagram);
    const sm = new WorkflowStateMachine(graph);
    const history: WorkflowNodeExecution[] = [];
    const timeoutMs = definition.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;

    let status: WorkflowExecutionStatus = 'running';
    let error: string | undefined;
    const startTime = new Date();

    // Emit workflow.started
    await this.emitEvent('workflow.started', {
      workflowId: executionId,
      definitionName: definition.name,
    });

    try {
      // Start the state machine
      let currentNode = sm.start();

      // Main execution loop
      while (sm.status !== 'completed' && sm.status !== 'failed') {
        const nodeStartTime = new Date();
        let nodeStatus: WorkflowNodeExecutionStatus = 'running';
        let result: ExecutorResult = {};

        try {
          result = await this.executeNodeWithTimeout(
            currentNode,
            executionId,
            sm,
            history,
            triggerContext ?? '',
            timeoutMs,
          );
          nodeStatus = 'completed';
        } catch (err) {
          nodeStatus = 'failed';
          result = {
            error: err instanceof Error ? err.message : String(err),
          };

          if (definition.errorStrategy === 'fail' || !definition.errorStrategy) {
            sm.fail();
            status = 'failed';
            error = result.error;
          }
          // For 'retry' — the caller would need to re-execute
        }

        // Record in history
        const nodeExecution: WorkflowNodeExecution = {
          nodeId: currentNode.id,
          nodeName: currentNode.label,
          nodeType: currentNode.type,
          status: nodeStatus,
          agentName: currentNode.agentName,
          sessionId: result.sessionId,
          output: result.output,
          chosenTransition: result.chosenTransition,
          startTime: nodeStartTime,
          endTime: new Date(),
          error: result.error,
        };
        history.push(nodeExecution);

        // Persist checkpoint
        if (this.persistence) {
          await this.persistence.saveCheckpoint(
            this.buildCheckpoint(
              executionId,
              definition,
              sm,
              history,
              status,
              triggerContext,
              startTime,
              error,
            ),
          );
        }

        // If failed, break
        if (status === 'failed') break;

        // Advance state machine
        try {
          if (result.chosenTransition) {
            currentNode = sm.fireTransition(result.chosenTransition);
          } else {
            // Check if current node is an exit node
            if (sm.isExitNode(currentNode.id)) {
              sm.advanceTo('__end__');
              break;
            }
            currentNode = sm.fireTransition();
          }
        } catch (err) {
          // No valid transition — workflow is stuck
          sm.fail();
          status = 'failed';
          error =
            `Failed to advance from node '${currentNode.id}': ` +
            (err instanceof Error ? err.message : String(err));
          break;
        }

        // Emit transition event
        await this.emitEvent('workflow.transition', {
          workflowId: executionId,
          definitionName: definition.name,
          fromNodeId: history[history.length - 1]?.nodeId,
          toNodeId: currentNode.id,
        });
      }

      if (status !== 'failed') {
        status = 'completed';
      }
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
    }

    const endTime = new Date();

    // Emit completion/failure
    const eventType = status === 'completed' ? 'workflow.completed' : 'workflow.failed';
    await this.emitEvent(eventType, {
      workflowId: executionId,
      definitionName: definition.name,
      error,
    });

    // Clean up checkpoint on completion
    if (this.persistence && status === 'completed') {
      await this.persistence.deleteCheckpoint(executionId).catch(() => {});
    }

    return {
      id: executionId,
      definitionName: definition.name,
      status,
      currentNodeId: sm.currentNodeId ?? undefined,
      history,
      triggerContext,
      startTime,
      endTime,
      error,
    };
  }

  /**
   * Resume a previously-checkpointed workflow execution.
   */
  async resume(checkpoint: WorkflowCheckpoint): Promise<WorkflowExecution> {
    const graph = parseStateDiagram(checkpoint.diagram);
    const definition: WorkflowDefinition = {
      name: checkpoint.definitionName,
      diagram: checkpoint.diagram,
      graph,
    };

    // Reconstruct state machine from checkpoint
    const sm = new WorkflowStateMachine(graph);
    const snap = {
      currentNodeId: checkpoint.currentNodeId ?? null,
      status: checkpoint.status === 'running' ? 'active' as const : 'active' as const,
      visitHistory: checkpoint.history.map((h) => h.nodeId),
      activeForks: [],
    };
    sm.restore(snap);

    // Re-execute from current node
    return this.execute(definition, checkpoint.triggerContext);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async executeNodeWithTimeout(
    node: ReturnType<WorkflowStateMachine['start']>,
    workflowId: string,
    sm: WorkflowStateMachine,
    history: WorkflowNodeExecution[],
    context: string,
    timeoutMs: number,
  ): Promise<ExecutorResult> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Node '${node.id}' timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    const executionPromise = this.executeNode(
      node,
      workflowId,
      sm,
      history,
      context,
    );

    return Promise.race([executionPromise, timeoutPromise]);
  }

  private async executeNode(
    node: ReturnType<WorkflowStateMachine['start']>,
    workflowId: string,
    sm: WorkflowStateMachine,
    history: WorkflowNodeExecution[],
    context: string,
  ): Promise<ExecutorResult> {
    switch (node.type) {
      case 'agent':
        return executeAgentNode(node, workflowId, context, this.deps);

      case 'human':
        return executeHumanNode(node, workflowId, sm, this.deps);

      case 'decision':
        return executeDecisionNode(node, workflowId, sm, history, this.deps);

      case 'fork': {
        const { branchResults } = await executeForkNode(
          node,
          workflowId,
          sm,
          context,
          this.deps,
        );
        // Complete all branches
        let joinNode: ReturnType<typeof sm.completeForkBranch> | undefined;
        for (const [branchId] of branchResults) {
          joinNode = sm.completeForkBranch(branchId);
        }
        const outputs = [...branchResults.values()]
          .map((r) => r.output ?? r.error ?? '')
          .join('\n');
        return { output: outputs, chosenTransition: undefined };
      }

      case 'join':
        // Join nodes are handled by fork logic — just pass through
        return { output: `Join node '${node.id}' reached` };

      case 'composite':
        // For composite nodes, we'd recursively execute the sub-graph
        // Simplified: treat as pass-through for now
        return { output: `Composite node '${node.id}' executed` };

      case 'start':
      case 'end':
        return {};

      default:
        return { output: `Unknown node type: ${node.type}` };
    }
  }

  private buildCheckpoint(
    executionId: string,
    definition: WorkflowDefinition,
    sm: WorkflowStateMachine,
    history: readonly WorkflowNodeExecution[],
    status: WorkflowExecutionStatus,
    triggerContext: string | undefined,
    startTime: Date,
    error: string | undefined,
  ): WorkflowCheckpoint {
    return {
      executionId,
      definitionName: definition.name,
      diagram: definition.diagram,
      status,
      currentNodeId: sm.currentNodeId ?? undefined,
      history,
      triggerContext,
      startTime: startTime.toISOString(),
      error,
      checkpointedAt: new Date().toISOString(),
    };
  }

  private async emitEvent(
    type: 'workflow.started' | 'workflow.completed' | 'workflow.failed' | 'workflow.transition',
    payload: WorkflowEventPayload,
  ): Promise<void> {
    await this.eventBus.emit({
      type,
      payload,
      timestamp: new Date(),
    });
  }
}
