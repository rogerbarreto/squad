import { describe, it, expect, vi } from 'vitest';
import { parseStateDiagram } from '../packages/squad-sdk/src/workflow/parser.js';
import { WorkflowEngine } from '../packages/squad-sdk/src/workflow/engine.js';
import { EventBus } from '../packages/squad-sdk/src/client/event-bus.js';
import type {
  WorkflowDefinition,
  WorkflowNodeExecution,
} from '../packages/squad-sdk/src/workflow/types.js';
import type { ExecutorDependencies } from '../packages/squad-sdk/src/workflow/executors.js';

// ---------------------------------------------------------------------------
// Mock dependencies factory
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<ExecutorDependencies>): ExecutorDependencies {
  return {
    spawnAgent: vi.fn().mockResolvedValue({
      sessionId: 'mock-session',
      output: 'Agent completed task.',
    }),
    promptHuman: vi.fn().mockResolvedValue({
      choice: 'approved',
      comment: 'Looks good.',
    }),
    evaluateDecision: vi.fn().mockResolvedValue('pass'),
    eventBus: new EventBus(),
    ...overrides,
  };
}

function createDefinition(diagram: string, name = 'test-workflow'): WorkflowDefinition {
  return {
    name,
    diagram,
    graph: parseStateDiagram(diagram),
  };
}

// ---------------------------------------------------------------------------
// Engine tests
// ---------------------------------------------------------------------------

