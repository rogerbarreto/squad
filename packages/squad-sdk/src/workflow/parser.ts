/**
 * Workflow Pipeline — Mermaid stateDiagram-v2 Parser
 *
 * Parses a subset of Mermaid stateDiagram-v2 syntax into a WorkflowGraph.
 * No external dependency — we parse the line-based syntax directly.
 *
 * Supported constructs:
 *   - States:       `StateId` or `StateId : description`
 *   - Transitions:  `StateA --> StateB` or `StateA --> StateB : label`
 *   - Start/End:    `[*] --> StateA` / `StateA --> [*]`
 *   - Stereotypes:  `state Name <<choice>>`, `<<fork>>`, `<<join>>`
 *   - Composites:   `state Name { ... }` (nested)
 *   - Direction:    `direction LR` / `direction TB` (ignored — visual only)
 *   - Comments:     `%%` lines
 *   - classDef/class: ignored (visual only)
 *
 * Node-type conventions (extracted from state descriptions):
 *   - `@agentname — task`  → agent node
 *   - `@human — prompt`    → human node
 *   - No description       → inferred from stereotype or defaults to agent
 */

import type {
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowTransition,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal mutable types used during parsing
// ---------------------------------------------------------------------------

interface MutableNode {
  id: string;
  type: WorkflowNodeType;
  label?: string;
  agentName?: string;
  task?: string;
  prompt?: string;
  children?: WorkflowGraph;
}

interface ParseContext {
  nodes: Map<string, MutableNode>;
  transitions: WorkflowTransition[];
  entryTargets: string[];
  exitSources: string[];
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

const RE_DIAGRAM_HEADER = /^\s*stateDiagram(?:-v2)?\s*$/;
const RE_COMMENT = /^\s*%%/;
const RE_DIRECTION = /^\s*direction\s+(LR|RL|TB|BT)\s*$/i;
const RE_CLASSDEF = /^\s*classDef\s+/;
const RE_CLASS = /^\s*class\s+/;

// `state Name <<stereotype>>`
const RE_STEREOTYPE = /^\s*state\s+(\S+)\s+<<(\w+)>>\s*$/;

// `state "Name with spaces" as alias <<stereotype>>`  (rare but valid)
const RE_STEREOTYPE_QUOTED =
  /^\s*state\s+"([^"]+)"\s+as\s+(\S+)\s+<<(\w+)>>\s*$/;

// `state CompositeId {`   — opens a composite state
const RE_COMPOSITE_OPEN = /^\s*state\s+(\S+)\s*\{\s*$/;

// `}`  — closes a composite state
const RE_COMPOSITE_CLOSE = /^\s*\}\s*$/;

// Transition: `A --> B` or `A --> B : label`
// Also handles `[*]` for start/end pseudo-states.
const RE_TRANSITION =
  /^\s*(\[\*\]|[\w-]+)\s*-->\s*(\[\*\]|[\w-]+)(?:\s*:\s*(.+?))?\s*$/;

// State description: `StateId : description text`
const RE_STATE_DESC = /^\s*([\w-]+)\s*:\s*(.+?)\s*$/;

// Agent description pattern: `@agentname — task text` or `@agentname - task text`
const RE_AGENT_DESC = /^@(\w+)\s*[—–-]\s*(.+)$/;

// Human node pattern: `@human — prompt text`
const RE_HUMAN_DESC = /^@human\s*[—–-]\s*(.+)$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class MermaidParseError extends Error {
  constructor(
    message: string,
    public readonly line?: number,
  ) {
    super(line !== undefined ? `Line ${line}: ${message}` : message);
    this.name = 'MermaidParseError';
  }
}

/**
 * Parse a Mermaid stateDiagram-v2 string into a WorkflowGraph.
 *
 * @throws {MermaidParseError} on invalid syntax or missing entry/exit.
 */
