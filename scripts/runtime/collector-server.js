import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.COLLECTOR_PORT || 3100);
const collectorId = process.env.COLLECTOR_ID || "collector-local-adapter";
const adapterMode = process.env.COLLECTOR_ADAPTER || "fake";
const pythonPath = process.env.PYTHON_PATH || "python";
const sdkDir = process.env.HIK_SDK_DIR || defaultSdkDir();
let gatewayUrl = (process.env.GATEWAY_URL || "").replace(/\/+$/, "");
const devices = new Map();
const workers = new Map();
const deviceFingerprints = new Map();
const retryState = new Map();
const workerGenerations = new Map();
const logs = [];
let lastHeartbeatAt = "";
let lastEventAt = "";
let eventCount = 0;
let enter = 0;
let exit = 0;
let duplicatePeople = 0;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      sendHtml(res, collectorStatusHtml(req));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, collector: publicState() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/devices") {
      sendJson(res, 200, { ok: true, devices: Array.from(devices.values()) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/logs") {
      sendJson(res, 200, { ok: true, logs });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/runtime/apply-snapshot") {
      const body = await readJson(req);
      const result = await applyRuntimeSnapshot(body);
      sendJson(res, 200, { ok: true, collectorId, ...result, collector: publicState() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/devices/register") {
      const body = await readJson(req);
      gatewayUrl = (body.gatewayUrl || gatewayUrl).replace(/\/+$/, "");
      const device = normalizeDevice(body);
      devices.set(device.deviceKey, device);
      await sendHeartbeat();
      writeLog("info", "device registered", { deviceKey: device.deviceKey, ipAddress: device.ipAddress, role: device.role });
      sendJson(res, 200, { ok: true, collectorId, deviceKey: device.deviceKey, status: "registered", connectionStatus: "pending", device });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/devices/delete") {
      const body = await readJson(req);
      const deviceKey = String(body.deviceKey || body.macAddress || "").trim();
      if (!deviceKey) throw new Error("deviceKey is required");
      stopWorker(deviceKey);
      const existed = devices.delete(deviceKey);
      deviceFingerprints.delete(deviceKey);
      await sendHeartbeat();
      writeLog("info", "device deleted", { deviceKey, existed });
      sendJson(res, 200, { ok: true, collectorId, deviceKey, deleted: existed });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/events/test") {
      const body = await readJson(req);
      const event = await sendEvent(body.deviceKey || firstDeviceKey());
      sendJson(res, 200, { ok: true, event });
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`collector server listening on http://localhost:${port}`);
  console.log(`collector=${collectorId}, gateway=${gatewayUrl || "not configured"}`);
  writeLog("info", "collector server started", { port, gatewayUrl });
});
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    writeLog("error", "collector port is already in use", { port, hint: "请修改 COLLECTOR_PORT 或 3000 控制台里的本地采集器地址" });
  }
  throw error;
});

setInterval(sendHeartbeat, Number(process.env.HEARTBEAT_INTERVAL_MS || 10000));
setInterval(processDeviceRetries, Number(process.env.RETRY_TICK_MS || 5000));
if (adapterMode !== "hikvision") {
  setInterval(() => sendEvent(firstDeviceKey()).catch((error) => console.error("event failed", error.message)), Number(process.env.INTERVAL_MS || 15000));
}

function defaultSdkDir() {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const packageRoot = path.resolve(projectRoot, "..");
  const platformDir = process.platform === "win32"
    ? "win-x64"
    : (process.arch === "arm64" ? "linux-arm64" : "linux-x64");
  const candidates = [
    path.join(packageRoot, "sdk", "hikvision"),
    path.join(projectRoot, "vendor", "hikvision", platformDir),
    path.join(packageRoot, "vendor", "hikvision", platformDir)
  ];
  return candidates.find((candidate) => pathExists(candidate)) || candidates[1];
}

function pathExists(value) {
  try {
    return Boolean(value) && path.isAbsolute(value) && fs.existsSync(value);
  } catch {
    return false;
  }
}

