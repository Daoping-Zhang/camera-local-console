const $ = (id) => document.getElementById(id);

let state = null;
let shops = [];
let collectors = [];
let latestEvents = [];

document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => showPage(tab.dataset.page);
});

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || data.message || "request failed");
  }
  return data;
}

async function refresh() {
  const data = await api("/api/state");
  state = data.state;
  latestEvents = data.events || [];
  $("serverUrl").value = state.server.baseUrl || "";
  $("loginPath").value = state.server.loginPath || "/user/login";
  $("shopId").value = state.shop.shopId || "";
  $("shopName").value = state.shop.shopName || "";
  $("debugModeBtn").textContent = state.server.localDebug ? "退出本地调试" : "启用本地调试";
  $("serverState").textContent = serverStatusText();
  renderModeBadge();
  renderShopSelect();
  $("interfaces").innerHTML = data.interfaces.map((iface) =>
    `<button class="chip" data-cidr="${iface.cidr}">${iface.name} ${iface.cidr}</button>`
  ).join("");
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.onclick = () => $("cidr").value = chip.dataset.cidr;
  });
  renderEvents(latestEvents);
  renderCollectorUrls();
  await refreshCollectors();
  renderMetrics();
  await refreshLogs();
}

async function refreshLogs() {
  const data = await api("/api/logs");
  $("logs").innerHTML = data.logs.map(renderLogItem).join("") || `<div class="empty-state">暂无日志</div>`;
}

function renderEvents(events) {
  $("events").innerHTML = events.map((entry) => {
    const alert = entry.payload.EventNotificationAlert;
    const count = alert.peopleCounting;
    const ok = entry.response?.ok && entry.response?.data?.code === 200;
    return `<div class="event-card">
      <div class="event-main">
        <span class="status-badge ${ok ? "online" : "error"}">${ok ? "成功" : "失败"}</span>
        <strong>${escapeHtml(alert.macAddress)}</strong>
        <span>${escapeHtml(formatTime(entry.time))}</span>
      </div>
      <div class="event-counts">
        <span>进店 <strong>${escapeHtml(count.enter)}</strong></span>
        <span>出店 <strong>${escapeHtml(count.exit)}</strong></span>
        <span>重复 <strong>${escapeHtml(count.duplicatePeople)}</strong></span>
      </div>
      <div class="event-response">${escapeHtml(entry.response?.data?.message || JSON.stringify(entry.response?.data || entry.response))}</div>
    </div>`;
  }).join("") || `<div class="empty-state">暂无事件</div>`;
}

async function refreshCollectors() {
  const data = await api("/api/collectors");
  collectors = data.collectors || [];
  $("collectors").innerHTML = collectors.map(renderCollectorCard).join("") || `<div class="empty-state">暂无已发现采集器。请先在注册流程里测试 Collector URL。</div>`;
  renderMetrics();
}

function renderCollectorCard(collector) {
  const status = collector.status || "unknown";
  const statusText = status === "online" ? "在线" : status === "reachable" ? "可访问" : status === "stale" ? "心跳过期" : "未知";
  const devices = collector.devices || [];
  return `<article class="collector-card ${escapeHtml(status)}">
    <div class="collector-head">
      <div>
        <div class="collector-title">${escapeHtml(collector.collectorId)}</div>
        <div class="collector-sub">${escapeHtml(collector.adapter || "-")} · v${escapeHtml(collector.version || "-")} · ${escapeHtml(collector.host || "-")}</div>
      </div>
      <span class="status-badge ${escapeHtml(status)}">${statusText}</span>
    </div>
    <div class="collector-times">
      <div><span>最近心跳</span><strong>${escapeHtml(formatRelative(collector.lastHeartbeatAt))}</strong><small>${escapeHtml(formatTime(collector.lastHeartbeatAt))}</small></div>
      <div><span>最近事件</span><strong>${escapeHtml(formatRelative(collector.lastEventAt))}</strong><small>${escapeHtml(formatTime(collector.lastEventAt))}</small></div>
    </div>
    <div class="device-list">
      ${devices.map(renderCollectorDevice).join("") || `<div class="device-row muted-row">暂无设备</div>`}
    </div>
  </article>`;
}

