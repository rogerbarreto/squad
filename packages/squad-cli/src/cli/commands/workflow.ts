/**
 * CLI Command: squad workflow
 *
 * Subcommands:
 *   list              — Show all defined workflows
 *   run <name>        — Manually execute a workflow
 *   status [exec-id]  — Show running/completed workflow status
 *   show <name>       — Display the mermaid diagram + node config
 *   history           — List past workflow executions
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { success, warn, info, dim, BOLD, RESET, YELLOW, GREEN, DIM, GRAY } from '../core/output.js';
import { fatal } from '../core/errors.js';

const WORKFLOWS_DIR = 'workflows';
const WORKFLOW_RUNS_DIR = 'workflow-runs';

// Local type — mirrors the SDK's WorkflowDef without requiring a built SDK
interface WorkflowDef {
  name: string;
  description?: string;
  diagram: string;
  graph?: { nodes: Map<string, any>; transitions: any[]; entryNodeId: string; exitNodeIds: string[] };
  trigger?: { type: string; pattern?: string; schedule?: string };
  nodeTimeoutMs?: number;
  errorStrategy?: string;
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Public entry point — called from cli-entry.ts
// ---------------------------------------------------------------------------

export interface WorkflowCommandOptions {
  dryRun?: boolean;
  context?: string;
}

export async function runWorkflow(
  cwd: string,
  action: string | undefined,
  args: string[],
  options: WorkflowCommandOptions = {},
): Promise<void> {
  switch (action) {
    case undefined:
    case 'list':
      return listWorkflows(cwd);
    case 'run':
      return runWorkflowByName(cwd, args[0], options);
    case 'status':
      return showStatus(cwd, args[0]);
    case 'show':
      return showWorkflow(cwd, args[0]);
    case 'history':
      return showHistory(cwd);
    default:
      info(`${BOLD}squad workflow${RESET} — Workflow pipeline management\n`);
      info(`Subcommands:`);
      info(`  ${BOLD}list${RESET}              Show all defined workflows`);
      info(`  ${BOLD}run <name>${RESET}        Execute a workflow`);
      info(`  ${BOLD}status [exec-id]${RESET}  Show workflow execution status`);
      info(`  ${BOLD}show <name>${RESET}       Display workflow diagram and nodes`);
      info(`  ${BOLD}history${RESET}           List past workflow executions`);
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function listWorkflows(cwd: string): Promise<void> {
  const workflows = await loadAllWorkflows(cwd);

  if (workflows.length === 0) {
    warn('No workflows defined.');
    dim(`  Create .squad/workflows/<name>.md or add workflows to squad.config.ts`);
    return;
  }

  info(`\n${BOLD}Workflows${RESET} (${workflows.length})\n`);

  for (const wf of workflows) {
    const trigger = wf.trigger
      ? `${DIM}trigger: ${wf.trigger.type}${wf.trigger.pattern ? ` (${wf.trigger.pattern})` : ''}${RESET}`
      : `${DIM}trigger: manual${RESET}`;

    const nodeCount = wf.graph ? wf.graph.nodes.size - 2 : '?'; // exclude __start__/__end__
    info(`  ${GREEN}●${RESET} ${BOLD}${wf.name}${RESET}  ${GRAY}(${nodeCount} nodes)${RESET}  ${trigger}`);

    if (wf.description) {
      dim(`    ${wf.description}`);
    }
  }
  info('');
}

async function runWorkflowByName(
  cwd: string,
  name: string | undefined,
  options: WorkflowCommandOptions,
): Promise<void> {
  if (!name) {
    fatal('Usage: squad workflow run <name> [--context "..."]');
    return;
  }

  const workflows = await loadAllWorkflows(cwd);
  const wf = workflows.find((w) => w.name === name);

  if (!wf) {
    fatal(`Workflow '${name}' not found. Run 'squad workflow list' to see available workflows.`);
    return;
  }

  info(`\n${YELLOW}▶${RESET} Starting workflow: ${BOLD}${wf.name}${RESET}`);

  if (wf.graph) {
    const nodeNames = [...wf.graph.nodes.values()]
      .filter((n) => n.type !== 'start' && n.type !== 'end')
      .map((n) => {
        const prefix =
          n.type === 'agent' ? `@${n.agentName}` :
          n.type === 'human' ? '@human' :
          n.type === 'decision' ? '⟨choice⟩' :
          n.type === 'fork' ? '⟨fork⟩' :
          n.type === 'join' ? '⟨join⟩' : n.id;
        return `${prefix}`;
      });
    dim(`  Nodes: ${nodeNames.join(' → ')}`);
  }

  if (options.context) {
    dim(`  Context: ${options.context}`);
  }

  info('');
  warn('Workflow execution requires an active Squad shell session.');
  dim('  Start the shell with `squad` and use /workflow run ' + name);
}

async function showStatus(cwd: string, execId: string | undefined): Promise<void> {
  const runsDir = path.join(cwd, '.squad', WORKFLOW_RUNS_DIR);

  if (!fs.existsSync(runsDir)) {
    info('No workflow executions found.');
    return;
  }

  const files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json'));

  if (files.length === 0) {
    info('No workflow executions found.');
    return;
  }

  if (execId) {
    const filePath = path.join(runsDir, `${execId}.json`);
    if (!fs.existsSync(filePath)) {
      fatal(`Execution '${execId}' not found.`);
      return;
    }
    const checkpoint = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    info(`\n${BOLD}Execution: ${checkpoint.executionId}${RESET}`);
    info(`  Workflow:  ${checkpoint.definitionName}`);
    info(`  Status:    ${checkpoint.status}`);
    info(`  Started:   ${checkpoint.startTime}`);
    if (checkpoint.currentNodeId) {
      info(`  Current:   ${checkpoint.currentNodeId}`);
    }
    info(`  Steps:     ${checkpoint.history?.length ?? 0} completed`);
    info('');
    return;
  }

  info(`\n${BOLD}Workflow Executions${RESET} (${files.length})\n`);
  for (const file of files.slice(-10)) {
    try {
      const checkpoint = JSON.parse(
        fs.readFileSync(path.join(runsDir, file), 'utf-8'),
      );
      const statusIcon =
        checkpoint.status === 'completed' ? `${GREEN}✓${RESET}` :
        checkpoint.status === 'failed' ? `${YELLOW}✗${RESET}` : '⏳';
      info(`  ${statusIcon} ${checkpoint.definitionName} — ${checkpoint.status} (${file.replace('.json', '')})`);
    } catch {
      dim(`  ? ${file} (corrupt)`);
    }
  }
  info('');
}

async function showWorkflow(cwd: string, name: string | undefined): Promise<void> {
  if (!name) {
    fatal('Usage: squad workflow show <name>');
    return;
  }

  const workflows = await loadAllWorkflows(cwd);
  const wf = workflows.find((w) => w.name === name);

  if (!wf) {
    fatal(`Workflow '${name}' not found.`);
    return;
  }

  info(`\n${BOLD}${wf.name}${RESET}`);
  if (wf.description) info(`${wf.description}\n`);

  info(`${BOLD}Diagram:${RESET}`);
  info(wf.diagram);

  if (wf.graph) {
    info(`\n${BOLD}Nodes:${RESET}`);
    for (const [id, node] of wf.graph.nodes) {
      if (node.type === 'start' || node.type === 'end') continue;
      const typeLabel =
        node.type === 'agent' ? `agent(@${node.agentName})` :
        node.type === 'human' ? 'human' :
        node.type === 'decision' ? 'decision' :
        node.type === 'fork' ? 'fork' :
        node.type === 'join' ? 'join' :
        node.type;
      info(`  ${BOLD}${id}${RESET} [${typeLabel}]${node.task ? ` — ${node.task}` : ''}${node.prompt ? ` — ${node.prompt}` : ''}`);
    }

    info(`\n${BOLD}Transitions:${RESET}`);
    for (const t of wf.graph.transitions) {
      if (t.from === '__start__' || t.to === '__end__') continue;
      info(`  ${t.from} → ${t.to}${t.label ? ` : ${t.label}` : ''}`);
    }
  }
  info('');
}

async function showHistory(cwd: string): Promise<void> {
  return showStatus(cwd, undefined);
}

// ---------------------------------------------------------------------------
// Workflow loading
// ---------------------------------------------------------------------------

async function loadAllWorkflows(cwd: string): Promise<WorkflowDef[]> {
  const workflows: WorkflowDef[] = [];

  // Load from .squad/workflows/*.md
  const workflowDir = path.join(cwd, '.squad', WORKFLOWS_DIR);
  try {
    const files = fs.readdirSync(workflowDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(workflowDir, file), 'utf-8');
        const name = file.replace('.md', '');
        const description = extractDescription(content);
        const diagram = extractMermaidBlock(content);
        if (diagram) {
          workflows.push({ name, description, diagram });
        }
      } catch {
        // Skip unparseable files
      }
    }
  } catch {
    // Directory doesn't exist
  }

  // Load from squad.config.ts
  const configWorkflows = await loadConfigWorkflows(cwd);
  for (const cw of configWorkflows) {
    const idx = workflows.findIndex((w) => w.name === cw.name);
    if (idx >= 0) {
      workflows[idx] = cw;
    } else {
      workflows.push(cw);
    }
  }

  return workflows;
}

function extractDescription(content: string): string | undefined {
  const match = /^#\s+.+\n+([\s\S]*?)(?=\n##\s|\n*$)/m.exec(content);
  const desc = match?.[1]?.trim();
  return desc && desc.length > 0 ? desc : undefined;
}

function extractMermaidBlock(content: string): string | undefined {
  const match = /```mermaid\s*\n([\s\S]*?)```/m.exec(content);
  return match?.[1]?.trim();
}

async function loadConfigWorkflows(cwd: string): Promise<WorkflowDef[]> {
  const candidates = ['squad.config.ts', 'squad.config.js'];

  for (const file of candidates) {
    const fullPath = path.join(cwd, file);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const url = pathToFileURL(fullPath).href;
      const mod = await import(url);
      const config = mod.default ?? mod.config;
      if (!config?.workflows) return [];

      return (config.workflows as any[]).map((wfDef: any) => ({
        name: wfDef.name,
        description: wfDef.description,
        diagram: wfDef.diagram,
        trigger: wfDef.trigger
          ? {
              type: wfDef.trigger.type,
              pattern: wfDef.trigger.pattern instanceof RegExp
                ? wfDef.trigger.pattern.source
                : wfDef.trigger.pattern,
              schedule: wfDef.trigger.schedule,
            }
          : undefined,
        nodeTimeoutMs: wfDef.nodeTimeoutMs,
        errorStrategy: wfDef.errorStrategy,
        maxRetries: wfDef.maxRetries,
      }));
    } catch {
      return [];
    }
  }

  return [];
}