export function parseStateDiagram(mermaidText: string): WorkflowGraph {
  const lines = mermaidText.split(/\r?\n/);
  const ctx: ParseContext = {
    nodes: new Map(),
    transitions: [],
    entryTargets: [],
    exitSources: [],
  };

  let startLine = 0;

  // Skip leading blank/comment lines and the optional `stateDiagram-v2` header
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === '' || RE_COMMENT.test(trimmed)) continue;
    if (RE_DIAGRAM_HEADER.test(trimmed)) {
      startLine = i + 1;
      break;
    }
    // No header — start parsing from the first non-blank line
    startLine = i;
    break;
  }

  parseBlock(lines, startLine, lines.length, ctx);

  // Build the immutable graph
  return buildGraph(ctx);
}

// ---------------------------------------------------------------------------
// Block parser (recursive for composites)
// ---------------------------------------------------------------------------

function parseBlock(
  lines: string[],
  start: number,
  end: number,
  ctx: ParseContext,
): void {
  let i = start;

  while (i < end) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();

    // Skip blanks, comments, direction, classDef, class
    if (
      trimmed === '' ||
      RE_COMMENT.test(trimmed) ||
      RE_DIRECTION.test(trimmed) ||
      RE_CLASSDEF.test(trimmed) ||
      RE_CLASS.test(trimmed)
    ) {
      i++;
      continue;
    }

    // Diagram header inside a block (ignore)
    if (RE_DIAGRAM_HEADER.test(trimmed)) {
      i++;
      continue;
    }

    // Composite close — shouldn't appear at top level
    if (RE_COMPOSITE_CLOSE.test(trimmed)) {
      i++;
      continue;
    }

    // Stereotype: `state Name <<choice>>`
    let match = RE_STEREOTYPE.exec(trimmed);
    if (match) {
      const stateId = match[1]!;
      const stereotype = match[2]!;
      ensureNode(ctx, stateId);
      applyStereotype(ctx.nodes.get(stateId)!, stereotype);
      i++;
      continue;
    }

    match = RE_STEREOTYPE_QUOTED.exec(trimmed);
    if (match) {
      const quotedLabel = match[1]!;
      const alias = match[2]!;
      const stereotype = match[3]!;
      ensureNode(ctx, alias);
      ctx.nodes.get(alias)!.label = quotedLabel;
      applyStereotype(ctx.nodes.get(alias)!, stereotype);
      i++;
      continue;
    }

    // Composite state: `state Name {`
    match = RE_COMPOSITE_OPEN.exec(trimmed);
    if (match) {
      const compositeId = match[1]!;
      const innerCtx: ParseContext = {
        nodes: new Map(),
        transitions: [],
        entryTargets: [],
        exitSources: [],
      };

      // Find matching closing brace
      const closeIdx = findMatchingBrace(lines, i);
      if (closeIdx === -1) {
        throw new MermaidParseError(
          `Unclosed composite state '${compositeId}'`,
          i + 1,
        );
      }

      parseBlock(lines, i + 1, closeIdx, innerCtx);
      const childGraph = buildGraph(innerCtx);

      ensureNode(ctx, compositeId);
      const node = ctx.nodes.get(compositeId)!;
      node.type = 'composite';
      node.children = childGraph;

      i = closeIdx + 1;
      continue;
    }

    // Transition: `A --> B` or `A --> B : label`
    match = RE_TRANSITION.exec(trimmed);
    if (match) {
      const fromId = normalizeStateId(match[1]!);
      const toId = normalizeStateId(match[2]!);
      const label = match[3];

      if (fromId === '[*]' && toId === '[*]') {
        throw new MermaidParseError(
          'Transition from [*] to [*] is not valid',
          i + 1,
        );
      }

      if (fromId === '[*]') {
        ctx.entryTargets.push(toId);
        ensureNode(ctx, toId);
      } else if (toId === '[*]') {
        ctx.exitSources.push(fromId);
        ensureNode(ctx, fromId);
      } else {
        ensureNode(ctx, fromId);
        ensureNode(ctx, toId);
        ctx.transitions.push({
          from: fromId,
          to: toId,
          label: label?.trim(),
        });
      }

      i++;
      continue;
    }

    // State description: `StateId : description`
    match = RE_STATE_DESC.exec(trimmed);
    if (match) {
      const stateId = match[1]!;
      const description = match[2]!;
      ensureNode(ctx, stateId);
      applyDescription(ctx.nodes.get(stateId)!, description);
      i++;
      continue;
    }

    // Bare state name (just an identifier on its own line)
    if (/^[\w-]+$/.test(trimmed)) {
      ensureNode(ctx, trimmed);
      i++;
      continue;
    }

    // Strip :::className suffix from states (visual-only)
    const strippedClass = trimmed.replace(/:::\w+/g, '');
    if (strippedClass !== trimmed) {
      // Re-parse with classes stripped
      const virtualLines = [strippedClass];
      const tmpCtx: ParseContext = {
        nodes: ctx.nodes,
        transitions: ctx.transitions,
        entryTargets: ctx.entryTargets,
        exitSources: ctx.exitSources,
      };
      parseBlock(virtualLines, 0, 1, tmpCtx);
      i++;
      continue;
    }

    // Unknown line — skip with warning (lenient parsing)
    i++;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeStateId(raw: string): string {
  return raw.trim();
}

function ensureNode(ctx: ParseContext, id: string): void {
  if (!ctx.nodes.has(id)) {
    ctx.nodes.set(id, { id, type: 'agent' });
  }
}

function applyStereotype(node: MutableNode, stereotype: string): void {
  const lower = stereotype.toLowerCase();
  if (lower === 'choice') {
    node.type = 'decision';
  } else if (lower === 'fork') {
    node.type = 'fork';
  } else if (lower === 'join') {
    node.type = 'join';
  }
}

function applyDescription(node: MutableNode, description: string): void {
  // Check for @human pattern first
  const humanMatch = RE_HUMAN_DESC.exec(description);
  if (humanMatch && humanMatch[1]) {
    node.type = 'human';
    node.prompt = humanMatch[1].trim();
    node.label = description;
    return;
  }

  // Check for @agent pattern
  const agentMatch = RE_AGENT_DESC.exec(description);
  if (agentMatch && agentMatch[1] && agentMatch[2]) {
    node.type = 'agent';
    node.agentName = agentMatch[1].toLowerCase();
    node.task = agentMatch[2].trim();
    node.label = description;
    return;
  }

  // Plain description — keep as label, type stays default
  node.label = description;
}

function findMatchingBrace(lines: string[], openIdx: number): number {
  let depth = 1;
  for (let i = openIdx + 1; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (RE_COMPOSITE_OPEN.test(trimmed)) depth++;
    if (RE_COMPOSITE_CLOSE.test(trimmed)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------

function buildGraph(ctx: ParseContext): WorkflowGraph {
  // Create synthetic start/end nodes
  const START_ID = '__start__';
  const END_ID = '__end__';

  const nodes = new Map<string, WorkflowNode>();

  // Add start node
  nodes.set(START_ID, { id: START_ID, type: 'start' });

  // Add all parsed nodes as frozen
  for (const [id, mutable] of ctx.nodes) {
    nodes.set(id, Object.freeze({ ...mutable }));
  }

  // Add end node
  nodes.set(END_ID, { id: END_ID, type: 'end' });

  // Build transitions including start/end edges
  const transitions: WorkflowTransition[] = [];

  for (const target of ctx.entryTargets) {
    transitions.push({ from: START_ID, to: target });
  }

  transitions.push(...ctx.transitions);

  for (const source of ctx.exitSources) {
    transitions.push({ from: source, to: END_ID });
  }

  // Determine entry node (first target after [*])
  if (ctx.entryTargets.length === 0) {
    throw new MermaidParseError(
      'Workflow must have at least one entry transition: [*] --> State',
    );
  }

  const entryNodeId = ctx.entryTargets[0]!;

  // Exit nodes are those that transition to [*]
  const exitNodeIds =
    ctx.exitSources.length > 0 ? ctx.exitSources : [END_ID];

  return Object.freeze({
    nodes,
    transitions: Object.freeze(transitions),
    entryNodeId,
    exitNodeIds: Object.freeze(exitNodeIds),
  });
}