function renderCollectorDevice(device) {
  return `<div class="device-row">
    <span class="dot ${escapeHtml(device.status || "unknown")}"></span>
    <strong>${escapeHtml(device.deviceKey || device.macAddress || device.ipAddress || "-")}</strong>
    <span>${escapeHtml(device.ipAddress || "-")}</span>
    <span>${escapeHtml(device.macAddress || "-")}</span>
  </div>`;
}

function renderLogItem(log) {
  const level = log.level || "info";
  const levelText = level === "error" ? "错误" : level === "warn" ? "警告" : "信息";
  const meta = log.meta || {};
  const tags = buildLogTags(meta);
  const details = JSON.stringify(meta, null, 2);
  return `<article class="log-item ${escapeHtml(level)}">
    <div class="log-main">
      <span class="log-level ${escapeHtml(level)}">${levelText}</span>
      <strong>${escapeHtml(translateLogMessage(log.message))}</strong>
      <time>${escapeHtml(formatTime(log.time))}</time>
    </div>
    ${tags.length ? `<div class="log-tags">${tags.join("")}</div>` : ""}
    ${details !== "{}" ? `<details class="log-details"><summary>查看详情</summary><pre>${escapeHtml(details)}</pre></details>` : ""}
  </article>`;
}

function buildLogTags(meta) {
  const tagMap = [
    ["collectorId", "采集器"],
    ["shopId", "门店"],
    ["shopName", "门店名"],
    ["macAddress", "MAC"],
    ["deviceKey", "设备"],
    ["ipAddress", "IP"],
    ["cidr", "网段"],
    ["count", "数量"],
    ["deviceCount", "设备数"],
    ["type", "角色"],
    ["enter", "进店"],
    ["exit", "出店"],
    ["enabled", "本地调试"]
  ];
  return tagMap
    .filter(([key]) => meta[key] !== undefined && meta[key] !== "")
    .map(([key, label]) => `<span class="log-tag"><small>${label}</small>${escapeHtml(formatLogValue(key, meta[key]))}</span>`);
}

function formatLogValue(key, value) {
  if (key === "type") return Number(value) === 1 ? "店内" : "店外";
  if (key === "enabled") return value ? "开启" : "关闭";
  return value;
}

function translateLogMessage(message) {
  const messages = {
    "local console started": "本地控制台已启动",
    "local debug mode changed": "本地调试模式已切换",
    "shop saved": "门店信息已保存",
    "scan started": "开始扫描摄像头",
    "scan finished": "扫描完成",
    "device bound": "摄像头已登记到 Gateway",
    "device registration flow started": "开始完整注册流程",
    "device registration flow finished": "完整注册流程完成",
    "collector heartbeat received": "收到采集器心跳",
    "collector event reported": "客流事件已上报",
    "collector event report failed": "客流事件上报失败",
    "collector server started": "采集器服务已启动",
    "collector device registered": "采集器已注册摄像头",
    "collector test event sent": "采集器测试事件已发送",
    "collector has no registered device": "采集器暂无已注册摄像头"
  };
  return messages[message] || message || "未知日志";
}

$("connectBtn").onclick = async () => {
  try {
    const data = await api("/api/server/connect", {
      method: "POST",
      body: JSON.stringify({
        baseUrl: $("serverUrl").value,
        loginPath: $("loginPath").value,
        username: $("username").value,
        password: $("password").value
      })
    });
    state = data.state;
    $("serverState").textContent = "登录成功";
    await loadShops();
    await refresh();
  } catch (error) {
    $("serverState").textContent = `登录失败：${error.message}`;
  }
};

$("debugModeBtn").onclick = async () => {
  const enabled = !state?.server?.localDebug;
  const data = await api("/api/debug-mode", {
    method: "POST",
    body: JSON.stringify({ enabled })
  });
  state = data.state;
  shops = data.shops || [];
  renderShopSelect();
  if (shops.length && !$("shopSelect").value) {
    $("shopSelect").value = String(shops[0].id);
    $("shopSelect").dispatchEvent(new Event("change"));
  }
  await refresh();
};

$("loadShopsBtn").onclick = async () => {
  await loadShops();
};

$("refreshCollectorsBtn").onclick = async () => {
  await refreshCollectors();
};

$("saveShopBtn").onclick = async () => {
  await api("/api/shop/save", {
    method: "POST",
    body: JSON.stringify({ shopId: $("shopId").value, shopName: $("shopName").value })
  });
  await refresh();
};

