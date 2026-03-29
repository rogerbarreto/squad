/**
 * Workflow Pipeline — State Machine Runtime
 *
 * Tracks the current state of a workflow execution and determines valid
 * transitions. Serializable to JSON for persistence / crash recovery.
 */

import type {
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowTransition,
} from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StateMachineStatus =
  | 'idle'
  | 'active'
  | 'waiting'
  | 'completed'
  | 'failed';

export interface ForkTracker {
  /** The fork node ID that started the parallel branch. */
  readonly forkNodeId: string;
  /** The join node ID that collects results. */
  readonly joinNodeId: string;
  /** IDs of branch-target nodes spawned from the fork. */
  readonly branchNodeIds: readonly string[];
  /** IDs of branches that have completed. */
  readonly completedBranchIds: readonly string[];
}

/** JSON-serializable snapshot of the state machine. */
export interface StateMachineSnapshot {
  readonly currentNodeId: string | null;
  readonly status: StateMachineStatus;
  readonly visitHistory: readonly string[];
  readonly activeForks: readonly ForkTracker[];
}

// ---------------------------------------------------------------------------
// State Machine
// ---------------------------------------------------------------------------

export class WorkflowStateMachine {
  private _currentNodeId: string | null = null;
  private _status: StateMachineStatus = 'idle';
  private _visitHistory: string[] = [];
  private _activeForks: ForkTracker[] = [];

  constructor(private readonly graph: WorkflowGraph) {}

  // -- Accessors ------------------------------------------------------------

  get currentNodeId(): string | null {
    return this._currentNodeId;
  }

  get currentNode(): WorkflowNode | undefined {
    if (!this._currentNodeId) return undefined;
    return this.graph.nodes.get(this._currentNodeId);
  }

  get status(): StateMachineStatus {
    return this._status;
  }

  get visitHistory(): readonly string[] {
    return this._visitHistory;
  }

  get activeForks(): readonly ForkTracker[] {
    return this._activeForks;
  }

  // -- Lifecycle ------------------------------------------------------------

  /** Start the state machine at the workflow entry node. */
  start(): WorkflowNode {
    const entryNode = this.graph.nodes.get(this.graph.entryNodeId);
    if (!entryNode) {
      throw new Error(
        `Entry node '${this.graph.entryNodeId}' not found in graph`,
      );
    }
    this._currentNodeId = entryNode.id;
    this._status = entryNode.type === 'human' ? 'waiting' : 'active';
    this._visitHistory.push(entryNode.id);
    return entryNode;
  }

  // -- Queries --------------------------------------------------------------

  /** Get all valid transitions from the current node. */
  getValidTransitions(): readonly WorkflowTransition[] {
    if (!this._currentNodeId) return [];
    return this.graph.transitions.filter(
      (t) => t.from === this._currentNodeId,
    );
  }

  /** Get the set of transition labels available from the current node. */
  getTransitionLabels(): readonly string[] {
    return this.getValidTransitions()
      .map((t) => t.label)
      .filter((l): l is string => l !== undefined);
  }

  /** Get the target nodes reachable from the current node. */
  getTargetNodes(): readonly WorkflowNode[] {
    const targets: WorkflowNode[] = [];
    for (const t of this.getValidTransitions()) {
      const node = this.graph.nodes.get(t.to);
      if (node) targets.push(node);
    }
    return targets;
  }

  /** Check whether a node is an exit node (transitions to workflow end). */
  isExitNode(nodeId: string): boolean {
    return this.graph.exitNodeIds.includes(nodeId);
  }

  /** Get a node by ID. */
  getNode(nodeId: string): WorkflowNode | undefined {
    return this.graph.nodes.get(nodeId);
  }

  // -- Transitions ----------------------------------------------------------

  /**
   * Fire a transition by label. Advances the state machine to the target node.
   *
   * @param label The transition label to follow (or undefined for unlabeled).
   * @returns The new current node.
   * @throws If no matching transition exists.
   */
  fireTransition(label?: string): WorkflowNode {
    if (!this._currentNodeId) {
      throw new Error('State machine not started');
    }

    const transitions = this.getValidTransitions();
    let match: WorkflowTransition | undefined;

    if (label !== undefined) {
      match = transitions.find((t) => t.label === label);
    } else {
      // Unlabeled: only valid if exactly one transition exists without a label
      const unlabeled = transitions.filter((t) => t.label === undefined);
      if (unlabeled.length === 1) {
        match = unlabeled[0];
      } else if (unlabeled.length === 0 && transitions.length === 1) {
        // Single labeled transition — auto-follow
        match = transitions[0];
      }
    }

    if (!match) {
      const available = transitions.map((t) => t.label ?? '(unlabeled)');
      throw new Error(
        `No matching transition for label '${label ?? '(none)'}' ` +
          `from node '${this._currentNodeId}'. ` +
          `Available: [${available.join(', ')}]`,
      );
    }

    return this.advanceTo(match.to);
  }