describe('WorkflowEngine', () => {
  it('executes a linear workflow in order', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine({ deps, eventBus: deps.eventBus });

    const def = createDefinition(`
      stateDiagram-v2
        [*] --> A
        A : @edie — Review code
        A --> B
        B : @fenster — Fix bugs
        B --> [*]
    `);

    const result = await engine.execute(def);

    expect(result.status).toBe('completed');
    expect(result.history).toHaveLength(2);
    expect(result.history[0]!.nodeId).toBe('A');
    expect(result.history[0]!.agentName).toBe('edie');
    expect(result.history[1]!.nodeId).toBe('B');
    expect(result.history[1]!.agentName).toBe('fenster');
    expect(deps.spawnAgent).toHaveBeenCalledTimes(2);
  });

  it('handles choice nodes via orchestrator evaluation', async () => {
    const deps = createMockDeps({
      evaluateDecision: vi.fn().mockResolvedValue('pass'),
    });
    const engine = new WorkflowEngine({ deps, eventBus: deps.eventBus });

    const def = createDefinition(`
      stateDiagram-v2
        [*] --> Review
        Review : @edie — Review code
        Review --> Gate
        state Gate <<choice>>
        Gate --> Done : pass
        Gate --> Fix : fail
        Done : @kobayashi — Merge
        Done --> [*]
        Fix : @fenster — Fix issues
        Fix --> [*]
    `);

    const result = await engine.execute(def);

    expect(result.status).toBe('completed');
    expect(deps.evaluateDecision).toHaveBeenCalledTimes(1);
    // Should have gone: Review → Gate (decision) → Done
    const nodeIds = result.history.map((h) => h.nodeId);
    expect(nodeIds).toContain('Review');
    expect(nodeIds).toContain('Gate');
    expect(nodeIds).toContain('Done');
    expect(nodeIds).not.toContain('Fix');
  });

  it('handles human-in-the-loop nodes', async () => {
    const deps = createMockDeps({
      promptHuman: vi.fn().mockResolvedValue({
        choice: 'approved',
        comment: 'Ship it!',
      }),
    });
    const engine = new WorkflowEngine({ deps, eventBus: deps.eventBus });

    const def = createDefinition(`
      stateDiagram-v2
        [*] --> Approval
        Approval : @human — Approve the changes?
        Approval --> Merge : approved
        Approval --> Revise : rejected
        Merge : @kobayashi — Merge to main
        Merge --> [*]
        Revise : @fenster — Revise code
        Revise --> [*]
    `);

    const result = await engine.execute(def);

    expect(result.status).toBe('completed');
    expect(deps.promptHuman).toHaveBeenCalledTimes(1);
    expect(deps.promptHuman).toHaveBeenCalledWith(
      'Approve the changes?',
      expect.arrayContaining(['approved', 'rejected']),
    );
    const nodeIds = result.history.map((h) => h.nodeId);
    expect(nodeIds).toContain('Approval');
    expect(nodeIds).toContain('Merge');
  });

  it('handles fork/join parallel execution', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine({ deps, eventBus: deps.eventBus });

    const def = createDefinition(`
      stateDiagram-v2
        [*] --> Start
        Start : @keaton — Plan work
        Start --> Fork1
        state Fork1 <<fork>>
        Fork1 --> BranchA
        Fork1 --> BranchB
        BranchA : @edie — Review TypeScript
        BranchB : @fenster — Run tests
        BranchA --> Join1
        BranchB --> Join1
        state Join1 <<join>>
        Join1 --> [*]
    `);

    const result = await engine.execute(def);

    expect(result.status).toBe('completed');
    // Start + Fork + Join = at minimum 3 entries, plus branches
    expect(deps.spawnAgent).toHaveBeenCalledTimes(3); // Start + BranchA + BranchB
  });

  it('follows cycle: fail → fix → review again', async () => {
    let callCount = 0;
    const deps = createMockDeps({
      evaluateDecision: vi.fn().mockImplementation(() => {
        callCount++;
        // First time: fail; second time: pass
        return callCount === 1 ? 'fail' : 'pass';
      }),
    });
    const engine = new WorkflowEngine({ deps, eventBus: deps.eventBus });

    const def = createDefinition(`
      stateDiagram-v2
        [*] --> Review
        Review : @edie — Review code
        Review --> Gate
        state Gate <<choice>>
        Gate --> Done : pass
        Gate --> Fix : fail
        Fix : @fenster — Fix issues
        Fix --> Review
        Done : @kobayashi — Ship it
        Done --> [*]
    `);

    const result = await engine.execute(def);

    expect(result.status).toBe('completed');
    // Should have gone: Review → Gate(fail) → Fix → Review → Gate(pass) → Done
    const nodeIds = result.history.map((h) => h.nodeId);
    expect(nodeIds.filter((id) => id === 'Review')).toHaveLength(2);
    expect(nodeIds).toContain('Fix');
    expect(nodeIds).toContain('Done');
  });

  it('fails on agent spawn error with fail strategy', async () => {
    const deps = createMockDeps({
      spawnAgent: vi.fn().mockRejectedValue(new Error('Agent crashed')),
    });
    const engine = new WorkflowEngine({ deps, eventBus: deps.eventBus });

    const def = createDefinition(`
      stateDiagram-v2
        [*] --> Broken
        Broken : @edie — This will fail
        Broken --> [*]
    `);

    const result = await engine.execute(def);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Agent crashed');
    expect(result.history).toHaveLength(1);
    expect(result.history[0]!.status).toBe('failed');
  });

  it('emits workflow events throughout execution', async () => {
    const eventBus = new EventBus();
    const events: string[] = [];
    eventBus.onAny((event) => {
      events.push(event.type);
    });

    const deps = createMockDeps({ eventBus });
    const engine = new WorkflowEngine({ deps, eventBus });

    const def = createDefinition(`
      stateDiagram-v2
        [*] --> A
        A : @edie — Do work
        A --> [*]
    `);

    await engine.execute(def);

    expect(events).toContain('workflow.started');
    expect(events).toContain('workflow.node_started');
    expect(events).toContain('workflow.node_completed');
    expect(events).toContain('workflow.completed');
  });

  it('persists checkpoints when persistence is provided', async () => {
    const mockPersistence = {
      saveCheckpoint: vi.fn().mockResolvedValue(undefined),
      loadCheckpoint: vi.fn().mockResolvedValue(null),
      deleteCheckpoint: vi.fn().mockResolvedValue(undefined),
    };

    const deps = createMockDeps();
    const engine = new WorkflowEngine({
      deps,
      eventBus: deps.eventBus,
      persistence: mockPersistence,
    });

    const def = createDefinition(`
      stateDiagram-v2
        [*] --> A
        A : @edie — Work
        A --> B
        B : @fenster — More work
        B --> [*]
    `);

    const result = await engine.execute(def);

    expect(result.status).toBe('completed');
    // Should save checkpoint after each node
    expect(mockPersistence.saveCheckpoint).toHaveBeenCalledTimes(2);
    // Should delete checkpoint on completion
    expect(mockPersistence.deleteCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('passes trigger context to agent spawns', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine({ deps, eventBus: deps.eventBus });

    const def = createDefinition(`
      stateDiagram-v2
        [*] --> A
        A : @edie — Review PR
        A --> [*]
    `);

    await engine.execute(def, 'PR #42: Add login feature');

    expect(deps.spawnAgent).toHaveBeenCalledWith(
      'edie',
      'Review PR',
      'PR #42: Add login feature',
    );
  });
});
