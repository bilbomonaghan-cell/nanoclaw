/**
 * Pip-Boy Status Dashboard
 * Serves a green-phosphor retro terminal UI at DASHBOARD_PORT (default 4000).
 * Endpoint: GET /       → HTML page
 *           GET /api/status → JSON snapshot
 */

import { execSync } from 'child_process';
import http from 'http';
import os from 'os';

import { CREDENTIAL_PROXY_PORT, SCOUT_MCP_URL } from './config.js';
import { getAllRegisteredGroups, getAllTasks } from './db.js';
import { logger } from './logger.js';

// ─── Data gathering helpers ────────────────────────────────────────────────

function getGitInfo(): { hash: string; message: string; date: string } {
  try {
    const cwd = process.cwd();
    const hash = execSync('git log --format="%h" -1', {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const message = execSync('git log --format="%s" -1', {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const date = execSync('git log --format="%ci" -1', {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { hash, message, date };
  } catch {
    return { hash: 'unknown', message: 'unknown', date: 'unknown' };
  }
}

interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
}

function getDockerContainers(): ContainerInfo[] {
  try {
    const output = execSync(
      'docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.State}}"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, name, image, status, state] = line.split('\t');
        return {
          id: (id ?? '').substring(0, 12),
          name: name ?? '',
          image: image ?? '',
          status: status ?? '',
          state: state ?? '',
        };
      });
  } catch {
    return [];
  }
}

interface DiskInfo {
  used: string;
  available: string;
  percent: string;
}

function getDiskUsage(): DiskInfo {
  try {
    const output = execSync("df -h / | tail -1 | awk '{print $3, $4, $5}'", {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const [used, available, percent] = output.split(' ');
    return {
      used: used ?? '?',
      available: available ?? '?',
      percent: percent ?? '?',
    };
  } catch {
    return { used: '?', available: '?', percent: '?' };
  }
}

async function checkHttp(url: string): Promise<'ok' | 'down'> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.status < 500 ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

// ─── Main status builder ───────────────────────────────────────────────────

async function buildStatus() {
  const git = getGitInfo();
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const load = os.loadavg();
  const uptime = os.uptime();
  const disk = getDiskUsage();
  const containers = getDockerContainers();

  const tasks = getAllTasks().map((t) => ({
    id: t.id,
    name: t.name ?? null,
    prompt: t.prompt.length > 70 ? t.prompt.substring(0, 70) + '…' : t.prompt,
    scheduleType: t.schedule_type,
    scheduleValue: t.schedule_value,
    nextRun: t.next_run,
    status: t.status,
    lastRun: t.last_run,
  }));

  const groups = Object.entries(getAllRegisteredGroups()).map(([jid, g]) => ({
    name: g.name,
    folder: g.folder,
    isMain: g.isMain ?? false,
    jidPrefix: jid.substring(0, 16) + '…',
  }));

  const scoutUrl = SCOUT_MCP_URL || `http://host.docker.internal:9987/mcp`;
  const [credProxy, scoutMcp, ollama] = await Promise.all([
    checkHttp(`http://127.0.0.1:${CREDENTIAL_PROXY_PORT}/health`),
    checkHttp(scoutUrl),
    checkHttp('http://127.0.0.1:11434/api/tags'),
  ]);

  return {
    timestamp: new Date().toISOString(),
    git,
    system: {
      uptime: Math.floor(uptime),
      load1: load[0].toFixed(2),
      load5: load[1].toFixed(2),
      load15: load[2].toFixed(2),
      memTotal,
      memFree,
      memUsedPct: Math.round(((memTotal - memFree) / memTotal) * 100),
      disk,
      platform: os.platform(),
      hostname: os.hostname(),
      cpuCount: os.cpus().length,
    },
    containers,
    tasks,
    groups,
    services: {
      nanoclaw: 'ok' as const,
      credProxy,
      scoutMcp,
      ollama,
    },
  };
}

// ─── HTML template ─────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BILBO-OS | STATUS MONITOR</title>
<link href="https://fonts.googleapis.com/css2?family=VT323&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --g:#00ff41;--gd:#00cc33;--gdk:#003a00;--amb:#ffb000;
  --red:#ff3131;--bg:#020402;--pb:#040904;
  --glow:0 0 8px #00ff41,0 0 18px #00ff4155;
  --tglow:0 0 6px #00ff41,0 0 14px #00ff4144;
}
html,body{background:var(--bg);color:var(--g);font-family:'VT323',monospace;font-size:17px;line-height:1.4;min-height:100vh;overflow-x:hidden}

/* CRT scanlines */
body::after{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.12) 2px,rgba(0,0,0,.12) 4px);pointer-events:none;z-index:9999}
/* Vignette */
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,.75) 100%);pointer-events:none;z-index:9998}