$("shopSelect").onchange = () => {
  const selected = shops.find((shop) => String(shop.id) === $("shopSelect").value);
  if (!selected) return;
  $("shopId").value = selected.id;
  $("shopName").value = selected.name || "";
};

$("scanBtn").onclick = async () => {
  $("scanResults").innerHTML = `<div class="empty-state">扫描中...</div>`;
  try {
    const data = await api("/api/scan", {
      method: "POST",
      body: JSON.stringify({ cidr: $("cidr").value })
    });
    $("scanResults").innerHTML = data.devices.map(renderScanDeviceCard).join("") || `<div class="empty-state">未发现疑似设备</div>`;
  } catch (error) {
    $("scanResults").innerHTML = `<div class="empty-state">扫描失败：${escapeHtml(error.message)}</div>`;
  }
};

$("scanResults").onclick = (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.action === "fill") {
    fillDevice(button.dataset.ip);
    return;
  }
  if (button.dataset.action === "quick-register") {
    registerScannedDevice(button.closest(".scan-card"));
  }
};

$("bindBtn").onclick = async () => {
  await bindDevice();
};

$("testCollectorBtn").onclick = async () => {
  try {
    const data = await api("/api/collector-proxy/health", {
      method: "POST",
      body: JSON.stringify({ collectorUrl: $("downCollectorUrl").value })
    });
    $("downCollectorState").textContent = `采集器可访问：${data.result.collector.collectorId}。注册摄像头后会开始心跳上报。`;
    await refreshCollectors();
  } catch (error) {
    $("downCollectorState").textContent = `采集器连接失败：${error.message}`;
  }
};

$("registerCollectorBtn").onclick = async () => {
  try {
    $("manualCollectorState").innerHTML = renderFlowSteps([
      { name: "collector-register", status: "running" },
      { name: state?.server?.localDebug ? "gateway-local-bind" : "remote-device-bind", status: "pending" }
    ]);
    const data = await api("/api/devices/register-flow", {
      method: "POST",
      body: JSON.stringify({
        collectorUrl: $("manualCollectorUrl").value,
        device: buildCollectorDeviceConfig()
      })
    });
    $("manualCollectorState").innerHTML = renderFlowSteps(data.steps || []);
    await refreshCollectors();
    await refresh();
  } catch (error) {
    $("manualCollectorState").innerHTML = `<span class="status-badge error">失败</span> ${escapeHtml(error.message)}`;
  }
};

$("collectorTestEventBtn").onclick = async () => {
  try {
    const data = await api("/api/collector-proxy/test-event", {
      method: "POST",
      body: JSON.stringify({
        collectorUrl: $("manualCollectorUrl").value,
        deviceKey: $("bindDeviceId").value || $("bindMac").value || $("bindIp").value
      })
    });
    $("manualCollectorState").textContent = data.result.event ? "采集器测试事件已触发" : "采集器暂无可触发设备";
    await refresh();
  } catch (error) {
    $("manualCollectorState").textContent = `触发失败：${error.message}`;
  }
};

$("testEventBtn").onclick = async () => {
  await api("/api/test-event", {
    method: "POST",
    body: JSON.stringify({
      macAddress: $("testMac").value,
      enter: Number($("testEnter").value),
      exit: Number($("testExit").value),
      duplicatePeople: Number($("testDuplicate").value)
    })
  });
  await refresh();
};

function fillDevice(ipAddress) {
  $("bindIp").value = ipAddress;
  const card = document.querySelector(`.scan-card[data-ip="${CSS.escape(ipAddress)}"]`);
  const deviceKey = card?.querySelector('[data-field="deviceKey"]')?.value || "";
  $("bindMac").value = deviceKey;
  $("bindDeviceId").value = deviceKey || ipAddress;
  $("bindDeviceName").value = `Camera ${ipAddress}`;
  $("testMac").value = $("bindMac").value;
}

