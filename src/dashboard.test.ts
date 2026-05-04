import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'http';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./config.js', () => ({
  CREDENTIAL_PROXY_PORT: 3001,
  DASHBOARD_PORT: 4000,
  SCOUT_MCP_URL: '',
  WEBHOOK_TOKEN: 'test-secret-token',
}));

const mockGetTaskById = vi.fn();
const mockUpdateTask = vi.fn();
const mockGetAllTasks = vi.fn(() => []);
const mockGetAllRegisteredGroups = vi.fn(() => []);

vi.mock('./db.js', () => ({
  getTaskById: (...args: unknown[]) => mockGetTaskById(...args),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  getAllTasks: (...args: unknown[]) => mockGetAllTasks(...args),
  getAllRegisteredGroups: (...args: unknown[]) =>
    mockGetAllRegisteredGroups(...args),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock execSync for git info
vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'mock-value'),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Make an HTTP request to the given server and return { status, body }. */
function httpRequest(
  server: http.Server,
  options: { method: string; path: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: options.path,
        method: options.method,
        headers: options.headers ?? {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Start the dashboard on a random available port, return the server. */
async function startTestDashboard(): Promise<http.Server> {
  const { startDashboard } = await import('./dashboard.js');
  const srv = startDashboard(0); // port 0 = OS assigns an ephemeral port
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  return srv;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('dashboard webhook', () => {
  let server: http.Server;

  afterEach(() => {
    server?.close();
    vi.clearAllMocks();
  });

  it('POST /webhook/task/:id with valid token triggers task', async () => {
    server = await startTestDashboard();

    mockGetTaskById.mockReturnValue({
      id: 'task-abc123',
      name: 'My Task',
      group_folder: 'main',
      status: 'active',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      next_run: null,
      prompt: 'Do something',
    });

    const res = await httpRequest(server, {
      method: 'POST',
      path: '/webhook/task/task-abc123',
      headers: { Authorization: 'Bearer test-secret-token' },
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.taskId).toBe('task-abc123');
    expect(body.name).toBe('My Task');
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'task-abc123',
      expect.objectContaining({
        status: 'active',
        next_run: expect.any(String),
      }),
    );
  });

  it('POST /webhook/task/:id with token in query param works', async () => {
    server = await startTestDashboard();

    mockGetTaskById.mockReturnValue({
      id: 'task-xyz',
      name: null,
      group_folder: 'main',
      status: 'active',
      schedule_type: 'interval',
      schedule_value: '3600000',
      next_run: null,
      prompt: 'Do something',
    });

    const res = await httpRequest(server, {
      method: 'POST',
      path: '/webhook/task/task-xyz?token=test-secret-token',
    });

    expect(res.status).toBe(200);
    expect(mockUpdateTask).toHaveBeenCalled();
  });

  it('POST /webhook/task/:id with wrong token returns 401', async () => {
    server = await startTestDashboard();

    const res = await httpRequest(server, {
      method: 'POST',
      path: '/webhook/task/task-abc123',
      headers: { Authorization: 'Bearer wrong-token' },
    });

    expect(res.status).toBe(401);
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it('POST /webhook/task/:id with no token returns 401', async () => {
    server = await startTestDashboard();

    const res = await httpRequest(server, {
      method: 'POST',
      path: '/webhook/task/task-abc123',
    });

    expect(res.status).toBe(401);
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it('POST /webhook/task/:id for unknown task returns 404', async () => {
    server = await startTestDashboard();
    mockGetTaskById.mockReturnValue(undefined);

    const res = await httpRequest(server, {
      method: 'POST',
      path: '/webhook/task/no-such-task',
      headers: { Authorization: 'Bearer test-secret-token' },
    });

    expect(res.status).toBe(404);
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it('GET /webhook/tasks with valid token returns task list', async () => {
    server = await startTestDashboard();

    mockGetAllTasks.mockReturnValue([
      {
        id: 'task-1',
        name: 'Daily Report',
        group_folder: 'main',
        status: 'active',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        next_run: '2026-05-05T09:00:00.000Z',
        prompt: 'Generate report',
      },
    ]);

    const res = await httpRequest(server, {
      method: 'GET',
      path: '/webhook/tasks',
      headers: { Authorization: 'Bearer test-secret-token' },
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      tasks: Array<{ id: string; endpoint: string }>;
    };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe('task-1');
    expect(body.tasks[0].endpoint).toBe('/webhook/task/task-1');
  });

  it('GET /webhook/tasks with wrong token returns 401', async () => {
    server = await startTestDashboard();

    const res = await httpRequest(server, {
      method: 'GET',
      path: '/webhook/tasks',
      headers: { Authorization: 'Bearer wrong' },
    });

    expect(res.status).toBe(401);
  });
});
