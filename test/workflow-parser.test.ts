import { describe, it, expect } from 'vitest';
import {
  parseStateDiagram,
  MermaidParseError,
} from '../packages/squad-sdk/src/workflow/parser.js';
import { WorkflowStateMachine } from '../packages/squad-sdk/src/workflow/state-machine.js';

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

describe('parseStateDiagram', () => {
  it('parses a simple linear workflow', () => {
    const graph = parseStateDiagram(`
      stateDiagram-v2
        [*] --> A
        A --> B
        B --> C
        C --> [*]
    `);

    expect(graph.entryNodeId).toBe('A');
    expect(graph.exitNodeIds).toContain('C');
    expect(graph.nodes.size).toBe(5); // __start__, A, B, C, __end__
    expect(graph.transitions).toHaveLength(4); // start→A, A→B, B→C, C→end
  });

  it('extracts @agent node type from description', () => {
    const graph = parseStateDiagram(`
      stateDiagram-v2
        [*] --> CodeReview
        CodeReview : @edie — Review TypeScript code quality
        CodeReview --> [*]
    `);

    const node = graph.nodes.get('CodeReview');
    expect(node).toBeDefined();
    expect(node!.type).toBe('agent');
    expect(node!.agentName).toBe('edie');
    expect(node!.task).toBe('Review TypeScript code quality');
  });

  it('extracts @human node type from description', () => {
    const graph = parseStateDiagram(`
      stateDiagram-v2
        [*] --> Approval
        Approval : @human — Approve the changes for merge?
        Approval --> [*]
    `);

    const node = graph.nodes.get('Approval');
    expect(node).toBeDefined();
    expect(node!.type).toBe('human');
    expect(node!.prompt).toBe('Approve the changes for merge?');
  });

  it('parses choice nodes with <<choice>> stereotype', () => {
    const graph = parseStateDiagram(`
      stateDiagram-v2
        [*] --> Review
        Review --> QualityCheck
        state QualityCheck <<choice>>
        QualityCheck --> Pass : pass
        QualityCheck --> Fail : fail
        Pass --> [*]
        Fail --> [*]
    `);

    const node = graph.nodes.get('QualityCheck');
    expect(node).toBeDefined();
    expect(node!.type).toBe('decision');

    const transitions = graph.transitions.filter(
      (t) => t.from === 'QualityCheck',
    );
    expect(transitions).toHaveLength(2);
    expect(transitions.map((t) => t.label).sort()).toEqual(['fail', 'pass']);
  });

  it('parses fork and join nodes', () => {
    const graph = parseStateDiagram(`
      stateDiagram-v2
        [*] --> ParallelStart
        state ParallelStart <<fork>>
        ParallelStart --> TaskA
        ParallelStart --> TaskB
        TaskA --> ParallelEnd
        TaskB --> ParallelEnd
        state ParallelEnd <<join>>
        ParallelEnd --> [*]
    `);

    expect(graph.nodes.get('ParallelStart')!.type).toBe('fork');
    expect(graph.nodes.get('ParallelEnd')!.type).toBe('join');
  });

  it('parses composite states as sub-workflows', () => {
    const graph = parseStateDiagram(`
      stateDiagram-v2
        [*] --> ReviewPhase
        state ReviewPhase {
          [*] --> Check
          Check --> Validate
          Validate --> [*]
        }
        ReviewPhase --> [*]
    `);

    const composite = graph.nodes.get('ReviewPhase');
    expect(composite).toBeDefined();
    expect(composite!.type).toBe('composite');
    expect(composite!.children).toBeDefined();
    expect(composite!.children!.nodes.size).toBe(4); // __start__, Check, Validate, __end__
    expect(composite!.children!.entryNodeId).toBe('Check');
  });

  it('handles transition labels correctly', () => {
    const graph = parseStateDiagram(`
      stateDiagram-v2
        [*] --> A
        A --> B : success
        A --> C : failure
        B --> [*]
        C --> [*]
    `);

    const fromA = graph.transitions.filter((t) => t.from === 'A');
    expect(fromA).toHaveLength(2);
    expect(fromA.find((t) => t.to === 'B')!.label).toBe('success');
    expect(fromA.find((t) => t.to === 'C')!.label).toBe('failure');
  });

  it('handles cycles (loops back to earlier node)', () => {
    const graph = parseStateDiagram(`
      stateDiagram-v2
        [*] --> Review
        Review --> Fix
        Fix --> Review
        Review --> Done
        Done --> [*]
    `);

    // Should have a cycle: Review → Fix → Review
    const reviewToFix = graph.transitions.find(
      (t) => t.from === 'Review' && t.to === 'Fix',
    );
    const fixToReview = graph.transitions.find(
      (t) => t.from === 'Fix' && t.to === 'Review',
    );
    expect(reviewToFix).toBeDefined();
    expect(fixToReview).toBeDefined();
  });

  it('disambiguates same agent at multiple nodes', () => {
    const graph = parseStateDiagram(`
      stateDiagram-v2
        [*] --> EarlyReview
        EarlyReview : @edie — Quick syntax check
        EarlyReview --> Process
        Process --> FinalReview
        FinalReview : @edie — Deep architecture review
        FinalReview --> [*]
    `);

    const early = graph.nodes.get('EarlyReview')!;
    const final = graph.nodes.get('FinalReview')!;

    // Same agent, different nodes with unique IDs
    expect(early.agentName).toBe('edie');
    expect(final.agentName).toBe('edie');
    expect(early.task).toBe('Quick syntax check');
    expect(final.task).toBe('Deep architecture review');
    expect(early.id).not.toBe(final.id);
  });

  it('throws on missing entry transition', () => {
    expect(() =>
      parseStateDiagram(`
        stateDiagram-v2
          A --> B
          B --> [*]
      `),
    ).toThrow(MermaidParseError);
  });

  it('throws on [*] --> [*] transition', () => {
    expect(() =>
      parseStateDiagram(`
        stateDiagram-v2
          [*] --> [*]
      `),
    ).toThrow('not valid');
  });

  it('ignores comments, direction, classDef, and class lines', () => {
    const graph = parseStateDiagram(`
      stateDiagram-v2
        direction LR
        classDef human fill:#ffd700
        class Approval human
        %% This is a comment
        [*] --> Approval
        Approval : @human — Approve?
        Approval --> [*]
    `);

    expect(graph.nodes.get('Approval')!.type).toBe('human');
  });

  it('works without stateDiagram-v2 header', () => {
    const graph = parseStateDiagram(`
      [*] --> A
      A --> [*]
    `);
    expect(graph.entryNodeId).toBe('A');
  });

  it('handles em-dash, en-dash, and hyphen in agent descriptions', () => {
    const graph1 = parseStateDiagram(`
      stateDiagram-v2
        [*] --> A
        A : @edie — task with em-dash
        A --> [*]
    `);
    expect(graph1.nodes.get('A')!.agentName).toBe('edie');

    const graph2 = parseStateDiagram(`
      stateDiagram-v2
        [*] --> A
        A : @edie – task with en-dash
        A --> [*]
    `);
    expect(graph2.nodes.get('A')!.agentName).toBe('edie');

    const graph3 = parseStateDiagram(`
      stateDiagram-v2
        [*] --> A
        A : @edie - task with hyphen
        A --> [*]
    `);
    expect(graph3.nodes.get('A')!.agentName).toBe('edie');
  });
});

