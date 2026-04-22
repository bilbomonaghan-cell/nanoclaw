/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
    target_jid: z.string().optional().describe('(Main group only) JID of a different registered group to send the message to. Defaults to the current group. Useful for broadcasting updates cross-group.'),
  },
  async (args) => {
    // Non-main groups cannot send to other groups
    const targetJid = isMain && args.target_jid ? args.target_jid : chatJid;
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid: targetJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    const targetNote = targetJid !== chatJid ? ` (→ ${targetJid})` : '';
    return { content: [{ type: 'text' as const, text: `Message sent${targetNote}.` }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    name: z.string().optional().describe('Short human-readable label for this task (e.g. "Daily weather briefing"). Shows in list_tasks instead of the raw ID prefix. Optional but recommended for recurring tasks.'),
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
    script: z.string().optional().describe(`Optional bash script that runs BEFORE the agent. Must print JSON to stdout: {"wakeAgent": true/false, "data": {...}}. If wakeAgent is false, the agent is skipped and the task waits for its next run — saving API credits. The data object is serialized and appended to the prompt when the agent does run.

Always test your script first with: bash -c '...'

Example — only wake agent if there are open PRs:
\`\`\`bash
prs=$(curl -s "https://api.github.com/repos/owner/repo/pulls?state=open" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(JSON.stringify({wakeAgent:d.length>0,data:{count:d.length,titles:d.slice(0,3).map(p=>p.title)}}))")
echo "$prs"
\`\`\``),
    notify_on_success: z
      .boolean()
      .optional()
      .describe(
        'Send a "✅ Task completed in Xs" message to the group when the task succeeds (default: false). Useful for maintenance tasks where you want to confirm completion. For tasks that always send a result message, leave this off to avoid double-messaging.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data: Record<string, string | undefined> = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };
    if (args.script) data.script = args.script;
    if (args.notify_on_success) data.notifyOnSuccess = String(args.notify_on_success);
    if (args.name) data.taskName = args.name;

    writeIpcFile(TASKS_DIR, data);

    const nameDisplay = args.name ? ` "${args.name}"` : '';
    return {
      content: [{ type: 'text' as const, text: `Task${nameDisplay} ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks. Supports optional filtering by status and keyword.",
  {
    status: z.enum(['active', 'paused']).optional().describe('Filter by task status. Omit to show all tasks.'),
    keyword: z.string().optional().describe('Filter tasks whose name or prompt contains this keyword (case-insensitive).'),
  },
  async (args) => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      // Apply optional status filter
      let filtered = tasks;
      if (args.status) {
        filtered = filtered.filter((t: { status: string }) => t.status === args.status);
      }
      if (args.keyword) {
        const kw = args.keyword.toLowerCase();
        filtered = filtered.filter((t: { name?: string | null; prompt: string }) =>
          (t.name && t.name.toLowerCase().includes(kw)) || t.prompt.toLowerCase().includes(kw)
        );
      }

      if (filtered.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = filtered
        .map(
          (t: { id: string; name?: string | null; prompt: string; schedule_type: string; schedule_value: string; context_mode?: string; script?: string; status: string; next_run?: string | null; last_run?: string | null }) => {
            const label = t.name ? `"${t.name}" [${t.id}]` : `[${t.id}]`;
            const promptPreview = t.prompt.length > 60 ? t.prompt.slice(0, 60) + '…' : t.prompt;
            const mode = t.context_mode || 'group';
            const scriptFlag = t.script ? ' [script]' : '';
            const next = t.next_run ? t.next_run.slice(0, 16).replace('T', ' ') : 'N/A';
            const lastRun = t.last_run ? t.last_run.slice(0, 16).replace('T', ' ') : 'never';
            return `- ${label} ${promptPreview}\n  ${t.schedule_type}: ${t.schedule_value} | ${mode}${scriptFlag} | ${t.status} | next: ${next} | last: ${lastRun}`;
          },
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks (${filtered.length}):\n\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'get_task',
  'Get full details for a specific scheduled task by ID, including its prompt, script, last result, and run history.',
  {
    task_id: z.string().describe('The task ID to look up'),
  },
  async (args) => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
      const task = allTasks.find((t: { id: string; groupFolder?: string }) =>
        t.id === args.task_id && (isMain || t.groupFolder === groupFolder)
      );

      if (!task) {
        return { content: [{ type: 'text' as const, text: `Task "${args.task_id}" not found.` }] };
      }

      const lines: string[] = [
        `**Task: ${task.id}**`,
        ...(task.name ? [`Name: ${task.name}`] : []),
        `Status: ${task.status}`,
        `Schedule: ${task.schedule_type} — ${task.schedule_value}`,
        `Context mode: ${task.context_mode || 'group'}`,
        `Notify on success: ${task.notify_on_success ? 'yes' : 'no'}`,
        `Next run: ${task.next_run || 'N/A'}`,
        `Last run: ${task.last_run || 'never'}`,
        `Created: ${task.created_at || 'unknown'}`,
        `Group: ${task.groupFolder || 'unknown'}`,
        ``,
        `**Prompt:**`,
        task.prompt,
      ];

      if (task.script) {
        lines.push(``, `**Pre-flight script:**`, `\`\`\`bash`, task.script, `\`\`\``);
      }

      if (task.last_result) {
        const truncated = task.last_result.length > 500
          ? task.last_result.slice(0, 500) + '…'
          : task.last_result;
        lines.push(``, `**Last result:**`, truncated);
      }

      // Show recent run history if available
      const recentRuns = task.recent_runs as Array<{ id?: number; run_at: string; duration_ms: number; status: string; error?: string | null }> | undefined;
      if (recentRuns && recentRuns.length > 0) {
        lines.push(``, `**Recent runs (last ${recentRuns.length}):**`);
        for (const run of recentRuns) {
          const ts = run.run_at.slice(0, 16).replace('T', ' ');
          const durationSec = (run.duration_ms / 1000).toFixed(1);
          const icon = run.status === 'success' ? '✅' : '❌';
          const errSuffix = run.error ? ` — ${run.error.slice(0, 80)}` : '';
          const idHint = run.id ? ` [log #${run.id}]` : '';
          lines.push(`  ${icon} ${ts} (${durationSec}s)${idHint}${errSuffix}`);
        }
        lines.push(`  (Use get_task_log with a log ID to see full output)`);
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading task: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'get_task_log',
  'Retrieve the full output (result or error) from a specific task run. Use get_task to see recent run IDs (log #N), then pass the ID here to fetch the complete output.',
  {
    log_id: z.number().int().describe('The run log ID shown as "log #N" in get_task output'),
  },
  async (args) => {
    const queryId = `tl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ipcTasksDir = '/workspace/ipc/tasks';
    const responseFile = `${RESPONSES_DIR}/${queryId}.json`;

    fs.mkdirSync(ipcTasksDir, { recursive: true });
    fs.writeFileSync(
      `${ipcTasksDir}/get_task_log_${queryId}.json`,
      JSON.stringify({
        type: 'get_task_log',
        queryId,
        runLogId: args.log_id,
      }),
      'utf-8',
    );

    // Poll for response
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 200));
      if (fs.existsSync(responseFile)) {
        const raw = JSON.parse(fs.readFileSync(responseFile, 'utf-8')) as {
          log?: {
            id?: number;
            task_id: string;
            run_at: string;
            duration_ms: number;
            status: string;
            result?: string | null;
            error?: string | null;
          };
          error?: string;
        };
        try { fs.unlinkSync(responseFile); } catch { /* ignore */ }

        if (raw.error) {
          return { content: [{ type: 'text' as const, text: `Error: ${raw.error}` }], isError: true };
        }
        const log = raw.log;
        if (!log) {
          return { content: [{ type: 'text' as const, text: 'No log entry returned.' }], isError: true };
        }

        const ts = log.run_at.slice(0, 19).replace('T', ' ');
        const durationSec = (log.duration_ms / 1000).toFixed(1);
        const icon = log.status === 'success' ? '✅' : '❌';
        const lines: string[] = [
          `**Task run log #${log.id ?? args.log_id}** — task ${log.task_id}`,
          `${icon} ${ts} UTC | ${durationSec}s | ${log.status}`,
          '',
        ];
        if (log.result) {
          lines.push('**Output:**', log.result);
        } else if (log.error) {
          lines.push('**Error:**', log.error);
        } else {
          lines.push('(no output recorded)');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }
    }

    return {
      content: [{ type: 'text' as const, text: 'Timed out waiting for host response. Try again in a moment.' }],
      isError: true,
    };
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'run_task_now',
  'Trigger a scheduled task to run immediately, bypassing its normal schedule. The task will run within the next scheduler poll (up to 60 seconds). Useful for testing a task or triggering a one-off manual run without changing its schedule.',
  {
    task_id: z.string().describe('The ID of the task to run immediately'),
  },
  async (args) => {
    const data = {
      type: 'run_task_now',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} scheduled for immediate run (picks up on next scheduler poll, within ~60s).`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    name: z.string().nullable().optional().describe('New human-readable label, or null to clear the current name'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
    script: z.string().nullable().optional().describe('New pre-flight bash script, or null to remove an existing script'),
    context_mode: z.enum(['group', 'isolated']).optional().describe('New context mode (group=with chat history, isolated=fresh session)'),
    notify_on_success: z.boolean().optional().describe('Enable or disable success notifications for this task'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined | null> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.name !== undefined) data.taskName = args.name ?? '';    // empty string signals "clear name"
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;
    if (args.script !== undefined) data.script = args.script ?? '';   // empty string signals "clear script"
    if (args.context_mode !== undefined) data.context_mode = args.context_mode;
    if (args.notify_on_success !== undefined)
      data.notifyOnSuccess = String(args.notify_on_success);

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// ─── Structured Memory Tools ─────────────────────────────────────────────────

const MEMORY_FILE = '/workspace/group/memory.json';

interface MemoryEntry {
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface MemoryStore {
  version: number;
  memories: Record<string, MemoryEntry>;
}

function readMemoryStore(): MemoryStore {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8')) as MemoryStore;
    }
  } catch { /* ignore parse errors */ }
  return { version: 1, memories: {} };
}

function writeMemoryStore(store: MemoryStore): void {
  const tempPath = `${MEMORY_FILE}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(store, null, 2));
  fs.renameSync(tempPath, MEMORY_FILE);
}

server.tool(
  'memory_store',
  `Store or update a structured memory entry. Each memory has a unique key, text content, and optional tags for later retrieval. Use this to remember facts, preferences, notes, or any information that should persist across sessions.

Examples:
- key: "user_prefs", content: "Berfday prefers brief responses and metric units", tags: ["preferences", "user"]
- key: "project_status", content: "Working on nanoclaw Ollama integration", tags: ["projects", "nanoclaw"]`,
  {
    key: z.string().describe('Unique identifier for this memory (e.g., "user_prefs", "todo_list")'),
    content: z.string().describe('The text content to store'),
    tags: z.array(z.string()).optional().describe('Optional tags for categorization and search (e.g., ["preferences", "user"])'),
  },
  async (args) => {
    const store = readMemoryStore();
    const now = new Date().toISOString();
    const existing = store.memories[args.key];

    store.memories[args.key] = {
      content: args.content,
      tags: args.tags || [],
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    writeMemoryStore(store);
    return { content: [{ type: 'text' as const, text: `Memory "${args.key}" stored (${Object.keys(store.memories).length} total entries).` }] };
  },
);

server.tool(
  'memory_search',
  'Search stored memories by content substring and/or tags. Returns all matching entries.',
  {
    query: z.string().optional().describe('Case-insensitive substring to search in memory content'),
    tags: z.array(z.string()).optional().describe('Filter to memories that have ALL of these tags'),
  },
  async (args) => {
    const store = readMemoryStore();
    const entries = Object.entries(store.memories);

    if (entries.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No memories stored yet.' }] };
    }

    const results = entries.filter(([, entry]) => {
      if (args.query && !entry.content.toLowerCase().includes(args.query.toLowerCase())) return false;
      if (args.tags && args.tags.length > 0) {
        if (!args.tags.every(t => entry.tags.includes(t))) return false;
      }
      return true;
    });

    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No memories match that search.' }] };
    }

    const formatted = results.map(([key, entry]) =>
      `**${key}** [${entry.tags.join(', ') || 'no tags'}]\n${entry.content}\n_(updated: ${entry.updated_at.slice(0, 10)})_`
    ).join('\n\n');

    return { content: [{ type: 'text' as const, text: `Found ${results.length} memor${results.length === 1 ? 'y' : 'ies'}:\n\n${formatted}` }] };
  },
);

server.tool(
  'memory_list',
  'List all stored memory keys with their tags and a content preview.',
  {
    tags: z.array(z.string()).optional().describe('Optional: filter to memories that have ALL of these tags'),
  },
  async (args) => {
    const store = readMemoryStore();
    const entries = Object.entries(store.memories);

    if (entries.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No memories stored yet.' }] };
    }

    const filtered = args.tags && args.tags.length > 0
      ? entries.filter(([, e]) => args.tags!.every(t => e.tags.includes(t)))
      : entries;

    if (filtered.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No memories match those tags.' }] };
    }

    const lines = filtered.map(([key, entry]) => {
      const preview = entry.content.length > 80 ? entry.content.slice(0, 80) + '…' : entry.content;
      const tagsStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
      return `• **${key}**${tagsStr}: ${preview}`;
    });

    return { content: [{ type: 'text' as const, text: `${filtered.length} memor${filtered.length === 1 ? 'y' : 'ies'}:\n\n${lines.join('\n')}` }] };
  },
);

server.tool(
  'memory_delete',
  'Delete a stored memory entry by key.',
  {
    key: z.string().describe('The memory key to delete'),
  },
  async (args) => {
    const store = readMemoryStore();

    if (!store.memories[args.key]) {
      return { content: [{ type: 'text' as const, text: `No memory found with key "${args.key}".` }] };
    }

    delete store.memories[args.key];
    writeMemoryStore(store);
    return { content: [{ type: 'text' as const, text: `Memory "${args.key}" deleted.` }] };
  },
);

server.tool(
  'memory_append',
  `Append a line of text to an existing memory entry. Useful for list-style memories (todo lists, logs, running notes) where you want to add an item without rewriting the whole entry.

If the key doesn't exist yet, it will be created with the appended text as the initial content.

Examples:
- key: "todo_list", text: "- Research Ollama streaming API"
- key: "session_log", text: "Apr 10: Added memory_append tool"`,
  {
    key: z.string().describe('The memory key to append to'),
    text: z.string().describe('Text to append as a new line'),
    tags: z.array(z.string()).optional().describe('Tags to set if creating a new entry (ignored on existing entries)'),
  },
  async (args) => {
    const store = readMemoryStore();
    const now = new Date().toISOString();
    const existing = store.memories[args.key];

    if (existing) {
      store.memories[args.key] = {
        ...existing,
        content: existing.content + '\n' + args.text,
        updated_at: now,
      };
    } else {
      store.memories[args.key] = {
        content: args.text,
        tags: args.tags || [],
        created_at: now,
        updated_at: now,
      };
    }

    writeMemoryStore(store);
    const action = existing ? 'appended to' : 'created';
    return { content: [{ type: 'text' as const, text: `Memory "${args.key}" ${action}.` }] };
  },
);

// ─── Health Check Tool ────────────────────────────────────────────────────────

server.tool(
  'health_check',
  `Check the health of key system components from within the container. Returns a status report for:
- Ollama (local LLM server at host.docker.internal:11434)
- Workspace mounts (/workspace/group, /workspace/ipc, /workspace/project)
- IPC directory writability
- Memory file (if it exists)

Use this to proactively check if anything looks degraded before starting work, or to diagnose issues.`,
  {
    components: z.array(z.enum(['ollama', 'mounts', 'ipc', 'memory'])).optional()
      .describe('Specific components to check. Defaults to all components.'),
  },
  async (args) => {
    const check = args.components ?? ['ollama', 'mounts', 'ipc', 'memory'];
    const results: Array<{ name: string; status: 'ok' | 'warn' | 'error'; detail: string }> = [];

    if (check.includes('ollama')) {
      try {
        const resp = await fetch('http://host.docker.internal:11434/api/tags', {
          signal: AbortSignal.timeout(5_000),
        });
        if (resp.ok) {
          const data = await resp.json() as { models?: Array<{ name: string }> };
          const count = data.models?.length ?? 0;
          results.push({
            name: 'Ollama',
            status: 'ok',
            detail: `Running — ${count} model${count === 1 ? '' : 's'} installed${count > 0 ? ': ' + data.models!.slice(0, 3).map(m => m.name).join(', ') : ''}`,
          });
        } else {
          results.push({ name: 'Ollama', status: 'warn', detail: `HTTP ${resp.status}` });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const hint = msg.includes('ECONNREFUSED') || msg.includes('fetch failed')
          ? 'not running — start with: ollama serve'
          : msg;
        results.push({ name: 'Ollama', status: 'warn', detail: hint });
      }
    }

    if (check.includes('mounts')) {
      const mounts = [
        { path: '/workspace/group', label: 'group folder' },
        { path: '/workspace/ipc', label: 'IPC dir' },
        { path: '/workspace/project', label: 'project (read-only)' },
      ];
      for (const mount of mounts) {
        if (fs.existsSync(mount.path)) {
          results.push({ name: `Mount: ${mount.label}`, status: 'ok', detail: mount.path });
        } else {
          results.push({ name: `Mount: ${mount.label}`, status: 'error', detail: `${mount.path} not found` });
        }
      }
    }

    if (check.includes('ipc')) {
      try {
        const testFile = path.join(IPC_DIR, `.health-${Date.now()}.tmp`);
        fs.writeFileSync(testFile, 'ok');
        fs.unlinkSync(testFile);
        results.push({ name: 'IPC write', status: 'ok', detail: 'IPC directory is writable' });
      } catch (err) {
        results.push({
          name: 'IPC write',
          status: 'error',
          detail: `Cannot write IPC dir: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (check.includes('memory')) {
      if (!fs.existsSync(MEMORY_FILE)) {
        results.push({ name: 'Memory file', status: 'ok', detail: 'Not yet created (will be created on first memory_store)' });
      } else {
        try {
          const store = readMemoryStore();
          const count = Object.keys(store.memories).length;
          results.push({ name: 'Memory file', status: 'ok', detail: `${count} entr${count === 1 ? 'y' : 'ies'} stored` });
        } catch (err) {
          results.push({
            name: 'Memory file',
            status: 'error',
            detail: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    const icons: Record<string, string> = { ok: '✅', warn: '⚠️', error: '❌' };
    const lines = results.map(r => `${icons[r.status]} **${r.name}**: ${r.detail}`);
    const hasError = results.some(r => r.status === 'error');
    const hasWarn = results.some(r => r.status === 'warn');
    const summary = hasError ? '❌ Some components have errors' : hasWarn ? '⚠️ Some components need attention' : '✅ All systems operational';

    return {
      content: [{ type: 'text' as const, text: `${summary}\n\n${lines.join('\n')}` }],
    };
  },
);

server.tool(
  'list_groups',
  `List registered chat groups. Main group sees all registered groups. Non-main groups see only their own entry.

Returns: group JID, name, folder, trigger word, and whether the group is the main group.
Useful for: understanding what groups are active, finding JIDs for scheduling cross-group tasks, auditing group configuration.`,
  {
    filter: z
      .string()
      .optional()
      .describe('Optional substring filter for group name or folder (case-insensitive)'),
  },
  async (args) => {
    const snapshotPath = '/workspace/ipc/registered_groups.json';

    if (!fs.existsSync(snapshotPath)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No registered groups snapshot found. This may be because the host has not written it yet — try again after the next agent run.',
          },
        ],
      };
    }

    const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as {
      groups: Array<{
        jid: string;
        name: string;
        folder: string;
        trigger: string;
        added_at: string;
        requiresTrigger?: boolean;
        isMain?: boolean;
      }>;
      updatedAt: string;
    };

    let groups = raw.groups;

    if (args.filter) {
      const f = args.filter.toLowerCase();
      groups = groups.filter(
        (g) =>
          g.name.toLowerCase().includes(f) ||
          g.folder.toLowerCase().includes(f),
      );
    }

    if (groups.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: args.filter
              ? `No groups match "${args.filter}".`
              : 'No registered groups found.',
          },
        ],
      };
    }

    const lines = groups.map((g) => {
      const flags: string[] = [];
      if (g.isMain) flags.push('MAIN');
      if (g.requiresTrigger === false) flags.push('no-trigger');
      const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
      return `• ${g.name}${flagStr}\n  folder: ${g.folder} | JID: ${g.jid}\n  trigger: ${g.trigger} | added: ${g.added_at.slice(0, 10)}`;
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `${groups.length} registered group(s) (snapshot from ${raw.updatedAt.slice(0, 16).replace('T', ' ')} UTC):\n\n${lines.join('\n\n')}`,
        },
      ],
    };
  },
);

server.tool(
  'search_messages',
  `Search the chat message history for messages containing a keyword or phrase. Searches this group's conversation history stored on the host and returns matching messages with timestamps and sender names.

Useful for:
- Recalling what was discussed in past conversations
- Finding specific information mentioned by users
- Building context from historical exchanges

Note: Only searches messages stored in the host database (typically the last several weeks). Does NOT search memory entries — use memory_search for those.`,
  {
    query: z
      .string()
      .describe('Text to search for in message content (case-insensitive substring match)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of results to return (default: 20, max: 100)'),
    from_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Only search messages from the last N days (default: 30)'),
    include_bot_messages: z
      .boolean()
      .optional()
      .describe("Include the assistant's own replies in results (default: false)"),
  },
  async (args) => {
    const queryId = `sq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ipcTasksDir = '/workspace/ipc/tasks';
    const responseFile = `/workspace/ipc/responses/${queryId}.json`;

    // Write query to IPC tasks dir — host will process and write response
    const queryFilePath = `${ipcTasksDir}/search_${queryId}.json`;
    fs.writeFileSync(
      queryFilePath,
      JSON.stringify({
        type: 'search_messages',
        queryId,
        query: args.query,
        searchLimit: args.limit ?? 20,
        fromDays: args.from_days ?? 30,
        includeBotMessages: args.include_bot_messages ?? false,
      }),
      'utf-8',
    );

    // Poll for response (host processes IPC every ~1s; give 8s total)
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 200));
      if (fs.existsSync(responseFile)) {
        const raw = JSON.parse(fs.readFileSync(responseFile, 'utf-8')) as {
          results: Array<{
            sender_name: string;
            content: string;
            timestamp: string;
            is_from_me: number;
            is_bot_message: number;
          }>;
        };
        try {
          fs.unlinkSync(responseFile);
        } catch {
          /* best-effort cleanup */
        }

        if (!raw.results || raw.results.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No messages found matching "${args.query}" in the last ${args.from_days ?? 30} days.`,
              },
            ],
          };
        }

        const lines = raw.results.map((r) => {
          const ts = r.timestamp.slice(0, 16).replace('T', ' ');
          const who = r.is_from_me ? '🤖 me' : r.sender_name || 'unknown';
          const preview = r.content.length > 300 ? r.content.slice(0, 300) + '…' : r.content;
          return `[${ts}] ${who}: ${preview}`;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${raw.results.length} message(s) matching "${args.query}":\n\n${lines.join('\n\n')}`,
            },
          ],
        };
      }
    }

    // Timed out — clean up query file
    try {
      fs.unlinkSync(queryFilePath);
    } catch {
      /* already processed or never written */
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Search timed out — the host did not respond in time. The nanoclaw service may be busy. Please try again.',
        },
      ],
    };
  },
);

server.tool(
  'get_recent_messages',
  `Retrieve the most recent messages from this group's chat history, newest first. No keyword required — returns messages as-is.

Useful for:
- Catching up on recent conversation context at the start of a task
- Checking what was said in the last few hours/days
- Getting the "last N messages" view without searching for a specific term

Note: Only retrieves messages stored in the host database (typically the last several weeks). Does NOT search memory entries — use memory_search for those. For keyword-based search use search_messages instead.`,
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of messages to return (default: 20, max: 100)'),
    from_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Only look at messages from the last N days (default: 7)'),
    include_bot_messages: z
      .boolean()
      .optional()
      .describe("Include the assistant's own replies in results (default: false)"),
  },
  async (args) => {
    const queryId = `rq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ipcTasksDir = '/workspace/ipc/tasks';
    const responseFile = `/workspace/ipc/responses/${queryId}.json`;

    const queryFilePath = `${ipcTasksDir}/recent_${queryId}.json`;
    fs.writeFileSync(
      queryFilePath,
      JSON.stringify({
        type: 'get_recent_messages',
        queryId,
        recentLimit: args.limit ?? 20,
        recentFromDays: args.from_days ?? 7,
        includeBotMessages: args.include_bot_messages ?? false,
      }),
      'utf-8',
    );

    // Poll for response (host processes IPC every ~1s; give 8s total)
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 200));
      if (fs.existsSync(responseFile)) {
        const raw = JSON.parse(fs.readFileSync(responseFile, 'utf-8')) as {
          results: Array<{
            sender_name: string;
            content: string;
            timestamp: string;
            is_from_me: number;
            is_bot_message: number;
          }>;
        };
        try {
          fs.unlinkSync(responseFile);
        } catch {
          /* best-effort cleanup */
        }

        if (!raw.results || raw.results.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No messages found in the last ${args.from_days ?? 7} days.`,
              },
            ],
          };
        }

        const lines = raw.results.map((r) => {
          const ts = r.timestamp.slice(0, 16).replace('T', ' ');
          const who = r.is_from_me ? '🤖 me' : r.sender_name || 'unknown';
          const preview = r.content.length > 300 ? r.content.slice(0, 300) + '…' : r.content;
          return `[${ts}] ${who}: ${preview}`;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `Last ${raw.results.length} message(s) (newest first):\n\n${lines.join('\n\n')}`,
            },
          ],
        };
      }
    }

    // Timed out — clean up query file
    try {
      fs.unlinkSync(queryFilePath);
    } catch {
      /* already processed or never written */
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Request timed out — the host did not respond in time. The nanoclaw service may be busy. Please try again.',
        },
      ],
    };
  },
);