.scan{position:fixed;top:0;left:0;right:0;height:4px;background:linear-gradient(transparent,rgba(0,255,65,.07),transparent);animation:scanmove 7s linear infinite;pointer-events:none;z-index:9997}

@keyframes scanmove{0%{transform:translateY(-4px)}100%{transform:translateY(100vh)}}
@keyframes blink{50%{opacity:0}}
@keyframes flicker{0%,97%{opacity:1}98%{opacity:.97}99%{opacity:1}100%{opacity:.99}}

.screen{animation:flicker 10s infinite;padding:12px 14px;max-width:1440px;margin:0 auto}

header{text-align:center;border:2px solid var(--g);border-bottom:none;padding:10px 20px 6px;background:var(--pb);box-shadow:var(--glow)}
.h-title{font-size:2.8rem;text-shadow:var(--tglow);letter-spacing:10px}
.h-sub{font-size:1.1rem;color:var(--gd);letter-spacing:5px}
.h-bar{display:flex;justify-content:space-between;align-items:center;border:2px solid var(--g);border-top:1px solid var(--gd);border-bottom:none;padding:3px 14px;font-size:.88rem;color:var(--gd);background:var(--pb);box-shadow:var(--glow)}
.blink{animation:blink 1s step-end infinite}

.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0;border:2px solid var(--g);border-top:none;box-shadow:var(--glow)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0;border:2px solid var(--g);border-top:none;box-shadow:var(--glow);margin-top:0}
.panel{background:var(--pb);border-right:1px solid var(--gdk);border-bottom:1px solid var(--gdk);padding:10px 14px;overflow:hidden}
.panel:last-child{border-right:none}
.ph{font-size:1rem;letter-spacing:3px;color:var(--gd);border-bottom:1px solid var(--gdk);padding-bottom:5px;margin-bottom:8px;text-shadow:var(--tglow)}
.ph::before{content:'[ '}.ph::after{content:' ]'}

.row{display:flex;justify-content:space-between;padding:2px 0;font-size:.95rem}
.lbl{color:var(--gd)}.val{color:var(--g);text-shadow:0 0 5px #00ff41}
.pbar{background:var(--gdk);height:9px;margin:3px 0 7px;border:1px solid var(--gdk);position:relative}
.pfill{height:100%;background:var(--g);box-shadow:0 0 5px var(--g);transition:width .5s}
.pfill.w{background:var(--amb);box-shadow:0 0 5px var(--amb)}
.pfill.c{background:var(--red);box-shadow:0 0 5px var(--red)}

.ok{color:var(--g);text-shadow:0 0 7px var(--g)}.warn{color:var(--amb);text-shadow:0 0 7px var(--amb)}.err{color:var(--red);text-shadow:0 0 7px var(--red)}

.svc-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px}
.svc{display:flex;justify-content:space-between;align-items:center;padding:5px 9px;border:1px solid var(--gdk);background:rgba(0,255,65,.02)}
.svc-nm{letter-spacing:2px;font-size:.9rem}
.badge{font-size:.8rem;padding:0 7px;border:1px solid currentColor;letter-spacing:1px}