function renderScanDeviceCard(device) {
  const ip = escapeHtml(device.ipAddress);
  const mac = device.macAddress || "";
  const deviceKey = escapeHtml(mac);
  const macHint = mac ? `MAC ${escapeHtml(mac)}` : "未从 ARP 获取到 MAC，请手动填写 Device Key";
  return `<article class="scan-card" data-ip="${ip}">
    <div class="scan-card-head">
      <div>
        <div class="scan-title">${ip}</div>
        <div class="scan-meta">端口 ${escapeHtml(device.openPorts.join(", ") || "-")} · 可信度 ${escapeHtml(device.confidence)} · ${macHint}</div>
      </div>
      <div class="actions">
        ${device.webUrl ? `<a class="link-button" href="${escapeHtml(device.webUrl)}" target="_blank" rel="noreferrer">打开后台</a>` : ""}
        <button class="secondary" data-action="fill" data-ip="${ip}">填到手动区</button>
      </div>
    </div>
    <div class="scan-register-grid">
      <label>角色<select data-field="type"><option value="0">店外 type=0</option><option value="1">店内 type=1</option></select></label>
      <label>Device Key / MAC<input data-field="deviceKey" value="${deviceKey}" placeholder="未获取到 MAC，请填 MAC 或设备唯一 ID"></label>
      <label>设备名称<input data-field="deviceName" value="Camera ${ip}"></label>
      <label>Collector URL<input data-field="collectorUrl" value="${escapeHtml($("downCollectorUrl").value || "http://localhost:3100")}"></label>
      <label>SDK 端口<input data-field="sdkPort" type="number" value="${escapeHtml(device.sdkPort || $("collectorDefaultSdkPort").value || 8000)}"></label>
      <label>摄像头账号<input data-field="cameraUsername" placeholder="admin" autocomplete="off"></label>
      <label>摄像头密码<input data-field="cameraPassword" type="password" autocomplete="off"></label>
    </div>
    <div class="scan-card-foot">
      <button data-action="quick-register">执行完整注册流程</button>
      <div class="scan-flow hint" data-role="flow">先向下注册到采集器，连接成功后再向上登记。</div>
    </div>
  </article>`;
}

async function registerScannedDevice(card) {
  const flow = card.querySelector('[data-role="flow"]');
  try {
    const get = (field) => card.querySelector(`[data-field="${field}"]`)?.value || "";
    const type = Number(get("type"));
    if (!get("deviceKey")) {
      throw new Error("未获取到 MAC，请先填写 Device Key / MAC");
    }
    flow.innerHTML = renderFlowSteps([
      { name: "collector-register", status: "running" },
      { name: state?.server?.localDebug ? "gateway-local-bind" : "remote-device-bind", status: "pending" }
    ]);
    const data = await api("/api/devices/register-flow", {
      method: "POST",
      body: JSON.stringify({
        collectorUrl: get("collectorUrl"),
        device: {
          gatewayUrl: window.location.origin,
          shopId: $("shopId").value,
          shopName: $("shopName").value,
          deviceKey: get("deviceKey"),
          deviceName: get("deviceName") || `Camera ${card.dataset.ip}`,
          ipAddress: card.dataset.ip,
          macAddress: get("deviceKey"),
          role: type === 1 ? "inside" : "outside",
          type,
          sdk: {
            vendor: "hikvision",
            port: Number(get("sdkPort") || 8000),
            username: get("cameraUsername"),
            password: get("cameraPassword")
          }
        }
      })
    });
    flow.innerHTML = renderFlowSteps(data.steps || []);
    fillDevice(card.dataset.ip);
    $("bindType").value = String(type);
    await refreshCollectors();
    await refresh();
  } catch (error) {
    flow.innerHTML = `<span class="status-badge error">失败</span> ${escapeHtml(error.message)}`;
  }
}

async function loadShops() {
  const data = await api("/api/shops");
  shops = data.shops || [];
  renderShopSelect();
  if (shops.length === 1 && !$("shopId").value) {
    $("shopSelect").value = String(shops[0].id);
    $("shopSelect").dispatchEvent(new Event("change"));
  }
}

function renderShopSelect() {
  const currentShopId = String($("shopId").value || state?.shop?.shopId || "");
  $("shopSelect").innerHTML = [
    `<option value="">${shops.length ? "请选择门店" : "登录后加载门店"}</option>`,
    ...shops.map((shop) => `<option value="${escapeHtml(shop.id)}">${escapeHtml(shop.name || "(未命名门店)")} #${escapeHtml(shop.id)}</option>`)
  ].join("");
  if (currentShopId && shops.some((shop) => String(shop.id) === currentShopId)) {
    $("shopSelect").value = currentShopId;
  }
}