server.tool(
  'get_chat_stats',
  'Get aggregate statistics for this group\'s conversation history: total message count, unique senders, date range, and top senders by message volume. Useful for understanding group activity and engagement.',
  {
    from_days: z.number().optional().describe('How many days back to include (default: 30). Use a larger value for long-term patterns.'),
  },
  async (args) => {
    const queryId = `stats-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'get_chat_stats',
      queryId,
      groupFolder,
      isMain,
      fromDays: args.from_days ?? 30,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Poll for response (up to 8s)
    const responseFile = path.join(RESPONSES_DIR, `${queryId}.json`);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      if (fs.existsSync(responseFile)) {
        const raw = fs.readFileSync(responseFile, 'utf-8');
        fs.unlinkSync(responseFile);
        const stats = JSON.parse(raw) as {
          total_messages: number;
          unique_senders: number;
          first_message: string | null;
          last_message: string | null;
          top_senders: Array<{ sender_name: string; count: number }>;
          days_covered: number;
        };

        const lines: string[] = [
          `**Chat statistics (last ${stats.days_covered} days)**`,
          ``,
          `Total messages: ${stats.total_messages}`,
          `Unique senders: ${stats.unique_senders}`,
          `First message: ${stats.first_message ? stats.first_message.slice(0, 16).replace('T', ' ') + ' UTC' : 'N/A'}`,
          `Last message: ${stats.last_message ? stats.last_message.slice(0, 16).replace('T', ' ') + ' UTC' : 'N/A'}`,
        ];

        if (stats.top_senders.length > 0) {
          lines.push(``, `**Top senders:**`);
          for (const s of stats.top_senders) {
            const pct = stats.total_messages > 0
              ? ` (${Math.round((s.count / stats.total_messages) * 100)}%)`
              : '';
            lines.push(`  ${s.sender_name || 'Unknown'}: ${s.count} msgs${pct}`);
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }
    }

    return {
      content: [{ type: 'text' as const, text: 'Timed out waiting for host response. Try again in a moment.' }],
      isError: true,
    };
  },
);

// ─── Time Tool ────────────────────────────────────────────────────────────────

server.tool(
  'get_current_time',
  `Get the current date and time in the server's configured timezone. Useful when you need to:
- Make time-aware scheduling decisions
- Reference the current date in a response
- Check if a deadline has passed
- Know the current day of the week

The timezone is configured on the host (TZ env var). Defaults to UTC if not set.`,
  {
    utc: z
      .boolean()
      .optional()
      .describe('Also include UTC time alongside local time (default: false)'),
  },
  async (args) => {
    const tz = process.env.TZ || 'UTC';
    const now = new Date();

    const localStr = now.toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    let text = `Current time: ${localStr} (${tz})`;
    if (args.utc) {
      text += `\nUTC: ${now.toISOString()}`;
    }

    return {
      content: [{ type: 'text' as const, text }],
    };
  },
);

// ─── Ollama Tools ─────────────────────────────────────────────────────────────

const OLLAMA_BASE = 'http://host.docker.internal:11434';

server.tool(
  'ollama_generate',
  `Generate a completion using a local Ollama model. Use this for lightweight tasks to save API credits — classification, summarization, simple Q&A, content filtering, etc.

Common models (use ollama_list_models to see what's installed):
- llama3.2 / llama3.1 — general purpose
- mistral / mistral-nemo — efficient general purpose
- phi3 / phi3.5 — small, fast
- gemma2 — good at reasoning
- nomic-embed-text — embeddings only`,
  {
    model: z.string().describe('Model name (e.g., "llama3.2", "mistral", "phi3")'),
    prompt: z.string().describe('The prompt to send to the model'),
    system: z.string().optional().describe('Optional system prompt'),
    temperature: z.number().optional().describe('Temperature 0-2 (default: 0.7)'),
  },
  async (args) => {
    try {
      const body: Record<string, unknown> = {
        model: args.model,
        prompt: args.prompt,
        stream: false,
        options: {} as Record<string, unknown>,
      };
      if (args.system) body.system = args.system;
      if (args.temperature !== undefined) (body.options as Record<string, unknown>).temperature = args.temperature;

      const response = await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const errText = await response.text();
        return {
          content: [{ type: 'text' as const, text: `Ollama error ${response.status}: ${errText}` }],
          isError: true,
        };
      }

      const result = await response.json() as { response: string; done: boolean; total_duration?: number };
      const durationSec = result.total_duration ? (result.total_duration / 1e9).toFixed(1) : null;
      const footer = durationSec ? `\n\n_(${args.model}, ${durationSec}s)_` : '';

      return { content: [{ type: 'text' as const, text: result.response + footer }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = msg.includes('ECONNREFUSED') || msg.includes('fetch failed')
        ? ' — Is Ollama running on the host? Check with: curl http://host.docker.internal:11434/api/tags'
        : '';
      return {
        content: [{ type: 'text' as const, text: `Failed to reach Ollama: ${msg}${hint}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'ollama_list_models',
  'List all locally available Ollama models on the host machine.',
  {},
  async () => {
    try {
      const response = await fetch(`${OLLAMA_BASE}/api/tags`, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return {
          content: [{ type: 'text' as const, text: `Ollama returned ${response.status}. Is Ollama running?` }],
          isError: true,
        };
      }

      const data = await response.json() as { models: Array<{ name: string; size: number; modified_at: string }> };

      if (!data.models || data.models.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Ollama is running but no models are installed. Run: ollama pull llama3.2' }] };
      }

      const lines = data.models.map(m => {
        const sizeGB = (m.size / 1e9).toFixed(1);
        const date = m.modified_at.slice(0, 10);
        return `• ${m.name} (${sizeGB} GB, updated ${date})`;
      });

      return { content: [{ type: 'text' as const, text: `${data.models.length} model${data.models.length === 1 ? '' : 's'} available:\n\n${lines.join('\n')}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = msg.includes('ECONNREFUSED') || msg.includes('fetch failed')
        ? '\n\nOllama does not appear to be running on the host. Start it with: ollama serve'
        : '';
      return {
        content: [{ type: 'text' as const, text: `Failed to reach Ollama: ${msg}${hint}` }],
        isError: true,
      };
    }
  },
);

// ─── get_instructions ────────────────────────────────────────────────────────

server.tool(
  'get_instructions',
  "Read this group's CLAUDE.md instructions file. Useful for reviewing current behaviour rules, memory notes, or checking what instructions are in effect.",
  {},
  async () => {
    const instructionsPath = '/workspace/group/CLAUDE.md';
    if (!fs.existsSync(instructionsPath)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No CLAUDE.md found at /workspace/group/CLAUDE.md — this group has no custom instructions yet.',
          },
        ],
      };
    }
    const content = fs.readFileSync(instructionsPath, 'utf-8');
    return {
      content: [
        {
          type: 'text' as const,
          text: `Contents of /workspace/group/CLAUDE.md (${content.length} chars):\n\n${content}`,
        },
      ],
    };
  },
);

// ─── update_instructions ─────────────────────────────────────────────────────

server.tool(
  'update_instructions',
  "Update this group's CLAUDE.md instructions file. Use `append` to add a section at the end, `replace` to overwrite the whole file, or `replace_section` to update one markdown section (by heading text) without touching the rest.",
  {
    mode: z
      .enum(['append', 'replace', 'replace_section'])
      .describe(
        '`append`: add text to end of file. `replace`: overwrite the whole file. `replace_section`: find a heading and replace only that section\'s content.',
      ),
    text: z.string().describe('The text to append / the new file content / the new section body depending on mode.'),
    section_heading: z
      .string()
      .optional()
      .describe('Required for replace_section mode. The exact heading text (e.g. "## Notes"). The heading line itself is preserved; only the content beneath it is replaced.'),
  },
  async (args) => {
    const instructionsPath = '/workspace/group/CLAUDE.md';

    if (args.mode === 'replace') {
      fs.writeFileSync(instructionsPath, args.text, 'utf-8');
      return {
        content: [
          {
            type: 'text' as const,
            text: `CLAUDE.md replaced (${args.text.length} chars).`,
          },
        ],
      };
    }

    if (args.mode === 'append') {
      const existing = fs.existsSync(instructionsPath)
        ? fs.readFileSync(instructionsPath, 'utf-8')
        : '';
      const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      const newContent = existing + separator + args.text;
      fs.writeFileSync(instructionsPath, newContent, 'utf-8');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Appended ${args.text.length} chars to CLAUDE.md (total: ${newContent.length} chars).`,
          },
        ],
      };
    }

    // replace_section
    if (!args.section_heading) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'replace_section mode requires a section_heading.',
          },
        ],
        isError: true,
      };
    }

    if (!fs.existsSync(instructionsPath)) {
      // File doesn't exist — create it with just the section
      const newContent = `${args.section_heading}\n\n${args.text}`;
      fs.writeFileSync(instructionsPath, newContent, 'utf-8');
      return {
        content: [
          {
            type: 'text' as const,
            text: `CLAUDE.md created with section "${args.section_heading}".`,
          },
        ],
      };
    }

    const existing = fs.readFileSync(instructionsPath, 'utf-8');
    const lines = existing.split('\n');

    // Determine heading depth from the provided heading (e.g. "## Notes" → depth 2)
    const headingMatch = args.section_heading.match(/^(#{1,6})\s/);
    const headingDepth = headingMatch ? headingMatch[1].length : 1;

    // Find the line index of the target heading
    const headingLineIdx = lines.findIndex(
      (l) => l.trim() === args.section_heading.trim(),
    );

    if (headingLineIdx === -1) {
      // Heading not found — append as a new section
      const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n';
      const newContent =
        existing + separator + args.section_heading + '\n\n' + args.text;
      fs.writeFileSync(instructionsPath, newContent, 'utf-8');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Section "${args.section_heading}" not found — appended as a new section.`,
          },
        ],
      };
    }

    // Find the end of this section (next heading of same or higher level, or EOF)
    let sectionEndIdx = lines.length;
    for (let i = headingLineIdx + 1; i < lines.length; i++) {
      const nextHeadingMatch = lines[i].match(/^(#{1,6})\s/);
      if (nextHeadingMatch && nextHeadingMatch[1].length <= headingDepth) {
        sectionEndIdx = i;
        break;
      }
    }

    // Rebuild: keep heading, replace body, keep rest
    const before = lines.slice(0, headingLineIdx + 1).join('\n');
    const after = lines.slice(sectionEndIdx).join('\n');
    const newContent =
      before + '\n\n' + args.text + (after.length > 0 ? '\n\n' + after : '\n');
    fs.writeFileSync(instructionsPath, newContent, 'utf-8');

    return {
      content: [
        {
          type: 'text' as const,
          text: `Section "${args.section_heading}" updated in CLAUDE.md.`,
        },
      ],
    };
  },
);

// ─── get_task_stats ───────────────────────────────────────────────────────────

server.tool(
  'get_task_stats',
  "Get a summary of this group's scheduled task run history: total runs, success/failure counts, and a per-task breakdown. Useful for monitoring task reliability over time.",
  {
    from_days: z
      .number()
      .optional()
      .describe('How many days of history to include (default: 7).'),
    group_folder: z
      .string()
      .optional()
      .describe('(Main group only) folder of a different group to query.'),
  },
  async (args) => {
    const queryId = `ts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ipcTasksDir = '/workspace/ipc/tasks';
    const responseFile = `/workspace/ipc/responses/${queryId}.json`;

    const queryFilePath = `${ipcTasksDir}/get_task_stats_${queryId}.json`;
    fs.writeFileSync(
      queryFilePath,
      JSON.stringify({
        type: 'get_task_stats',
        queryId,
        fromDays: args.from_days ?? 7,
        groupFolder: args.group_folder,
      }),
      'utf-8',
    );

    // Poll for response (8s)
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 200));
      if (fs.existsSync(responseFile)) {
        const raw = JSON.parse(fs.readFileSync(responseFile, 'utf-8')) as {
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
        };

        try {
          fs.unlinkSync(responseFile);
        } catch {
          /* best-effort */
        }

        const fromDays = args.from_days ?? 7;

        if (raw.total_runs === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No task runs recorded in the last ${fromDays} day${fromDays === 1 ? '' : 's'}.`,
              },
            ],
          };
        }

        const successRate =
          raw.total_runs > 0
            ? Math.round((raw.succeeded / raw.total_runs) * 100)
            : 0;

        const header = [
          `Task run stats — last ${fromDays} day${fromDays === 1 ? '' : 's'}`,
          `Total runs: ${raw.total_runs}  ✅ ${raw.succeeded}  ❌ ${raw.failed}  (${successRate}% success)`,
          `Active tasks: ${raw.active_tasks}`,
        ].join('\n');

        const taskLines = raw.by_task.map((t) => {
          const label = t.name ? `"${t.name}"` : t.task_id;
          const taskRate =
            t.total_runs > 0
              ? Math.round((t.succeeded / t.total_runs) * 100)
              : 0;
          const lastTs = t.last_run
            ? t.last_run.slice(0, 16).replace('T', ' ')
            : '—';
          return `  ${label}: ${t.total_runs} run${t.total_runs === 1 ? '' : 's'}, ${taskRate}% ok, last: ${lastTs}`;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `${header}\n\nBy task:\n${taskLines.join('\n')}`,
            },
          ],
        };
      }
    }

    // Timed out
    try {
      fs.unlinkSync(queryFilePath);
    } catch {
      /* already processed */
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: 'get_task_stats timed out — the host did not respond. Try again shortly.',
        },
      ],
      isError: true,
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
