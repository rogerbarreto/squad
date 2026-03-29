/**
 * Workflow Pipeline — Module Exports
 */

// Types
export type {
  WorkflowNodeType,
  WorkflowNode,
  WorkflowTransition,
  WorkflowGraph,
  WorkflowTriggerType,
  WorkflowTrigger,
  WorkflowDefinition,
  WorkflowExecutionStatus,
  WorkflowNodeExecutionStatus,
  WorkflowNodeExecution,
  WorkflowExecution,
  WorkflowCheckpoint,
  WorkflowEventType,
  WorkflowEventPayload,
} from './types.js';

export {
  DEFAULT_NODE_TIMEOUT_MS,
  DEFAULT_ERROR_STRATEGY,
  DEFAULT_MAX_RETRIES,
  WORKFLOW_RUNS_DIR,
  WORKFLOWS_DIR,
} from './types.js';

// Parser
export { parseStateDiagram, MermaidParseError } from './parser.js';

// State Machine
export {
  WorkflowStateMachine,
  type StateMachineStatus,
  type StateMachineSnapshot,
  type ForkTracker,
} from './state-machine.js';

// Engine
export {
  WorkflowEngine,
  type WorkflowEngineConfig,
  type WorkflowPersistence,
} from './engine.js';

// Executors
export type {
  AgentSpawnFn,
  HumanPromptFn,
  DecisionEvalFn,
  ExecutorDependencies,
  ExecutorResult,
} from './executors.js';

// Persistence
export { FileWorkflowPersistence } from './persistence.js';

// Markdown
export {
  loadWorkflowsFromDirectory,
  parseWorkflowMarkdown,
} from './markdown.js';