// ---------------------------------------------------------------------------
// State Machine tests
// ---------------------------------------------------------------------------

describe('WorkflowStateMachine', () => {
  function createLinearGraph() {
    return parseStateDiagram(`
      stateDiagram-v2
        [*] --> A
        A --> B
        B --> C
        C --> [*]
    `);
  }

  function createChoiceGraph() {
    return parseStateDiagram(`
      stateDiagram-v2
        [*] --> Review
        Review --> Gate
        state Gate <<choice>>
        Gate --> Approve : pass
        Gate --> Fix : fail
        Fix --> Review
        Approve --> [*]
    `);
  }

  function createForkJoinGraph() {
    return parseStateDiagram(`
      stateDiagram-v2
        [*] --> Start
        Start --> Fork1
        state Fork1 <<fork>>
        Fork1 --> BranchA
        Fork1 --> BranchB
        BranchA --> Join1
        BranchB --> Join1
        state Join1 <<join>>
        Join1 --> [*]
    `);
  }

  it('starts at the entry node', () => {
    const sm = new WorkflowStateMachine(createLinearGraph());
    const entry = sm.start();
    expect(entry.id).toBe('A');
    expect(sm.status).toBe('active');
  });

  it('follows unlabeled transitions in linear flow', () => {
    const sm = new WorkflowStateMachine(createLinearGraph());
    sm.start();

    const b = sm.fireTransition();
    expect(b.id).toBe('B');

    const c = sm.fireTransition();
    expect(c.id).toBe('C');

    expect(sm.visitHistory).toEqual(['A', 'B', 'C']);
  });

  it('gets valid transitions from current node', () => {
    const sm = new WorkflowStateMachine(createChoiceGraph());
    sm.start(); // Review
    sm.fireTransition(); // → Gate

    const labels = sm.getTransitionLabels();
    expect(labels).toContain('pass');
    expect(labels).toContain('fail');
  });

  it('fires labeled transitions at choice nodes', () => {
    const sm = new WorkflowStateMachine(createChoiceGraph());
    sm.start(); // Review
    sm.fireTransition(); // → Gate

    const approve = sm.fireTransition('pass');
    expect(approve.id).toBe('Approve');
  });

  it('follows cycle path (fix → review → gate → fix)', () => {
    const sm = new WorkflowStateMachine(createChoiceGraph());
    sm.start(); // Review
    sm.fireTransition(); // → Gate
    sm.fireTransition('fail'); // → Fix
    sm.fireTransition(); // → Review (cycle!)

    expect(sm.currentNodeId).toBe('Review');
    expect(sm.visitHistory).toEqual([
      'Review',
      'Gate',
      'Fix',
      'Review',
    ]);
  });

  it('throws when firing non-existent transition label', () => {
    const sm = new WorkflowStateMachine(createChoiceGraph());
    sm.start();
    sm.fireTransition(); // → Gate

    expect(() => sm.fireTransition('nonexistent')).toThrow(
      'No matching transition',
    );
  });

  it('throws when not started', () => {
    const sm = new WorkflowStateMachine(createLinearGraph());
    expect(() => sm.fireTransition()).toThrow('not started');
  });

  it('begins fork and tracks branches', () => {
    const sm = new WorkflowStateMachine(createForkJoinGraph());
    sm.start(); // Start
    sm.fireTransition(); // → Fork1

    const branches = sm.beginFork();
    expect(branches).toHaveLength(2);
    expect(branches.map((b) => b.id).sort()).toEqual(['BranchA', 'BranchB']);
    expect(sm.activeForks).toHaveLength(1);
  });

  it('completes fork branches and advances to join', () => {
    const sm = new WorkflowStateMachine(createForkJoinGraph());
    sm.start();
    sm.fireTransition(); // → Fork1
    sm.beginFork();

    // Complete first branch — no join yet
    const partial = sm.completeForkBranch('BranchA');
    expect(partial).toBeUndefined();

    // Complete second branch — should advance to join
    const joinNode = sm.completeForkBranch('BranchB');
    expect(joinNode).toBeDefined();
    expect(joinNode!.type).toBe('join');
    expect(sm.activeForks).toHaveLength(0);
  });

  it('serializes and restores via snapshot', () => {
    const graph = createChoiceGraph();
    const sm = new WorkflowStateMachine(graph);
    sm.start();
    sm.fireTransition(); // → Gate

    const snap = sm.snapshot();
    expect(snap.currentNodeId).toBe('Gate');
    expect(snap.status).toBe('active');
    expect(snap.visitHistory).toEqual(['Review', 'Gate']);

    // Restore into a fresh machine
    const sm2 = new WorkflowStateMachine(graph);
    sm2.restore(snap);
    expect(sm2.currentNodeId).toBe('Gate');
    expect(sm2.status).toBe('active');

    // Should be able to continue
    const approve = sm2.fireTransition('pass');
    expect(approve.id).toBe('Approve');
  });

  it('marks status as completed when reaching end node', () => {
    const sm = new WorkflowStateMachine(createLinearGraph());
    sm.start();
    sm.fireTransition(); // B
    sm.fireTransition(); // C

    // C is an exit node — advance to __end__ to complete
    sm.advanceTo('__end__');
    expect(sm.status).toBe('completed');
  });

  it('marks status as waiting on human nodes', () => {
    const graph = parseStateDiagram(`
      stateDiagram-v2
        [*] --> Approval
        Approval : @human — Approve?
        Approval --> [*]
    `);
    const sm = new WorkflowStateMachine(graph);
    sm.start();
    expect(sm.status).toBe('waiting');
  });

  it('marks status as failed', () => {
    const sm = new WorkflowStateMachine(createLinearGraph());
    sm.start();
    sm.fail();
    expect(sm.status).toBe('failed');
  });

  it('getNode returns node by id', () => {
    const sm = new WorkflowStateMachine(createLinearGraph());
    const nodeA = sm.getNode('A');
    expect(nodeA).toBeDefined();
    expect(nodeA!.id).toBe('A');
  });

  it('getTargetNodes returns reachable nodes', () => {
    const graph = createChoiceGraph();
    const sm = new WorkflowStateMachine(graph);
    sm.start();
    sm.fireTransition(); // → Gate

    const targets = sm.getTargetNodes();
    expect(targets.map((t) => t.id).sort()).toEqual(['Approve', 'Fix']);
  });
});