.ct-row{padding:3px 0;font-size:.9rem;border-bottom:1px dotted var(--gdk);display:grid;grid-template-columns:80px 1fr 1fr;gap:6px;align-items:center}
.ct-nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ct-img{color:var(--gd);font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.task-row{padding:4px 0;font-size:.88rem;border-bottom:1px dotted var(--gdk)}
.task-p{color:var(--g);line-height:1.3}
.task-m{color:var(--gd);font-size:.8rem;margin-top:1px}

.grp-row{padding:3px 0;font-size:.9rem;border-bottom:1px dotted var(--gdk);display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}
.grp-nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grp-fl{color:var(--gd);font-size:.82rem}

.empty{color:var(--gd);font-size:.88rem;font-style:italic}
.loading{text-align:center;font-size:2rem;padding:50px;text-shadow:var(--tglow);letter-spacing:8px}
</style>
</head>
<body>
<div class="scan"></div>
<div class="screen">
  <header>
    <div class="h-title">◈ BILBO-OS ◈</div>
    <div class="h-sub">PERSONAL AGENT SYSTEM — STATUS MONITOR</div>
  </header>
  <div class="h-bar">
    <span id="hostname">HOST: —</span>
    <span id="build">BUILD: —</span>
    <span id="refresh-ts">REFRESH: — <span class="blink">█</span></span>
  </div>
  <div id="content">
    <div class="grid3"><div class="panel loading" style="grid-column:1/-1">LOADING<span class="blink">_</span></div></div>
  </div>
</div>
<script>
const p2=(n)=>String(n).padStart(2,'0');
function fmtUp(s){const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60);return d>0?\`\${d}D \${p2(h)}H \${p2(m)}M\`:\`\${p2(h)}H \${p2(m)}M\`;}
function fmtB(b){return b>1e9?(b/1e9).toFixed(1)+'GB':(b/1e6).toFixed(0)+'MB';}
function fmtD(iso){if(!iso)return'—';try{const d=new Date(iso);return \`\${p2(d.getMonth()+1)}-\${p2(d.getDate())} \${p2(d.getHours())}:\${p2(d.getMinutes())}\`;}catch{return iso.substring(0,16);}}
function bar(pct){const c=pct>85?'c':pct>65?'w':'';return \`<div class="pbar"><div class="pfill \${c}" style="width:\${pct}%"></div></div>\`;}
function badge(s){const c=s==='ok'?'ok':s==='down'?'err':'warn';const t=s==='ok'?'ONLINE':s==='down'?'OFFLINE':'UNKNOWN';return \`<span class="badge \${c}">\${t}</span>\`;}
function stClr(st){return st==='running'?'ok':st==='exited'?'err':'warn';}
function tClr(st){return st==='active'?'ok':st==='paused'?'warn':'err';}

async function refresh(){
  try{
    const d=await fetch('/api/status').then(r=>r.json());
    const s=d.system;
    document.getElementById('hostname').textContent='HOST: '+s.hostname+' ('+s.cpuCount+'cpu)';
    document.getElementById('build').textContent='BUILD: '+d.git.hash+' — '+d.git.message.substring(0,42);
    const now=new Date();
    document.getElementById('refresh-ts').innerHTML=\`REFRESH: \${p2(now.getHours())}:\${p2(now.getMinutes())}:\${p2(now.getSeconds())} <span class="blink">█</span>\`;

    // SYS
    const sys=\`
      <div class="row"><span class="lbl">UPTIME</span><span class="val">\${fmtUp(s.uptime)}</span></div>
      <div class="row"><span class="lbl">PLATFORM</span><span class="val">\${s.platform.toUpperCase()}</span></div>
      <div class="row"><span class="lbl">LOAD</span><span class="val">\${s.load1} / \${s.load5} / \${s.load15}</span></div>
      <br>
      <div class="row"><span class="lbl">MEMORY</span><span class="val">\${s.memUsedPct}% (\${fmtB(s.memTotal-s.memFree)} / \${fmtB(s.memTotal)})</span></div>
      \${bar(s.memUsedPct)}
      <div class="row"><span class="lbl">DISK ROOT</span><span class="val">\${s.disk.used} / \${s.disk.available} free \${s.disk.percent}</span></div>
    \`;

    // SERVICES
    const svc=\`
      <div class="svc-grid">
        <div class="svc"><span class="svc-nm">NANOCLAW</span>\${badge(d.services.nanoclaw)}</div>
        <div class="svc"><span class="svc-nm">CRED PROXY</span>\${badge(d.services.credProxy)}</div>
        <div class="svc"><span class="svc-nm">SCOUT MCP</span>\${badge(d.services.scoutMcp)}</div>
        <div class="svc"><span class="svc-nm">OLLAMA</span>\${badge(d.services.ollama)}</div>
      </div>
      <div class="row"><span class="lbl">COMMIT</span><span class="val">\${d.git.hash}</span></div>
      <div class="row"><span class="lbl">MESSAGE</span><span class="val">\${d.git.message.substring(0,36)}</span></div>
      <div class="row"><span class="lbl">DATE</span><span class="val">\${fmtD(d.git.date)}</span></div>
    \`;

    // GROUPS
    const grps=d.groups;
    const grpHtml=grps.length===0?'<div class="empty">NO GROUPS REGISTERED</div>':grps.map(g=>\`
      <div class="grp-row">
        <span class="grp-nm \${g.isMain?'ok':''}">\${g.name}\${g.isMain?' ★':''}</span>
        <span class="grp-fl">\${g.folder}</span>
      </div>\`).join('');

    // CONTAINERS
    const cts=d.containers.filter(c=>c.name);
    const ctHtml=cts.length===0?'<div class="empty">NO CONTAINERS</div>':cts.map(c=>\`
      <div class="ct-row">
        <span class="\${stClr(c.state)}">\${c.state.toUpperCase()}</span>
        <span class="ct-nm">\${c.name}</span>
        <span class="ct-img">\${c.image.replace(/^[^/]+\\//,'').substring(0,32)}</span>
      </div>\`).join('');

    // TASKS
    const tasks=d.tasks;
    const taskHtml=tasks.length===0?'<div class="empty">NO SCHEDULED TASKS</div>':tasks.slice(0,10).map(t=>\`
      <div class="task-row">
        <div class="task-p">\${t.name?'<b>'+t.name+'</b> — ':''}\${t.prompt}</div>
        <div class="task-m">
          <span class="\${tClr(t.status)}">\${t.status.toUpperCase()}</span>
          &nbsp;·&nbsp;\${t.scheduleType.toUpperCase()}
          &nbsp;·&nbsp;NEXT: <span class="val">\${fmtD(t.nextRun)}</span>
          \${t.lastRun?'&nbsp;·&nbsp;LAST: <span class="val">'+fmtD(t.lastRun)+'</span>':''}
        </div>
      </div>\`).join('');

    document.getElementById('content').innerHTML=\`
      <div class="grid3">
        <div class="panel"><div class="ph">SYS STATUS</div>\${sys}</div>
        <div class="panel"><div class="ph">SERVICES</div>\${svc}</div>
        <div class="panel"><div class="ph">GROUPS (\${grps.length})</div>\${grpHtml}</div>
      </div>
      <div class="grid2">
        <div class="panel"><div class="ph">AGENT CONTAINERS (\${cts.length})</div>\${ctHtml}</div>
        <div class="panel"><div class="ph">SCHEDULED TASKS (\${tasks.length})</div>\${taskHtml}</div>
      </div>
    \`;
  }catch(e){
    document.getElementById('refresh-ts').innerHTML='REFRESH: <span class="err">FETCH ERROR</span> <span class="blink">█</span>';
  }
}
refresh();
setInterval(refresh,30000);
</script>
</body>
</html>`;

// ─── HTTP server ───────────────────────────────────────────────────────────

export function startDashboard(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (url === '/api/status' || url === '/api/status/') {
      try {
        const status = await buildStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
      } catch (err) {
        logger.error({ err }, 'Dashboard status error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
      return;
    }

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Dashboard listening');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Dashboard server error');
  });

  return server;
}