function renderCollectorUrls() {
  const origin = window.location.origin;
  $("collectorEventUrl").value = `${origin}/api/collector/events`;
  $("collectorHeartbeatUrl").value = `${origin}/api/collector/heartbeat`;
}

function renderModeBadge() {
  $("modeBadge").className = `status-badge ${state.server.localDebug ? "debug" : state.server.token ? "online" : "muted"}`;
  $("modeBadge").textContent = state.server.localDebug ? "本地调试" : state.server.token ? "远端已登录" : "远端未登录";
}

function renderMetrics() {
  if (!state) return;
  const onlineCount = collectors.filter((collector) => collector.status === "online").length;
  const reachableCount = collectors.filter((collector) => collector.status === "reachable").length;
  const staleCount = collectors.filter((collector) => collector.status === "stale").length;
  const lastEvent = latestEvents[0];
  const eventText = lastEvent ? `${formatRelative(lastEvent.time)} · ${lastEvent.payload.EventNotificationAlert.macAddress}` : "暂无";
  $("gatewayMetric").textContent = state.server.localDebug ? "本地调试" : state.server.token ? "远端已登录" : "待登录";
  $("collectorMetric").textContent = `${onlineCount} 在线 / ${reachableCount} 可访问 / ${staleCount} 过期`;
  $("eventMetric").textContent = eventText;
  $("shopMetric").textContent = state.shop.shopId ? `${state.shop.shopName || "未命名"} #${state.shop.shopId}` : "未选择";
}

function serverStatusText() {
  if (state.server.localDebug) {
    return `本地调试模式：设备绑定不写远端，上报仍发送到 ${state.server.baseUrl}${state.server.cameraDataPath}`;
  }
  return state.server.token ? `远端模式：已登录，Header: ${state.server.tokenHeader}` : "远端模式：未登录";
}

async function bindDevice() {
  await api("/api/devices/bind", {
    method: "POST",
    body: JSON.stringify({
      shopId: $("shopId").value,
      shopName: $("shopName").value,
      ipAddress: $("bindIp").value,
      macAddress: $("bindMac").value,
      deviceId: $("bindDeviceId").value,
      deviceName: $("bindDeviceName").value,
      type: Number($("bindType").value)
    })
  });
  await refresh();
}

function buildCollectorDeviceConfig() {
  const deviceKey = $("bindDeviceId").value || $("bindMac").value || $("bindIp").value;
  if (!deviceKey) {
    throw new Error("请先填入摄像头 IP/MAC/Device ID");
  }
  return {
    gatewayUrl: window.location.origin,
    shopId: $("shopId").value,
    shopName: $("shopName").value,
    deviceKey,
    deviceName: $("bindDeviceName").value || `Camera ${deviceKey}`,
    ipAddress: $("bindIp").value,
    macAddress: $("bindMac").value || deviceKey,
    role: Number($("bindType").value) === 1 ? "inside" : "outside",
    type: Number($("bindType").value),
    sdk: {
      vendor: "hikvision",
      port: Number($("sdkPort").value || 8000),
      username: $("cameraUsername").value,
      password: $("cameraPassword").value
    }
  };
}

function renderFlowSteps(steps) {
  const names = {
    "collector-register": "1. 向下注册到采集器并连接摄像头",
    "gateway-local-bind": "2. 本地调试登记到 Gateway",
    "remote-device-bind": "2. 向上注册到远端服务器"
  };
  return `<div class="flow-steps">${steps.map((step) => {
    const statusClass = step.status === "success" ? "online" : step.status === "running" ? "warn" : step.status === "pending" ? "muted" : "error";
    const statusText = step.status === "success" ? "完成" : step.status === "running" ? "进行中" : step.status === "pending" ? "等待" : "失败";
    return `<div class="flow-step"><span class="status-badge ${statusClass}">${statusText}</span><strong>${escapeHtml(names[step.name] || step.name)}</strong></div>`;
  }).join("")}</div>`;
}

function showPage(pageClass) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.page === pageClass);
  });
  document.querySelectorAll(".page").forEach((page) => {
    page.hidden = !page.classList.contains(pageClass);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

function formatRelative(value) {
  if (!value) return "从未";
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta)) return "-";
  if (delta < 5000) return "刚刚";
  if (delta < 60000) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`;
  return `${Math.floor(delta / 3600000)} 小时前`;
}

$("refreshBtn").onclick = refresh;
refresh().catch(console.error);