// ---------------------------------------------------------------------------
// Integration: parser → state machine
// ---------------------------------------------------------------------------

describe('Parser → StateMachine integration', () => {
  it('runs a full workflow: review → decision → approve → merge', () => {
    const graph = parseStateDiagram(`
      stateDiagram-v2
        [*] --> CodeReview
        CodeReview : @edie — Review code quality
        CodeReview --> QualityCheck
        state QualityCheck <<choice>>
        QualityCheck --> LeadApproval : pass
        QualityCheck --> BugFix : fail
        BugFix : @fenster — Fix identified issues
        BugFix --> CodeReview
        LeadApproval : @human — Approve the changes?
        LeadApproval --> Merge : approved
        LeadApproval --> CodeReview : rejected
        Merge : @kobayashi — Merge to main
        Merge --> [*]
    `);

    const sm = new WorkflowStateMachine(graph);

    // Step 1: Start at CodeReview
    const review = sm.start();
    expect(review.id).toBe('CodeReview');
    expect(review.agentName).toBe('edie');

    // Step 2: Advance to QualityCheck (decision)
    const gate = sm.fireTransition();
    expect(gate.type).toBe('decision');

    // Step 3: Decision says "pass"
    const approval = sm.fireTransition('pass');
    expect(approval.type).toBe('human');
    expect(approval.prompt).toBe('Approve the changes?');
    expect(sm.status).toBe('waiting');

    // Step 4: Human approves
    const merge = sm.fireTransition('approved');
    expect(merge.agentName).toBe('kobayashi');

    // Step 5: Merge completes → end
    expect(sm.isExitNode('Merge')).toBe(true);
  });
});
