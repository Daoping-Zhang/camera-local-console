import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { logger } from "./core/logger.js";
import { loadState, saveState } from "./core/store.js";
import { getJson, postJson, joinUrl } from "./services/http-client.js";
import { buildPeopleCountingPayload } from "./services/payload-builder.js";
import { listInterfaces, scanSubnet } from "./services/scanner.js";
import { startTunnel, stopTunnel, tunnelStatus } from "./services/tunnel-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const LOCAL_COLLECTOR_URL = process.env.LOCAL_COLLECTOR_URL || (process.env.COLLECTOR_PORT ? `http://127.0.0.1:${process.env.COLLECTOR_PORT}` : "");

let currentTunnelKey = null;
let updateTimer = null;
let updating = false;
let state = loadState();
state.devices = dedupeDeviceRecords(state.devices);
// 控制台唯一标识（持久化；重装/重启不变）
if (!state.console?.id) {
  state.console = { id: randomBytes(6).toString("hex"), name: os.hostname() };
  saveState(state);
}
syncTunnel();
if (LOCAL_COLLECTOR_URL) {
  state.localCollector = { ...(state.localCollector || {}), baseUrl: LOCAL_COLLECTOR_URL };
}
if (process.env.SERVER_URL || process.env.LEGACY_HIK_BASE_URL) {
  state.server.serverUrl = process.env.SERVER_URL || process.env.LEGACY_HIK_BASE_URL;
}
const recentEvents = [];
const collectors = new Map();
let collectorProcess = null;
let collectorRefreshPromise = null;
let collectorPortConflict = false;
let lastCollectorRefreshAt = 0;
const COLLECTOR_REFRESH_INTERVAL_MS = 5_000;
const MANAGED_COLLECTOR_ID = "collector-local-adapter";
const debugShops = [
  { id: "10001", name: "本地调试门店 A" },
  { id: "10002", name: "本地调试门店 B" }
];

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    logger.error("request failed", { url: req.url, error: error.message });
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  logger.info("local console started", { host: HOST, port: PORT });
  cleanupCompletedUpdateWorkDir().catch((error) => logger.warn("update work dir cleanup failed", { error: error.message }));
  ensureManagedCollector().catch((error) => logger.warn("managed collector bootstrap failed", { error: error.message }));
  scheduleConfiguredCollectorRefresh({ force: true });
});
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    logger.error("local console port is already in use", { host: HOST, port: PORT, hint: "请修改 PORT 后重启，例如 Windows 包里的 config\\ports.env" });
  }
  throw error;
});

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/api/state") {
    scheduleConfiguredCollectorRefresh();
    sendJson(res, 200, {
      ok: true,
      state: publicState(),
      collectors: listCollectors(),
      interfaces: listInterfaces(),
      consoleInfo: consoleInfo(),
      tunnel: tunnelStatus(),
      events: recentEvents,
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/logs") {
    sendJson(res, 200, { ok: true, logs: logger.list() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/collectors") {
    sendJson(res, 200, { ok: true, collectors: listCollectors() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/release") {
    sendJson(res, 200, { ok: true, release: releaseState() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/release/configure") {
    const body = await readJson(req);
    const channel = String(body.channel || state.release?.channel || "stable").trim() || "stable";
    state.release = {
      ...(state.release || {}),
      channel,
      manifestUrl: String(body.manifestUrl || defaultManifestUrl(channel)).trim()
    };
    saveState(state);
    sendJson(res, 200, { ok: true, release: releaseState() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/release/check") {
    const body = await readJson(req);
    const result = await checkRelease(body.manifestUrl || state.release?.manifestUrl);
    state.release = {
      ...(state.release || {}),
      lastCheckAt: new Date().toISOString(),
      lastCheckResult: result
    };
    saveState(state);
    sendJson(res, 200, { ok: true, release: releaseState(), result });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/release/apply") {
    const body = await readJson(req);
    const result = startLocalUpdate(body.manifestUrl || state.release?.manifestUrl, body.channel || state.release?.channel);
    sendJson(res, 202, { ok: true, result });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/collector-proxy/health") {
    const body = await readJson(req);
    const collectorUrl = String(body.collectorUrl || state.localCollector?.baseUrl || "http://127.0.0.1:3100").trim();
    state.localCollector = { ...(state.localCollector || {}), baseUrl: collectorUrl };
    saveState(state);
    const result = await collectorGet(collectorUrl, "/api/health");
    discoverCollector(result, collectorUrl);
    await applyCollectorSnapshot(collectorUrl).catch((error) => {
      logger.warn("collector snapshot apply failed after health check", { error: error.message });
    });
    sendJson(res, 200, { ok: true, result });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/collector-proxy/register-device") {
    const body = await readJson(req);
    const collectorUrl = body.collectorUrl || state.localCollector?.baseUrl;
    const result = await collectorPost(collectorUrl, "/api/devices/register", buildCollectorDeviceConfig(body.device || {}));
    await refreshCollectorSnapshot(collectorUrl, result).catch((error) => {
      logger.warn("collector snapshot refresh failed after register", { error: error.message });
    });
    await applyCollectorSnapshot(collectorUrl).catch((error) => {
      logger.warn("collector snapshot apply failed after register", { error: error.message });
    });
    sendJson(res, 200, { ok: true, result });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/collector-proxy/test-event") {
    const body = await readJson(req);
    const result = await collectorPost(body.collectorUrl, "/api/events/test", { deviceKey: body.deviceKey });
    sendJson(res, 200, { ok: true, result });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/collector-proxy/delete-device") {
    const body = await readJson(req);
    const result = await collectorPost(body.collectorUrl, "/api/devices/delete", {
      deviceKey: body.deviceKey,
      macAddress: body.macAddress
    });
    sendJson(res, 200, { ok: true, result });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/devices/register-flow") {
    const body = await readJson(req);
    const result = await registerDeviceFlow(body);
    sendJson(res, 200, { ok: true, ...result, state: publicState() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/shops") {
    sendJson(res, 200, { ok: true, shops: debugShops });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/legacy-hik/connect") {
    const body = await readJson(req);
    const baseUrl = String(body.baseUrl || "").trim();
    if (!baseUrl) {
      throw new Error("hik-contact-data URL is required");
    }
    state.server.serverUrl = baseUrl;
    state.server.siteToken = String(body.siteToken || "").trim();
    saveState(state);
    const result = await probeLegacyHik(baseUrl);
    syncTunnel();
    logger.info("legacy hik service configured", { baseUrl, reachable: result.reachable, status: result.status });
    sendJson(res, 200, { ok: true, result, state: publicState() });
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/backend/")) {
    const body = await readJson(req);
    const baseUrl = String(body.baseUrl || state.server.serverUrl || "").trim();
    const token = String(body.token || state.server.siteToken || "").trim();
    if (!baseUrl || !token) {
      sendJson(res, 400, { ok: false, error: "未配置数据服务地址或接入令牌（请在「数据上报」页填写）" });
      return;
    }
    if (url.pathname === "/api/backend/bootstrap") {
      const result = await backendBootstrap(baseUrl, token);
      sendJson(res, 200, { ok: true, result });
      return;
    }
    const pathMap = {
      "/api/backend/stores": "/api/edge/stores",
      "/api/backend/devices": "/api/edge/devices",
      "/api/backend/console": "/api/edge/console",
    };
    const path = pathMap[url.pathname];
    if (!path) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }
    const result = await backendPost(baseUrl, token, path, body.body || body.payload || {});
    sendJson(res, 200, { ok: true, result });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/shop/save") {
    const body = await readJson(req);
    state.shop = {
      shopId: String(body.shopId || ""),
      shopName: String(body.shopName || "")
    };
    saveState(state);
    syncTunnel();
    logger.info("shop saved", state.shop);
    sendJson(res, 200, { ok: true, state: publicState() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/config/save") {
    const body = await readJson(req);
    state.localCollector = {
      ...(state.localCollector || {}),
      baseUrl: String(body.localCollector?.baseUrl || state.localCollector?.baseUrl || "http://127.0.0.1:3100").trim(),
      autoConnect: body.localCollector?.autoConnect !== false
    };
    collectorPortConflict = false;
    state.server = {
      ...(state.server || {}),
      serverUrl: String(body.server?.serverUrl || state.server?.serverUrl || "").trim()
    };
    state.cameraDefaults = {
      ...(state.cameraDefaults || {}),
      username: String(body.cameraDefaults?.username || "admin").trim(),
      sdkPort: Number(body.cameraDefaults?.sdkPort || 8000),
      savePassword: Boolean(body.cameraDefaults?.savePassword)
    };
    saveState(state);
    syncTunnel();
    scheduleConfiguredCollectorRefresh({ force: true });
    sendJson(res, 200, { ok: true, state: publicState() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/scan") {
    const body = await readJson(req);
    logger.info("scan started", { cidr: body.cidr });
    const devices = await scanSubnet(body.cidr, { timeoutMs: body.timeoutMs, limit: body.limit });
    logger.info("scan finished", { cidr: body.cidr, count: devices.length });
    sendJson(res, 200, { ok: true, devices });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/devices/bind") {
    const body = await readJson(req);
    const record = buildDeviceRecord(body);
    const remote = await bindLocalDeviceWithRemote(record);
    state.devices = state.devices.filter((item) => deviceUniqueKey(item) !== deviceUniqueKey(record));
    state.devices.unshift({ ...record, localId: `${Date.now()}`, remote });
    state.devices = dedupeDeviceRecords(state.devices).slice(0, 50);
    saveState(state);
    scheduleConfiguredCollectorRefresh({ force: true });
    logger.info("device bound", { shopId: record.shopId, macAddress: record.macAddress, type: record.type });
    sendJson(res, 200, { ok: true, record, remote, state: publicState() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/devices/update") {
    const body = await readJson(req);
    const key = deviceUniqueKey({ macAddress: body.deviceKey || body.macAddress || body.deviceIndexCode || body.deviceId });
    let updated = false;
    state.devices = state.devices.map((device) => {
      if (deviceUniqueKey(device) !== key) return device;
      updated = true;
      const next = { ...device };
      if (body.positionType) next.positionType = String(body.positionType);
      return next;
    });
    if (updated) saveState(state);
    sendJson(res, 200, { ok: true, updated, state: publicState() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/devices/delete") {
    const body = await readJson(req);
    const key = deviceUniqueKey({ macAddress: body.deviceIndexCode || body.macAddress || body.deviceKey || body.deviceId || body.ipAddress });
    const before = state.devices.length;
    state.devices = state.devices.filter((device) => {
      const deviceKey = deviceUniqueKey(device);
      return deviceKey !== key;
    });
    saveState(state);
    scheduleConfiguredCollectorRefresh({ force: true });
    logger.info("device deleted locally", { deviceKey: key, deleted: before - state.devices.length });
    sendJson(res, 200, { ok: true, deleted: before - state.devices.length, state: publicState() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/collector/events") {
    const event = await readJson(req);
    await ingestCollectorEvent(event);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/collector/heartbeat") {
    const heartbeat = await readJson(req);
    const collector = upsertCollector(heartbeat);
    const errorDevices = collector.devices.filter((device) => device.lastError || device.worker?.lastError);
    if (errorDevices.length) {
      logger.warn("collector heartbeat contains device errors", {
        collectorId: collector.collectorId,
        deviceCount: collector.devices.length,
        errorDevices: errorDevices.map((device) => ({
          deviceKey: device.deviceKey,
          ipAddress: device.ipAddress,
          error: device.lastError || device.worker?.lastError
        }))
      });
    }
    sendJson(res, 200, { ok: true, collector });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/test-event") {
    const body = await readJson(req);
    const macAddress = normalizeMacAddress(body.macAddress) || "02:00:00:00:00:01";
    const event = {
      source: "console-test",
      deviceKey: macAddress,
      macAddress,
      ipAddress: body.ipAddress || "",
      channelId: body.channelId || 1,
      occurredAt: body.occurredAt,
      enter: body.enter ?? 1,
      exit: body.exit ?? 0,
      duplicatePeople: body.duplicatePeople ?? 0
    };
    await ingestCollectorEvent(event);
    sendJson(res, 200, { ok: true, event });
    return;
  }
  sendJson(res, 404, { ok: false, error: "not found" });
}

function bindLocalDevice(record) {
  logger.info("device bound locally", { shopId: record.shopId, macAddress: record.macAddress, type: record.type });
  return {
    code: 200,
    message: "local debug bind only",
    data: "本地调试模式，未调用远端 /shop/insertDevice"
  };
}

/** 远端注册设备：调后端 POST /api/edge/devices（X-Access-Token） */
/** 隧道自动启停：配置了数据服务地址 + 令牌 + 后端门店（非本地调试店）时启动 */
function syncTunnel() {
  const { serverUrl, siteToken } = state.server || {};
  const shopId = String(state.shop?.shopId || "");
  const isDebugShop = ["10001", "10002"].includes(shopId);
  const ready = Boolean(serverUrl && siteToken && shopId && !isDebugShop);
  if (!ready) {
    stopTunnel();
    currentTunnelKey = null;
    return;
  }
  const key = `${serverUrl}|${siteToken}|${shopId}|${PORT}`;
  if (key !== currentTunnelKey) {
    currentTunnelKey = key;
    stopTunnel();
    startTunnel({ serverUrl, siteToken, localPort: PORT, onState: () => {} });
  }
  startUpdatePolling();
}

/** 远程更新：每 30s 轮询后端更新任务，有任务则 detached 执行 update-linux.sh（脚本自行上报结果） */
function startUpdatePolling() {
  const { serverUrl, siteToken } = state.server || {};
  const shopId = String(state.shop?.shopId || "");
  if (!serverUrl || !siteToken || ["10001", "10002"].includes(shopId)) {
    if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
    return;
  }
  if (updateTimer) return;
  updateTimer = setInterval(checkUpdateTask, 30_000);
  checkUpdateTask();
}

async function checkUpdateTask() {
  if (updating) return;
  const { serverUrl, siteToken } = state.server || {};
  if (!serverUrl || !siteToken) return;
  try {
    const response = await getJson(joinUrl(serverUrl, "/api/edge/update-task"), { "X-Access-Token": siteToken });
    const task = response.data?.task;
    if (task?.status === "pending") {
      updating = true;
      runUpdateTask(task);
      setTimeout(() => { updating = false; }, 120_000); // 执行窗口 2 分钟
    }
  } catch { /* 后端不可达忽略，下轮再试 */ }
}

function runUpdateTask(task) {
  const installRoot = resolveInstallRoot();
  const updater = path.join(installRoot, "scripts", "linux", "update-linux.sh");
  const { serverUrl, siteToken } = state.server || {};
  if (!fs.existsSync(updater)) {
    logger.warn("update runner missing", { updater });
    updating = false;
    return;
  }
  const args = [updater, task.url, task.sha256, task.version, installRoot, serverUrl, siteToken, String(state.shop?.shopId || "")];
  const child = spawn("bash", args, { detached: true, stdio: "ignore" });
  child.unref();
  logger.info("remote update started", { version: task.version, url: task.url });
}

async function registerDeviceRemote(record) {
  const baseUrl = state.server.serverUrl;
  const token = state.server.siteToken;
  if (!baseUrl || !token) {
    return { enabled: false, message: "未配置数据服务地址或接入令牌（可在「hik 数据上报」页填写）" };
  }
  const deviceIndexCode = String(record.deviceIndexCode || record.macAddress || record.deviceKey || "")
    .trim()
    .toLowerCase()
    .replace(/[:\-]/g, "");
  const storeId = record.storeId != null ? record.storeId : record.shopId != null ? record.shopId : null;
  const url = joinUrl(baseUrl, "/api/edge/devices");
  try {
    const response = await postJson(url, {
      deviceIndexCode,
      cameraIndexCode: record.cameraIndexCode || "",
      macAddress: record.macAddress || "",
      storeId,
      positionType: record.positionType || "UNKNOWN",
      deviceName: record.deviceName || "",
      ipAddress: record.ipAddress || "",
    }, { "X-Access-Token": token });
    const ok = response.ok && response.data?.ok === true;
    logger.info("remote device register", {
      url, deviceIndexCode, storeId, ok,
      message: ok ? "" : (response.data?.error || `HTTP ${response.status}`)
    });
    return {
      enabled: true,
      ok,
      url,
      message: ok ? "远端注册成功" : (response.data?.error || `HTTP ${response.status}`),
      response: response.data
    };
  } catch (error) {
    logger.warn("remote device register failed", { url, error: error.message });
    return { enabled: true, ok: false, url, message: error.message };
  }
}

/** 远端注册设备（async 版本，绑定本地设备后调用） */
async function bindLocalDeviceWithRemote(record) {
  const local = bindLocalDevice(record);
  const remote = await registerDeviceRemote(record);
  return {
    ...local,
    remote,
  };
}

/** 拉取后端 bootstrap（门店/品牌/已有设备，供下拉选取） */
async function backendBootstrap(baseUrl, token) {
  const macs = dedupeDeviceRecords(state.devices)
    .map((d) => d.macAddress || "")
    .filter(Boolean)
    .join(",");
  const url = joinUrl(baseUrl, "/api/edge/bootstrap" + (macs ? `?macs=${encodeURIComponent(macs)}` : ""));
  const response = await getJson(url, { "X-Access-Token": token });
  if (!response.ok) {
    throw new Error(response.data?.error || `bootstrap failed with ${response.status}`);
  }
  return response.data;
}

/** 调后端 POST 接口（edge/stores、edge/devices） */
async function backendPost(baseUrl, token, path, body) {
  const url = joinUrl(baseUrl, path);
  const response = await postJson(url, body || {}, { "X-Access-Token": token });
  if (!response.ok) {
    throw new Error(response.data?.error || `request failed with ${response.status}`);
  }
  return response.data;
}

async function registerDeviceFlow(body) {
  const steps = [];
  const collectorUrl = body.collectorUrl || state.localCollector?.baseUrl;
  const device = buildCollectorDeviceConfig(body.device || {});
  if (!collectorUrl) {
    throw new Error("collectorUrl is required");
  }

  steps.push({ name: "collector-register", status: "running" });
  const collector = await collectorPost(collectorUrl, "/api/devices/register", device);
  steps[steps.length - 1] = { name: "collector-register", status: "success", result: collector };
  await refreshCollectorSnapshot(collectorUrl, collector).catch((error) => {
    logger.warn("collector snapshot refresh failed after register flow", { error: error.message });
  });

  steps.push({ name: "local-device-record", status: "running" });
  const record = buildDeviceRecord(device);
  const remote = await bindLocalDeviceWithRemote(record);
  state.localCollector = { ...(state.localCollector || {}), baseUrl: collectorUrl };
  state.devices = state.devices.filter((item) => deviceUniqueKey(item) !== deviceUniqueKey(record));
  state.devices.unshift({ ...record, localId: `${Date.now()}`, remote, collector });
  state.devices = dedupeDeviceRecords(state.devices).slice(0, 50);
  saveState(state);
  await applyCollectorSnapshot(collectorUrl).catch((error) => {
    logger.warn("collector snapshot apply failed after register flow", { error: error.message });
  });
  steps[steps.length - 1] = { name: "local-device-record", status: "success", result: remote };

  logger.info("device register flow completed", {
    collectorUrl,
    deviceKey: device.deviceKey,
    shopId: record.shopId
  });
  return { steps, record, collector, remote };
}

function scheduleConfiguredCollectorRefresh(options = {}) {
  const collectorUrl = state.localCollector?.baseUrl;
  if (!collectorUrl || state.localCollector?.autoConnect === false) return collectorRefreshPromise;
  if (collectorPortConflict) return collectorRefreshPromise;
  const now = Date.now();
  if (!options.force && now - lastCollectorRefreshAt < COLLECTOR_REFRESH_INTERVAL_MS) return collectorRefreshPromise;
  if (collectorRefreshPromise) return collectorRefreshPromise;
  lastCollectorRefreshAt = now;
  collectorRefreshPromise = refreshConfiguredCollector(collectorUrl)
    .catch((error) => {
      logger.warn("configured collector refresh failed", { collectorUrl, error: error.message });
    })
    .finally(() => {
      collectorRefreshPromise = null;
    });
  return collectorRefreshPromise;
}

async function refreshConfiguredCollector(collectorUrl) {
  await ensureManagedCollector();
  await refreshCollectorSnapshot(collectorUrl);
  await applyCollectorSnapshot(collectorUrl);
}

async function ensureManagedCollector() {
  const collectorUrl = state.localCollector?.baseUrl;
  if (!collectorUrl || state.localCollector?.autoConnect === false) return;
  if (!isLocalCollectorUrl(collectorUrl)) return;
  const parsed = new URL(collectorUrl);
  if (Number(parsed.port || 80) === PORT) {
    collectorPortConflict = true;
    logger.error("collector port conflicts with console port", { port: PORT, hint: "请修改 COLLECTOR_PORT 或本地采集器地址" });
    return;
  }
  collectorPortConflict = false;
  if (await isCollectorReachable(collectorUrl)) return;
  startManagedCollector();
  await waitForCollectorReachable(collectorUrl);
}

async function isCollectorReachable(collectorUrl) {
  try {
    await collectorGet(collectorUrl, "/api/health");
    return true;
  } catch {
    return false;
  }
}

async function waitForCollectorReachable(collectorUrl, timeoutMs = 4_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isCollectorReachable(collectorUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function startManagedCollector() {
  if (collectorProcess && !collectorProcess.killed) return;
  const scriptPath = path.join(__dirname, "..", "scripts", "runtime", "collector-server.js");
  const collectorUrl = new URL(state.localCollector?.baseUrl || "http://127.0.0.1:3100");
  const env = {
    ...process.env,
    COLLECTOR_ID: MANAGED_COLLECTOR_ID,
    COLLECTOR_PORT: collectorUrl.port || "3100",
    GATEWAY_URL: `http://${HOST}:${PORT}`,
    COLLECTOR_ADAPTER: process.env.COLLECTOR_ADAPTER || "hikvision",
    PYTHON_PATH: process.env.PYTHON_PATH || "python",
    HIK_SDK_DIR: process.env.HIK_SDK_DIR || ""
  };
  collectorProcess = spawn(process.execPath, [scriptPath], {
    cwd: path.join(__dirname, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false
  });
  logger.info("managed collector started", { pid: collectorProcess.pid, collectorUrl: state.localCollector?.baseUrl });
  collectorProcess.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      logger.info("managed collector output", { line });
    }
  });
  collectorProcess.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      logger.warn("managed collector error", { line });
    }
  });
  collectorProcess.on("exit", (code, signal) => {
    logger.warn("managed collector exited", { code, signal });
    collectorProcess = null;
  });
  collectorProcess.on("error", (error) => {
    logger.warn("managed collector start failed", { error: error.message });
    collectorProcess = null;
  });
}

function isLocalCollectorUrl(value) {
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function applyCollectorSnapshot(collectorUrl) {
  const snapshot = buildCollectorSnapshot();
  const result = await collectorPost(collectorUrl, "/api/runtime/apply-snapshot", snapshot);
  discoverCollector(result, collectorUrl);
  return result;
}

function listCollectorDevices() {
  return Array.from(collectors.values()).flatMap((collector) => collector.devices || []);
}

function dedupeDeviceRecords(devices) {
  const seen = new Set();
  const output = [];
  for (const device of Array.isArray(devices) ? devices : []) {
    const macAddress = normalizeMacAddress(device.macAddress || device.deviceIndexCode || device.deviceKey || device.deviceId);
    const key = macAddress || deviceUniqueKey(device);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push({
      ...device,
      macAddress: macAddress || device.macAddress,
      deviceKey: macAddress || device.deviceKey,
      deviceIndexCode: macAddress || device.deviceIndexCode,
      invalidConfig: macAddress ? "" : "缺少有效 MAC，不能自动下发到本地采集器"
    });
  }
  return output;
}

function deviceUniqueKey(device) {
  return normalizeMacAddress(device.macAddress || device.deviceIndexCode || device.deviceKey || device.deviceId) || deviceIndexCode(device);
}

function normalizeMacAddress(value) {
  const text = String(value || "").trim().toLowerCase();
  const compact = text.replace(/[^0-9a-f]/g, "");
  if (compact.length !== 12) return "";
  return compact.match(/.{1,2}/g).join(":");
}

function buildCollectorSnapshot() {
  const devices = [];
  const skipped = [];
  for (const device of dedupeDeviceRecords(state.devices)) {
    try {
      devices.push(buildCollectorDeviceConfig(device));
    } catch (error) {
      skipped.push({
        deviceName: device.deviceName || "",
        ipAddress: device.ipAddress || "",
        macAddress: device.macAddress || "",
        reason: "missing-valid-mac"
      });
    }
  }
  if (skipped.length) {
    logger.warn("collector snapshot skipped invalid devices", { count: skipped.length, devices: skipped.slice(0, 10) });
  }
  return {
    gatewayUrl: `http://${HOST}:${PORT}`,
    collector: {
      collectorId: MANAGED_COLLECTOR_ID,
      adapter: process.env.COLLECTOR_ADAPTER || "hikvision"
    },
    cameraDefaults: {
      username: state.cameraDefaults?.username || "admin",
      sdkPort: Number(state.cameraDefaults?.sdkPort || 8000),
      savePassword: Boolean(state.cameraDefaults?.savePassword)
    },
    devices,
    skippedDevices: skipped
  };
}

function buildDeviceRecord(body) {
  const shopId = String(body.shopId || state.shop.shopId || "local-shop");
  const macAddress = normalizeMacAddress(body.macAddress || body.deviceIndexCode || body.deviceKey || body.deviceId);
  if (!macAddress) {
    throw new Error("缺少有效 MAC 地址，不能保存摄像头");
  }
  const savePassword = body.savePassword ?? state.cameraDefaults?.savePassword;
  return {
    shopId,
    shopName: body.shopName || state.shop.shopName || "Local Shop",
    type: Number(body.type),
    positionType: body.positionType || "UNKNOWN",
    macAddress,
    deviceKey: macAddress,
    deviceIndexCode: macAddress,
    deviceId: macAddress,
    deviceType: body.deviceType || "Hikvision",
    ipAddress: body.ipAddress || "",
    deviceName: body.deviceName || `Camera ${body.ipAddress || macAddress}`,
    username: body.username || body.sdk?.username || state.cameraDefaults?.username || "admin",
    password: savePassword ? (body.password || body.sdk?.password || "") : "",
    sdkVendor: body.sdkVendor || body.vendor || body.sdk?.vendor || "hikvision-real",
    sdkPort: Number(body.sdkPort || body.sdk?.port || state.cameraDefaults?.sdkPort || 8000),
    savePassword: Boolean(savePassword),
    city: body.city || "",
    remark: body.remark || "registered by local console"
  };
}

async function collectorGet(baseUrl, path) {
  const response = await getJson(joinUrl(baseUrl, path));
  if (!response.ok || response.data?.ok === false) {
    throw new Error(response.data?.error || `collector request failed with ${response.status}`);
  }
  return response.data;
}

async function collectorPost(baseUrl, path, body) {
  const response = await postJson(joinUrl(baseUrl, path), body || {});
  if (!response.ok || response.data?.ok === false) {
    throw new Error(response.data?.error || `collector request failed with ${response.status}`);
  }
  return response.data;
}

async function ingestCollectorEvent(event) {
  if (event.collectorId) {
    touchCollectorFromEvent(event);
  }
  const payload = event.eventType === "HumanBodyComparison" ? buildLegacyHumanBodyPayload(event) : buildPeopleCountingPayload(event);
  let response = {
    ok: false,
    status: 0,
    data: { message: "remote reporting skipped" }
  };
  const legacy = await forwardLegacyHikEvent(event);
  const summary = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toISOString(),
    event,
    deviceIndexCode: deviceIndexCode(event),
    payload,
    response,
    legacy
  };
  recentEvents.unshift(summary);
  recentEvents.splice(100);
  logger.info("collector event received locally", {
    macAddress: event.macAddress || event.deviceKey,
    eventType: event.eventType,
    enter: event.enter,
    exit: event.exit,
    legacyForwarded: legacy.enabled ? legacy.ok : false
  });
}

function buildCollectorDeviceConfig(body) {
  const macAddress = normalizeMacAddress(body.macAddress || body.deviceIndexCode || body.deviceKey || body.deviceId);
  if (!macAddress) throw new Error("缺少有效 MAC 地址，不能下发摄像头");
  return {
    ...body,
    macAddress,
    deviceKey: macAddress,
    deviceIndexCode: macAddress,
    deviceId: macAddress,
    gatewayUrl: body.gatewayUrl || `http://${HOST}:${PORT}`,
    sdk: {
      vendor: body.sdk?.vendor || body.sdkVendor || body.vendor || "hikvision-real",
      port: Number(body.sdk?.port || body.sdkPort || body.port || 8000),
      username: body.sdk?.username || body.username || "",
      password: body.sdk?.password || body.password || ""
    }
  };
}

async function probeLegacyHik(baseUrl) {
  const eventRcv = await probeLegacyEndpoint(baseUrl, "/api/hik/eventRcv", buildLegacyPeopleCountingPayload({
    macAddress: "00:00:00:00:00:00",
    ipAddress: "127.0.0.1",
    channelId: 1,
    enter: 0,
    exit: 0,
    duplicatePeople: 0
  }));
  const eventRtbw = await probeLegacyEndpoint(baseUrl, "/api/hik/eventRtbw", buildLegacyHumanBodyPayload({
    eventType: "HumanBodyComparison",
    macAddress: "00:00:00:00:00:00",
    ipAddress: "127.0.0.1",
    channelId: 1,
    raw: {
      isapi: {
        eventType: "humanBodyComparison",
        dateTime: new Date().toISOString(),
        HumanBodyComparison: [{ HumanInfo: { humanID: 0, ageGroup: "unknown", gender: "unknown", mask: "unknown", hat: "unknown" } }]
      },
      pictureFiles: []
    }
  }));
  return {
    reachable: eventRcv.ok && eventRtbw.ok,
    status: eventRcv.status || eventRtbw.status || 0,
    message: eventRcv.ok && eventRtbw.ok ? "两个接口均可用" : "至少一个接口不可用",
    endpoints: { eventRcv, eventRtbw }
  };
}

async function probeLegacyEndpoint(baseUrl, path, payload) {
  const url = joinUrl(baseUrl, path);
  try {
    const response = await postJson(url, payload);
    return {
      ok: response.ok && response.data?.code === 200,
      status: response.status,
      path,
      message: response.data?.message || ""
    };
  } catch (error) {
    return { ok: false, status: 0, path, message: error.message };
  }
}

async function forwardLegacyHikEvent(event) {
  const baseUrl = state.server.serverUrl;
  if (!baseUrl) return { enabled: false, deviceIndexCode: deviceIndexCode(event) };

  const isHumanBody = event.eventType === "HumanBodyComparison";
  const path = isHumanBody ? "/api/hik/eventRtbw" : "/api/hik/eventRcv";
  const payload = isHumanBody ? buildLegacyHumanBodyPayload(event) : buildLegacyPeopleCountingPayload(event);
  if (!payload) return { enabled: true, skipped: true, deviceIndexCode: deviceIndexCode(event), path };

  const url = joinUrl(baseUrl, path);
  try {
    const headers = {};
    if (state.server.siteToken) headers["X-Access-Token"] = state.server.siteToken;
    const response = await postJson(url, payload, headers);
    if (response.ok && response.data?.code === 200) {
      logger.info("legacy hik event forwarded", { url, eventType: event.eventType, deviceIndexCode: deviceIndexCode(event) });
    } else {
      logger.warn("legacy hik event forward failed", { url, eventType: event.eventType, response });
    }
    return { enabled: true, ok: response.ok && response.data?.code === 200, url, path, deviceIndexCode: deviceIndexCode(event), response };
  } catch (error) {
    logger.warn("legacy hik event forward failed", { url, eventType: event.eventType, error: error.message });
    return { enabled: true, ok: false, url, path, deviceIndexCode: deviceIndexCode(event), error: error.message };
  }
}

function buildLegacyPeopleCountingPayload(event) {
  const occurredAt = legacyTime(event.occurredAt);
  const indexCode = deviceIndexCode(event);
  return {
    method: "OnEventNotify",
    params: {
      ability: "event_pdc",
      events: [{
        data: {
          channelID: Number(event.channelId || 1),
          dataType: "flowStatistic",
          dateTime: occurredAt,
          eventDescription: "peopleCounting",
          eventType: "peopleCounting",
          ipAddress: event.ipAddress || "",
          peopleCounting: [{
            childEnterNum: Number(event.childEnter || 0),
            childLeaveNum: Number(event.childExit || 0),
            duplicatePeople: Number(event.duplicatePeople || 0),
            enter: Number(event.enter || 0),
            exit: Number(event.exit || 0),
            pass: Number(event.passing || 0),
            statisticalMethods: "realTime",
            targetAttrs: {
              cameraIndexCode: indexCode,
              deviceIndexCode: indexCode
            }
          }],
          portNo: 8000,
          recvTime: occurredAt,
          sendTime: occurredAt
        },
        eventId: `local-${indexCode}-${Date.now()}`,
        eventType: 131616,
        happenTime: occurredAt,
        srcIndex: indexCode,
        srcParentIndex: indexCode,
        srcType: "camera",
        status: 0,
        timeout: 0
      }],
      sendTime: occurredAt
    }
  };
}

function buildLegacyHumanBodyPayload(event) {
  const data = event.raw?.isapi;
  if (!data || data.eventType !== "humanBodyComparison" || !Array.isArray(data.HumanBodyComparison)) return null;
  const indexCode = deviceIndexCode(event);
  const occurredAt = legacyTime(event.occurredAt || data.dateTime);
  const pictureFiles = event.raw?.pictureFiles || [];
  const comparisons = data.HumanBodyComparison.map((item) => ({
    HumanInfo: {
      ...(item.HumanInfo || {}),
      LocalPictureFiles: pictureFiles
    },
    targetAttrs: {
      cameraIndexCode: indexCode,
      deviceIndexCode: indexCode,
      picServerIndexCode: indexCode
    }
  }));
  return {
    method: "OnEventNotify",
    params: {
      ability: "event_body",
      events: [{
        data: {
          ...data,
          dateTime: occurredAt,
          deviceID: indexCode,
          macAddress: event.macAddress || event.deviceKey,
          HumanBodyComparison: comparisons,
          targetAttrs: {
            cameraIndexCode: indexCode,
            deviceIndexCode: indexCode,
            imageServerCode: indexCode,
            picServerIndexCode: indexCode
          }
        },
        eventId: `local-body-${indexCode}-${Date.now()}`,
        eventType: 262147,
        happenTime: occurredAt,
        srcIndex: indexCode,
        srcParentIndex: indexCode,
        srcType: "camera",
        status: 1,
        timeout: 30
      }],
      sendTime: occurredAt
    }
  };
}

function deviceIndexCode(event) {
  return String(event.macAddress || event.deviceKey || event.ipAddress || "")
    .trim()
    .toLowerCase()
    .replaceAll(":", "")
    .replaceAll("-", "");
}

function legacyTime(value) {
  if (!value) return new Date().toISOString();
  const text = String(value);
  if (text.includes("T")) return text.includes("+") || text.endsWith("Z") ? text : `${text}.000+08:00`;
  return `${text.replace(" ", "T")}.000+08:00`;
}

function upsertCollector(heartbeat) {
  const collectorId = String(heartbeat.collectorId || heartbeat.id || "unknown-collector");
  const now = new Date().toISOString();
  const collector = {
    collectorId,
    version: heartbeat.version || "",
    adapter: heartbeat.adapter || "",
    host: heartbeat.host || "",
    devices: Array.isArray(heartbeat.devices) ? heartbeat.devices : [],
    lastHeartbeatAt: now,
    lastEventAt: collectors.get(collectorId)?.lastEventAt || "",
    status: "online"
  };
  collectors.set(collectorId, collector);
  return collector;
}

function discoverCollector(result, collectorUrl) {
  const info = result?.collector || {};
  const collectorId = String(info.collectorId || info.id || "unknown-collector");
  const existing = collectors.get(collectorId) || {};
  collectors.set(collectorId, {
    collectorId,
    version: info.version || existing.version || "",
    adapter: info.adapter || existing.adapter || "",
    host: collectorUrl || existing.host || "",
    devices: Array.isArray(info.devices) ? info.devices : existing.devices || [],
    lastHeartbeatAt: existing.lastHeartbeatAt || info.lastHeartbeatAt || "",
    lastEventAt: existing.lastEventAt || info.lastEventAt || "",
    lastSeenAt: new Date().toISOString(),
    status: existing.lastHeartbeatAt ? "online" : "reachable"
  });
}

async function refreshCollectorSnapshot(collectorUrl, fallbackResult) {
  if (!collectorUrl) return;
  try {
    const health = await collectorGet(collectorUrl, "/api/health");
    discoverCollector(health, collectorUrl);
  } catch (error) {
    if (fallbackResult) discoverCollector({ collector: { ...fallbackResult, devices: fallbackResult.device ? [fallbackResult.device] : [] } }, collectorUrl);
    throw error;
  }
}

function touchCollectorFromEvent(event) {
  const collectorId = String(event.collectorId);
  const existing = collectors.get(collectorId) || {
    collectorId,
    version: "",
    adapter: event.source || "",
    host: "",
    devices: [],
    lastHeartbeatAt: "",
    lastEventAt: "",
    status: "event-only"
  };
  collectors.set(collectorId, {
    ...existing,
    lastEventAt: new Date().toISOString(),
    adapter: existing.adapter || event.source || "",
    devices: mergeCollectorDevices(existing.devices, event)
  });
}

function mergeCollectorDevices(devices, event) {
  const deviceKey = event.deviceKey || event.macAddress || event.ipAddress;
  if (!deviceKey) return devices;
  const nextDevice = {
    deviceKey,
    ipAddress: event.ipAddress || "",
    macAddress: event.macAddress || "",
    status: "online",
    lastEventAt: new Date().toISOString()
  };
  const output = devices.filter((device) => String(device.deviceKey || device.macAddress || device.ipAddress) !== String(deviceKey));
  output.unshift(nextDevice);
  return output.slice(0, 50);
}

function listCollectors() {
  const now = Date.now();
  return Array.from(collectors.values()).map((collector) => {
    const last = collector.lastHeartbeatAt ? Date.parse(collector.lastHeartbeatAt) : 0;
    if (!last && collector.status === "reachable") {
      return { ...collector, status: "reachable" };
    }
    return {
      ...collector,
      status: last && now - last <= 30_000 ? "online" : "stale"
    };
  });
}

/** 控制台自身信息（上报给后端，Web 端一键跳转用）：局域网 IP + 端口 */
function consoleInfo() {
  return {
    id: state.console?.id || "",
    name: state.console?.name || os.hostname(),
    ip: detectLanIp(),
    port: PORT,
  };
}

/** 探测局域网 IP：优先私有网段（10./172.16-31./192.168.） */
function detectLanIp() {
  const ifaces = listInterfaces();
  for (const iface of ifaces) {
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(iface.address)) return iface.address;
  }
  return ifaces[0]?.address || "127.0.0.1";
}

function publicState() {
  return {
    ...state,
    devices: dedupeDeviceRecords(state.devices),
    release: releaseState(),
    server: {
      serverUrl: state.server.serverUrl || "",
      siteToken: state.server.siteToken || "",
      mode: state.server.serverUrl ? "hik-contact-data" : "offline",
      token: ""
    }
  };
}

function defaultManifestUrl(channel = "stable") {
  return `https://kequn.fenqunshuju.com:8443/releases/camera-local-console/channels/${channel}.json`;
}

function releaseState() {
  const release = state.release || {};
  const installed = readInstalledVersion();
  const channel = release.channel || installed.channel || "stable";
  return {
    version: installed.version || release.version || readPackageVersion(),
    channel,
    manifestUrl: release.manifestUrl || defaultManifestUrl(channel),
    lastCheckAt: release.lastCheckAt || "",
    lastCheckResult: release.lastCheckResult || null
  };
}

function readInstalledVersion() {
  const candidates = [
    path.join(process.cwd(), "version.json"),
    path.join(__dirname, "..", "..", "version.json"),
    path.join(__dirname, "..", "version.json")
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      return {
        version: String(parsed.version || "").trim(),
        channel: String(parsed.channel || "").trim()
      };
    } catch (error) {
      logger.warn("installed version file read failed", { file, error: error.message });
    }
  }
  return {};
}

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function checkRelease(manifestUrl) {
  const current = releaseState();
  const url = String(manifestUrl || current.manifestUrl || "").trim();
  if (!url) throw new Error("manifestUrl is required");
  const channels = await checkReleaseChannels(url, current);
  const selected = channels.find((item) => item.channel === current.channel) || channels.find((item) => item.manifestUrl === url) || channels[0];
  const manifest = selected?.manifest || null;
  const latestVersion = String(manifest?.version || "");
  return {
    currentVersion: current.version,
    latestVersion,
    updateAvailable: Boolean(selected?.updateAvailable),
    manifestUrl: url,
    manifest,
    channels
  };
}

async function checkReleaseChannels(manifestUrl, current) {
  const urls = new Map();
  urls.set(current.channel || "stable", manifestUrl);
  for (const channel of ["stable", "beta", "canary"]) {
    urls.set(channel, siblingManifestUrl(manifestUrl, channel) || defaultManifestUrl(channel));
  }
  const checks = await Promise.all(Array.from(urls.entries()).map(async ([channel, url]) => {
    try {
      const response = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!response.ok) throw new Error(`manifest request failed with ${response.status}`);
      const manifest = await response.json();
      const latestVersion = String(manifest.version || "");
      const manifestChannel = String(manifest.channel || channel || "");
      return {
        ok: true,
        channel: manifestChannel,
        label: releaseChannelLabel(manifestChannel),
        manifestUrl: url,
        currentVersion: current.version,
        latestVersion,
        updateAvailable: isNewerVersion(latestVersion, current.version),
        manifest
      };
    } catch (error) {
      return {
        ok: false,
        channel,
        label: releaseChannelLabel(channel),
        manifestUrl: url,
        currentVersion: current.version,
        latestVersion: "",
        updateAvailable: false,
        error: error.message
      };
    }
  }));
  const seen = new Set();
  return checks.filter((item) => {
    const key = item.channel || item.manifestUrl;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isNewerVersion(latestVersion, currentVersion) {
  if (!latestVersion) return false;
  if (!currentVersion) return true;
  return compareVersions(latestVersion, currentVersion) > 0;
}

function compareVersions(a, b) {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta !== 0) return delta;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function parseVersionParts(version) {
  return String(version || "")
    .split(/[.+-]/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function siblingManifestUrl(manifestUrl, channel) {
  try {
    const url = new URL(manifestUrl);
    url.pathname = url.pathname.replace(/\/channels\/[^/]+\.json$/, `/channels/${channel}.json`);
    return url.toString();
  } catch {
    return "";
  }
}

function releaseChannelLabel(channel) {
  return {
    stable: "稳定版",
    beta: "测试版",
    canary: "灰度版"
  }[channel] || channel || "自定义";
}

function startLocalUpdate(manifestUrl, channel) {
  const url = String(manifestUrl || defaultManifestUrl(channel || "stable")).trim();
  if (process.platform !== "win32") {
    throw new Error("当前本机更新仅支持 Windows 安装包。Linux ARM64 / RK3566 请使用镜像更新脚本。");
  }
  const installRoot = resolveInstallRoot();
  const runnerScript = path.join(installRoot, "app", "scripts", "runtime", "update-runner.js");
  const sourceRunnerScript = path.join(installRoot, "scripts", "runtime", "update-runner.js");
  const scriptPath = fs.existsSync(runnerScript) ? runnerScript : sourceRunnerScript;
  if (!fs.existsSync(scriptPath)) {
    throw new Error("未找到更新进度 runner，无法执行本机更新。");
  }
  const updaterNode = prepareUpdaterRuntime(installRoot);
  const runnerPort = Number(process.env.UPDATE_RUNNER_PORT || 3219);
  const progressUrl = `http://127.0.0.1:${runnerPort}/`;
  const child = spawn(updaterNode, [scriptPath], {
    cwd: installRoot,
    env: {
      ...process.env,
      INSTALL_ROOT: installRoot,
      MANIFEST_URL: url,
      CHANNEL: channel || state.release?.channel || "stable",
      CONSOLE_URL: `http://${HOST}:${PORT}`,
      UPDATE_RUNNER_PORT: String(runnerPort)
    },
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  logger.info("local update runner started", { manifestUrl: url, progressUrl });
  return {
    started: true,
    platform: process.platform,
    manifestUrl: url,
    progressUrl,
    message: "已进入更新进度页。更新过程会停止当前控制台，页面短暂断开属于正常现象。"
  };
}

function prepareUpdaterRuntime(installRoot) {
  const updateRoot = path.join(installRoot, ".update");
  const updaterRuntimeDir = path.join(updateRoot, "updater-runtime");
  fs.mkdirSync(updaterRuntimeDir, { recursive: true });
  const sourceNode = process.execPath;
  const targetNode = path.join(updaterRuntimeDir, path.basename(sourceNode));
  fs.copyFileSync(sourceNode, targetNode);
  logger.info("updater runtime prepared", { sourceNode, targetNode });
  return targetNode;
}

async function cleanupCompletedUpdateWorkDir() {
  const installRoot = resolveInstallRoot();
  const updateRoot = path.join(installRoot, ".update");
  const statePath = path.join(updateRoot, "update-state.json");
  if (!fs.existsSync(updateRoot) || !fs.existsSync(statePath)) return;
  let updateState = null;
  try {
    updateState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return;
  }
  if (updateState?.status !== "done") return;
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  fs.rmSync(updateRoot, { recursive: true, force: true });
  logger.info("completed update work dir cleaned", { updateRoot });
}

function resolveInstallRoot() {
  const appRoot = path.resolve(__dirname, "..");
  const packagedRoot = path.resolve(appRoot, "..");
  if (fs.existsSync(path.join(packagedRoot, "start-all.cmd"))) return packagedRoot;
  return appRoot;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath);
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  };
  res.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("request body too large"));
      }
    });
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

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}
