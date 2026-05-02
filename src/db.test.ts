import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  deleteAllTasks,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getChatStats,
  getMessagesSince,
  getNewMessages,
  getRecentMessages,
  getRecentTaskRunLogs,
  getTaskById,
  getTaskHistory,
  getTaskRunLogById,
  getTaskStats,
  incrementTaskRunCount,
  logTaskRun,
  pruneTaskRunLogs,
  searchMessages,
  setAllTasksStatus,
  setRegisteredGroup,
  setRetryAttempt,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- Task run logs ---

function makeTask(id: string) {
  createTask({
    id,
    group_folder: 'main',
    chat_jid: 'group@g.us',
    prompt: 'test task',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: '2024-06-01T09:00:00.000Z',
    status: 'active',
    created_at: '2024-01-01T00:00:00.000Z',
  });
}

describe('getRecentTaskRunLogs', () => {
  it('returns empty array when no logs exist', () => {
    makeTask('task-log-1');
    const logs = getRecentTaskRunLogs('task-log-1');
    expect(logs).toHaveLength(0);
  });

  it('returns logs in newest-first order', () => {
    makeTask('task-log-2');

    logTaskRun({
      task_id: 'task-log-2',
      run_at: '2024-01-01T09:00:00.000Z',
      duration_ms: 1000,
      status: 'success',
      result: 'ok',
      error: null,
    });
    logTaskRun({
      task_id: 'task-log-2',
      run_at: '2024-01-02T09:00:00.000Z',
      duration_ms: 1500,
      status: 'error',
      result: null,
      error: 'timeout',
    });
    logTaskRun({
      task_id: 'task-log-2',
      run_at: '2024-01-03T09:00:00.000Z',
      duration_ms: 900,
      status: 'success',
      result: 'done',
      error: null,
    });

    const logs = getRecentTaskRunLogs('task-log-2');
    expect(logs).toHaveLength(3);
    // Newest first
    expect(logs[0].run_at).toBe('2024-01-03T09:00:00.000Z');
    expect(logs[1].run_at).toBe('2024-01-02T09:00:00.000Z');
    expect(logs[2].run_at).toBe('2024-01-01T09:00:00.000Z');
  });

  it('respects the limit parameter', () => {
    makeTask('task-log-3');

    for (let i = 1; i <= 8; i++) {
      logTaskRun({
        task_id: 'task-log-3',
        run_at: `2024-01-${String(i).padStart(2, '0')}T09:00:00.000Z`,
        duration_ms: 1000,
        status: 'success',
        result: null,
        error: null,
      });
    }

    const logs = getRecentTaskRunLogs('task-log-3', 3);
    expect(logs).toHaveLength(3);
    // Should be the 3 most recent
    expect(logs[0].run_at).toBe('2024-01-08T09:00:00.000Z');
    expect(logs[2].run_at).toBe('2024-01-06T09:00:00.000Z');
  });

  it('only returns logs for the specified task', () => {
    makeTask('task-log-4a');
    makeTask('task-log-4b');

    logTaskRun({
      task_id: 'task-log-4a',
      run_at: '2024-01-01T09:00:00.000Z',
      duration_ms: 1000,
      status: 'success',
      result: null,
      error: null,
    });
    logTaskRun({
      task_id: 'task-log-4b',
      run_at: '2024-01-01T10:00:00.000Z',
      duration_ms: 500,
      status: 'error',
      result: null,
      error: 'failed',
    });

    const logs4a = getRecentTaskRunLogs('task-log-4a');
    expect(logs4a).toHaveLength(1);
    expect(logs4a[0].task_id).toBe('task-log-4a');

    const logs4b = getRecentTaskRunLogs('task-log-4b');
    expect(logs4b).toHaveLength(1);
    expect(logs4b[0].error).toBe('failed');
  });
});

