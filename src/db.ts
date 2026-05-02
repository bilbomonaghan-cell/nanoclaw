import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN script TEXT DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }

  // Add notify_on_success column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN notify_on_success INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Add name column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN name TEXT DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add max_runs column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN max_runs INTEGER DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add run_count column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN run_count INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Add retry_on_failure column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN retry_on_failure INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Add retry_attempt column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN retry_attempt INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

/**
 * Return the timestamp of the most recent bot message for a chat,
 * used to recover the message cursor after a restart.
 */
export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, name, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at, notify_on_success, max_runs, run_count, retry_on_failure, retry_attempt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.name || null,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
    task.notify_on_success ? 1 : 0,
    task.max_runs ?? null,
    task.run_count ?? 0,
    task.retry_on_failure ?? 0,
    task.retry_attempt ?? 0,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'name'
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
      | 'script'
      | 'context_mode'
      | 'notify_on_success'
      | 'max_runs'
      | 'retry_on_failure'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name ?? null);
  }
  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script ?? null);
  }
  if (updates.context_mode !== undefined) {
    fields.push('context_mode = ?');
    values.push(updates.context_mode);
  }
  if (updates.notify_on_success !== undefined) {
    fields.push('notify_on_success = ?');
    values.push(updates.notify_on_success ? 1 : 0);
  }
  if (updates.max_runs !== undefined) {
    fields.push('max_runs = ?');
    values.push(updates.max_runs ?? null);
  }
  if (updates.retry_on_failure !== undefined) {
    fields.push('retry_on_failure = ?');
    values.push(updates.retry_on_failure ?? 0);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

/**
 * Update the retry_attempt counter for a task.
 * Called by the scheduler when retrying a failed task or resetting after success.
 */
export function setRetryAttempt(id: string, attempt: number): void {
  db.prepare(`UPDATE scheduled_tasks SET retry_attempt = ? WHERE id = ?`).run(
    attempt,
    id,
  );
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

/**
 * Increment the run_count for a task and return the new count.
 * Used by the task scheduler to track successful runs for max_runs enforcement.
 */
export function incrementTaskRunCount(id: string): number {
  db.prepare(
    `UPDATE scheduled_tasks SET run_count = run_count + 1 WHERE id = ?`,
  ).run(id);
  const row = db
    .prepare(`SELECT run_count FROM scheduled_tasks WHERE id = ?`)
    .get(id) as { run_count: number } | undefined;
  return row?.run_count ?? 0;
}

/**
 * Delete all tasks for a group, optionally filtered by status.
 * Returns the number of tasks deleted.
 */
export function deleteAllTasks(
  groupFolder: string,
  status?: 'active' | 'paused',
): number {
  // Collect task IDs first so we can delete logs too
  const taskIds = (
    status !== undefined
      ? (db
          .prepare(
            `SELECT id FROM scheduled_tasks WHERE group_folder = ? AND status = ?`,
          )
          .all(groupFolder, status) as { id: string }[])
      : (db
          .prepare(`SELECT id FROM scheduled_tasks WHERE group_folder = ?`)
          .all(groupFolder) as { id: string }[])
  ).map((r) => r.id);

  if (taskIds.length === 0) return 0;

  // Delete run logs for these tasks first (FK constraint)
  const placeholders = taskIds.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM task_run_logs WHERE task_id IN (${placeholders})`,
  ).run(...taskIds);

  // Delete the tasks themselves
  if (status !== undefined) {
    db.prepare(
      `DELETE FROM scheduled_tasks WHERE group_folder = ? AND status = ?`,
    ).run(groupFolder, status);
  } else {
    db.prepare(`DELETE FROM scheduled_tasks WHERE group_folder = ?`).run(
      groupFolder,
    );
  }

  return taskIds.length;
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

/**
 * Retrieve the N most recent run log entries for a task, newest first.
 */
export function getRecentTaskRunLogs(
  taskId: string,
  limit: number = 5,
): TaskRunLog[] {
  return db
    .prepare(
      'SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?',
    )
    .all(taskId, limit) as TaskRunLog[];
}

/**
 * Retrieve a single task run log by its autoincrement ID.
 * Returns null if not found.
 */
export function getTaskRunLogById(id: number): TaskRunLog | null {
  return (
    (db.prepare('SELECT * FROM task_run_logs WHERE id = ?').get(id) as
      | TaskRunLog
      | undefined) ?? null
  );
}

/**
 * Delete task run logs older than `olderThanDays` days.
 * Returns the number of rows deleted.
 */
export function pruneTaskRunLogs(olderThanDays: number = 30): number {
  const cutoff = new Date(
    Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare('DELETE FROM task_run_logs WHERE run_at < ?')
    .run(cutoff);
  return result.changes;
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- Message search ---

export interface MessageSearchResult {
  id: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
}

/**
 * Search message history for a chat by content substring.
 * Returns results newest-first.
 */
export function searchMessages(
  chatJid: string,
  query: string,
  limit: number = 20,
  fromDays: number = 30,
  includeBotMessages: boolean = false,
): MessageSearchResult[] {
  const sinceDate = new Date(Date.now() - fromDays * 86_400_000).toISOString();
  const likeQuery = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  const botFilter = includeBotMessages ? '' : 'AND is_bot_message = 0';
  const rows = db
    .prepare(
      `SELECT id, sender_name, content, timestamp, is_from_me, is_bot_message
       FROM messages
       WHERE chat_jid = ?
         AND content LIKE ? ESCAPE '\\'
         AND timestamp >= ?
         ${botFilter}
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(chatJid, likeQuery, sinceDate, limit);
  return rows as MessageSearchResult[];
}

/**
 * Retrieve the N most recent messages from a chat, newest-first.
 * No keyword filter — use searchMessages() for keyword-based lookup.
 */
export function getRecentMessages(
  chatJid: string,
  limit: number = 20,
  fromDays: number = 7,
  includeBotMessages: boolean = false,
): MessageSearchResult[] {
  const sinceDate = new Date(Date.now() - fromDays * 86_400_000).toISOString();
  const botFilter = includeBotMessages ? '' : 'AND is_bot_message = 0';
  const rows = db
    .prepare(
      `SELECT id, sender_name, content, timestamp, is_from_me, is_bot_message
       FROM messages
       WHERE chat_jid = ?
         AND timestamp >= ?
         ${botFilter}
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(chatJid, sinceDate, limit);
  return rows as MessageSearchResult[];
}

export interface ChatStats {
  total_messages: number;
  unique_senders: number;
  first_message: string | null;
  last_message: string | null;
  top_senders: Array<{ sender_name: string; count: number }>;
  days_covered: number;
}

/**
 * Aggregate statistics for a chat over a given time window.
 */
export function getChatStats(
  chatJid: string,
  fromDays: number = 30,
): ChatStats {
  const sinceDate = new Date(Date.now() - fromDays * 86_400_000).toISOString();

  const summary = db
    .prepare(
      `SELECT
         COUNT(*) as total_messages,
         COUNT(DISTINCT sender) as unique_senders,
         MIN(timestamp) as first_message,
         MAX(timestamp) as last_message
       FROM messages
       WHERE chat_jid = ?
         AND timestamp >= ?
         AND is_bot_message = 0`,
    )
    .get(chatJid, sinceDate) as {
    total_messages: number;
    unique_senders: number;
    first_message: string | null;
    last_message: string | null;
  };

  const topSenders = db
    .prepare(
      `SELECT sender_name, COUNT(*) as count
       FROM messages
       WHERE chat_jid = ?
         AND timestamp >= ?
         AND is_bot_message = 0
       GROUP BY sender_name
       ORDER BY count DESC
       LIMIT 10`,
    )
    .all(chatJid, sinceDate) as Array<{ sender_name: string; count: number }>;

  return {
    ...summary,
    top_senders: topSenders,
    days_covered: fromDays,
  };
}

export interface TaskStatsSummary {
  total_runs: number;
  succeeded: number;
  failed: number;
  active_tasks: number;
  days_covered: number;
  by_task: Array<{
    task_id: string;
    name: string | null;
    total_runs: number;
    succeeded: number;
    failed: number;
    last_run: string | null;
  }>;
}

/**
 * Aggregate run statistics for a group's tasks over a given time window.
 */
export function getTaskStats(
  groupFolder: string,
  fromDays: number = 7,
): TaskStatsSummary {
  const sinceDate = new Date(Date.now() - fromDays * 86_400_000).toISOString();

  const summary = db
    .prepare(
      `SELECT
         COUNT(*) as total_runs,
         COALESCE(SUM(CASE WHEN l.status = 'success' THEN 1 ELSE 0 END), 0) as succeeded,
         COALESCE(SUM(CASE WHEN l.status = 'error' THEN 1 ELSE 0 END), 0) as failed,
         COUNT(DISTINCT l.task_id) as active_tasks
       FROM task_run_logs l
       JOIN scheduled_tasks t ON l.task_id = t.id
       WHERE t.group_folder = ?
         AND l.run_at >= ?`,
    )
    .get(groupFolder, sinceDate) as {
    total_runs: number;
    succeeded: number;
    failed: number;
    active_tasks: number;
  };

  const byTask = db
    .prepare(
      `SELECT
         t.id as task_id,
         t.name,
         COUNT(*) as total_runs,
         SUM(CASE WHEN l.status = 'success' THEN 1 ELSE 0 END) as succeeded,
         SUM(CASE WHEN l.status = 'error' THEN 1 ELSE 0 END) as failed,
         MAX(l.run_at) as last_run
       FROM task_run_logs l
       JOIN scheduled_tasks t ON l.task_id = t.id
       WHERE t.group_folder = ?
         AND l.run_at >= ?
       GROUP BY t.id, t.name
       ORDER BY total_runs DESC`,
    )
    .all(groupFolder, sinceDate) as Array<{
    task_id: string;
    name: string | null;
    total_runs: number;
    succeeded: number;
    failed: number;
    last_run: string | null;
  }>;

  return {
    total_runs: summary.total_runs,
    succeeded: summary.succeeded,
    failed: summary.failed,
    active_tasks: summary.active_tasks,
    days_covered: fromDays,
    by_task: byTask,
  };
}

// --- Task history (cross-task run timeline) ---

export interface TaskHistoryEntry {
  log_id: number;
  task_id: string;
  task_name: string | null;
  run_at: string;
  duration_ms: number;
  status: string;
  error: string | null;
}

/**
 * Return a chronological run log across all tasks for a group.
 * Useful for a unified "what ran recently and did it succeed?" timeline.
 */
export function getTaskHistory(
  groupFolder: string,
  limit: number = 50,
  fromDays: number = 7,
): TaskHistoryEntry[] {
  const sinceDate = new Date(Date.now() - fromDays * 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT
         l.id        AS log_id,
         l.task_id,
         t.name      AS task_name,
         l.run_at,
         l.duration_ms,
         l.status,
         l.error
       FROM task_run_logs l
       JOIN scheduled_tasks t ON l.task_id = t.id
       WHERE t.group_folder = ?
         AND l.run_at >= ?
       ORDER BY l.run_at DESC
       LIMIT ?`,
    )
    .all(groupFolder, sinceDate, limit) as TaskHistoryEntry[];
}

// --- Bulk task status changes ---

/**
 * Set all tasks for a group to a given status.
 * Optionally filter by current status (e.g. only pause active tasks).
 * Returns the number of rows changed.
 */
export function setAllTasksStatus(
  groupFolder: string,
  newStatus: 'active' | 'paused',
  currentStatus?: 'active' | 'paused',
): number {
  if (currentStatus !== undefined) {
    return db
      .prepare(
        `UPDATE scheduled_tasks
           SET status = ?
           WHERE group_folder = ? AND status = ?`,
      )
      .run(newStatus, groupFolder, currentStatus).changes;
  }
  return db
    .prepare(
      `UPDATE scheduled_tasks
         SET status = ?
         WHERE group_folder = ?`,
    )
    .run(newStatus, groupFolder).changes;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
