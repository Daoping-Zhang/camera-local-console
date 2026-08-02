import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./core/logger.js";
import { loadState, saveState } from "./core/store.js";
import { getJson, postJson, joinUrl } from "./services/http-client.js";
import { buildPeopleCountingPayload } from "./services/payload-builder.js";
import { listInterfaces, scanSubnet } from "./services/scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

let state = loadState();
const recentEvents = [];
const collectors = new Map();
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
});

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, { ok: true, state: publicState(), interfaces: listInterfaces(), events: recentEvents });
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
  if (req.method === "POST" && url.pathname === "/api/collector-proxy/health") {
    const body = await readJson(req);
    const result = await collectorGet(body.collectorUrl, "/api/health");
    discoverCollector(result, body.collectorUrl);
    sendJson(res, 200, { ok: true, result });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/collector-proxy/register-device") {
    const body = await readJson(req);
    const result = await collectorPost(body.collectorUrl, "/api/devices/register", body.device);
    sendJson(res, 200, { ok: true, result });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/collector-proxy/test-event") {
    const body = await readJson(req);
    const result = await collectorPost(body.collectorUrl, "/api/events/test", { deviceKey: body.deviceKey });
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
    const shops = state.server.localDebug ? debugShops : await listRemoteShops();
    sendJson(res, 200, { ok: true, shops });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/debug-mode") {
    const body = await readJson(req);
    state.server.localDebug = Boolean(body.enabled);
    if (state.server.localDebug) {
      state.server.token = "";
      state.shop = state.shop.shopId ? state.shop : { shopId: debugShops[0].id, shopName: debugShops[0].name };
    }
    saveState(state);
    logger.info("local debug mode changed", { enabled: state.server.localDebug });
    sendJson(res, 200, { ok: true, state: publicState(), shops: state.server.localDebug ? debugShops : [] });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/server/connect") {
    const body = await readJson(req);
    state.server = {
      ...state.server,
      baseUrl: body.baseUrl || state.server.baseUrl,
      loginPath: body.loginPath || state.server.loginPath,
      cameraDataPath: body.cameraDataPath || state.server.cameraDataPath
    };
    const result = await loginRemote(body.username, body.password);
    saveState(state);
    sendJson(res, 200, { ok: true, result, state: publicState() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/shop/save") {
    const body = await readJson(req);
    state.shop = {
      shopId: String(body.shopId || ""),
      shopName: String(body.shopName || "")
    };
    saveState(state);
    logger.info("shop saved", state.shop);
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
    const remote = state.server.localDebug ? bindLocalDevice(record) : await bindRemoteDevice(record);
    state.devices.unshift({ ...record, localId: `${Date.now()}`, remote });
    state.devices = state.devices.slice(0, 50);
    saveState(state);
    logger.info("device bound", { shopId: record.shopId, macAddress: record.macAddress, type: record.type });
    sendJson(res, 200, { ok: true, record, remote, state: publicState() });
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
    logger.info("collector heartbeat received", { collectorId: collector.collectorId, deviceCount: collector.devices.length });
    sendJson(res, 200, { ok: true, collector });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/test-event") {
    const body = await readJson(req);
    const event = {
      source: "console-test",
      deviceKey: body.macAddress || "local-camera-001",
      macAddress: body.macAddress || "local-camera-001",
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

async function loginRemote(username, password) {
  if (!username || !password) {
    throw new Error("username and password are required");
  }
  const url = joinUrl(state.server.baseUrl, state.server.loginPath);
  const response = await postJson(url, { username, password });
  if (!response.ok || response.data?.code !== 200) {
    logger.warn("remote login failed", { status: response.status, response: response.data });
    throw new Error(response.data?.message || "remote login failed");
  }
  const data = response.data.data || {};
  state.server.tokenHeader = data.tokenHeader || state.server.tokenHeader || "Authorization";
  state.server.token = data.token || "";
  logger.info("remote login succeeded", { baseUrl: state.server.baseUrl, tokenHeader: state.server.tokenHeader });
  return { status: response.status, data: response.data };
}

async function listRemoteShops() {
  const url = joinUrl(state.server.baseUrl, "/shop/listShopNames");
  const headers = {};
  if (state.server.token) {
    headers[state.server.tokenHeader || "Authorization"] = state.server.token;
  }
  const response = await getJson(url, headers);
  if (!response.ok || response.data?.code !== 200) {
    logger.warn("remote shop list failed", { status: response.status, response: response.data });
    throw new Error(response.data?.message || "remote shop list failed");
  }
  const shops = Array.isArray(response.data.data) ? response.data.data : [];
  logger.info("remote shop list loaded", { count: shops.length });
  return shops.map((shop) => ({
    id: shop.id ?? shop.shopId,
    name: shop.name ?? shop.shopName ?? shop.shop_name ?? ""
  })).filter((shop) => shop.id);
}

function bindLocalDevice(record) {
  logger.info("device bound locally", { shopId: record.shopId, macAddress: record.macAddress, type: record.type });
  return {
    code: 200,
    message: "local debug bind only",
    data: "本地调试模式，未调用远端 /shop/insertDevice"
  };
}

async function registerDeviceFlow(body) {
  const steps = [];
  const collectorUrl = body.collectorUrl;
  const device = body.device || {};
  if (!collectorUrl) {
    throw new Error("collectorUrl is required");
  }

  steps.push({ name: "collector-register", status: "running" });
  const collector = await collectorPost(collectorUrl, "/api/devices/register", device);
  steps[steps.length - 1] = { name: "collector-register", status: "success", result: collector };

  steps.push({ name: state.server.localDebug ? "gateway-local-bind" : "remote-device-bind", status: "running" });
  const record = buildDeviceRecord(device);
  const remote = state.server.localDebug ? bindLocalDevice(record) : await bindRemoteDevice(record);
  state.devices.unshift({ ...record, localId: `${Date.now()}`, remote, collector });
  state.devices = state.devices.slice(0, 50);
  saveState(state);
  steps[steps.length - 1] = { name: state.server.localDebug ? "gateway-local-bind" : "remote-device-bind", status: "success", result: remote };

  logger.info("device register flow completed", {
    collectorUrl,
    deviceKey: device.deviceKey,
    shopId: record.shopId,
    localDebug: state.server.localDebug
  });
  return { steps, record, collector, remote };
}

function buildDeviceRecord(body) {
  const shopId = String(body.shopId || state.shop.shopId || "");
  if (!shopId) {
    throw new Error("shopId is required");
  }
  const macAddress = String(body.macAddress || body.deviceId || body.ipAddress || "").trim();
  if (!macAddress) {
    throw new Error("macAddress is required");
  }
  return {
    shopId,
    shopName: body.shopName || state.shop.shopName || "",
    type: Number(body.type),
    macAddress,
    deviceId: body.deviceId || macAddress,
    deviceType: body.deviceType || "Hikvision",
    ipAddress: body.ipAddress || "",
    deviceName: body.deviceName || `Camera ${macAddress}`,
    city: body.city || "",
    remark: body.remark || "registered by local console"
  };
}

async function bindRemoteDevice(record) {
  const url = joinUrl(state.server.baseUrl, "/shop/insertDevice");
  const headers = {};
  if (state.server.token) {
    headers[state.server.tokenHeader || "Authorization"] = state.server.token;
  }
  const response = await postJson(url, record, headers);
  if (!response.ok || response.data?.code !== 200) {
    logger.warn("remote device bind failed", { status: response.status, response: response.data });
    throw new Error(response.data?.message || "remote device bind failed");
  }
  return response.data;
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
  const payload = buildPeopleCountingPayload(event);
  const url = joinUrl(state.server.baseUrl, state.server.cameraDataPath);
  const response = await postJson(url, payload);
  const summary = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toISOString(),
    event,
    payload,
    response
  };
  recentEvents.unshift(summary);
  recentEvents.splice(100);
  if (response.ok && response.data?.code === 200) {
    logger.info("collector event reported", {
      macAddress: payload.EventNotificationAlert.macAddress,
      enter: payload.EventNotificationAlert.peopleCounting.enter,
      exit: payload.EventNotificationAlert.peopleCounting.exit
    });
  } else {
    logger.warn("collector event report failed", { response });
  }
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

function publicState() {
  return {
    ...state,
    server: {
      ...state.server,
      mode: state.server.localDebug ? "local-debug" : "remote",
      token: state.server.token ? "******" : ""
    }
  };
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
  res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
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