function normalizeDevice(body) {
  const macAddress = normalizeMacAddress(body.macAddress || body.deviceKey || body.deviceIndexCode || body.deviceId);
  const deviceKey = macAddress;
  if (!deviceKey) throw new Error("deviceKey is required");
  return {
    deviceKey,
    deviceName: body.deviceName || `Camera ${deviceKey}`,
    shopId: String(body.shopId || ""),
    shopName: body.shopName || "",
    ipAddress: body.ipAddress || "",
    macAddress,
    role: body.role || (Number(body.type) === 1 ? "inside" : "outside"),
    type: Number(body.type || 0),
    sdk: {
      vendor: body.sdk?.vendor || "hikvision",
      port: Number(body.sdk?.port || 8000),
      username: body.sdk?.username || "",
      password: body.sdk?.password || ""
    },
    status: "pending",
    connectionStatus: "pending",
    registeredAt: new Date().toISOString()
  };
}

function normalizeMacAddress(value) {
  const text = String(value || "").trim().toLowerCase();
  const compact = text.replace(/[^0-9a-f]/g, "");
  if (compact.length !== 12) return "";
  return compact.match(/.{1,2}/g).join(":");
}

async function applyRuntimeSnapshot(snapshot) {
  gatewayUrl = String(snapshot.gatewayUrl || gatewayUrl || "").replace(/\/+$/, "");
  const snapshotDevices = Array.isArray(snapshot.devices) ? snapshot.devices : [];
  const nextKeys = new Set();
  const result = { applied: 0, unchanged: 0, removed: 0, skipped: 0, errors: [] };

  for (const item of snapshotDevices) {
    let device = null;
    try {
      device = normalizeDevice(item);
      nextKeys.add(device.deviceKey);
      const fingerprint = deviceFingerprint(device);
      const existingRetry = retryState.get(device.deviceKey);
      if (deviceFingerprints.get(device.deviceKey) === fingerprint && devices.has(device.deviceKey) && !isRetryDue(existingRetry)) {
        result.unchanged += 1;
        continue;
      }
      if (!device.sdk.password && (adapterMode === "hikvision" || device.sdk.vendor === "hikvision-real")) {
        const previous = devices.get(device.deviceKey);
        if (previous) {
          devices.set(device.deviceKey, {
            ...previous,
            ...device,
            status: "pending",
            connectionStatus: "needs-password",
            lastError: "摄像头密码未保存，请在 3000 控制台重新下发"
          });
        } else {
          devices.set(device.deviceKey, {
            ...device,
            status: "pending",
            connectionStatus: "needs-password",
            lastError: "摄像头密码未保存，请在 3000 控制台重新下发"
          });
        }
        deviceFingerprints.set(device.deviceKey, fingerprint);
        result.skipped += 1;
        continue;
      }
      deviceFingerprints.set(device.deviceKey, fingerprint);
      const connected = await tryConnectCamera(device, { resetRetry: !existingRetry });
      if (connected.connectionStatus === "retry-waiting") {
        result.skipped += 1;
      } else {
        result.applied += 1;
      }
    } catch (error) {
      result.errors.push({ deviceKey: device?.deviceKey || item.deviceKey || item.macAddress || item.ipAddress || "", error: error.message });
      writeLog("error", "snapshot device apply failed", { deviceKey: device?.deviceKey, error: error.message });
    }
  }

  for (const deviceKey of Array.from(devices.keys())) {
    if (nextKeys.has(deviceKey)) continue;
    stopWorker(deviceKey);
    devices.delete(deviceKey);
    deviceFingerprints.delete(deviceKey);
    retryState.delete(deviceKey);
    result.removed += 1;
  }

  await sendHeartbeat();
  writeLog("info", "runtime snapshot applied", result);
  return result;
}

function deviceFingerprint(device) {
  return JSON.stringify({
    deviceKey: device.deviceKey,
    ipAddress: device.ipAddress,
    macAddress: device.macAddress,
    role: device.role,
    type: device.type,
    sdk: device.sdk
  });
}

function publicDevice(device) {
  const worker = workers.get(device.deviceKey);
  return {
    ...device,
    sdk: {
      ...device.sdk,
      password: device.sdk?.password ? "******" : ""
    },
    worker: worker ? {
      status: worker.status,
      startedAt: worker.startedAt,
      lastError: worker.lastError
    } : undefined
  };
}

function adapterName() {
  return adapterMode === "hikvision" ? "hikvision-hcnetsdk" : "fake-http-collector";
}

