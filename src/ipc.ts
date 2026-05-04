import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteAllTasks,
  deleteTask,
  getChatStats,
  getRecentMessages,
  getTaskById,
  getTaskHistory,
  getTaskRunLogById,
  getTaskStats,
  searchMessages,
  setAllTasksStatus,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    script?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For search_messages / get_recent_messages
    queryId?: string;
    query?: string;
    searchLimit?: number;
    fromDays?: number;
    includeBotMessages?: boolean;
    recentLimit?: number;
    recentFromDays?: number;
    // For schedule_task / update_task
    notifyOnSuccess?: boolean | string;
    taskName?: string;
    maxRuns?: string | number | null;
    retryOnFailure?: string | number | null;
    timeoutMinutes?: string | number | null;
    taskEnv?: string | null;
    // For get_task_log
    runLogId?: number;
    // For snooze_task
    until?: string;
    // For get_task_history
    historyLimit?: number;
    historyFromDays?: number;
    // For cancel_all_tasks
    status?: string;
    // For set_group_instructions
    targetFolder?: string;
    text?: string;
    mode?: string;
    sectionHeading?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        const maxRunsRaw = data.maxRuns;
        const maxRunsParsed = maxRunsRaw != null ? Number(maxRunsRaw) : NaN;
        const maxRuns =
          !isNaN(maxRunsParsed) && maxRunsParsed > 0 ? maxRunsParsed : null;
        const retryOnFailureRaw = data.retryOnFailure;
        const retryOnFailureParsed =
          retryOnFailureRaw != null ? Number(retryOnFailureRaw) : NaN;
        const retryOnFailure =
          !isNaN(retryOnFailureParsed) &&
          retryOnFailureParsed > 0 &&
          retryOnFailureParsed <= 5
            ? Math.floor(retryOnFailureParsed)
            : 0;
        const timeoutMinutesRaw = data.timeoutMinutes;
        const timeoutMinutesParsed =
          timeoutMinutesRaw != null ? Number(timeoutMinutesRaw) : NaN;
        const timeoutMinutes =
          !isNaN(timeoutMinutesParsed) && timeoutMinutesParsed > 0
            ? Math.floor(timeoutMinutesParsed)
            : null;

        // Validate task_env JSON if provided
        let taskEnv: string | null = null;
        if (data.taskEnv) {
          try {
            const parsed = JSON.parse(data.taskEnv);
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              !Array.isArray(parsed)
            ) {
              taskEnv = data.taskEnv;
            }
          } catch {
            logger.warn({ taskId }, 'Invalid task_env JSON — ignoring');
          }
        }

        createTask({
          id: taskId,
          name: data.taskName || null,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
          notify_on_success:
            data.notifyOnSuccess === true || data.notifyOnSuccess === 'true',
          max_runs: maxRuns,
          run_count: 0,
          retry_on_failure: retryOnFailure,
          retry_attempt: 0,
          timeout_minutes: timeoutMinutes,
          task_env: taskEnv,
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.taskName !== undefined) updates.name = data.taskName || null;
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;
        if (data.script !== undefined) updates.script = data.script || null;
        if (
          data.context_mode !== undefined &&
          (data.context_mode === 'group' || data.context_mode === 'isolated')
        )
          updates.context_mode = data.context_mode;
        if (data.notifyOnSuccess !== undefined)
          updates.notify_on_success =
            data.notifyOnSuccess === true || data.notifyOnSuccess === 'true';
        if (data.maxRuns !== undefined) {
          // Empty string means "clear the limit"; otherwise parse the number
          if (data.maxRuns === '' || data.maxRuns === null) {
            updates.max_runs = null;
          } else {
            const parsed = Number(data.maxRuns);
            updates.max_runs = !isNaN(parsed) && parsed > 0 ? parsed : null;
          }
        }
        if (data.retryOnFailure !== undefined) {
          // Empty string / null means "disable retries"
          if (data.retryOnFailure === '' || data.retryOnFailure === null) {
            updates.retry_on_failure = 0;
          } else {
            const parsed = Math.floor(Number(data.retryOnFailure));
            updates.retry_on_failure =
              !isNaN(parsed) && parsed > 0 && parsed <= 5 ? parsed : 0;
          }
        }
        if (data.timeoutMinutes !== undefined) {
          // Empty string / null means "clear the timeout (use global default)"
          if (data.timeoutMinutes === '' || data.timeoutMinutes === null) {
            updates.timeout_minutes = null;
          } else {
            const parsed = Math.floor(Number(data.timeoutMinutes));
            updates.timeout_minutes =
              !isNaN(parsed) && parsed > 0 ? parsed : null;
          }
        }
        if (data.taskEnv !== undefined) {
          // Empty string / null means "clear env vars"
          if (!data.taskEnv) {
            updates.task_env = null;
          } else {
            try {
              const parsed = JSON.parse(data.taskEnv);
              if (
                typeof parsed === 'object' &&
                parsed !== null &&
                !Array.isArray(parsed)
              ) {
                updates.task_env = data.taskEnv;
              }
            } catch {
              logger.warn(
                { taskId: data.taskId },
                'Invalid task_env JSON in update — ignoring',
              );
            }
          }
        }

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = deps.registeredGroups()[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'run_task_now':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for run_task_now',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized run_task_now attempt blocked',
          );
          break;
        }
        // Set next_run to now and ensure active — scheduler picks it up on next poll
        updateTask(data.taskId, {
          status: 'active',
          next_run: new Date().toISOString(),
        });
        logger.info(
          { taskId: data.taskId, sourceGroup },
          'Task scheduled for immediate run via IPC',
        );
      }
      break;

    case 'snooze_task': {
      const snoozeTaskId = data.taskId;
      const snoozeUntil = data.until; // ISO timestamp
      if (!snoozeTaskId || !snoozeUntil) {
        logger.warn({ sourceGroup }, 'snooze_task missing taskId or until');
        break;
      }
      const snoozeTask = getTaskById(snoozeTaskId);
      if (!snoozeTask) {
        logger.warn(
          { taskId: snoozeTaskId, sourceGroup },
          'Task not found for snooze_task',
        );
        break;
      }
      if (!isMain && snoozeTask.group_folder !== sourceGroup) {
        logger.warn(
          { taskId: snoozeTaskId, sourceGroup },
          'Unauthorized snooze_task attempt blocked',
        );
        break;
      }
      const snoozeDate = new Date(snoozeUntil);
      if (isNaN(snoozeDate.getTime()) || snoozeDate <= new Date()) {
        logger.warn(
          { taskId: snoozeTaskId, until: snoozeUntil, sourceGroup },
          'snooze_task: until timestamp is invalid or in the past',
        );
        break;
      }
      updateTask(snoozeTaskId, { next_run: snoozeDate.toISOString() });
      logger.info(
        { taskId: snoozeTaskId, until: snoozeUntil, sourceGroup },
        'Task snoozed via IPC',
      );
      break;
    }

    case 'search_messages': {
      if (!data.queryId || !data.query) {
        logger.warn(
          { sourceGroup },
          'search_messages missing queryId or query',
        );
        break;
      }
      // Find the chat JID for this group
      const groupEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === sourceGroup,
      );
      if (!groupEntry) {
        logger.warn(
          { sourceGroup },
          'search_messages: group not found in registered groups',
        );
        break;
      }
      const chatJid = groupEntry[0];
      const results = searchMessages(
        chatJid,
        data.query as string,
        typeof data.searchLimit === 'number' ? data.searchLimit : 20,
        typeof data.fromDays === 'number' ? data.fromDays : 30,
        data.includeBotMessages === true,
      );

      // Write response file to group's IPC responses directory
      const ipcBaseDir = path.join(DATA_DIR, 'ipc');
      const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');
      fs.mkdirSync(responsesDir, { recursive: true });
      const responseFile = path.join(responsesDir, `${data.queryId}.json`);
      fs.writeFileSync(responseFile, JSON.stringify({ results }), 'utf-8');
      logger.info(
        { sourceGroup, queryId: data.queryId, resultCount: results.length },
        'search_messages: wrote response',
      );
      break;
    }

    case 'get_recent_messages': {
      if (!data.queryId) {
        logger.warn({ sourceGroup }, 'get_recent_messages missing queryId');
        break;
      }
      const recentGroupEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === sourceGroup,
      );
      if (!recentGroupEntry) {
        logger.warn(
          { sourceGroup },
          'get_recent_messages: group not found in registered groups',
        );
        break;
      }
      const recentChatJid = recentGroupEntry[0];
      const recentResults = getRecentMessages(
        recentChatJid,
        typeof data.recentLimit === 'number' ? data.recentLimit : 20,
        typeof data.recentFromDays === 'number' ? data.recentFromDays : 7,
        data.includeBotMessages === true,
      );
      const recentIpcBaseDir = path.join(DATA_DIR, 'ipc');
      const recentResponsesDir = path.join(
        recentIpcBaseDir,
        sourceGroup,
        'responses',
      );
      fs.mkdirSync(recentResponsesDir, { recursive: true });
      const recentResponseFile = path.join(
        recentResponsesDir,
        `${data.queryId}.json`,
      );
      fs.writeFileSync(
        recentResponseFile,
        JSON.stringify({ results: recentResults }),
        'utf-8',
      );
      logger.info(
        {
          sourceGroup,
          queryId: data.queryId,
          resultCount: recentResults.length,
        },
        'get_recent_messages: wrote response',
      );
      break;
    }

    case 'get_chat_stats': {
      const queryId = data.queryId as string;
      if (!queryId) break;
      const statsGroupEntry = Object.entries(registeredGroups).find(([, g]) =>
        isMain && data.groupFolder
          ? g.folder === data.groupFolder
          : g.folder === sourceGroup,
      );
      if (!statsGroupEntry) {
        logger.warn({ sourceGroup }, 'get_chat_stats: group not found');
        break;
      }
      const statsChatJid = statsGroupEntry[0];
      const fromDays = typeof data.fromDays === 'number' ? data.fromDays : 30;
      const stats = getChatStats(statsChatJid, fromDays);
      const statsIpcBaseDir = path.join(DATA_DIR, 'ipc');
      const statsResponsesDir = path.join(
        statsIpcBaseDir,
        sourceGroup,
        'responses',
      );
      fs.mkdirSync(statsResponsesDir, { recursive: true });
      const statsResponseFile = path.join(statsResponsesDir, `${queryId}.json`);
      fs.writeFileSync(statsResponseFile, JSON.stringify(stats), 'utf-8');
      logger.info({ sourceGroup, queryId }, 'get_chat_stats: wrote response');
      break;
    }

    case 'get_task_stats': {
      const tsQueryId = data.queryId as string;
      if (!tsQueryId) break;
      const fromDays = typeof data.fromDays === 'number' ? data.fromDays : 7;
      // Main can request stats for any group; others get their own
      const statsGroupFolder =
        isMain && typeof data.groupFolder === 'string'
          ? data.groupFolder
          : sourceGroup;
      const stats = getTaskStats(statsGroupFolder, fromDays);
      const tsIpcBaseDir = path.join(DATA_DIR, 'ipc');
      const tsResponsesDir = path.join(tsIpcBaseDir, sourceGroup, 'responses');
      fs.mkdirSync(tsResponsesDir, { recursive: true });
      const tsResponseFile = path.join(tsResponsesDir, `${tsQueryId}.json`);
      fs.writeFileSync(tsResponseFile, JSON.stringify(stats), 'utf-8');
      logger.info(
        { sourceGroup, queryId: tsQueryId },
        'get_task_stats: wrote response',
      );
      break;
    }

    case 'get_task_log': {
      if (!data.queryId || data.runLogId === undefined) {
        logger.warn(
          { sourceGroup },
          'get_task_log missing queryId or runLogId',
        );
        break;
      }
      // Authorization: verify the run log belongs to a task owned by this group (or isMain)
      const logEntry = getTaskRunLogById(data.runLogId);
      if (!logEntry) {
        const ipcBase = path.join(DATA_DIR, 'ipc');
        const respDir = path.join(ipcBase, sourceGroup, 'responses');
        fs.mkdirSync(respDir, { recursive: true });
        fs.writeFileSync(
          path.join(respDir, `${data.queryId}.json`),
          JSON.stringify({ error: 'Run log not found' }),
          'utf-8',
        );
        break;
      }
      // Check ownership
      const logTask = getTaskById(logEntry.task_id);
      if (!logTask || (!isMain && logTask.group_folder !== sourceGroup)) {
        logger.warn(
          { sourceGroup, taskId: logEntry.task_id },
          'get_task_log: unauthorized access attempt',
        );
        const ipcBase = path.join(DATA_DIR, 'ipc');
        const respDir = path.join(ipcBase, sourceGroup, 'responses');
        fs.mkdirSync(respDir, { recursive: true });
        fs.writeFileSync(
          path.join(respDir, `${data.queryId}.json`),
          JSON.stringify({ error: 'Unauthorized' }),
          'utf-8',
        );
        break;
      }

      const ipcBaseDir = path.join(DATA_DIR, 'ipc');
      const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');
      fs.mkdirSync(responsesDir, { recursive: true });
      fs.writeFileSync(
        path.join(responsesDir, `${data.queryId}.json`),
        JSON.stringify({ log: logEntry }),
        'utf-8',
      );
      logger.info(
        { sourceGroup, queryId: data.queryId, runLogId: data.runLogId },
        'get_task_log: wrote response',
      );
      break;
    }

    case 'get_task_history': {
      const thQueryId = data.queryId as string;
      if (!thQueryId) break;
      const historyLimit =
        typeof data.historyLimit === 'number' ? data.historyLimit : 50;
      const historyFromDays =
        typeof data.historyFromDays === 'number' ? data.historyFromDays : 7;
      // Main can query any group; others get their own
      const historyGroupFolder =
        isMain && typeof data.groupFolder === 'string'
          ? data.groupFolder
          : sourceGroup;
      const history = getTaskHistory(
        historyGroupFolder,
        historyLimit,
        historyFromDays,
      );
      const thIpcBase = path.join(DATA_DIR, 'ipc');
      const thResponsesDir = path.join(thIpcBase, sourceGroup, 'responses');
      fs.mkdirSync(thResponsesDir, { recursive: true });
      fs.writeFileSync(
        path.join(thResponsesDir, `${thQueryId}.json`),
        JSON.stringify({ history }),
        'utf-8',
      );
      logger.info(
        { sourceGroup, queryId: thQueryId },
        'get_task_history: wrote response',
      );
      break;
    }

    case 'pause_all_tasks': {
      const paQueryId = data.queryId as string;
      // Main can pause any group; others can only pause their own
      const paGroupFolder =
        isMain && typeof data.groupFolder === 'string'
          ? data.groupFolder
          : sourceGroup;
      const pausedCount = setAllTasksStatus(paGroupFolder, 'paused', 'active');
      logger.info(
        { sourceGroup, targetGroup: paGroupFolder, pausedCount },
        'pause_all_tasks: paused tasks',
      );
      if (paQueryId) {
        const paIpcBase = path.join(DATA_DIR, 'ipc');
        const paResponsesDir = path.join(paIpcBase, sourceGroup, 'responses');
        fs.mkdirSync(paResponsesDir, { recursive: true });
        fs.writeFileSync(
          path.join(paResponsesDir, `${paQueryId}.json`),
          JSON.stringify({ paused: pausedCount }),
          'utf-8',
        );
      }
      break;
    }

    case 'resume_all_tasks': {
      const raQueryId = data.queryId as string;
      // Main can resume any group; others can only resume their own
      const raGroupFolder =
        isMain && typeof data.groupFolder === 'string'
          ? data.groupFolder
          : sourceGroup;
      const resumedCount = setAllTasksStatus(raGroupFolder, 'active', 'paused');
      logger.info(
        { sourceGroup, targetGroup: raGroupFolder, resumedCount },
        'resume_all_tasks: resumed tasks',
      );
      if (raQueryId) {
        const raIpcBase = path.join(DATA_DIR, 'ipc');
        const raResponsesDir = path.join(raIpcBase, sourceGroup, 'responses');
        fs.mkdirSync(raResponsesDir, { recursive: true });
        fs.writeFileSync(
          path.join(raResponsesDir, `${raQueryId}.json`),
          JSON.stringify({ resumed: resumedCount }),
          'utf-8',
        );
      }
      break;
    }

    case 'cancel_all_tasks': {
      const caQueryId = data.queryId as string;
      // Main can cancel any group; others can only cancel their own
      const caGroupFolder =
        isMain && typeof data.groupFolder === 'string'
          ? data.groupFolder
          : sourceGroup;
      const caStatus =
        data.status === 'active' || data.status === 'paused'
          ? data.status
          : undefined;
      const cancelledCount = deleteAllTasks(caGroupFolder, caStatus);
      logger.info(
        { sourceGroup, targetGroup: caGroupFolder, cancelledCount, caStatus },
        'cancel_all_tasks: deleted tasks',
      );
      if (caQueryId) {
        const caIpcBase = path.join(DATA_DIR, 'ipc');
        const caResponsesDir = path.join(caIpcBase, sourceGroup, 'responses');
        fs.mkdirSync(caResponsesDir, { recursive: true });
        fs.writeFileSync(
          path.join(caResponsesDir, `${caQueryId}.json`),
          JSON.stringify({ cancelled: cancelledCount }),
          'utf-8',
        );
      }
      break;
    }

    case 'set_group_instructions': {
      // Main-only: update any group's CLAUDE.md from the host side
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized set_group_instructions attempt blocked',
        );
        break;
      }
      const sgiQueryId = data.queryId as string;
      const sgiIpcBase = path.join(DATA_DIR, 'ipc');
      const sgiResponsesDir = path.join(sgiIpcBase, sourceGroup, 'responses');
      fs.mkdirSync(sgiResponsesDir, { recursive: true });

      const targetFolder = data.targetFolder as string | undefined;
      const instructionsText = data.text as string | undefined;
      const mode = (data.mode as string | undefined) || 'replace';

      if (!targetFolder || !instructionsText) {
        logger.warn(
          { data },
          'set_group_instructions: missing required fields (targetFolder, text)',
        );
        if (sgiQueryId) {
          fs.writeFileSync(
            path.join(sgiResponsesDir, `${sgiQueryId}.json`),
            JSON.stringify({
              error: 'Missing required fields: targetFolder, text',
            }),
            'utf-8',
          );
        }
        break;
      }

      if (!isValidGroupFolder(targetFolder)) {
        if (sgiQueryId) {
          fs.writeFileSync(
            path.join(sgiResponsesDir, `${sgiQueryId}.json`),
            JSON.stringify({
              error: `Invalid group folder name: ${targetFolder}`,
            }),
            'utf-8',
          );
        }
        break;
      }

      const claudeMdPath = path.join(GROUPS_DIR, targetFolder, 'CLAUDE.md');
      const groupDir = path.join(GROUPS_DIR, targetFolder);

      try {
        // Ensure group directory exists
        if (!fs.existsSync(groupDir)) {
          fs.mkdirSync(groupDir, { recursive: true });
        }

        let newContent: string;
        if (mode === 'append') {
          const existing = fs.existsSync(claudeMdPath)
            ? fs.readFileSync(claudeMdPath, 'utf-8')
            : '';
          newContent = existing
            ? `${existing}\n${instructionsText}`
            : instructionsText;
        } else if (mode === 'replace_section') {
          const sectionHeading = data.sectionHeading as string | undefined;
          if (!sectionHeading) {
            if (sgiQueryId) {
              fs.writeFileSync(
                path.join(sgiResponsesDir, `${sgiQueryId}.json`),
                JSON.stringify({
                  error: 'replace_section mode requires sectionHeading field',
                }),
                'utf-8',
              );
            }
            break;
          }
          const existing = fs.existsSync(claudeMdPath)
            ? fs.readFileSync(claudeMdPath, 'utf-8')
            : '';
          const lines = existing.split('\n');
          const headingLine = sectionHeading.trim();
          const headingIdx = lines.findIndex((l) => l.trim() === headingLine);
          if (headingIdx === -1) {
            // Append as new section
            newContent = existing
              ? `${existing}\n\n${headingLine}\n\n${instructionsText}`
              : `${headingLine}\n\n${instructionsText}`;
          } else {
            // Find next same-or-higher-level heading
            const level = (headingLine.match(/^#+/) ?? [''])[0].length;
            let endIdx = lines.length;
            for (let i = headingIdx + 1; i < lines.length; i++) {
              const m = lines[i].match(/^(#+)\s/);
              if (m && m[1].length <= level) {
                endIdx = i;
                break;
              }
            }
            const before = lines.slice(0, headingIdx + 1);
            const after = lines.slice(endIdx);
            newContent = [
              ...before,
              '',
              instructionsText,
              ...(after.length ? ['', ...after] : []),
            ].join('\n');
          }
        } else {
          // replace (default)
          newContent = instructionsText;
        }

        fs.writeFileSync(claudeMdPath, newContent, 'utf-8');
        logger.info(
          { sourceGroup, targetFolder, mode, chars: newContent.length },
          'set_group_instructions: CLAUDE.md updated',
        );
        if (sgiQueryId) {
          fs.writeFileSync(
            path.join(sgiResponsesDir, `${sgiQueryId}.json`),
            JSON.stringify({ ok: true, chars: newContent.length }),
            'utf-8',
          );
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          { sourceGroup, targetFolder, err },
          'set_group_instructions: failed to write CLAUDE.md',
        );
        if (sgiQueryId) {
          fs.writeFileSync(
            path.join(sgiResponsesDir, `${sgiQueryId}.json`),
            JSON.stringify({ error: errMsg }),
            'utf-8',
          );
        }
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