  /**
   * Directly advance to a specific node by ID.
   * Used by fork/join logic and manual overrides.
   */
  advanceTo(nodeId: string): WorkflowNode {
    const node = this.graph.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node '${nodeId}' not found in graph`);
    }

    this._currentNodeId = nodeId;
    this._visitHistory.push(nodeId);

    if (node.type === 'end') {
      this._status = 'completed';
    } else if (node.type === 'human') {
      this._status = 'waiting';
    } else {
      this._status = 'active';
    }

    return node;
  }

  /** Mark the machine as failed. */
  fail(): void {
    this._status = 'failed';
  }

  // -- Fork / Join ----------------------------------------------------------

  /**
   * Begin a fork: register all branch targets from the current fork node.
   * Returns the list of branch-target nodes to execute in parallel.
   */
  beginFork(): readonly WorkflowNode[] {
    if (!this._currentNodeId) {
      throw new Error('State machine not started');
    }

    const forkNode = this.currentNode;
    if (!forkNode || forkNode.type !== 'fork') {
      throw new Error(`Current node '${this._currentNodeId}' is not a fork`);
    }

    const transitions = this.getValidTransitions();
    const branchNodeIds = transitions.map((t) => t.to);

    // Find the join node — look for a node of type 'join' that all branches converge to
    const joinNodeId = this.findJoinNode(branchNodeIds);

    this._activeForks.push({
      forkNodeId: this._currentNodeId,
      joinNodeId,
      branchNodeIds,
      completedBranchIds: [],
    });

    const nodes: WorkflowNode[] = [];
    for (const id of branchNodeIds) {
      const node = this.graph.nodes.get(id);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  /**
   * Mark a fork branch as completed. If all branches done, advance to join node.
   * @returns The join node if all branches complete, undefined otherwise.
   */
  completeForkBranch(branchNodeId: string): WorkflowNode | undefined {
    const forkIdx = this._activeForks.findIndex((f) =>
      f.branchNodeIds.includes(branchNodeId),
    );
    if (forkIdx === -1) {
      throw new Error(
        `Branch node '${branchNodeId}' not found in any active fork`,
      );
    }

    const fork = this._activeForks[forkIdx]!;
    const updatedCompleted = [...fork.completedBranchIds, branchNodeId];

    this._activeForks[forkIdx] = {
      forkNodeId: fork.forkNodeId,
      joinNodeId: fork.joinNodeId,
      branchNodeIds: fork.branchNodeIds,
      completedBranchIds: updatedCompleted,
    };

    if (updatedCompleted.length === fork.branchNodeIds.length) {
      // All branches done — remove fork and advance to join
      this._activeForks.splice(forkIdx, 1);
      return this.advanceTo(fork.joinNodeId);
    }

    return undefined;
  }

  // -- Serialization --------------------------------------------------------

  /** Create a JSON-serializable snapshot. */
  snapshot(): StateMachineSnapshot {
    return {
      currentNodeId: this._currentNodeId,
      status: this._status,
      visitHistory: [...this._visitHistory],
      activeForks: this._activeForks.map((f) => ({ ...f })),
    };
  }

  /** Restore state from a snapshot. */
  restore(snap: StateMachineSnapshot): void {
    this._currentNodeId = snap.currentNodeId;
    this._status = snap.status;
    this._visitHistory = [...snap.visitHistory];
    this._activeForks = snap.activeForks.map((f) => ({
      ...f,
      completedBranchIds: [...f.completedBranchIds],
      branchNodeIds: [...f.branchNodeIds],
    }));
  }

  // -- Private helpers ------------------------------------------------------

  private findJoinNode(branchNodeIds: string[]): string {
    // Strategy: from each branch target, walk forward to find a common
    // downstream node of type 'join'. If not found, use the first node
    // that all branches eventually reach.
    const reachable = new Map<string, Set<string>>();

    for (const branchId of branchNodeIds) {
      reachable.set(branchId, this.collectReachable(branchId));
    }

    // Find nodes reachable from ALL branches
    const sets = [...reachable.values()];
    if (sets.length === 0) return '__end__';

    let common = new Set(sets[0]);
    for (let i = 1; i < sets.length; i++) {
      const currentSet = sets[i]!;
      common = new Set([...common].filter((id) => currentSet.has(id)));
    }

    // Prefer a 'join' type node
    for (const id of common) {
      const node = this.graph.nodes.get(id);
      if (node?.type === 'join') return id;
    }

    // Fallback: first common reachable node
    if (common.size > 0) return common.values().next().value!;

    // No common node found — fallback to end
    return '__end__';
  }

  private collectReachable(startId: string): Set<string> {
    const visited = new Set<string>();
    const queue = [startId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      for (const t of this.graph.transitions) {
        if (t.from === current && !visited.has(t.to)) {
          queue.push(t.to);
        }
      }
    }

    return visited;
  }
}