async function tryConnectCamera(device, options = {}) {
  try {
    if (options.resetRetry) retryState.delete(device.deviceKey);
    const connected = await connectCamera(device);
    retryState.delete(device.deviceKey);
    devices.set(device.deviceKey, connected);
    return connected;
  } catch (error) {
    return markDeviceRetry(device, error.message);
  }
}

function markDeviceRetry(device, error) {
  const previous = retryState.get(device.deviceKey) || { retryCount: 0 };
  const retryCount = previous.retryCount + 1;
  const retryDelayMs = retryDelayFor(retryCount);
  const nextRetryAt = new Date(Date.now() + retryDelayMs).toISOString();
  const next = {
    ...device,
    status: "offline",
    connectionStatus: isRetryableError(error) ? "retry-waiting" : "error",
    lastError: friendlyConnectError(error),
    retryCount,
    nextRetryAt,
    lastAttemptAt: new Date().toISOString()
  };
  devices.set(device.deviceKey, next);
  retryState.set(device.deviceKey, { retryCount, nextRetryAt, lastError: error });
  writeLog("warn", "camera connection scheduled retry", { deviceKey: device.deviceKey, ipAddress: device.ipAddress, retryCount, nextRetryAt, error: next.lastError });
  sendHeartbeat().catch((heartbeatError) => writeLog("warn", "heartbeat after retry schedule failed", { error: heartbeatError.message }));
  return next;
}

function retryDelayFor(retryCount) {
  const schedule = [10_000, 30_000, 60_000, 120_000];
  return schedule[Math.min(retryCount - 1, schedule.length - 1)];
}

function isRetryDue(state) {
  return Boolean(state?.nextRetryAt && Date.parse(state.nextRetryAt) <= Date.now());
}

function isRetryableError(error) {
  const text = String(error || "").toLowerCase();
  if (text.includes("password") || text.includes("unauthorized") || text.includes("authentication")) return false;
  return true;
}

function friendlyConnectError(error) {
  const text = String(error || "");
  if (text.toLowerCase().includes("password")) return "摄像头账号或密码缺失/错误，请在 3000 控制台重新下发";
  if (text.toLowerCase().includes("sdk")) return `SDK 启动失败：${text}`;
  return `连接失败，等待网络或摄像头就绪后自动重试：${text}`;
}

async function processDeviceRetries() {
  for (const [deviceKey, retry] of Array.from(retryState.entries())) {
    if (!isRetryDue(retry)) continue;
    const device = devices.get(deviceKey);
    if (!device || device.connectionStatus === "needs-password") {
      retryState.delete(deviceKey);
      continue;
    }
    writeLog("info", "camera retry started", { deviceKey, retryCount: retry.retryCount });
    await tryConnectCamera({ ...device, status: "pending", connectionStatus: "retrying" });
  }
}

async function connectCamera(device) {
  writeLog("info", "camera connection started", { deviceKey: device.deviceKey, ipAddress: device.ipAddress, sdkPort: device.sdk.port });
  if (adapterMode === "hikvision" || device.sdk.vendor === "hikvision-real") {
    return startHikvisionWorker(device);
  }
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CONNECT_DELAY_MS || 200)));
  const connected = process.env.FAKE_CONNECT_FAIL !== "1";
  if (!connected) {
    writeLog("error", "camera connection failed", { deviceKey: device.deviceKey, ipAddress: device.ipAddress });
    throw new Error("camera connection failed");
  }
  const next = {
    ...device,
    status: "online",
    connectionStatus: "connected",
    connectedAt: new Date().toISOString()
  };
  writeLog("info", "camera connection succeeded", { deviceKey: device.deviceKey, ipAddress: device.ipAddress });
  return next;
}

