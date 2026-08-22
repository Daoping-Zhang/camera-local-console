// 隧道客户端：主动连总部后端的 /ws/tunnel，把本地控制台 HTTP 转发过去
// 依赖：Node >= 22 全局 WebSocket（部署包/镜像使用 Node 22+）
import http from "node:http";

const PING_INTERVAL_MS = 30_000;
const RECONNECT_MIN_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;

let active = false;
let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
let tunnelInfo = null; // { port, token }
let onStateChange = null;

export function startTunnel({ serverUrl, siteToken, localPort, onState }) {
  if (typeof WebSocket === "undefined") {
    console.error("[tunnel] 需要 Node >= 22 的全局 WebSocket，无法启动异地访问隧道");
    return;
  }
  onStateChange = onState || (() => {});
  if (active) stopTunnel();
  active = true;
  connect({ serverUrl, siteToken, localPort });
}

export function stopTunnel() {
  active = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  tunnelInfo = null;
  onStateChange?.({ online: false });
}

export function tunnelStatus() {
  return { online: !!ws, ...(tunnelInfo || {}) };
}

function connect({ serverUrl, siteToken, localPort }) {
  if (!active || !serverUrl || !siteToken) return;
  let url = String(serverUrl).trim().replace(/\/+$/, "");
  url = url.replace(/^http/, "ws") + "/ws/tunnel?token=" + encodeURIComponent(siteToken);
  try {
    ws = new WebSocket(url);
  } catch (e) {
    scheduleReconnect({ serverUrl, siteToken, localPort });
    return;
  }
  ws.onopen = () => {
    console.log("[tunnel] connected, waiting for ready");
  };
  ws.onmessage = (ev) => handleMessage(ev.data, { localPort });
  ws.onclose = () => {
    ws = null;
    tunnelInfo = null;
    onStateChange?.({ online: false });
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    scheduleReconnect({ serverUrl, siteToken, localPort });
  };
  ws.onerror = (e) => {
    console.error("[tunnel] error", e?.message || "unknown");
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect(opts) {
  if (!active) return;
  if (reconnectTimer) return;
  console.log(`[tunnel] reconnecting in ${reconnectDelay / 1000}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connect(opts);
  }, reconnectDelay);
}

function handleMessage(data, { localPort }) {
  let msg;
  try { msg = JSON.parse(String(data)); } catch { return; }
  if (msg.type === "ready") {
    tunnelInfo = { port: msg.port, token: msg.token };
    reconnectDelay = RECONNECT_MIN_MS;
    onStateChange?.({ online: true, ...tunnelInfo });
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, PING_INTERVAL_MS);
    return;
  }
  if (msg.type === "req") {
    forwardRequest(msg, localPort);
  }
}

function forwardRequest(msg, localPort) {
  const body = msg.body ? Buffer.from(msg.body, "base64") : null;
  const req = http.request(
    {
      host: "127.0.0.1",
      port: localPort,
      method: msg.method || "GET",
      path: msg.url || "/",
      headers: msg.headers || {},
    },
    (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        sendRes(msg.id, {
          status: res.statusCode || 500,
          headers: filterResHeaders(res.headers),
          body: buf.length ? buf.toString("base64") : "",
        });
      });
    },
  );
  req.on("error", (e) => {
    sendRes(msg.id, { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: Buffer.from(`tunnel forward error: ${e.message}`).toString("base64") });
  });
  if (body) req.write(body);
  req.end();
}

function filterResHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (["connection", "keep-alive", "transfer-encoding", "content-length", "upgrade"].includes(k)) continue;
    out[k] = v;
  }
  return out;
}

function sendRes(id, payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "res", id, ...payload }));
  }
}
