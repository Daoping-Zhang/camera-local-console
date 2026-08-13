import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.UPDATE_RUNNER_PORT || 3219);
const installRoot = process.env.INSTALL_ROOT || path.resolve(__dirname, "..", "..");
const manifestUrl = process.env.MANIFEST_URL || "";
const channel = process.env.CHANNEL || "";
const consoleUrl = process.env.CONSOLE_URL || "http://127.0.0.1:3000";
const powershellExe = process.env.POWERSHELL_EXE || "powershell.exe";
const updateScript = findUpdateScript();
const startedAt = new Date().toISOString();
const logs = [];
let status = "starting";
let message = "正在准备更新...";
let stage = "prepare";
let percent = 0;
let finishedAt = "";
let exitCode = null;
let stdoutBuffer = "";
let stderrBuffer = "";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/status") {
    sendJson(res, { status, stage, percent, message, logs: logs.slice(-80), startedAt, finishedAt, exitCode, consoleUrl });
    return;
  }
  sendHtml(res, pageHtml());
});

server.listen(port, "127.0.0.1", () => {
  appendLog("更新进度页已启动");
  runUpdate();
});

function runUpdate() {
  status = "running";
  message = "正在下载并安装更新...";
  stage = "prepare";
  percent = 0;
  if (!updateScript) {
    status = "error";
    message = "未找到 update-windows.ps1，无法执行更新。";
    appendLog(message);
    return;
  }
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", updateScript, "-ManifestUrl", manifestUrl, "-RestartMode", "NoBrowser"];
  if (channel) args.push("-Channel", channel);
  const child = spawn(powershellExe, args, {
    cwd: installRoot,
    windowsHide: false,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8"
    }
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer = appendStreamData(stdoutBuffer, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBuffer = appendStreamData(stderrBuffer, chunk);
  });
  child.on("exit", (code) => {
    flushStreamBuffers();
    exitCode = code;
    finishedAt = new Date().toISOString();
    const wasRollback = status === "rollback";
    status = code === 0 ? "done" : wasRollback ? "rollback" : "error";
    message = code === 0 ? "更新完成，正在返回控制台..." : wasRollback ? "更新失败，已回滚到旧版本" : `更新失败，退出码 ${code}`;
    appendLog(message);
  });
  child.on("error", (error) => {
    exitCode = 1;
    finishedAt = new Date().toISOString();
    status = "error";
    message = `更新启动失败：${error.message}`;
    appendLog(message);
  });
}

function appendStreamData(buffer, chunk) {
  const next = buffer + String(chunk);
  const lines = next.split(/\r?\n/);
  const rest = lines.pop() || "";
  appendLog(lines.join("\n"));
  return rest;
}

function flushStreamBuffers() {
  appendLog(stdoutBuffer.trim());
  appendLog(stderrBuffer.trim());
  stdoutBuffer = "";
  stderrBuffer = "";
}

function findUpdateScript() {
  const candidates = [
    path.join(installRoot, "update-windows.ps1"),
    path.join(installRoot, "scripts", "windows", "update-windows.ps1")
  ];
  return candidates.find((candidate) => fsExists(candidate)) || "";
}

function fsExists(filePath) {
  try {
    return Boolean(filePath) && fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function appendLog(line) {
  if (!line) return;
  for (const item of line.split(/\r?\n/).filter(Boolean)) {
    const progress = parseProgressLine(item);
    if (progress) {
      stage = progress.stage || stage;
      percent = Number.isFinite(Number(progress.percent)) ? Number(progress.percent) : percent;
      message = progress.message || message;
      if (stage === "rollback") status = "rollback";
      logs.push({ time: progress.time || new Date().toISOString(), line: progress.message || item });
      continue;
    }
    logs.push({ time: new Date().toISOString(), line: item });
  }
}

function parseProgressLine(line) {
  const prefix = "UPDATE_PROGRESS ";
  if (!line.startsWith(prefix)) return null;
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
}

function sendJson(res, body) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function pageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>正在更新摄像头本地控制台</title>
  <style>
    body{margin:0;background:#f3f5f7;color:#17202a;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:820px;margin:0 auto;padding:42px 20px}
    .panel{background:#fff;border:1px solid #d9dee7;border-radius:8px;padding:24px}
    h1{margin:0 0 8px;font-size:24px}p{margin:0 0 16px;color:#667085}
    .percent{font-size:28px;font-weight:800;color:#07835d;margin:10px 0}
    .bar{height:10px;background:#edf2f7;border-radius:999px;overflow:hidden;margin:18px 0}.bar span{display:block;height:100%;width:0;background:#07835d;transition:width .2s ease}.bar.unknown span{width:35%;animation:pulse 1.4s infinite}
    .done .bar span{width:100%;animation:none}.error .bar span{width:100%;background:#c62828;animation:none}.rollback .bar span{background:#b54708}
    pre{max-height:360px;overflow:auto;background:#0f172a;color:#dbeafe;border-radius:8px;padding:14px;white-space:pre-wrap}
    a{display:inline-block;margin-top:10px;color:#075e45;font-weight:700}
    @keyframes pulse{0%{transform:translateX(-100%)}100%{transform:translateX(280%)}}
  </style>
</head>
<body>
  <main><section id="panel" class="panel">
    <h1 id="title">正在更新摄像头本地控制台</h1>
    <p id="message">正在准备更新...</p>
    <div id="percent" class="percent">0%</div>
    <div id="bar" class="bar unknown"><span></span></div>
    <pre id="logs"></pre>
    <a id="consoleLink" href="${escapeHtml(consoleUrl)}">返回控制台</a>
  </section></main>
  <script>
    async function tick(){
      const res=await fetch('/api/status',{cache:'no-store'});
      const data=await res.json();
      document.getElementById('message').textContent=data.message||'';
      document.getElementById('title').textContent=data.status==='done'?'更新完成':data.status==='rollback'?'已自动回滚':data.status==='error'?'更新失败':'正在更新摄像头本地控制台';
      const pct=Number(data.percent||0);
      const hasPercent=data.stage&&data.stage!=='prepare';
      document.getElementById('percent').textContent=(hasPercent||pct>0||data.status==='done')?Math.max(0,Math.min(100,pct))+'%':'准备中';
      const bar=document.getElementById('bar');
      bar.className='bar '+((hasPercent||pct>0||data.status==='done')?'':'unknown');
      bar.querySelector('span').style.width=Math.max(0,Math.min(100,pct))+'%';
      document.getElementById('logs').textContent=(data.logs||[]).map(x=>'['+x.time+'] '+x.line).join('\\n');
      document.getElementById('consoleLink').href=data.consoleUrl;
      document.getElementById('panel').className='panel '+data.status;
      if(data.status==='done') setTimeout(()=>location.href=data.consoleUrl,3000);
    }
    setInterval(tick,1000); tick();
  </script>
</body></html>`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
