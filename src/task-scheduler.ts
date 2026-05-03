import { ChildProcess, exec } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  deleteTask,
  getAllTasks,
  getDueTasks,
  getRecentTaskRunLogs,
  getTaskById,
  incrementTaskRunCount,
  logTaskRun,
  setRetryAttempt,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

const SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Retry backoff delays for failed tasks.
 * attempt=1 → 60s, attempt=2 → 300s, attempt=3+ → 1800s (cap)
 */
export function retryDelayMs(attempt: number): number {
  if (attempt <= 1) return 60_000;
  if (attempt === 2) return 300_000;
  return 1_800_000;
}

export interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

/**
 * Run a task's pre-flight script on the host.
 * Returns { wakeAgent: true/false, data } parsed from stdout JSON.
 * On error, defaults to wakeAgent: true so the task still runs.
 */
export async function runScript(
  script: string,
  taskId: string,
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    exec(
      script,
      { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          logger.warn(
            { taskId, error: err.message, stderr },
            'Task pre-flight script failed — running agent anyway',
          );
          resolve({ wakeAgent: true });
          return;
        }

        const output = stdout.trim();
        if (!output) {
          logger.warn(
            { taskId },
            'Task pre-flight script produced no output — running agent anyway',
          );
          resolve({ wakeAgent: true });
          return;
        }

        try {
          const parsed = JSON.parse(output) as ScriptResult;
          if (typeof parsed.wakeAgent !== 'boolean') {
            logger.warn(
              { taskId, output },
              'Script output missing wakeAgent boolean — running agent anyway',
            );
            resolve({ wakeAgent: true });
            return;
          }
          logger.info(
            { taskId, wakeAgent: parsed.wakeAgent },
            'Task pre-flight script result',
          );
          resolve(parsed);
        } catch {
          logger.warn(
            { taskId, output },
            'Failed to parse script output as JSON — running agent anyway',
          );
          resolve({ wakeAgent: true });
        }
      },
    );
  });
}

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      name: t.name || undefined,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      context_mode: t.context_mode,
      status: t.status,
      next_run: t.next_run,
      last_run: t.last_run,
      last_result: t.last_result,
      created_at: t.created_at,
      notify_on_success: t.notify_on_success ?? false,
      max_runs: t.max_runs ?? null,
      run_count: t.run_count ?? 0,
      retry_on_failure: t.retry_on_failure ?? 0,
      retry_attempt: t.retry_attempt ?? 0,
      timeout_minutes: t.timeout_minutes ?? null,
      task_env: t.task_env ?? null,
      recent_runs: getRecentTaskRunLogs(t.id, 5).map((r) => ({
        id: r.id,
        run_at: r.run_at,
        duration_ms: r.duration_ms,
        status: r.status,
        error: r.error,
      })),
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // Run the pre-flight script (if any) before spinning up a container.
  // If the script returns wakeAgent: false, skip the container run entirely.
  if (task.script) {
    const scriptResult = await runScript(task.script, task.id);
    if (!scriptResult.wakeAgent) {
      logger.info(
        { taskId: task.id, group: task.group_folder },
        'Task pre-flight script returned wakeAgent: false — skipping agent run',
      );
      const nextRun = computeNextRun(task);
      updateTaskAfterRun(task.id, nextRun, 'Script: skipped (wakeAgent=false)');
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'success',
        result: 'Skipped by pre-flight script',
        error: null,
      });
      return;
    }

    // Append script data to prompt so the agent has context
    if (scriptResult.data !== undefined) {
      const dataJson = JSON.stringify(scriptResult.data, null, 2);
      task = {
        ...task,
        prompt: `${task.prompt}\n\n[Pre-flight script data]\n\`\`\`json\n${dataJson}\n\`\`\``,
      };
      logger.debug(
        { taskId: task.id, dataSize: dataJson.length },
        'Appended script data to task prompt',
      );
    }
  }

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    // Parse per-task env vars (stored as JSON string)
    let taskExtraEnv: Record<string, string> | undefined;
    if (task.task_env) {
      try {
        taskExtraEnv = JSON.parse(task.task_env) as Record<string, string>;
      } catch {
        logger.warn({ taskId: task.id }, 'Failed to parse task_env JSON — ignoring');
      }
    }

    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        timeoutOverrideMs: task.timeout_minutes
          ? task.timeout_minutes * 60_000
          : undefined,
        extraEnv: taskExtraEnv,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  // --- Retry-on-failure logic ---
  // When a task fails and retry_on_failure > 0, schedule a quick retry instead
  // of immediately moving to the next cron window and notifying the group.
  // After all retries are exhausted, fall through to the normal failure path.
  if (error) {
    const maxRetries = task.retry_on_failure ?? 0;
    const currentAttempt = task.retry_attempt ?? 0;

    if (maxRetries > 0 && currentAttempt < maxRetries) {
      // Schedule a retry after a short backoff delay
      const nextAttempt = currentAttempt + 1;
      const delayMs = retryDelayMs(nextAttempt);
      const retryAt = new Date(Date.now() + delayMs).toISOString();

      setRetryAttempt(task.id, nextAttempt);
      updateTaskAfterRun(
        task.id,
        retryAt,
        `Retry ${nextAttempt}/${maxRetries}: ${error.slice(0, 100)}`,
      );

      const shortId = task.id.slice(-12);
      const errMsg = error.length > 100 ? error.slice(0, 100) + '…' : error;
      const delaySec = Math.round(delayMs / 1000);
      await deps
        .sendMessage(
          task.chat_jid,
          `⏱️ Task [${shortId}] failed (attempt ${nextAttempt}/${maxRetries + 1}), retrying in ${delaySec}s: ${errMsg}`,
        )
        .catch((notifyErr) => {
          logger.warn(
            { taskId: task.id, notifyErr },
            'Failed to send task retry notification',
          );
        });

      logger.info(
        { taskId: task.id, nextAttempt, maxRetries, retryAt },
        'Task scheduled for retry',
      );

      // Skip normal post-run handling — don't advance the cron window yet
      return;
    }

    // All retries exhausted (or no retries configured) — reset attempt counter
    if (currentAttempt > 0) {
      setRetryAttempt(task.id, 0);
    }
  }
  // --- End retry logic ---

  // On success, reset the retry attempt counter if it was non-zero
  if (!error && (task.retry_attempt ?? 0) > 0) {
    setRetryAttempt(task.id, 0);
  }

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);

  // Notify the group on task failure so silent errors surface in the chat
  if (error) {
    const shortId = task.id.slice(-12);
    const errMsg = error.length > 150 ? error.slice(0, 150) + '…' : error;
    const nextRunMsg = nextRun
      ? ` Next attempt: ${nextRun.slice(0, 16).replace('T', ' ')} UTC`
      : '';
    const retryExhaustedNote =
      (task.retry_on_failure ?? 0) > 0 ? ' (all retries exhausted)' : '';
    await deps
      .sendMessage(
        task.chat_jid,
        `⚠️ Task [${shortId}] failed${retryExhaustedNote}: ${errMsg}${nextRunMsg}`,
      )
      .catch((notifyErr) => {
        logger.warn(
          { taskId: task.id, notifyErr },
          'Failed to send task error notification',
        );
      });
  }

  // Optionally notify the group on task success
  if (!error && task.notify_on_success) {
    const shortId = task.id.slice(-12);
    const durationSec = Math.round(durationMs / 1000);
    await deps
      .sendMessage(
        task.chat_jid,
        `✅ Task [${shortId}] completed in ${durationSec}s`,
      )
      .catch((notifyErr) => {
        logger.warn(
          { taskId: task.id, notifyErr },
          'Failed to send task success notification',
        );
      });
  }

  // Enforce max_runs: increment the run counter on success and auto-cancel
  // when the limit is reached. Errors don't count toward the limit.
  if (!error && task.max_runs != null && task.max_runs > 0) {
    const newCount = incrementTaskRunCount(task.id);
    if (newCount >= task.max_runs) {
      logger.info(
        { taskId: task.id, newCount, max_runs: task.max_runs },
        'Task reached max_runs limit — auto-cancelling',
      );
      deleteTask(task.id);
      const shortId = task.id.slice(-12);
      await deps
        .sendMessage(
          task.chat_jid,
          `🏁 Task [${task.name ? `${task.name} / ` : ''}${shortId}] completed all ${task.max_runs} scheduled run${task.max_runs === 1 ? '' : 's'} and has been removed.`,
        )
        .catch((notifyErr) => {
          logger.warn(
            { taskId: task.id, notifyErr },
            'Failed to send max_runs completion notification',
          );
        });
    }
  }
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
