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
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
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

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; context_mode?: string; script?: string; status: string; next_run?: string | null; last_run?: string | null }) => {
            const promptPreview = t.prompt.length > 60 ? t.prompt.slice(0, 60) + '…' : t.prompt;
            const mode = t.context_mode || 'group';
            const scriptFlag = t.script ? ' [script]' : '';
            const next = t.next_run ? t.next_run.slice(0, 16).replace('T', ' ') : 'N/A';
            const lastRun = t.last_run ? t.last_run.slice(0, 16).replace('T', ' ') : 'never';
            return `- [${t.id}] ${promptPreview}\n  ${t.schedule_type}: ${t.schedule_value} | ${mode}${scriptFlag} | ${t.status} | next: ${next} | last: ${lastRun}`;
          },
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks (${tasks.length}):\n\n${formatted}` }] };
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
        `Status: ${task.status}`,
        `Schedule: ${task.schedule_type} — ${task.schedule_value}`,
        `Context mode: ${task.context_mode || 'group'}`,
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
      const recentRuns = task.recent_runs as Array<{ run_at: string; duration_ms: number; status: string; error?: string | null }> | undefined;
      if (recentRuns && recentRuns.length > 0) {
        lines.push(``, `**Recent runs (last ${recentRuns.length}):**`);
        for (const run of recentRuns) {
          const ts = run.run_at.slice(0, 16).replace('T', ' ');
          const durationSec = (run.duration_ms / 1000).toFixed(1);
          const icon = run.status === 'success' ? '✅' : '❌';
          const errSuffix = run.error ? ` — ${run.error.slice(0, 80)}` : '';
          lines.push(`  ${icon} ${ts} (${durationSec}s)${errSuffix}`);
        }
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
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
    script: z.string().nullable().optional().describe('New pre-flight bash script, or null to remove an existing script'),
    context_mode: z.enum(['group', 'isolated']).optional().describe('New context mode (group=with chat history, isolated=fresh session)'),
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
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;
    if (args.script !== undefined) data.script = args.script ?? '';   // empty string signals "clear script"
    if (args.context_mode !== undefined) data.context_mode = args.context_mode;

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

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
