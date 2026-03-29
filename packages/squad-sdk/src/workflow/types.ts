/**
 * Workflow Pipeline — Core Type Definitions
 *
 * Types for Mermaid stateDiagram-v2 powered workflow pipelines.
 * Follows the readonly-builder-types convention used across the SDK.
 */

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/** Discriminator for workflow node behavior. */
export type WorkflowNodeType =
  | 'agent'
  | 'human'
  | 'decision'
  | 'fork'
  | 'join'
  | 'composite'
  | 'start'
  | 'end';

/** A single node in a workflow graph. */
export interface WorkflowNode {
  /** Unique identifier — matches the Mermaid state ID. */
  readonly id: string;
  /** What kind of node this is. */
  readonly type: WorkflowNodeType;
  /** Human-readable label (from Mermaid state description, sans @-prefix). */
  readonly label?: string;
  /** For agent nodes: the squad member name (e.g. "edie"). */
  readonly agentName?: string;
  /** For agent nodes: the task description passed to the agent session. */
  readonly task?: string;
  /** For human nodes: the prompt shown in the shell. */
  readonly prompt?: string;
  /** For composite nodes: the nested sub-workflow graph. */
  readonly children?: WorkflowGraph;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** A directed edge between two nodes. */
export interface WorkflowTransition {
  /** Source node ID. */
  readonly from: string;
  /** Target node ID. */
  readonly to: string;
  /** Optional transition label (e.g. "pass", "fail", "approved"). */
  readonly label?: string;
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/** Complete parsed workflow graph — the output of the Mermaid parser. */
export interface WorkflowGraph {
  /** All nodes keyed by ID for O(1) lookup. */
  readonly nodes: ReadonlyMap<string, WorkflowNode>;
  /** All transitions. */
  readonly transitions: readonly WorkflowTransition[];
  /** ID of the entry node (first state after [*] →). */
  readonly entryNodeId: string;
  /** IDs of exit nodes (states that transition to → [*]). */
  readonly exitNodeIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** How a workflow execution is started. */
export type WorkflowTriggerType =
  | 'manual'
  | 'message-pattern'
  | 'squad-route'
  | 'schedule';

export interface WorkflowTrigger {
  readonly type: WorkflowTriggerType;
  /** Regex pattern (for message-pattern triggers). */
  readonly pattern?: string;
  /** Cron expression (for schedule triggers). */
  readonly schedule?: string;
}

// ---------------------------------------------------------------------------
// Definition (static — what gets stored in config)
// ---------------------------------------------------------------------------

/** A complete workflow definition — the unit of configuration. */
export interface WorkflowDefinition {
  readonly name: string;
  readonly description?: string;
  readonly trigger?: WorkflowTrigger;
  /** Raw Mermaid stateDiagram-v2 text. */
  readonly diagram: string;
  /** Parsed graph (populated at load/build time). */
  readonly graph?: WorkflowGraph;
  /** Per-node timeout in ms (default: 300_000 = 5 min). */
  readonly nodeTimeoutMs?: number;
  /** What to do on unrecoverable error. */
  readonly errorStrategy?: 'fail' | 'retry' | 'fallback';
  /** Max retries when errorStrategy is 'retry'. */
  readonly maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Execution (runtime — tracks a running workflow instance)
// ---------------------------------------------------------------------------

/** Lifecycle state of a workflow execution. */
export type WorkflowExecutionStatus =
  | 'pending'
  | 'running'
  | 'waiting_human'
  | 'waiting_decision'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Lifecycle state of a single node execution. */
export type WorkflowNodeExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

/** The result of executing a single node. */
export interface WorkflowNodeExecution {
  readonly nodeId: string;
  readonly nodeName?: string;
  readonly nodeType: WorkflowNodeType;
  readonly status: WorkflowNodeExecutionStatus;
  readonly agentName?: string;
  readonly sessionId?: string;
  /** Agent output or human response. */
  readonly output?: string;
  /** For decision nodes: the transition label chosen. */
  readonly chosenTransition?: string;
  readonly startTime: Date;
  readonly endTime?: Date;
  readonly error?: string;
}

/** A snapshot of a complete workflow run. */
export interface WorkflowExecution {
  /** Unique execution ID. */
  readonly id: string;
  /** Name of the workflow definition. */
  readonly definitionName: string;
  readonly status: WorkflowExecutionStatus;
  /** ID of the node currently being executed (or waiting). */
  readonly currentNodeId?: string;
  /** Ordered history of completed node executions. */
  readonly history: readonly WorkflowNodeExecution[];
  /** IDs of nodes currently executing in parallel (fork). */
  readonly activeParallelNodeIds?: readonly string[];
  /** Context string passed at trigger time. */
  readonly triggerContext?: string;
  readonly startTime: Date;
  readonly endTime?: Date;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Persistence (serializable checkpoint)
// ---------------------------------------------------------------------------

/** JSON-serializable checkpoint for crash recovery. */
export interface WorkflowCheckpoint {
  readonly executionId: string;
  readonly definitionName: string;
  /** Raw Mermaid text to re-parse graph on resume. */
  readonly diagram: string;
  readonly status: WorkflowExecutionStatus;
  readonly currentNodeId?: string;
  readonly history: readonly WorkflowNodeExecution[];
  readonly activeParallelNodeIds?: readonly string[];
  readonly triggerContext?: string;
  readonly startTime: string;
  readonly endTime?: string;
  readonly error?: string;
  /** ISO-8601 timestamp of last checkpoint write. */
  readonly checkpointedAt: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Event types emitted by the workflow engine. */
export type WorkflowEventType =
  | 'workflow.started'
  | 'workflow.node_started'
  | 'workflow.node_completed'
  | 'workflow.decision_made'
  | 'workflow.human_prompt'
  | 'workflow.human_response'
  | 'workflow.transition'
  | 'workflow.completed'
  | 'workflow.failed';

/** Payload shape for workflow events. */
export interface WorkflowEventPayload {
  readonly workflowId: string;
  readonly definitionName: string;
  readonly nodeId?: string;
  readonly nodeType?: WorkflowNodeType;
  readonly agentName?: string;
  readonly transitionLabel?: string;
  readonly fromNodeId?: string;
  readonly toNodeId?: string;
  readonly output?: string;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Configuration defaults
// ---------------------------------------------------------------------------

export const DEFAULT_NODE_TIMEOUT_MS = 300_000; // 5 minutes
export const DEFAULT_ERROR_STRATEGY: WorkflowDefinition['errorStrategy'] = 'fail';
export const DEFAULT_MAX_RETRIES = 2;
export const WORKFLOW_RUNS_DIR = 'workflow-runs';
export const WORKFLOWS_DIR = 'workflows';
