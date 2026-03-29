/**
 * Workflow Pipeline — File-based Persistence
 *
 * Saves/loads workflow execution checkpoints to `.squad/workflow-runs/`.
 * Each execution gets a `{executionId}.json` file. Completed runs are
 * cleaned up; old runs are pruned after 30 days.
 */

import { mkdir, readFile, writeFile, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowCheckpoint } from './types.js';
import { WORKFLOW_RUNS_DIR } from './types.js';
import type { WorkflowPersistence } from './engine.js';

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class FileWorkflowPersistence implements WorkflowPersistence {
  private readonly dir: string;

  constructor(teamRoot: string) {
    this.dir = join(teamRoot, WORKFLOW_RUNS_DIR);
  }

  async saveCheckpoint(checkpoint: WorkflowCheckpoint): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const filePath = this.filePath(checkpoint.executionId);
    await writeFile(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');
  }

  async loadCheckpoint(executionId: string): Promise<WorkflowCheckpoint | null> {
    try {
      const content = await readFile(this.filePath(executionId), 'utf-8');
      return JSON.parse(content) as WorkflowCheckpoint;
    } catch {
      return null;
    }
  }

  async deleteCheckpoint(executionId: string): Promise<void> {
    try {
      await unlink(this.filePath(executionId));
    } catch {
      // File may not exist
    }
  }

  /** List all active (non-completed) checkpoint IDs. */
  async listActive(): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }

    const ids: string[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const checkpoint = await this.loadCheckpoint(
          file.replace('.json', ''),
        );
        if (
          checkpoint &&
          checkpoint.status !== 'completed' &&
          checkpoint.status !== 'failed' &&
          checkpoint.status !== 'cancelled'
        ) {
          ids.push(checkpoint.executionId);
        }
      } catch {
        // Skip corrupt files
      }
    }
    return ids;
  }

  /** Remove checkpoint files older than 30 days. */
  async pruneOld(): Promise<number> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return 0;
    }

    let pruned = 0;
    const cutoff = Date.now() - MAX_AGE_MS;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const filePath = join(this.dir, file);
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs < cutoff) {
          await unlink(filePath);
          pruned++;
        }
      } catch {
        // Skip errors
      }
    }
    return pruned;
  }

  private filePath(executionId: string): string {
    return join(this.dir, `${executionId}.json`);
  }
}