function startHikvisionWorker(device) {
  if (!gatewayUrl) {
    throw new Error("gatewayUrl is required before starting hikvision worker");
  }
  if (!device.ipAddress) {
    throw new Error("camera ipAddress is required");
  }
  if (!device.sdk.username || !device.sdk.password) {
    throw new Error("camera sdk username and password are required");
  }

  stopWorker(device.deviceKey, { reason: "restart" });
  const generation = (workerGenerations.get(device.deviceKey) || 0) + 1;
  workerGenerations.set(device.deviceKey, generation);

  const args = [
    path.join(__dirname, "hikvision-collector.py"),
    "--camera-ip", device.ipAddress,
    "--camera-port", String(device.sdk.port || 8000),
    "--username", device.sdk.username,
    "--password", device.sdk.password,
    "--device-key", device.deviceKey,
    "--mac-address", device.macAddress || device.deviceKey,
    "--channel-id", "1",
    "--collector-id", collectorId,
    "--gateway-url", gatewayUrl,
    "--sdk-dir", sdkDir
  ];
  const child = spawn(pythonPath, args, {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const worker = {
    process: child,
    generation,
    stopping: false,
    stopReason: "",
    startedAt: new Date().toISOString(),
    status: "starting",
    lastError: ""
  };
  workers.set(device.deviceKey, worker);

  child.stdout.on("data", (chunk) => handleWorkerOutput(device, chunk));
  child.stderr.on("data", (chunk) => handleWorkerError(device, chunk));
  child.on("error", (error) => {
    const current = workers.get(device.deviceKey);
    if (current?.process !== child || current.generation !== generation || current.stopping) return;
    if (current?.process === child) {
      current.status = "error";
      current.lastError = error.message;
    }
    const saved = devices.get(device.deviceKey);
    if (saved) {
      markDeviceRetry({ ...saved, sdk: device.sdk }, error.message);
    }
    writeLog("error", "hikvision worker start failed", { deviceKey: device.deviceKey, error: error.message, pythonPath, sdkDir });
    sendHeartbeat().catch((heartbeatError) => writeLog("warn", "heartbeat after worker error failed", { error: heartbeatError.message }));
  });
  child.on("exit", (code, signal) => {
    const current = workers.get(device.deviceKey);
    const isCurrentWorker = current?.process === child && current.generation === generation;
    const plannedStop = current?.stopping;
    if (isCurrentWorker) {
      current.status = "stopped";
      current.lastError = code === 0 ? "" : `exit code ${code ?? "null"}, signal ${signal ?? "null"}`;
    }
    if (!isCurrentWorker || plannedStop) {
      writeLog("info", "hikvision worker exited after planned stop", {
        deviceKey: device.deviceKey,
        code,
        signal,
        generation,
        reason: current?.stopReason || "superseded"
      });
      return;
    }
    const saved = devices.get(device.deviceKey);
    if (saved) {
      if (code === 0) {
        devices.set(device.deviceKey, { ...saved, status: "offline", connectionStatus: "stopped", lastError: "" });
      } else {
        markDeviceRetry({ ...saved, sdk: device.sdk }, current?.lastError || `exit code ${code ?? "null"}, signal ${signal ?? "null"}`);
      }
      sendHeartbeat().catch((error) => writeLog("warn", "heartbeat after worker exit failed", { error: error.message }));
    }
    writeLog(code === 0 ? "info" : "error", "hikvision worker exited", { deviceKey: device.deviceKey, code, signal });
  });

  return {
    ...device,
    sdk: { ...device.sdk, password: "******" },
    status: "online",
    connectionStatus: "worker-started",
    connectedAt: new Date().toISOString()
  };
}

function stopWorker(deviceKey, options = {}) {
  const worker = workers.get(deviceKey);
  if (!worker) return;
  worker.stopping = true;
  worker.stopReason = options.reason || "stop";
  worker.process.kill();
  workers.delete(deviceKey);
}

function handleWorkerOutput(device, chunk) {
  for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      writeLog("info", "hikvision worker output", { deviceKey: device.deviceKey, line });
      continue;
    }
    if (entry.message === "login succeeded" || entry.message === "alarm armed" || entry.message === "heartbeat sent") {
      const worker = workers.get(device.deviceKey);
      if (worker) worker.status = "running";
      const saved = devices.get(device.deviceKey);
      if (saved) {
        devices.set(device.deviceKey, {
          ...saved,
          status: "online",
          connectionStatus: "connected",
          lastError: "",
          connectedAt: saved.connectedAt || new Date().toISOString()
        });
        sendHeartbeat().catch((error) => writeLog("warn", "heartbeat after worker output failed", { error: error.message }));
      }
    }
    if (entry.message === "heartbeat sent") continue;
    writeLog(entry.level || "info", entry.message || "hikvision worker output", { deviceKey: device.deviceKey, ...entry });
  }
}

