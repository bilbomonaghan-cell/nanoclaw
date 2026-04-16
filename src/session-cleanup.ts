import { execFile } from 'child_process';
import path from 'path';

import { pruneTaskRunLogs } from './db.js';
import { logger } from './logger.js';

const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/cleanup-sessions.sh');

const TASK_RUN_LOG_RETENTION_DAYS = 30;

function runCleanup(): void {
  // Prune old task run logs from SQLite (keep 30 days)
  try {
    const pruned = pruneTaskRunLogs(TASK_RUN_LOG_RETENTION_DAYS);
    if (pruned > 0) {
      logger.info({ pruned }, 'Pruned old task run log entries');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to prune task run logs');
  }

  // Prune file-based artifacts (session JSONLs, debug logs, telemetry, etc.)
  execFile('/bin/bash', [SCRIPT_PATH], { timeout: 60_000 }, (err, stdout) => {
    if (err) {
      logger.error({ err }, 'Session cleanup failed');
      return;
    }
    const summary = stdout.trim().split('\n').pop();
    if (summary) logger.info(summary);
  });
}

export function startSessionCleanup(): void {
  // Run once at startup (delayed 30s to not compete with init)
  setTimeout(runCleanup, 30_000);
  // Then every 24 hours
  setInterval(runCleanup, CLEANUP_INTERVAL);
}
