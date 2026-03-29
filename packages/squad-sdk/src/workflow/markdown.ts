/**
 * Workflow Pipeline — Markdown Format Parser
 *
 * Parses `.squad/workflows/{name}.md` files into WorkflowDefinition objects.
 *
 * Expected format:
 * ```markdown
 * # workflow-name
 *
 * Description text.
 *
 * ## Trigger
 *
 * type: message-pattern
 * pattern: review|approve|merge
 *
 * ## Diagram
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> CodeReview
 *   ...
 * ```
 * ```
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import type {
  WorkflowDefinition,
  WorkflowTrigger,
  WorkflowTriggerType,
} from './types.js';
import { parseStateDiagram } from './parser.js';
import { WORKFLOWS_DIR } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all workflow definitions from a `.squad/workflows/` directory.
 * Silently skips files that fail to parse.
 */
export async function loadWorkflowsFromDirectory(
  teamRoot: string,
): Promise<WorkflowDefinition[]> {
  const dir = join(teamRoot, WORKFLOWS_DIR);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return []; // Directory doesn't exist — no workflows
  }

  const mdFiles = files.filter((f) => extname(f) === '.md');
  const workflows: WorkflowDefinition[] = [];

  for (const file of mdFiles) {
    try {
      const content = await readFile(join(dir, file), 'utf-8');
      const definition = parseWorkflowMarkdown(content, basename(file, '.md'));
      workflows.push(definition);
    } catch {
      // Skip unparseable files
    }
  }

  return workflows;
}

/**
 * Parse a single markdown file's content into a WorkflowDefinition.
 */
export function parseWorkflowMarkdown(
  content: string,
  fallbackName?: string,
): WorkflowDefinition {
  const name = extractHeading(content) ?? fallbackName ?? 'unnamed';
  const description = extractDescription(content);
  const trigger = extractTrigger(content);
  const diagram = extractDiagram(content);

  if (!diagram) {
    throw new Error(
      `Workflow '${name}': no mermaid diagram found. ` +
        'Expected a ```mermaid code block under a ## Diagram heading.',
    );
  }

  const graph = parseStateDiagram(diagram);

  return {
    name,
    description,
    trigger,
    diagram,
    graph,
  };
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/** Extract the H1 heading as the workflow name. */
function extractHeading(content: string): string | undefined {
  const match = /^#\s+(.+)/m.exec(content);
  return match?.[1]?.trim();
}

/** Extract description text between H1 and first H2. */
function extractDescription(content: string): string | undefined {
  const match = /^#\s+.+\n+([\s\S]*?)(?=\n##\s|\n*$)/m.exec(content);
  const desc = match?.[1]?.trim();
  return desc && desc.length > 0 ? desc : undefined;
}

/** Extract trigger config from ## Trigger section. */
function extractTrigger(content: string): WorkflowTrigger | undefined {
  const sectionMatch = /^##\s+Trigger\s*\n([\s\S]*?)(?=\n##\s|\n*$)/m.exec(
    content,
  );
  if (!sectionMatch?.[1]) return undefined;

  const section = sectionMatch[1];
  const typeMatch = /^type:\s*(.+)/m.exec(section);
  if (!typeMatch?.[1]) return undefined;

  const type = typeMatch[1].trim() as WorkflowTriggerType;
  const patternMatch = /^pattern:\s*(.+)/m.exec(section);
  const scheduleMatch = /^schedule:\s*(.+)/m.exec(section);

  return {
    type,
    pattern: patternMatch?.[1]?.trim(),
    schedule: scheduleMatch?.[1]?.trim(),
  };
}

/** Extract mermaid code block from ## Diagram section. */
function extractDiagram(content: string): string | undefined {
  // Look for ```mermaid block anywhere (preferably under ## Diagram)
  const match = /```mermaid\s*\n([\s\S]*?)```/m.exec(content);
  return match?.[1]?.trim();
}