function handleWorkerError(device, chunk) {
  const text = String(chunk).trim();
  if (!text) return;
  const worker = workers.get(device.deviceKey);
  if (worker) {
    worker.status = "error";
    worker.lastError = text;
  }
  writeLog("error", "hikvision worker error", { deviceKey: device.deviceKey, error: text });
}

async function sendHeartbeat() {
  if (!gatewayUrl) return;
  const heartbeat = {
    collectorId,
    version: "0.1.0",
    adapter: adapterName(),
    mode: adapterMode,
    host: `localhost:${port}`,
    devices: Array.from(devices.values()).map((device) => ({
      deviceKey: device.deviceKey,
      ipAddress: device.ipAddress,
      macAddress: device.macAddress,
      status: device.status,
      connectionStatus: device.connectionStatus,
      lastError: device.lastError || workers.get(device.deviceKey)?.lastError || "",
      retryCount: device.retryCount || 0,
      nextRetryAt: device.nextRetryAt || "",
      lastAttemptAt: device.lastAttemptAt || "",
      worker: workers.get(device.deviceKey) ? {
        status: workers.get(device.deviceKey).status,
        lastError: workers.get(device.deviceKey).lastError
      } : undefined
    }))
  };
  await postJson(`${gatewayUrl}/api/collector/heartbeat`, heartbeat);
  lastHeartbeatAt = new Date().toISOString();
  writeLog("info", "heartbeat sent", { deviceCount: heartbeat.devices.length });
}

async function sendEvent(deviceKey) {
  if (!gatewayUrl) return null;
  const device = devices.get(deviceKey);
  if (!device) return null;
  enter += Math.floor(Math.random() * 3);
  exit += Math.floor(Math.random() * 2);
  duplicatePeople += Math.random() > 0.9 ? 1 : 0;
  const event = {
    collectorId,
    source: "fake-http-collector",
    deviceKey: device.deviceKey,
    macAddress: device.macAddress,
    ipAddress: device.ipAddress,
    channelId: 1,
    eventType: "PeopleCounting",
    occurredAt: formatLocalDate(new Date()),
    enter,
    exit,
    duplicatePeople,
    raw: { generatedBy: "collector-server" }
  };
  await postJson(`${gatewayUrl}/api/collector/events`, event);
  eventCount += 1;
  lastEventAt = new Date().toISOString();
  writeLog("info", "event sent", { deviceKey: device.deviceKey, enter, exit, duplicatePeople });
  return event;
}

function firstDeviceKey() {
  return devices.keys().next().value;
}

function publicState() {
  return {
    collectorId,
    version: "0.1.0",
    adapter: adapterName(),
    mode: adapterMode,
    gatewayUrl,
    port,
    lastHeartbeatAt,
    lastEventAt,
    eventCount,
    devices: Array.from(devices.values()).map(publicDevice)
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    writeLog("error", "post failed", { url, status: response.status });
    throw new Error(`POST ${url} failed with ${response.status}`);
  }
  return response;
}