describe('pruneTaskRunLogs', () => {
  it('deletes logs older than the given days', () => {
    makeTask('task-prune-1');

    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

    logTaskRun({
      task_id: 'task-prune-1',
      run_at: old,
      duration_ms: 500,
      status: 'success',
      result: null,
      error: null,
    });
    logTaskRun({
      task_id: 'task-prune-1',
      run_at: recent,
      duration_ms: 500,
      status: 'success',
      result: null,
      error: null,
    });

    const deleted = pruneTaskRunLogs(30);
    expect(deleted).toBe(1);

    const remaining = getRecentTaskRunLogs('task-prune-1', 10);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].run_at).toBe(recent);
  });

  it('returns 0 when nothing is old enough to prune', () => {
    makeTask('task-prune-2');

    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    logTaskRun({
      task_id: 'task-prune-2',
      run_at: recent,
      duration_ms: 500,
      status: 'success',
      result: null,
      error: null,
    });

    const deleted = pruneTaskRunLogs(30);
    expect(deleted).toBe(0);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- searchMessages ---

describe('searchMessages', () => {
  const jid = 'search-test@g.us';

  function storeMsg(
    id: string,
    content: string,
    opts: {
      is_from_me?: boolean;
      is_bot_message?: boolean;
      daysAgo?: number;
    } = {},
  ) {
    const daysAgo = opts.daysAgo ?? 0;
    const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    storeMessage({
      id,
      chat_jid: jid,
      sender: 'sender1',
      sender_name: 'Alice',
      content,
      timestamp: ts,
      is_from_me: opts.is_from_me ?? false,
      is_bot_message: opts.is_bot_message ?? false,
    });
  }

  it('returns messages matching query substring', () => {
    storeChatMetadata(jid, 'Search Test', jid, 'test', false);
    storeMsg('sm1', 'Hello world from Alice');
    storeMsg('sm2', 'Another message here');
    storeMsg('sm3', 'World domination plans');

    const results = searchMessages(jid, 'world');
    expect(results).toHaveLength(2);
    const contents = results.map((r) => r.content);
    expect(contents).toContain('Hello world from Alice');
    expect(contents).toContain('World domination plans');
  });

  it('is case-insensitive', () => {
    storeChatMetadata(jid, 'Search Test', jid, 'test', false);
    storeMsg('sm4', 'UPPERCASE QUERY');
    storeMsg('sm5', 'lowercase query');

    const results = searchMessages(jid, 'QUERY');
    expect(results).toHaveLength(2);
  });

  it('excludes bot messages by default', () => {
    storeChatMetadata(jid, 'Search Test', jid, 'test', false);
    storeMsg('sm6', 'Bot reply about bananas', { is_bot_message: true });
    storeMsg('sm7', 'User message about bananas');

    const resultsDefault = searchMessages(jid, 'bananas');
    expect(resultsDefault).toHaveLength(1);
    expect(resultsDefault[0].id).toBe('sm7');

    const resultsWithBot = searchMessages(jid, 'bananas', 20, 30, true);
    expect(resultsWithBot).toHaveLength(2);
  });

  it('respects from_days cutoff', () => {
    storeChatMetadata(jid, 'Search Test', jid, 'test', false);
    storeMsg('sm8', 'Recent pineapple message', { daysAgo: 2 });
    storeMsg('sm9', 'Old pineapple message', { daysAgo: 60 });

    const recentOnly = searchMessages(jid, 'pineapple', 20, 30);
    expect(recentOnly).toHaveLength(1);
    expect(recentOnly[0].id).toBe('sm8');
  });

  it('returns empty array when no matches', () => {
    storeChatMetadata(jid, 'Search Test', jid, 'test', false);
    storeMsg('sm10', 'Just a regular message');

    const results = searchMessages(jid, 'xyzzy-no-match');
    expect(results).toHaveLength(0);
  });

  it('respects limit parameter', () => {
    storeChatMetadata(jid, 'Search Test', jid, 'test', false);
    for (let i = 0; i < 10; i++) {
      storeMsg(`sm-limit-${i}`, `limit test message ${i}`);
    }

    const limited = searchMessages(jid, 'limit test', 3);
    expect(limited).toHaveLength(3);
  });
});

// --- getRecentMessages ---

describe('getRecentMessages', () => {
  const jid = 'recent-test@g.us';

  function storeMsg(
    id: string,
    content: string,
    opts: {
      is_from_me?: boolean;
      is_bot_message?: boolean;
      daysAgo?: number;
    } = {},
  ) {
    const daysAgo = opts.daysAgo ?? 0;
    const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    storeMessage({
      id,
      chat_jid: jid,
      sender: 'sender1',
      sender_name: 'Bob',
      content,
      timestamp: ts,
      is_from_me: opts.is_from_me ?? false,
      is_bot_message: opts.is_bot_message ?? false,
    });
  }

  it('returns recent messages newest-first', () => {
    storeChatMetadata(jid, 'Recent Test', jid, 'test', false);
    storeMsg('rq1', 'First message', { daysAgo: 2 });
    storeMsg('rq2', 'Second message', { daysAgo: 1 });
    storeMsg('rq3', 'Third message', { daysAgo: 0 });

    const results = getRecentMessages(jid, 20, 7);
    expect(results.length).toBeGreaterThanOrEqual(3);
    // Newest-first ordering
    expect(results[0].id).toBe('rq3');
    expect(results[1].id).toBe('rq2');
    expect(results[2].id).toBe('rq1');
  });

  it('excludes bot messages by default', () => {
    storeChatMetadata(jid, 'Recent Test', jid, 'test', false);
    storeMsg('rq4', 'Bot reply text', { is_bot_message: true });
    storeMsg('rq5', 'User message text');

    const defaultResults = getRecentMessages(jid, 20, 7);
    const ids = defaultResults.map((r) => r.id);
    expect(ids).not.toContain('rq4');
    expect(ids).toContain('rq5');

    const withBot = getRecentMessages(jid, 20, 7, true);
    const withBotIds = withBot.map((r) => r.id);
    expect(withBotIds).toContain('rq4');
    expect(withBotIds).toContain('rq5');
  });

  it('respects from_days cutoff', () => {
    storeChatMetadata(jid, 'Recent Test', jid, 'test', false);
    storeMsg('rq6', 'Recent message', { daysAgo: 2 });
    storeMsg('rq7', 'Old message', { daysAgo: 30 });

    const results = getRecentMessages(jid, 20, 7);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('rq6');
    expect(ids).not.toContain('rq7');
  });

  it('respects limit parameter', () => {
    storeChatMetadata(jid, 'Recent Test', jid, 'test', false);
    for (let i = 0; i < 10; i++) {
      storeMsg(`rq-lim-${i}`, `limit message ${i}`);
    }

    const limited = getRecentMessages(jid, 4, 7);
    expect(limited).toHaveLength(4);
  });

  it('returns empty array when no messages in window', () => {
    storeChatMetadata(jid, 'Recent Test', jid, 'test', false);
    storeMsg('rq8', 'Very old message', { daysAgo: 90 });

    const results = getRecentMessages(jid, 20, 7);
    expect(results).toHaveLength(0);
  });
});

// --- Task name field ---

describe('task name field', () => {
  function makeNamedTask(id: string, name?: string | null) {
    createTask({
      id,
      name: name ?? null,
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test task',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: '2024-06-01T09:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  }

  it('creates task with a name and retrieves it', () => {
    makeNamedTask('name-task-1', 'Daily weather briefing');
    const task = getTaskById('name-task-1');
    expect(task).toBeDefined();
    expect(task!.name).toBe('Daily weather briefing');
  });

  it('creates task without a name (null)', () => {
    makeNamedTask('name-task-2', null);
    const task = getTaskById('name-task-2');
    expect(task).toBeDefined();
    expect(task!.name == null).toBe(true);
  });

  it('updates name via updateTask', () => {
    makeNamedTask('name-task-3', 'Original name');
    updateTask('name-task-3', { name: 'Updated name' });
    const task = getTaskById('name-task-3');
    expect(task!.name).toBe('Updated name');
  });

  it('clears name by setting it to null', () => {
    makeNamedTask('name-task-4', 'Has a name');
    updateTask('name-task-4', { name: null });
    const task = getTaskById('name-task-4');
    expect(task!.name == null).toBe(true);
  });
});

// --- getTaskRunLogById ---

describe('getTaskRunLogById', () => {
  function makeTask(id: string) {
    createTask({
      id,
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test task',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: '2024-06-01T09:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  }

  it('returns null for a non-existent log ID', () => {
    const log = getTaskRunLogById(999999);
    expect(log).toBeNull();
  });

  it('returns the correct log entry by ID', () => {
    makeTask('log-by-id-1');
    logTaskRun({
      task_id: 'log-by-id-1',
      run_at: '2024-05-01T09:00:00.000Z',
      duration_ms: 1234,
      status: 'success',
      result: 'Full output here',
      error: null,
    });

    // The only way to get the inserted ID is via getRecentTaskRunLogs which returns the row including id
    const logs = getRecentTaskRunLogs('log-by-id-1', 1);
    expect(logs).toHaveLength(1);
    const insertedId = logs[0].id;
    expect(insertedId).toBeDefined();

    const found = getTaskRunLogById(insertedId!);
    expect(found).not.toBeNull();
    expect(found!.task_id).toBe('log-by-id-1');
    expect(found!.result).toBe('Full output here');
    expect(found!.duration_ms).toBe(1234);
  });

  it('distinguishes between different log entries', () => {
    makeTask('log-by-id-2');
    logTaskRun({
      task_id: 'log-by-id-2',
      run_at: '2024-05-01T09:00:00.000Z',
      duration_ms: 100,
      status: 'success',
      result: 'first',
      error: null,
    });
    logTaskRun({
      task_id: 'log-by-id-2',
      run_at: '2024-05-02T09:00:00.000Z',
      duration_ms: 200,
      status: 'error',
      result: null,
      error: 'oops',
    });

    const logs = getRecentTaskRunLogs('log-by-id-2', 2);
    const [newer, older] = logs; // newest-first

    expect(getTaskRunLogById(newer.id!)!.result).toBeNull();
    expect(getTaskRunLogById(newer.id!)!.error).toBe('oops');
    expect(getTaskRunLogById(older.id!)!.result).toBe('first');
  });
});

// --- getChatStats ---

describe('getChatStats', () => {
  const jid = 'stats-test@g.us';

  function storeMsg(
    id: string,
    opts: {
      sender?: string;
      sender_name?: string;
      is_bot_message?: boolean;
      daysAgo?: number;
    } = {},
  ) {
    const daysAgo = opts.daysAgo ?? 0;
    const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    storeMessage({
      id,
      chat_jid: jid,
      sender: opts.sender ?? 'sender1',
      sender_name: opts.sender_name ?? 'Alice',
      content: `message ${id}`,
      timestamp: ts,
      is_from_me: false,
      is_bot_message: opts.is_bot_message ?? false,
    });
  }

  it('returns zero stats for an empty chat', () => {
    storeChatMetadata(jid, 'Stats Test', jid, 'test', false);
    const stats = getChatStats(jid, 30);
    expect(stats.total_messages).toBe(0);
    expect(stats.unique_senders).toBe(0);
    expect(stats.first_message).toBeNull();
    expect(stats.last_message).toBeNull();
    expect(stats.top_senders).toHaveLength(0);
    expect(stats.days_covered).toBe(30);
  });

  it('counts messages and unique senders correctly', () => {
    storeChatMetadata(jid, 'Stats Test', jid, 'test', false);
    storeMsg('cs1', { sender: 'u1', sender_name: 'Alice' });
    storeMsg('cs2', { sender: 'u1', sender_name: 'Alice' });
    storeMsg('cs3', { sender: 'u2', sender_name: 'Bob' });

    const stats = getChatStats(jid, 30);
    expect(stats.total_messages).toBe(3);
    expect(stats.unique_senders).toBe(2);
    expect(stats.first_message).not.toBeNull();
    expect(stats.last_message).not.toBeNull();
  });

  it('excludes bot messages', () => {
    storeChatMetadata(jid, 'Stats Test', jid, 'test', false);
    storeMsg('cs4', { sender: 'u1', sender_name: 'Alice' });
    storeMsg('cs5', {
      sender: 'bot',
      sender_name: 'Bot',
      is_bot_message: true,
    });
    storeMsg('cs6', { sender: 'u2', sender_name: 'Bob' });

    const stats = getChatStats(jid, 30);
    expect(stats.total_messages).toBe(2);
    expect(stats.unique_senders).toBe(2);
  });

  it('respects fromDays cutoff', () => {
    storeChatMetadata(jid, 'Stats Test', jid, 'test', false);
    storeMsg('cs7', { sender: 'u1', sender_name: 'Alice', daysAgo: 5 });
    storeMsg('cs8', { sender: 'u2', sender_name: 'Bob', daysAgo: 60 });

    const recent = getChatStats(jid, 30);
    expect(recent.total_messages).toBe(1);

    const allTime = getChatStats(jid, 90);
    expect(allTime.total_messages).toBe(2);
    expect(allTime.days_covered).toBe(90);
  });

  it('returns correct top_senders ranking', () => {
    storeChatMetadata(jid, 'Stats Test', jid, 'test', false);
    // Alice sends 3 messages, Bob sends 2, Carol sends 1
    storeMsg('cs9', { sender: 'u1', sender_name: 'Alice' });
    storeMsg('cs10', { sender: 'u1', sender_name: 'Alice' });
    storeMsg('cs11', { sender: 'u1', sender_name: 'Alice' });
    storeMsg('cs12', { sender: 'u2', sender_name: 'Bob' });
    storeMsg('cs13', { sender: 'u2', sender_name: 'Bob' });
    storeMsg('cs14', { sender: 'u3', sender_name: 'Carol' });

    const stats = getChatStats(jid, 30);
    expect(stats.top_senders).toHaveLength(3);
    expect(stats.top_senders[0].sender_name).toBe('Alice');
    expect(stats.top_senders[0].count).toBe(3);
    expect(stats.top_senders[1].sender_name).toBe('Bob');
    expect(stats.top_senders[1].count).toBe(2);
    expect(stats.top_senders[2].sender_name).toBe('Carol');
    expect(stats.top_senders[2].count).toBe(1);
  });
});

// --- getTaskStats ---

function makeTaskForStats(id: string, folder: string) {
  createTask({
    id,
    group_folder: folder,
    chat_jid: 'stats@g.us',
    prompt: 'stats task',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: '2024-06-01T09:00:00.000Z',
    status: 'active',
    created_at: '2024-01-01T00:00:00.000Z',
  });
}

describe('getTaskStats', () => {
  it('returns zeroes when no runs exist', () => {
    makeTaskForStats('stats-task-0', 'gfolder-a');
    const stats = getTaskStats('gfolder-a', 7);
    expect(stats.total_runs).toBe(0);
    expect(stats.succeeded).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.active_tasks).toBe(0);
    expect(stats.by_task).toHaveLength(0);
  });

  it('counts success and error runs correctly', () => {
    makeTaskForStats('stats-task-1', 'gfolder-b');
    const now = new Date().toISOString();
    logTaskRun({
      task_id: 'stats-task-1',
      run_at: now,
      duration_ms: 500,
      status: 'success',
      result: 'ok',
      error: null,
    });
    logTaskRun({
      task_id: 'stats-task-1',
      run_at: now,
      duration_ms: 600,
      status: 'error',
      result: null,
      error: 'boom',
    });
    logTaskRun({
      task_id: 'stats-task-1',
      run_at: now,
      duration_ms: 700,
      status: 'success',
      result: 'ok2',
      error: null,
    });

    const stats = getTaskStats('gfolder-b', 7);
    expect(stats.total_runs).toBe(3);
    expect(stats.succeeded).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.active_tasks).toBe(1);
    expect(stats.by_task).toHaveLength(1);
    expect(stats.by_task[0].task_id).toBe('stats-task-1');
    expect(stats.by_task[0].total_runs).toBe(3);
    expect(stats.by_task[0].succeeded).toBe(2);
    expect(stats.by_task[0].failed).toBe(1);
  });

  it('only includes runs from the specified time window', () => {
    makeTaskForStats('stats-task-2', 'gfolder-c');
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    logTaskRun({
      task_id: 'stats-task-2',
      run_at: recent,
      duration_ms: 100,
      status: 'success',
      result: 'r',
      error: null,
    });
    logTaskRun({
      task_id: 'stats-task-2',
      run_at: old,
      duration_ms: 200,
      status: 'error',
      result: null,
      error: 'old',
    });

    const stats = getTaskStats('gfolder-c', 7);
    expect(stats.total_runs).toBe(1);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it('does not include runs from other group folders', () => {
    makeTaskForStats('stats-task-3a', 'gfolder-d1');
    makeTaskForStats('stats-task-3b', 'gfolder-d2');
    const now = new Date().toISOString();
    logTaskRun({
      task_id: 'stats-task-3a',
      run_at: now,
      duration_ms: 100,
      status: 'success',
      result: 'ok',
      error: null,
    });
    logTaskRun({
      task_id: 'stats-task-3b',
      run_at: now,
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'x',
    });

    const statsD1 = getTaskStats('gfolder-d1', 7);
    expect(statsD1.total_runs).toBe(1);
    expect(statsD1.succeeded).toBe(1);

    const statsD2 = getTaskStats('gfolder-d2', 7);
    expect(statsD2.total_runs).toBe(1);
    expect(statsD2.failed).toBe(1);
  });

  it('aggregates multiple tasks correctly', () => {
    makeTaskForStats('stats-task-4a', 'gfolder-e');
    makeTaskForStats('stats-task-4b', 'gfolder-e');
    const now = new Date().toISOString();
    logTaskRun({
      task_id: 'stats-task-4a',
      run_at: now,
      duration_ms: 100,
      status: 'success',
      result: 'ok',
      error: null,
    });
    logTaskRun({
      task_id: 'stats-task-4a',
      run_at: now,
      duration_ms: 100,
      status: 'success',
      result: 'ok',
      error: null,
    });
    logTaskRun({
      task_id: 'stats-task-4b',
      run_at: now,
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'err',
    });

    const stats = getTaskStats('gfolder-e', 7);
    expect(stats.total_runs).toBe(3);
    expect(stats.active_tasks).toBe(2);
    expect(stats.by_task).toHaveLength(2);
    // task-4a should be first (more runs)
    expect(stats.by_task[0].task_id).toBe('stats-task-4a');
    expect(stats.by_task[0].total_runs).toBe(2);
  });
});

// --- getTaskHistory ---

describe('getTaskHistory', () => {
  function makeTask(id: string, folder: string, name?: string) {
    createTask({
      id,
      group_folder: folder,
      chat_jid: `${folder}@g.us`,
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
      name: name ?? null,
      script: null,
      context_mode: 'group',
      notify_on_success: null,
    });
  }

  function makeLog(taskId: string, status: 'success' | 'error', daysAgo = 0) {
    logTaskRun({
      task_id: taskId,
      run_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      duration_ms: 1000,
      status,
      result: status === 'success' ? 'ok' : null,
      error: status === 'error' ? 'boom' : null,
    });
  }

  it('returns empty array when no runs exist', () => {
    expect(getTaskHistory('no-runs', 50, 7)).toHaveLength(0);
  });

  it('returns runs for the group in newest-first order', () => {
    makeTask('th-task-a', 'th-group');
    makeLog('th-task-a', 'success', 2);
    makeLog('th-task-a', 'error', 0);

    const history = getTaskHistory('th-group', 50, 7);
    expect(history).toHaveLength(2);
    // Most recent first
    expect(history[0].status).toBe('error');
    expect(history[1].status).toBe('success');
  });

  it('joins task name correctly', () => {
    makeTask('th-task-named', 'th-named-group', 'My Task');
    makeLog('th-task-named', 'success');

    const [entry] = getTaskHistory('th-named-group', 50, 7);
    expect(entry.task_name).toBe('My Task');
    expect(entry.task_id).toBe('th-task-named');
  });

  it('isolates by group_folder', () => {
    makeTask('th-x', 'th-gx');
    makeTask('th-y', 'th-gy');
    makeLog('th-x', 'success');
    makeLog('th-y', 'success');

    expect(getTaskHistory('th-gx', 50, 7)).toHaveLength(1);
    expect(getTaskHistory('th-gy', 50, 7)).toHaveLength(1);
  });

  it('respects fromDays cutoff', () => {
    makeTask('th-old', 'th-old-group');
    makeLog('th-old', 'success', 10); // 10 days ago — outside 7-day window
    makeLog('th-old', 'success', 1); // 1 day ago — inside window

    const history = getTaskHistory('th-old-group', 50, 7);
    expect(history).toHaveLength(1);
  });

  it('respects limit', () => {
    makeTask('th-lim', 'th-lim-group');
    makeLog('th-lim', 'success');
    makeLog('th-lim', 'success');
    makeLog('th-lim', 'success');

    expect(getTaskHistory('th-lim-group', 2, 7)).toHaveLength(2);
  });
});

// --- setAllTasksStatus ---

describe('setAllTasksStatus', () => {
  function makeTask(id: string, folder: string, status: 'active' | 'paused') {
    createTask({
      id,
      group_folder: folder,
      chat_jid: `${folder}@g.us`,
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      next_run: new Date().toISOString(),
      status,
      created_at: new Date().toISOString(),
      name: null,
      script: null,
      context_mode: 'group',
      notify_on_success: null,
    });
  }

  it('pauses all active tasks for a group', () => {
    makeTask('sat-a1', 'sat-group', 'active');
    makeTask('sat-a2', 'sat-group', 'active');
    makeTask('sat-p1', 'sat-group', 'paused');

    const changed = setAllTasksStatus('sat-group', 'paused', 'active');
    expect(changed).toBe(2);
    expect(getTaskById('sat-a1')!.status).toBe('paused');
    expect(getTaskById('sat-a2')!.status).toBe('paused');
    expect(getTaskById('sat-p1')!.status).toBe('paused'); // already paused
  });

  it('resumes all paused tasks for a group', () => {
    makeTask('sat-b1', 'sat-b-group', 'paused');
    makeTask('sat-b2', 'sat-b-group', 'paused');

    const changed = setAllTasksStatus('sat-b-group', 'active', 'paused');
    expect(changed).toBe(2);
    expect(getTaskById('sat-b1')!.status).toBe('active');
    expect(getTaskById('sat-b2')!.status).toBe('active');
  });

  it('returns 0 when no tasks match', () => {
    expect(setAllTasksStatus('empty-group', 'paused', 'active')).toBe(0);
  });

  it('isolates by group_folder', () => {
    makeTask('sat-c1', 'sat-c1-group', 'active');
    makeTask('sat-c2', 'sat-c2-group', 'active');

    setAllTasksStatus('sat-c1-group', 'paused', 'active');
    expect(getTaskById('sat-c1')!.status).toBe('paused');
    expect(getTaskById('sat-c2')!.status).toBe('active'); // untouched
  });

  it('changes all statuses when currentStatus is omitted', () => {
    makeTask('sat-d1', 'sat-d-group', 'active');
    makeTask('sat-d2', 'sat-d-group', 'paused');

    const changed = setAllTasksStatus('sat-d-group', 'paused');
    expect(changed).toBe(2);
  });
});

// --- deleteAllTasks ---

describe('deleteAllTasks', () => {
  function makeTask(id: string, folder: string, status: 'active' | 'paused') {
    createTask({
      id,
      group_folder: folder,
      chat_jid: `${folder}@g.us`,
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      next_run: new Date().toISOString(),
      status,
      created_at: new Date().toISOString(),
      name: null,
      script: null,
      context_mode: 'group',
      notify_on_success: null,
    });
  }

  it('deletes all tasks for a group when no status filter', () => {
    makeTask('dat-a1', 'dat-group', 'active');
    makeTask('dat-a2', 'dat-group', 'paused');

    const deleted = deleteAllTasks('dat-group');
    expect(deleted).toBe(2);
    expect(getTaskById('dat-a1')).toBeUndefined();
    expect(getTaskById('dat-a2')).toBeUndefined();
  });

  it('only deletes tasks matching the status filter', () => {
    makeTask('dat-b1', 'dat-b-group', 'active');
    makeTask('dat-b2', 'dat-b-group', 'paused');

    const deleted = deleteAllTasks('dat-b-group', 'active');
    expect(deleted).toBe(1);
    expect(getTaskById('dat-b1')).toBeUndefined();
    expect(getTaskById('dat-b2')).toBeDefined(); // paused task untouched
  });

  it('returns 0 when no tasks match', () => {
    expect(deleteAllTasks('empty-dat-group')).toBe(0);
  });

  it('isolates by group_folder', () => {
    makeTask('dat-c1', 'dat-c1-group', 'active');
    makeTask('dat-c2', 'dat-c2-group', 'active');

    deleteAllTasks('dat-c1-group');
    expect(getTaskById('dat-c1')).toBeUndefined();
    expect(getTaskById('dat-c2')).toBeDefined(); // other group untouched
  });

  it('also removes associated task_run_logs', () => {
    makeTask('dat-d1', 'dat-d-group', 'active');
    logTaskRun({
      task_id: 'dat-d1',
      run_at: new Date().toISOString(),
      duration_ms: 100,
      status: 'success',
      result: 'ok',
      error: null,
    });

    deleteAllTasks('dat-d-group');
    // Task is gone
    expect(getTaskById('dat-d1')).toBeUndefined();
    // Logs are gone too (no FK violation on re-insert with same task id)
    const logs = getRecentTaskRunLogs('dat-d1', 10);
    expect(logs).toHaveLength(0);
  });
});

// --- incrementTaskRunCount ---

describe('incrementTaskRunCount', () => {
  function makeTask(id: string) {
    createTask({
      id,
      group_folder: 'itrc-group',
      chat_jid: 'itrc@g.us',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
      name: null,
      script: null,
      context_mode: 'group',
      notify_on_success: null,
      max_runs: 3,
      run_count: 0,
    });
  }

  it('starts at 0 and increments to 1', () => {
    makeTask('itrc-1');
    const count = incrementTaskRunCount('itrc-1');
    expect(count).toBe(1);
    expect(getTaskById('itrc-1')!.run_count).toBe(1);
  });

  it('increments across multiple calls', () => {
    makeTask('itrc-2');
    incrementTaskRunCount('itrc-2');
    incrementTaskRunCount('itrc-2');
    const count = incrementTaskRunCount('itrc-2');
    expect(count).toBe(3);
  });

  it('returns 0 for unknown task id', () => {
    const count = incrementTaskRunCount('nonexistent-task-id');
    expect(count).toBe(0);
  });
});

// --- setRetryAttempt + retry_on_failure ---

describe('setRetryAttempt and retry_on_failure', () => {
  function makeRetryTask(id: string, retryOnFailure = 3) {
    createTask({
      id,
      group_folder: 'retry-group',
      chat_jid: 'retry@g.us',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
      name: null,
      script: null,
      context_mode: 'isolated',
      notify_on_success: null,
      max_runs: null,
      run_count: 0,
      retry_on_failure: retryOnFailure,
      retry_attempt: 0,
    });
  }

  it('stores retry_on_failure and retry_attempt on creation', () => {
    makeRetryTask('rt-1', 2);
    const task = getTaskById('rt-1')!;
    expect(task.retry_on_failure).toBe(2);
    expect(task.retry_attempt).toBe(0);
  });

  it('setRetryAttempt updates the attempt counter', () => {
    makeRetryTask('rt-2');
    setRetryAttempt('rt-2', 1);
    expect(getTaskById('rt-2')!.retry_attempt).toBe(1);
    setRetryAttempt('rt-2', 2);
    expect(getTaskById('rt-2')!.retry_attempt).toBe(2);
  });

  it('setRetryAttempt can reset to 0', () => {
    makeRetryTask('rt-3');
    setRetryAttempt('rt-3', 3);
    setRetryAttempt('rt-3', 0);
    expect(getTaskById('rt-3')!.retry_attempt).toBe(0);
  });

  it('updateTask can change retry_on_failure', () => {
    makeRetryTask('rt-4', 1);
    updateTask('rt-4', { retry_on_failure: 5 });
    expect(getTaskById('rt-4')!.retry_on_failure).toBe(5);
    updateTask('rt-4', { retry_on_failure: 0 });
    expect(getTaskById('rt-4')!.retry_on_failure).toBe(0);
  });

  it('defaults to 0 when not specified', () => {
    createTask({
      id: 'rt-5',
      group_folder: 'retry-group',
      chat_jid: 'retry@g.us',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
      name: null,
      script: null,
      context_mode: 'isolated',
      notify_on_success: null,
      max_runs: null,
      run_count: 0,
    });
    const task = getTaskById('rt-5')!;
    expect(task.retry_on_failure ?? 0).toBe(0);
    expect(task.retry_attempt ?? 0).toBe(0);
  });
});
