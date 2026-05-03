import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  retryDelayMs,
  startSchedulerLoop,
} from './task-scheduler.js';
import { runContainerAgent } from './container-runner.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('sends failure notification to group chat when a task errors', async () => {
    // Register a valid group so task-scheduler can find it
    const { setRegisteredGroup } = await import('./db.js');
    setRegisteredGroup('notif@g.us', {
      name: 'Notif Group',
      folder: 'notif-group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    createTask({
      id: 'task-fail-notif',
      group_folder: 'notif-group',
      chat_jid: 'notif@g.us',
      prompt: 'will fail',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    // Mock runContainerAgent to return an error
    vi.mocked(runContainerAgent).mockResolvedValueOnce({
      status: 'error',
      error: 'Container OOM',
      result: null,
    });

    const sentMessages: { jid: string; text: string }[] = [];
    const sendMessage = vi.fn(async (jid: string, text: string) => {
      sentMessages.push({ jid, text });
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'notif@g.us': {
          name: 'Notif Group',
          folder: 'notif-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(100);

    // sendMessage should have been called with an error notification
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].jid).toBe('notif@g.us');
    expect(sentMessages[0].text).toMatch(/⚠️.*failed.*Container OOM/i);
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('auto-cancels task and notifies group when max_runs is reached', async () => {
    const { setRegisteredGroup } = await import('./db.js');
    setRegisteredGroup('maxruns@g.us', {
      name: 'MaxRuns Group',
      folder: 'maxruns-group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    createTask({
      id: 'task-max-runs',
      group_folder: 'maxruns-group',
      chat_jid: 'maxruns@g.us',
      prompt: 'run once then stop',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      max_runs: 1,
      run_count: 0,
    });

    vi.mocked(runContainerAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'done',
    });

    const sentMessages: { jid: string; text: string }[] = [];
    const sendMessage = vi.fn(async (jid: string, text: string) => {
      sentMessages.push({ jid, text });
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'maxruns@g.us': {
          name: 'MaxRuns Group',
          folder: 'maxruns-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(100);

    // Task should be deleted from the DB after reaching max_runs
    expect(getTaskById('task-max-runs')).toBeUndefined();

    // Should have sent the completion message
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].jid).toBe('maxruns@g.us');
    expect(sentMessages[0].text).toMatch(/🏁.*1 scheduled run/);
  });

  it('does not auto-cancel when max_runs not set', async () => {
    const { setRegisteredGroup } = await import('./db.js');
    setRegisteredGroup('unlimited@g.us', {
      name: 'Unlimited Group',
      folder: 'unlimited-group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    createTask({
      id: 'task-unlimited',
      group_folder: 'unlimited-group',
      chat_jid: 'unlimited@g.us',
      prompt: 'run forever',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      max_runs: null,
      run_count: 0,
    });

    vi.mocked(runContainerAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'done',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'unlimited@g.us': {
          name: 'Unlimited Group',
          folder: 'unlimited-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(100);

    // Task should still exist (not auto-cancelled)
    expect(getTaskById('task-unlimited')).toBeDefined();
  });
});

// --- retryDelayMs ---

describe('retryDelayMs', () => {
  it('returns 60s for first attempt', () => {
    expect(retryDelayMs(1)).toBe(60_000);
  });

  it('returns 5min for second attempt', () => {
    expect(retryDelayMs(2)).toBe(300_000);
  });

  it('caps at 30min for third attempt and beyond', () => {
    expect(retryDelayMs(3)).toBe(1_800_000);
    expect(retryDelayMs(5)).toBe(1_800_000);
  });
});

// --- retry_on_failure in scheduler ---

describe('task retry on failure', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules retry instead of final failure notification on first failure', async () => {
    createTask({
      id: 'task-retry',
      group_folder: 'retry-group',
      chat_jid: 'retry@g.us',
      prompt: 'run',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
      retry_on_failure: 2,
      retry_attempt: 0,
    });

    vi.mocked(runContainerAgent).mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'Container crashed',
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'retry@g.us': {
          name: 'Retry Group',
          folder: 'retry-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(200);

    const task = getTaskById('task-retry')!;
    // retry_attempt should have been incremented to 1
    expect(task.retry_attempt).toBe(1);

    // A retry notification should have been sent, not a failure notification
    const sentMessages = sendMessage.mock.calls.map((c) => c[1] as string);
    expect(sentMessages.some((m) => m.includes('⏱️'))).toBe(true);
    expect(sentMessages.some((m) => m.includes('⚠️'))).toBe(false);

    // next_run should be ~60s in the future (first retry delay)
    const nextRun = new Date(task.next_run!).getTime();
    const now = Date.now();
    expect(nextRun).toBeGreaterThan(now + 50_000);
    expect(nextRun).toBeLessThan(now + 70_000);
  });

  it('sends failure notification after all retries are exhausted', async () => {
    createTask({
      id: 'task-exhausted',
      group_folder: 'retry-group',
      chat_jid: 'retry@g.us',
      prompt: 'run',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
      retry_on_failure: 2,
      retry_attempt: 2, // already used all retries
    });

    vi.mocked(runContainerAgent).mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'Still broken',
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'retry@g.us': {
          name: 'Retry Group',
          folder: 'retry-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(200);

    const task = getTaskById('task-exhausted')!;
    // retry_attempt should be reset to 0
    expect(task.retry_attempt).toBe(0);

    // Should have sent the final failure notification (⚠️) not a retry notice
    const sentMessages = sendMessage.mock.calls.map((c) => c[1] as string);
    expect(
      sentMessages.some(
        (m) => m.includes('⚠️') && m.includes('all retries exhausted'),
      ),
    ).toBe(true);
    expect(sentMessages.some((m) => m.includes('⏱️'))).toBe(false);
  });

  it('resets retry_attempt to 0 on task success after previous failures', async () => {
    createTask({
      id: 'task-recovered',
      group_folder: 'retry-group',
      chat_jid: 'retry@g.us',
      prompt: 'run',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
      retry_on_failure: 3,
      retry_attempt: 1, // was on first retry, now succeeds
    });

    vi.mocked(runContainerAgent).mockResolvedValueOnce({
      status: 'success',
      result: 'All good',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'retry@g.us': {
          name: 'Retry Group',
          folder: 'retry-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(200);

    // retry_attempt should be reset to 0 after success
    expect(getTaskById('task-recovered')!.retry_attempt).toBe(0);
  });
});