function writeLog(level, message, meta = {}) {
  if (message === "heartbeat sent") return;
  const entry = { time: new Date().toISOString(), level, message, meta };
  logs.unshift(entry);
  logs.splice(500);
  const line = `[${entry.time}] ${level.toUpperCase()} ${message}`;
  if (level === "error") {
    console.error(line, meta);
  } else {
    console.log(line, meta);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function collectorStatusHtml(req) {
  const state = publicState();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(state.collectorId)}</title>
  <style>
    body{margin:0;background:#f3f5f7;color:#17202a;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:1180px;margin:0 auto;padding:24px}
    .panel{background:#fff;border:1px solid #d9dee7;border-radius:8px;padding:18px;margin-bottom:16px}
    h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:0 0 12px} p{margin:0;color:#667085}
    .head{display:flex;justify-content:space-between;gap:16px;align-items:center}
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:16px}
    .item{border:1px solid #edf0f4;border-radius:6px;padding:10px;background:#f8fafc}
    .item span{display:block;color:#667085;font-size:12px}.item strong{display:block;overflow-wrap:anywhere}
    table{width:100%;border-collapse:collapse} th,td{padding:9px;border-bottom:1px solid #edf0f4;text-align:left}
    th{color:#667085}.badge{display:inline-block;border-radius:999px;padding:2px 8px;color:#15803d;background:#eaf7ee;font-weight:700}
    .warn{color:#b54708;background:#fff4e5}.muted{color:#667085;background:#eef1f5}
    .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
    button{height:34px;border:0;border-radius:6px;padding:0 12px;color:white;background:#087f5b;font-weight:700;cursor:pointer}
    button.secondary{color:#344054;background:#fff;border:1px solid #d9dee7}
    .logs{display:grid;gap:8px;max-height:360px;overflow:auto}
    .log{display:grid;gap:8px;border:1px solid #edf0f4;border-left:4px solid #1d4ed8;border-radius:6px;padding:10px;background:#fcfcfd;overflow-wrap:anywhere}
    .log.warn{border-left-color:#b54708;background:#fffdf8}.log.error{border-left-color:#b42318;background:#fffafa}
    .log-main{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.log-main strong{font-size:14px}.log-main time{margin-left:auto;color:#667085;font-size:12px}
    .level{min-width:44px;border-radius:999px;padding:3px 8px;text-align:center;font-size:12px;font-weight:800;color:#1d4ed8;background:#e9f0ff}
    .level.warn{color:#b54708;background:#fff4e5}.level.error{color:#b42318;background:#feeceb}
    .tags{display:flex;gap:8px;flex-wrap:wrap}.tag{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:6px;background:#f1f5f9;color:#334155;font-weight:700}.tag small{color:#667085;font-weight:600}
    details summary{cursor:pointer;color:#667085;font-size:12px}pre{max-height:160px;margin:8px 0 0;padding:10px;border-radius:6px;background:#f8fafc;color:#334155;font-size:12px;white-space:pre-wrap;overflow:auto}
    code{background:#eef1f5;border-radius:4px;padding:2px 5px}
    a{color:#087f5b;font-weight:700}
    @media(max-width:900px){.grid{grid-template-columns:1fr}.head{display:block}.actions{margin-top:12px}}
  </style>
</head>
<body>
  <main>
    <section class="panel">
      <div class="head">
        <div>
          <h1>Collector 数据接收器</h1>
          <p>这是独立采集进程的 Web 页面。主控制台在 <a href="${escapeHtml(state.gatewayUrl)}">${escapeHtml(state.gatewayUrl)}</a>。</p>
        </div>
        <div class="actions">
          <button onclick="refreshAll()">刷新</button>
          <button class="secondary" onclick="triggerTestEvent()">触发测试事件</button>
        </div>
      </div>
      <div class="grid">
        <div class="item"><span>采集器 ID</span><strong id="collectorId">-</strong></div>
        <div class="item"><span>适配器</span><strong id="adapter">-</strong></div>
        <div class="item"><span>Gateway</span><strong id="gateway">-</strong></div>
        <div class="item"><span>设备数量</span><strong id="deviceCount">-</strong></div>
        <div class="item"><span>最近心跳</span><strong id="lastHeartbeat">-</strong></div>
        <div class="item"><span>最近事件</span><strong id="lastEvent">-</strong></div>
        <div class="item"><span>事件数量</span><strong id="eventCount">-</strong></div>
        <div class="item"><span>监听端口</span><strong id="port">-</strong></div>
      </div>
    </section>
    <section class="panel">
      <h2>已注册设备</h2>
      <table>
        <thead><tr><th>设备 Key</th><th>IP</th><th>MAC</th><th>角色</th><th>状态</th></tr></thead>
        <tbody id="devices"><tr><td colspan="5">加载中...</td></tr></tbody>
      </table>
    </section>
    <section class="panel">
      <h2>运行日志</h2>
      <div id="logs" class="logs"></div>
    </section>
    <section class="panel">
      <h2>API</h2>
      <p><code>GET /api/health</code> · <code>GET /api/devices</code> · <code>GET /api/logs</code> · <code>POST /api/devices/register</code> · <code>POST /api/events/test</code></p>
    </section>
  </main>
  <script>
    async function getJson(path) {
      const response = await fetch(path);
      return response.json();
    }
    async function postJson(path, body) {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      return response.json();
    }
    async function refreshAll() {
      const health = await getJson("/api/health");
      const logs = await getJson("/api/logs");
      const collector = health.collector;
      document.getElementById("collectorId").textContent = collector.collectorId;
      document.getElementById("adapter").textContent = collector.adapter + " v" + collector.version;
      document.getElementById("gateway").textContent = collector.gatewayUrl;
      document.getElementById("deviceCount").textContent = collector.devices.length;
      document.getElementById("lastHeartbeat").textContent = formatTime(collector.lastHeartbeatAt);
      document.getElementById("lastEvent").textContent = formatTime(collector.lastEventAt);
      document.getElementById("eventCount").textContent = collector.eventCount;
      document.getElementById("port").textContent = collector.port;
      document.getElementById("devices").innerHTML = collector.devices.map(device => '<tr><td>' + esc(device.deviceKey) + '</td><td>' + esc(device.ipAddress || '-') + '</td><td>' + esc(device.macAddress || '-') + '</td><td>' + esc(formatRole(device.role)) + '</td><td><span class="badge">' + esc(formatStatus(device.status)) + '</span></td></tr>').join("") || '<tr><td colspan="5">暂无设备，请在主控制台注册。</td></tr>';
      const logBox = document.getElementById("logs");
      logBox.innerHTML = logs.logs.map(renderLog).join("") || '<div class="log">暂无日志</div>';
      logBox.scrollTop = 0;
    }
    async function triggerTestEvent() {
      await postJson("/api/events/test", {});
      await refreshAll();
    }
    function formatTime(value) { return value ? new Date(value).toLocaleString() : "-"; }
    function renderLog(log) {
      const level = log.level || "info";
      const meta = log.meta || {};
      const details = JSON.stringify(meta, null, 2);
      const tags = buildTags(meta);
      return '<article class="log ' + esc(level) + '"><div class="log-main"><span class="level ' + esc(level) + '">' + esc(formatLevel(level)) + '</span><strong>' + esc(translateMessage(log.message)) + '</strong><time>' + esc(formatTime(log.time)) + '</time></div>' + (tags ? '<div class="tags">' + tags + '</div>' : '') + (details !== '{}' ? '<details><summary>查看详情</summary><pre>' + esc(details) + '</pre></details>' : '') + '</article>';
    }
    function buildTags(meta) {
      const pairs = [["deviceKey","设备"],["ipAddress","IP"],["role","角色"],["sdkPort","SDK端口"],["commandName","SDK"],["command","指令"],["eventType","事件"],["eventDescription","描述"],["eventState","状态"],["dataType","数据"],["dataLen","长度"],["pictures","图片"],["channelId","通道"],["savedTo","保存"],["deviceCount","设备数"],["enter","进入"],["exit","离开"],["passing","经过"],["duplicatePeople","重复"],["port","端口"],["gatewayUrl","Gateway"],["url","地址"],["status","状态"]];
      return pairs.filter(pair => meta[pair[0]] !== undefined && meta[pair[0]] !== "").map(pair => '<span class="tag"><small>' + esc(pair[1]) + '</small>' + esc(formatMeta(pair[0], meta[pair[0]])) + '</span>').join("");
    }
    function formatMeta(key, value) {
      if (key === "role") return formatRole(value);
      if (key === "status") return formatStatus(value);
      if (key === "gatewayUrl" && !value) return "未配置";
      return value;
    }
    function translateMessage(message) {
      const map = {
        "collector server started": "采集器服务已启动",
        "camera connection started": "开始连接摄像头",
        "camera connection failed": "摄像头连接失败",
        "camera connection succeeded": "摄像头连接成功",
        "device registered": "摄像头已注册到采集器",
        "sdk isapi packet": "SDK ISAPI 报文",
        "sdk pdc packet": "SDK PDC 报文",
        "sdk alarm packet": "SDK 报警报文",
        "empty isapi alarm": "SDK ISAPI 空报文",
        "pdc event posted": "客流事件已上报",
        "event sent": "客流事件已上报",
        "post failed": "上报请求失败"
      };
      return map[message] || message || "未知日志";
    }
    function formatLevel(level) { return level === "error" ? "错误" : level === "warn" ? "警告" : "信息"; }
    function formatRole(role) { return role === "inside" ? "店内" : role === "outside" ? "店外" : role || "-"; }
    function formatStatus(status) { return status === "online" ? "在线" : status === "pending" ? "等待" : status === "connected" ? "已连接" : status || "-"; }
    function esc(value) { return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }
    refreshAll();
    setInterval(refreshAll, 5000);
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatLocalDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":");
}
