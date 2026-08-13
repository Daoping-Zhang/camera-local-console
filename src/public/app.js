const $ = (id) => document.getElementById(id);

let state = null;
let shops = [];
let collectors = [];
let latestEvents = [];
let scanResults = [];
let lastErrorText = "";

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function setValue(id, value) {
  const element = $(id);
  if (element) element.value = value;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || data.message || "request failed");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeDeviceIndexCode(value) {
  return String(value || "").trim().toLowerCase().replaceAll(":", "").replaceAll("-", "");
}

function defaultCameraWebUrl(device) {
  if (device.webUrl) return device.webUrl;
  if (!device.ipAddress) return "about:blank";
  const ports = Array.isArray(device.openPorts) ? device.openPorts : [];
  if (ports.includes(443)) return `https://${device.ipAddress}`;
  return `http://${device.ipAddress}`;
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatRelative(value) {
  if (!value) return "-";
  const delta = Date.now() - new Date(value).getTime();
  if (Number.isNaN(delta)) return "-";
  if (delta < 60000) return "刚刚";
  if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`;
  return `${Math.floor(delta / 3600000)} 小时前`;
}

function showError(error) {
  console.error(error);
  lastErrorText = error.message || String(error);
  renderLastError(lastErrorText);
}

function showPage(pageClass) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.page === pageClass);
  });
  document.querySelectorAll(".page").forEach((page) => {
    page.hidden = !page.classList.contains(pageClass);
  });
  if (pageClass === "page-logs") refreshLogs().catch(showError);
}

async function refresh() {
  const data = await api("/api/state");
  state = data.state;
  latestEvents = data.events || [];
  setValue("legacyHikBaseUrl", state.server.legacyHikBaseUrl || "");
  setValue("downCollectorUrl", state.localCollector?.baseUrl || "http://127.0.0.1:3100");
  setValue("manualCollectorUrl", state.localCollector?.baseUrl || "http://127.0.0.1:3100");
  setValue("collectorDefaultSdkPort", state.cameraDefaults?.sdkPort || 8000);
  setValue("sdkPort", state.cameraDefaults?.sdkPort || 8000);
  setValue("cameraUsername", state.cameraDefaults?.username || "admin");
  const savePassword = $("saveCameraPassword");
  if (savePassword) savePassword.value = state.cameraDefaults?.savePassword ? "1" : "";
  setValue("shopId", state.shop.shopId || "");
  setValue("shopName", state.shop.shopName || "");
  renderModeBadge();
  renderShopSelect();
  renderInterfaces(data.interfaces || []);
  renderScanResults(scanResults);
  renderCollectors(data.collectors || []);
  renderSavedCameras();
  renderEvents(latestEvents);
  renderEvents(latestEvents, "overviewEvents", 5);
  renderRelease(state.release || {});
  renderMetrics();
  renderSetupChecklist();
  renderConfigSummary();
  renderLastError(lastErrorText);
}

function renderModeBadge() {
  const configured = Boolean(state?.server?.legacyHikBaseUrl);
  const element = $("modeBadge");
  if (!element) return;
  element.textContent = configured ? "数据服务已配置" : "数据服务未配置";
  element.className = `status-badge ${configured ? "online" : "muted"}`;
}

function renderMetrics() {
  if (!state) return;
  const onlineCount = collectors.filter((collector) => collector.status === "online").length;
  const reachableCount = collectors.filter((collector) => collector.status === "reachable").length;
  const staleCount = collectors.filter((collector) => collector.status === "stale").length;
  const lastEvent = latestEvents[0];
  const lastEventMac = lastEvent?.event?.macAddress || lastEvent?.payload?.EventNotificationAlert?.macAddress || "-";
  const savedDeviceCount = uniqueSavedDevices(state.devices || []).length;
  setText("gatewayMetric", state.server.legacyHikBaseUrl ? "已配置" : "未配置");
  setText("deviceMetric", `${savedDeviceCount} 台已保存`);
  setText("collectorMetric", `${collectors.length} 个本地采集器，${onlineCount} 已回传，${reachableCount} 可用，${staleCount} 过期`);
  setText("eventMetric", lastEvent ? `${formatRelative(lastEvent.time)} - ${lastEventMac}` : "暂无");
}

function setupItems() {
  const latestEvent = latestEvents[0];
  const hasBackend = Boolean(state?.server?.legacyHikBaseUrl);
  const onlineCollectors = collectors.filter((collector) => collector.status === "online");
  const reachableCollectors = collectors.filter((collector) => collector.status === "reachable");
  const registeredDevices = uniqueSavedDevices(state?.devices || []).length;
  const hasEvent = Boolean(latestEvent);
  const lastWriteOk = latestEvent?.legacy?.enabled ? Boolean(latestEvent.legacy.ok) : false;
  return [
    {
      key: "backend",
      label: "hik 数据服务",
      status: hasBackend ? "ready" : "todo",
      title: hasBackend ? "数据服务已配置" : "数据服务未配置",
      detail: hasBackend ? "客流和人体事件会写入该服务。" : "先填写 hik 数据服务地址，再测试两个写入接口。",
      actionLabel: hasBackend ? "重新测试" : "去配置",
      action: hasBackend ? connectLegacyHik : () => showPage("page-uplink")
    },
    {
      key: "collector",
      label: "本地采集器",
      status: onlineCollectors.length || reachableCollectors.length ? "ready" : "todo",
      title: onlineCollectors.length ? "本地采集器已回传心跳" : reachableCollectors.length ? "本地采集器可用" : "未发现本地采集器",
      detail: onlineCollectors.length
        ? `${onlineCollectors.length} 个本地采集器已回传心跳`
        : reachableCollectors.length
          ? "本地采集器端口已通，可以下发摄像头。"
          : "请先启动本地采集器，再点击测试。",
      actionLabel: "测试采集器",
      action: testCollector
    },
    {
      key: "device",
      label: "摄像头",
      status: registeredDevices ? "ready" : "todo",
      title: registeredDevices ? `已保存 ${registeredDevices} 台` : "还没有保存摄像头",
      detail: registeredDevices ? "来自 data/config.json，不代表当前都在线。" : "扫描网段，填写账号密码后注册到本地采集器。",
      actionLabel: registeredDevices ? "查看列表" : "扫描添加",
      action: registeredDevices ? focusSavedCameraList : focusScanInput
    },
    {
      key: "event",
      label: "事件写入",
      status: lastWriteOk ? "ready" : hasEvent ? "warn" : "todo",
      title: lastWriteOk ? "最近事件已写入后端" : hasEvent ? "收到事件，但后端写入未成功" : "还没有收到事件",
      detail: lastWriteOk
        ? `${formatRelative(latestEvent.time)} 写入 ${latestEvent.legacy.path}`
        : hasEvent
          ? eventFailureAdvice(latestEvent)
          : "注册摄像头后等待真实事件，或发送一条测试客流事件。",
      actionLabel: "发送测试事件",
      action: testEvent
    }
  ];
}

function focusScanInput() {
  showPage("page-cameras");
  $("scanSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
  $("cidr")?.focus();
}

function focusSavedCameraList() {
  showPage("page-cameras");
  $("savedCameras")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderSetupChecklist() {
  const container = $("setupChecklist");
  if (!container || !state) return;
  const items = setupItems();
  container.innerHTML = items.map((item) => `<div class="setup-item ${escapeHtml(item.status)}">
    <span class="setup-dot"></span>
    <div>
      <small>${escapeHtml(item.label)}</small>
      <strong>${escapeHtml(item.title)}</strong>
      <p>${escapeHtml(item.detail)}</p>
    </div>
    <button class="secondary" data-setup-action="${escapeHtml(item.key)}">${escapeHtml(item.actionLabel)}</button>
  </div>`).join("");
  container.querySelectorAll("[data-setup-action]").forEach((button) => {
    const item = items.find((entry) => entry.key === button.dataset.setupAction);
    button.onclick = () => runWithButton(button, item.action).catch(showError);
  });
  renderNextAction(items);
}

function renderNextAction(items) {
  const container = $("nextAction");
  if (!container) return;
  const next = items.find((item) => item.status !== "ready") || items[items.length - 1];
  container.innerHTML = `<div>
    <strong>下一步：${escapeHtml(next.title)}</strong>
    <p>${escapeHtml(next.detail)}</p>
  </div>
  <button data-next-action="${escapeHtml(next.key)}">${escapeHtml(next.actionLabel)}</button>`;
  const button = container.querySelector("[data-next-action]");
  button.onclick = () => runWithButton(button, next.action).catch(showError);
}

function renderLastError(message) {
  const container = $("nextAction");
  if (!container) return;
  const existing = container.querySelector(".error-advice");
  if (existing) existing.remove();
  if (!message) return;
  container.insertAdjacentHTML("beforeend", `<div class="error-advice">
    <strong>刚才的操作失败</strong>
    <p>${escapeHtml(message)}</p>
    <p>${escapeHtml(errorAdvice(message))}</p>
  </div>`);
}

function errorAdvice(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("fetch") || text.includes("failed")) return "请检查服务地址是否正确、采集器或 hik-contact-data 是否已经启动。";
  if (text.includes("password") || text.includes("login")) return "请确认摄像头账号密码和 SDK 端口，必要时先打开摄像头登录页验证。";
  if (text.includes("gatewayurl")) return "请先从控制台完成注册，让采集器知道事件要回传到哪里。";
  if (text.includes("not found")) return "请确认接口路径和服务版本是否匹配。";
  return "可以到运行日志页查看更完整的错误上下文。";
}

function eventFailureAdvice(entry) {
  const legacy = entry?.legacy || {};
  if (!legacy.enabled) return "已收到本地事件，但还没有配置 hik-contact-data 地址。";
  return legacy.error || legacy.response?.data?.message || "事件已到达本地控制台，但写入 hik-contact-data 失败。";
}

function renderConfigSummary() {
  if (!state) return;
  const savedDeviceCount = uniqueSavedDevices(state.devices || []).length;
  const items = [
    { label: "配置文件", value: "data/config.json", action: "", actionLabel: "" },
    { label: "本地采集器", value: state.localCollector?.baseUrl ? "已配置" : "未配置", action: "page-collectors", actionLabel: "去修改" },
    { label: "hik 数据服务", value: state.server?.legacyHikBaseUrl ? "已配置" : "未配置", action: "page-uplink", actionLabel: "去修改" },
    { label: "已保存摄像头", value: `${savedDeviceCount} 台`, action: "page-cameras", actionLabel: "查看" },
    { label: "默认 SDK 端口", value: state.cameraDefaults?.sdkPort || 8000, action: "page-cameras", actionLabel: "去修改" },
    { label: "保存摄像头密码", value: state.cameraDefaults?.savePassword ? "是" : "否", action: "page-cameras", actionLabel: "去修改" },
    { label: "版本更新", value: state.release?.manifestUrl ? "已配置" : "未配置", action: "page-release", actionLabel: "去修改" }
  ];
  const html = items.map((item) => `<div class="summary-row">
    <span>${escapeHtml(item.label)}</span>
    <strong>${escapeHtml(item.value)}</strong>
    ${item.action ? `<button class="summary-action" data-summary-page="${escapeHtml(item.action)}">${escapeHtml(item.actionLabel)}</button>` : ""}
  </div>`).join("");
  const overview = $("configSummary");
  if (overview) {
    overview.innerHTML = html;
    overview.querySelectorAll("[data-summary-page]").forEach((button) => {
      button.onclick = () => showPage(button.dataset.summaryPage);
    });
  }
}

function collectorUrlValue() {
  return $("downCollectorUrl")?.value || $("manualCollectorUrl")?.value || "http://127.0.0.1:3100";
}

async function runWithButton(button, action) {
  if (!action) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中...";
  lastErrorText = "";
  renderLastError("");
  try {
    await action();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function renderRelease(release) {
  setValue("releaseVersion", release.version || "-");
  setValue("releaseChannel", release.channel || "stable");
  setValue("releaseManifestUrl", release.manifestUrl || "");
  const result = release.lastCheckResult;
  renderReleaseDownload(null, release.manifestUrl);
  renderReleaseOptions([]);
  if (!result) {
    setText("releaseState", release.lastCheckAt ? `上次检查：${formatTime(release.lastCheckAt)}` : "尚未检查");
    setText("releaseManifest", "");
    return;
  }
  const availableCount = (result.channels || []).filter((item) => item.updateAvailable).length;
  const failedCount = (result.channels || []).filter((item) => item.ok === false).length;
  const status = availableCount
    ? `发现 ${availableCount} 个可更新版本`
    : failedCount
      ? `未发现可用更新，${failedCount} 个通道检查失败`
      : "已是最新版本";
  setText("releaseState", `${status}；上次检查：${formatTime(release.lastCheckAt)}`);
  setText("releaseManifest", "");
  renderReleaseOptions(result.channels || []);
  renderReleaseDownload(result, result.manifestUrl || release.manifestUrl);
}

function renderReleaseDownload(result, manifestUrl) {
  const container = $("releaseDownload");
  if (!container) return;
  const manifest = result?.manifest || {};
  if (!result || !manifest.url) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  container.hidden = false;
  const notes = manifest.notes || "暂无更新说明";
  container.innerHTML = `
    <div>
      <span class="release-label">最新版本</span>
      <strong>${escapeHtml(result.latestVersion || manifest.version || "-")}</strong>
      <p class="hint">${escapeHtml(notes)}</p>
    </div>
    <div class="release-actions">
      ${result.updateAvailable ? `<button class="apply-release" type="button" data-manifest-url="${escapeHtml(manifestUrl || "")}">立即更新本机</button>` : ""}
      <a class="button-link ${result.updateAvailable ? "" : "primary-link"}" href="${escapeHtml(manifest.url)}" target="_blank" rel="noopener">下载安装包</a>
      <a class="button-link" href="${escapeHtml(manifestUrl || "")}" target="_blank" rel="noopener">查看清单</a>
      <button class="secondary copy-release-url" type="button" data-url="${escapeHtml(manifest.url)}">复制下载链接</button>
    </div>
  `;
}

function renderReleaseOptions(channels) {
  const container = $("releaseOptions");
  if (!container) return;
  if (!channels.length) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = channels.map((item) => {
    const manifest = item.manifest || {};
    const notes = manifest.notes || item.error || "暂无更新说明";
    const status = item.ok === false
      ? "检查失败"
      : item.updateAvailable
        ? `可更新：${item.currentVersion || "-"} -> ${item.latestVersion || "-"}`
        : `已是最新：${item.currentVersion || "-"}`
    const badgeClass = item.ok === false ? "error" : item.updateAvailable ? "online" : "muted";
    return `<div class="release-card">
      <div>
        <span class="status-badge ${badgeClass}">${escapeHtml(status)}</span>
        <h3>${escapeHtml(item.label || item.channel || "版本")}</h3>
        <p class="hint">${escapeHtml(notes)}</p>
        <p class="hint">${escapeHtml(item.manifestUrl || "")}</p>
      </div>
      <div class="release-actions">
        ${item.updateAvailable ? `<button class="apply-release" type="button" data-manifest-url="${escapeHtml(item.manifestUrl || "")}" data-channel="${escapeHtml(item.channel || "")}">更新到此版本</button>` : ""}
        ${manifest.url ? `<a class="button-link" href="${escapeHtml(manifest.url)}" target="_blank" rel="noopener">下载安装包</a>` : ""}
        ${item.manifestUrl ? `<a class="button-link" href="${escapeHtml(item.manifestUrl)}" target="_blank" rel="noopener">查看清单</a>` : ""}
      </div>
    </div>`;
  }).join("");
}

async function copyReleaseUrl(url) {
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    setText("releaseState", "下载链接已复制");
  } catch {
    setText("releaseState", url);
  }
}

async function saveReleaseConfig() {
  const channel = $("releaseChannel")?.value || "stable";
  const manifestUrl = $("releaseManifestUrl")?.value || "";
  const data = await api("/api/release/configure", {
    method: "POST",
    body: JSON.stringify({ channel, manifestUrl })
  });
  renderRelease(data.release || {});
  await refresh();
}

async function checkRelease() {
  setText("releaseState", "正在检查更新...");
  renderReleaseOptions([]);
  const data = await api("/api/release/check", {
    method: "POST",
    body: JSON.stringify({ manifestUrl: $("releaseManifestUrl")?.value })
  });
  renderRelease(data.release || {});
}

async function applyReleaseUpdate(manifestUrl, channel) {
  if (!confirm("将开始本机更新。更新过程可能会停止当前控制台，页面短暂断开属于正常现象。继续吗？")) return;
  const data = await api("/api/release/apply", {
    method: "POST",
    body: JSON.stringify({
      manifestUrl: manifestUrl || $("releaseManifestUrl")?.value,
      channel: channel || $("releaseChannel")?.value
    })
  });
  setText("releaseState", data.result?.message || "已启动本机更新");
}

function renderInterfaces(interfaces) {
  const container = $("interfaces");
  if (!container) return;
  container.innerHTML = interfaces.map((iface) =>
    `<button class="chip" data-cidr="${escapeHtml(iface.cidr)}">${escapeHtml(iface.name)} ${escapeHtml(iface.cidr)}</button>`
  ).join("");
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.onclick = () => setValue("cidr", chip.dataset.cidr);
  });
}

function renderShopSelect() {
  const select = $("shopSelect");
  if (!select) return;
  const currentShopId = String($("shopId")?.value || state?.shop?.shopId || "");
  select.innerHTML = [
    `<option value="">${shops.length ? "Select shop" : "No shops"}</option>`,
    ...shops.map((shop) => `<option value="${escapeHtml(shop.id)}">${escapeHtml(shop.name || "Unnamed shop")} #${escapeHtml(shop.id)}</option>`)
  ].join("");
  if (currentShopId && shops.some((shop) => String(shop.id) === currentShopId)) select.value = currentShopId;
}

function selectShop() {
  const shop = shops.find((item) => String(item.id) === $("shopSelect")?.value);
  if (!shop) return;
  setValue("shopId", shop.id);
  setValue("shopName", shop.name || "");
}

async function loadShops() {
  const data = await api("/api/shops");
  shops = data.shops || [];
  renderShopSelect();
}

async function saveShop() {
  await api("/api/shop/save", {
    method: "POST",
    body: JSON.stringify({ shopId: $("shopId")?.value, shopName: $("shopName")?.value })
  });
  await refresh();
}

async function connectLegacyHik() {
  try {
    const data = await api("/api/legacy-hik/connect", {
      method: "POST",
      body: JSON.stringify({ baseUrl: $("legacyHikBaseUrl")?.value })
    });
    const endpoints = data.result?.endpoints || {};
    const rcv = endpoints.eventRcv?.ok ? "客流接口可用" : `客流接口失败：${endpoints.eventRcv?.message || "-"}`;
    const rtbw = endpoints.eventRtbw?.ok ? "人体接口可用" : `人体接口失败：${endpoints.eventRtbw?.message || "-"}`;
    setText("legacyHikState", `${data.result?.reachable ? "数据服务可用" : "已保存，但接口测试失败"}：${rcv}；${rtbw}`);
    await refresh();
  } catch (error) {
    setText("legacyHikState", `数据服务测试失败：${error.message}`);
    showError(error);
  }
}

async function scan() {
  const data = await api("/api/scan", {
    method: "POST",
    body: JSON.stringify({ cidr: $("cidr")?.value })
  });
  scanResults = mergeScanResults(data.devices || []);
  renderScanResults(scanResults);
}

function renderScanResults(devices) {
  const container = $("scanResults");
  if (!container) return;
  container.innerHTML = devices.map((device) => {
    const deviceIndexCode = normalizeDeviceIndexCode(device.macAddress || device.deviceIndexCode || device.deviceKey);
    const bound = device.bound
      ? `<span class="status-badge online">已注册</span>`
      : `<span class="status-badge reachable">新发现</span>`;
    return `<div class="device-card" data-device-index-code="${escapeHtml(deviceIndexCode)}">
      <div class="device-title"><strong>${escapeHtml(device.ipAddress)}</strong>${bound}</div>
      <p>MAC: ${escapeHtml(device.macAddress || "-")}</p>
      <p>deviceIndexCode: ${escapeHtml(deviceIndexCode || "-")}</p>
      <p>${escapeHtml(device.hostname || device.vendor || "")}</p>
      <div class="inline-form">
        <input aria-label="设备 ID" placeholder="设备 ID" value="${escapeHtml(device.deviceId || deviceIndexCode || "")}" data-field="deviceId">
        <input aria-label="设备名称" placeholder="设备名称" value="${escapeHtml(device.deviceName || device.hostname || "")}" data-field="deviceName">
        <input aria-label="SDK 账号" placeholder="SDK 账号" value="${escapeHtml(device.username || savedDeviceConfig(device)?.username || $("cameraUsername")?.value || "admin")}" data-field="username" autocomplete="off">
        <input aria-label="SDK 密码" placeholder="SDK 密码" type="password" value="${escapeHtml(device.password || $("cameraPassword")?.value || "")}" data-field="password" autocomplete="off">
        <input aria-label="SDK 端口" placeholder="SDK 端口" type="number" value="${escapeHtml(device.sdkPort || savedDeviceConfig(device)?.sdkPort || $("sdkPort")?.value || $("collectorDefaultSdkPort")?.value || 8000)}" data-field="sdkPort">
        <select data-field="type">
          <option value="0" ${Number(device.type || 0) === 0 ? "selected" : ""}>入口/外侧</option>
          <option value="1" ${Number(device.type || 0) === 1 ? "selected" : ""}>出口/内侧</option>
        </select>
        <button data-action="open-login" data-web-url="${escapeHtml(device.webUrl || defaultCameraWebUrl(device))}">打开登录页</button>
        <button data-action="register" data-ip="${escapeHtml(device.ipAddress)}" data-mac="${escapeHtml(device.macAddress || "")}" data-device-index-code="${escapeHtml(deviceIndexCode)}" ${deviceIndexCode ? "" : "disabled"}>注册到采集器</button>
        <button class="secondary" data-action="delete" data-ip="${escapeHtml(device.ipAddress)}" data-mac="${escapeHtml(device.macAddress || "")}" data-device-index-code="${escapeHtml(deviceIndexCode)}">删除</button>
      </div>
      <div class="flow-steps">
        <div class="flow-step"><span class="status-badge muted">1</span>保存到 data/config.json</div>
        <div class="flow-step"><span class="status-badge muted">2</span>下发到本地采集器</div>
        <div class="flow-step"><span class="status-badge muted">3</span>等待 SDK 登录和心跳</div>
      </div>
      <p class="hint" data-role="scan-status">${escapeHtml(device.lastError || device.statusText || "")}</p>
    </div>`;
  }).join("") || `<div class="empty-state">暂无扫描结果。点击“开始扫描”后，发现的摄像头会显示在这里。</div>`;
  document.querySelectorAll(".device-card button").forEach((button) => {
    button.onclick = () => {
      if (button.dataset.action === "open-login") {
        window.open(button.dataset.webUrl, "_blank", "noopener,noreferrer");
        return;
      }
      if (button.dataset.action === "delete") {
        deleteDevice(button).catch(showError);
        return;
      }
      bindAndRegister(button).catch(showError);
    };
  });
  document.querySelectorAll(".device-card [data-field]").forEach((input) => {
    input.oninput = () => persistScanCardInput(input);
    input.onchange = () => persistScanCardInput(input);
  });
}

function renderSavedCameras() {
  const summary = $("savedCameraSummary");
  const container = $("savedCameras");
  if (!container || !state) return;
  const allDevices = state.devices || [];
  const devices = uniqueSavedDevices(allDevices);
  const duplicateCount = Math.max(0, allDevices.length - devices.length);
  if (summary) {
    summary.innerHTML = `<div>
      <strong>${devices.length} 台</strong>
      <span>已保存到 data/config.json，重启后会自动读取。${duplicateCount ? `已合并 ${duplicateCount} 条重复历史记录。` : ""}</span>
    </div>`;
  }
  container.innerHTML = devices.map(renderSavedCameraRow).join("") || `<div class="empty-state">暂无已保存摄像头。可以先扫描网段并注册。</div>`;
  container.querySelectorAll("[data-saved-action]").forEach((button) => {
    button.onclick = () => runWithButton(button, () => handleSavedCameraAction(button)).catch(showError);
  });
}

function uniqueSavedDevices(devices) {
  const seen = new Set();
  const output = [];
  for (const device of devices || []) {
    const key = normalizeDeviceIndexCode(device.macAddress || device.deviceIndexCode || device.deviceKey) || `invalid-${device.localId || device.ipAddress || output.length}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(device);
  }
  return output;
}

function renderSavedCameraRow(device) {
  const key = normalizeDeviceIndexCode(device.macAddress || device.deviceIndexCode || device.deviceKey);
  const collectorStatus = savedCameraCollectorStatus(device);
  const latestEvent = latestEvents.find((entry) => normalizeDeviceIndexCode(entry.deviceIndexCode || entry.event?.macAddress || entry.event?.deviceKey || entry.event?.ipAddress) === key);
  const webUrl = defaultCameraWebUrl(device);
  return `<div class="camera-row" data-device-key="${escapeHtml(key)}">
    <div class="camera-main">
      <strong>${escapeHtml(device.deviceName || device.ipAddress || device.macAddress || key || "未命名摄像头")}</strong>
      <span>${escapeHtml(device.ipAddress || "-")} · ${escapeHtml(device.macAddress || device.deviceKey || "-")}</span>
    </div>
    <div>
      <span class="status-badge ${collectorStatus.className}">${escapeHtml(collectorStatus.label)}</span>
      <p class="hint">${escapeHtml(collectorStatus.detail)}</p>
    </div>
    <div class="camera-meta">
      <span>SDK ${escapeHtml(device.sdkPort || 8000)}</span>
      <span>${Number(device.type || 0) === 1 ? "出口/内侧" : "入口/外侧"}</span>
      <span>最近事件 ${escapeHtml(latestEvent ? formatRelative(latestEvent.time) : "-")}</span>
    </div>
    <div class="camera-actions">
      <button class="secondary" data-saved-action="open" data-web-url="${escapeHtml(webUrl)}">打开</button>
      <button data-saved-action="register" data-device-key="${escapeHtml(key)}" ${device.invalidConfig ? "disabled" : ""}>下发</button>
      <button class="secondary" data-saved-action="delete" data-device-key="${escapeHtml(key)}" data-mac="${escapeHtml(device.macAddress || "")}">删除</button>
    </div>
  </div>`;
}

function savedCameraCollectorStatus(device) {
  if (device.invalidConfig) return { label: "配置异常", className: "error", detail: device.invalidConfig };
  const keys = deviceMatchKeys(device);
  for (const collector of collectors) {
    for (const item of collector.devices || []) {
      if (!hasMatchingDeviceKey(keys, item)) continue;
      return collectorDeviceStatus(item);
    }
  }
  const resultDevice = device.collector?.device || device.collector?.result?.device;
  if (resultDevice && hasMatchingDeviceKey(keys, resultDevice)) return collectorDeviceStatus(resultDevice);
  if (device.collector?.status === "registered") return { label: "已下发", className: "reachable", detail: "本地采集器已接收，等待 SDK 状态更新" };
  return { label: "未下发", className: "muted", detail: "仅存在本地配置记录" };
}

function deviceMatchKeys(device) {
  return [
    device.deviceIndexCode,
    device.deviceKey,
    device.macAddress,
    device.ipAddress,
    device.deviceId
  ].map(normalizeDeviceIndexCode).filter(Boolean);
}

function hasMatchingDeviceKey(keys, item) {
  const itemKeys = deviceMatchKeys(item);
  return itemKeys.some((key) => keys.includes(key));
}

function collectorDeviceStatus(item) {
  const error = item.lastError || item.worker?.lastError || "";
  const status = item.worker?.status || item.connectionStatus || item.status || "";
  if (error) return { label: "异常", className: "error", detail: error };
  if (status === "running" || status === "connected" || item.status === "online") return { label: "在线", className: "online", detail: "本地采集器已登录 SDK" };
  return { label: status || "已下发", className: "reachable", detail: "本地采集器已接收，等待 SDK 状态更新" };
}

async function handleSavedCameraAction(button) {
  const action = button.dataset.savedAction;
  if (action === "open") {
    window.open(button.dataset.webUrl, "_blank", "noopener,noreferrer");
    return;
  }
  if (action === "delete") {
    await deleteSavedCamera(button);
    return;
  }
  if (action === "register") {
    await registerSavedCamera(button);
  }
}

function savedDeviceConfig(device) {
  const key = normalizeDeviceIndexCode(device.macAddress || device.deviceIndexCode || device.deviceKey);
  return (state?.devices || []).find((item) => normalizeDeviceIndexCode(item.macAddress || item.deviceIndexCode || item.deviceKey) === key);
}

function mergeScanResults(devices) {
  const previous = new Map(scanResults.map((device) => [
    normalizeDeviceIndexCode(device.macAddress || device.deviceIndexCode || device.deviceKey),
    device
  ]));
  return devices.filter((device) => normalizeDeviceIndexCode(device.macAddress || device.deviceIndexCode || device.deviceKey)).map((device) => {
    const key = normalizeDeviceIndexCode(device.macAddress || device.deviceIndexCode || device.deviceKey);
    const old = previous.get(key) || {};
    return {
      ...device,
      deviceId: old.deviceId || device.deviceId,
      deviceName: old.deviceName || device.deviceName,
      username: old.username || device.username,
      password: old.password || device.password,
      sdkPort: old.sdkPort || device.sdkPort,
      type: old.type ?? device.type,
      bound: old.bound || device.bound
    };
  });
}

function persistScanCardInput(input) {
  const card = input.closest(".device-card");
  const key = card?.dataset.deviceIndexCode;
  const field = input.dataset.field;
  if (!key || !field) return;
  scanResults = scanResults.map((device) => {
    const deviceKey = normalizeDeviceIndexCode(device.macAddress || device.deviceIndexCode || device.deviceKey);
    if (deviceKey !== key) return device;
    return { ...device, [field]: field === "type" ? Number(input.value) : input.value };
  });
}

async function bindAndRegister(button) {
  const card = button.closest(".device-card");
  const read = (field) => card.querySelector(`[data-field="${field}"]`)?.value || "";
  const macAddress = button.dataset.mac || "";
  if (!normalizeDeviceIndexCode(macAddress)) {
    setScanCardStatus(button.dataset.deviceIndexCode, "缺少 MAC 地址，不能注册为摄像头");
    return;
  }
  setScanCardStatus(button.dataset.deviceIndexCode, "正在注册...");
  try {
    await api("/api/devices/register-flow", {
      method: "POST",
      body: JSON.stringify({
        collectorUrl: collectorUrlValue(),
        device: {
          gatewayUrl: location.origin,
          shopId: $("shopId")?.value,
          shopName: $("shopName")?.value,
          ipAddress: button.dataset.ip,
          macAddress,
          deviceKey: macAddress,
          deviceIndexCode: button.dataset.deviceIndexCode,
          deviceId: macAddress,
          deviceName: read("deviceName"),
          type: Number(read("type")),
          sdkPort: Number(read("sdkPort") || $("sdkPort")?.value || $("collectorDefaultSdkPort")?.value || 8000),
          username: read("username") || $("cameraUsername")?.value,
          password: read("password") || $("cameraPassword")?.value,
          savePassword: $("saveCameraPassword")?.value === "1"
        }
      })
    });
    scanResults = scanResults.map((device) => {
      const key = normalizeDeviceIndexCode(device.macAddress || device.deviceKey);
      return key && key === button.dataset.deviceIndexCode ? { ...device, bound: true, statusText: "已下发，等待本地采集器状态", lastError: "" } : device;
    });
    await refresh();
  } catch (error) {
    setScanCardStatus(button.dataset.deviceIndexCode, error.message);
    throw error;
  }
}

async function deleteDevice(button) {
  if (!confirm("确认删除这条扫描/本地摄像头记录吗？")) return;
  const collectorUrl = collectorUrlValue();
  const payload = {
    collectorUrl,
    deviceKey: button.dataset.deviceIndexCode || button.dataset.mac || button.dataset.ip,
    macAddress: button.dataset.mac,
    ipAddress: button.dataset.ip,
    deviceIndexCode: button.dataset.deviceIndexCode
  };
  if (collectorUrl) {
    await api("/api/collector-proxy/delete-device", {
      method: "POST",
      body: JSON.stringify(payload)
    }).catch((error) => setScanCardStatus(button.dataset.deviceIndexCode, `采集器删除失败：${error.message}`));
  }
  await api("/api/devices/delete", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  scanResults = scanResults.filter((device) => {
    const key = normalizeDeviceIndexCode(device.deviceIndexCode || device.macAddress || device.deviceKey || device.ipAddress);
    return key !== button.dataset.deviceIndexCode;
  });
  await refresh();
}

async function registerSavedCamera(button) {
  const key = button.dataset.deviceKey;
  const device = (state.devices || []).find((item) => normalizeDeviceIndexCode(item.deviceIndexCode || item.macAddress || item.deviceKey || item.ipAddress) === key);
  if (!device) throw new Error("camera record not found");
  const payload = {
    ...device,
    gatewayUrl: location.origin,
    deviceKey: device.deviceIndexCode || device.deviceKey || device.macAddress || device.ipAddress,
    sdkPort: device.sdkPort || state.cameraDefaults?.sdkPort || 8000,
    username: device.username || state.cameraDefaults?.username || "admin",
    password: device.password || ""
  };
  await api("/api/collector-proxy/register-device", {
    method: "POST",
    body: JSON.stringify({
      collectorUrl: collectorUrlValue(),
      device: payload
    })
  });
  await refresh();
}

async function deleteSavedCamera(button) {
  if (!confirm("确认删除这条本地摄像头记录吗？该操作会从 data/config.json 移除。")) return;
  await api("/api/devices/delete", {
    method: "POST",
    body: JSON.stringify({
      deviceKey: button.dataset.deviceKey,
      macAddress: button.dataset.mac
    })
  });
  await refresh();
}

function setScanCardStatus(deviceIndexCode, message) {
  scanResults = scanResults.map((device) => {
    const key = normalizeDeviceIndexCode(device.deviceIndexCode || device.macAddress || device.deviceKey || device.ipAddress);
    return key === deviceIndexCode ? { ...device, statusText: message, lastError: message } : device;
  });
  const card = document.querySelector(`.device-card[data-device-index-code="${CSS.escape(deviceIndexCode)}"]`);
  const status = card?.querySelector('[data-role="scan-status"]');
  if (status) status.textContent = message;
}

async function bindDevice() {
  const deviceIndexCode = normalizeDeviceIndexCode($("bindMac")?.value || $("bindDeviceId")?.value || $("bindIp")?.value);
  await api("/api/devices/bind", {
    method: "POST",
    body: JSON.stringify({
      shopId: $("shopId")?.value,
      shopName: $("shopName")?.value,
      ipAddress: $("bindIp")?.value,
      macAddress: $("bindMac")?.value,
      deviceIndexCode,
      deviceId: $("bindDeviceId")?.value || deviceIndexCode,
      deviceName: $("bindDeviceName")?.value,
      type: Number($("bindType")?.value || 0)
    })
  });
  await refresh();
}

async function testEvent() {
  await api("/api/test-event", {
    method: "POST",
    body: JSON.stringify({
      macAddress: $("testMac")?.value,
      enter: Number($("testEnter")?.value || 0),
      exit: Number($("testExit")?.value || 0),
      duplicatePeople: Number($("testDuplicate")?.value || 0)
    })
  });
  await refresh();
}

async function testCollector() {
  try {
    const data = await api("/api/collector-proxy/health", {
      method: "POST",
      body: JSON.stringify({ collectorUrl: collectorUrlValue() })
    });
    setText("downCollectorState", `采集器已同步：${data.result?.collector?.collectorId || "ok"}`);
    await refresh();
  } catch (error) {
    setText("downCollectorState", `采集器同步失败：${error.message}`);
    showError(error);
  }
}

async function saveConfig() {
  const data = await api("/api/config/save", {
    method: "POST",
    body: JSON.stringify({
      localCollector: {
        baseUrl: collectorUrlValue(),
        autoConnect: true
      },
      server: {
        legacyHikBaseUrl: $("legacyHikBaseUrl")?.value || ""
      },
      cameraDefaults: {
        username: $("cameraUsername")?.value || "admin",
        sdkPort: Number($("collectorDefaultSdkPort")?.value || $("sdkPort")?.value || 8000),
        savePassword: $("saveCameraPassword")?.value === "1"
      }
    })
  });
  state = data.state;
  await refresh();
}

async function saveLegacyHikConfig() {
  await saveConfig();
  setText("legacyHikState", "hik 数据服务地址已保存，重启后会自动读取 data/config.json");
}

async function saveCameraDefaults() {
  await saveConfig();
  setText("cameraDefaultsState", "摄像头默认值已保存，重启后会自动读取 data/config.json");
}

async function saveCollectorConfig() {
  await saveConfig();
  setText("downCollectorState", "本地采集器地址已保存，重启后会自动读取 data/config.json");
}

async function registerCollectorManual() {
  try {
    const deviceIndexCode = normalizeDeviceIndexCode($("bindMac")?.value || $("bindDeviceId")?.value || $("bindIp")?.value);
    const response = await api("/api/collector-proxy/register-device", {
      method: "POST",
      body: JSON.stringify({
        collectorUrl: collectorUrlValue(),
        device: {
          gatewayUrl: location.origin,
          shopId: $("shopId")?.value,
          shopName: $("shopName")?.value,
          ipAddress: $("bindIp")?.value,
          macAddress: $("bindMac")?.value,
          deviceKey: deviceIndexCode || $("bindDeviceId")?.value || $("bindIp")?.value,
          deviceIndexCode,
          deviceId: $("bindDeviceId")?.value || deviceIndexCode,
          deviceName: $("bindDeviceName")?.value,
          type: Number($("bindType")?.value || 0),
          sdkPort: Number($("sdkPort")?.value || 8000),
          username: $("cameraUsername")?.value,
          password: $("cameraPassword")?.value
        }
      })
    });
    setText("manualCollectorState", `已注册到采集器：${response.result?.collectorId || "ok"}`);
    await refresh();
  } catch (error) {
    setText("manualCollectorState", `注册失败：${error.message}`);
  }
}

async function triggerCollectorTestEvent() {
  try {
    const data = await api("/api/collector-proxy/test-event", {
      method: "POST",
      body: JSON.stringify({ collectorUrl: collectorUrlValue() })
    });
    setText("manualCollectorState", data.result?.event ? "采集器测试事件已发送" : "采集器暂无设备");
    await refresh();
  } catch (error) {
    setText("manualCollectorState", `采集器测试事件失败：${error.message}`);
  }
}

function renderCollectors(items) {
  collectors = items;
  syncCollectorDeviceStatus(items);
  setValue("collectorEventUrl", `${location.origin}/api/collector/events`);
  setValue("collectorHeartbeatUrl", `${location.origin}/api/collector/heartbeat`);
  const container = $("collectors");
  if (!container) return;
  container.innerHTML = collectors.map(renderCollectorCard).join("") || `<div class="empty-state">暂无采集器。3000 会自动尝试启动本地采集器，也可以点击“检查并下发”。</div>`;
  container.querySelectorAll('[data-action="collector-delete"]').forEach((button) => {
    button.onclick = () => deleteCollectorDevice(button).catch(showError);
  });
}

function renderCollectorCard(collector) {
  const status = collector.status || "unknown";
  const devices = collector.devices || [];
  const statusText = collectorStatusText(status);
  return `<div class="collector-card ${escapeHtml(status)}">
    <div class="device-title">
      <strong>${escapeHtml(collector.collectorId)}</strong>
      <span class="status-badge ${status === "online" ? "online" : status === "reachable" ? "reachable" : "error"}">${escapeHtml(statusText)}</span>
    </div>
    <p>${escapeHtml(collector.baseUrl || collector.host || "")}</p>
    <p>最近心跳：${escapeHtml(formatRelative(collector.lastSeen || collector.lastHeartbeatAt))}</p>
    <div class="device-list">
      ${devices.map((device) => renderCollectorDevice(device, collector)).join("") || "<span>暂无下发设备</span>"}
    </div>
  </div>`;
}

function collectorStatusText(status) {
  return {
    online: "在线",
    reachable: "可访问",
    stale: "心跳过期",
    "event-only": "仅事件"
  }[status] || "未知";
}

function renderCollectorDevice(device, collector) {
  const error = device.lastError || device.worker?.lastError || "";
  const workerStatus = device.worker?.status || device.connectionStatus || device.status || "-";
  const workerText = workerStatusText(workerStatus);
  const key = normalizeDeviceIndexCode(device.deviceKey || device.macAddress || device.ipAddress);
  return `<span>
    ${escapeHtml(device.macAddress || device.deviceKey || device.ipAddress)}
    (${escapeHtml(workerText)})
    ${error ? `<strong class="error-text">${escapeHtml(error)}</strong>` : ""}
    <button data-action="collector-delete" data-collector-url="${escapeHtml(collectorUrlValue() || collector.baseUrl || collector.host || "")}" data-device-key="${escapeHtml(device.deviceKey || key)}" data-mac="${escapeHtml(device.macAddress || "")}">删除</button>
  </span>`;
}

function workerStatusText(status) {
  return {
    running: "运行中",
    connected: "已连接",
    pending: "等待中",
    starting: "启动中",
    stopped: "已停止",
    online: "在线",
    offline: "离线",
    error: "异常",
    "-": "-"
  }[status] || status || "-";
}

function syncCollectorDeviceStatus(items) {
  if (!scanResults.length) return;
  const statuses = new Map();
  for (const collector of items || []) {
    for (const device of collector.devices || []) {
      const key = normalizeDeviceIndexCode(device.deviceKey || device.macAddress || device.ipAddress);
      const error = device.lastError || device.worker?.lastError || "";
      const workerStatus = device.worker?.status || device.connectionStatus || device.status || "";
      if (key) statuses.set(key, { error, workerStatus });
    }
  }
  scanResults = scanResults.map((device) => {
    const key = normalizeDeviceIndexCode(device.deviceIndexCode || device.macAddress || device.deviceKey || device.ipAddress);
    const status = statuses.get(key);
    if (!status) return device;
    return {
      ...device,
      bound: true,
      lastError: status.error || device.lastError || "",
      statusText: status.error || status.workerStatus || device.statusText || ""
    };
  });
}

async function deleteCollectorDevice(button) {
  if (!confirm("确认从采集器和本地配置中删除这台设备吗？")) return;
  const collectorUrl = button.dataset.collectorUrl || collectorUrlValue();
  await api("/api/collector-proxy/delete-device", {
    method: "POST",
    body: JSON.stringify({
      collectorUrl,
      deviceKey: button.dataset.deviceKey,
      macAddress: button.dataset.mac
    })
  });
  await api("/api/devices/delete", {
    method: "POST",
    body: JSON.stringify({
      deviceKey: button.dataset.deviceKey,
      macAddress: button.dataset.mac
    })
  });
  scanResults = scanResults.filter((device) => {
    const key = normalizeDeviceIndexCode(device.deviceIndexCode || device.macAddress || device.deviceKey || device.ipAddress);
    return key !== normalizeDeviceIndexCode(button.dataset.deviceKey || button.dataset.mac);
  });
  await refresh();
}

function renderEvents(events, containerId = "events", limit = 100) {
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = events.slice(0, limit).map((entry) => {
    const isHumanBody = entry.event?.eventType === "HumanBodyComparison";
    const alert = entry.payload?.EventNotificationAlert || {};
    const count = alert.peopleCounting || {};
    const legacy = entry.legacy || {};
    const ok = legacy.enabled ? legacy.ok : (entry.response?.ok && entry.response?.data?.code === 200);
    const title = entry.event?.macAddress || entry.event?.deviceKey || alert.macAddress || "-";
    const eventType = entry.event?.eventType || alert.eventType || "-";
    const human = entry.event?.raw?.isapi?.HumanBodyComparison?.[0]?.HumanInfo || {};
    const responseText = legacy.enabled
      ? (legacy.ok ? `写入成功 - ${legacy.path}` : `写入失败 - ${legacy.error || legacy.response?.data?.message || JSON.stringify(legacy.response?.data || legacy.response)}`)
      : "尚未配置 hik 数据服务";
    const details = isHumanBody
      ? `<span>age <strong>${escapeHtml(human.ageGroup || "-")}</strong></span>
         <span>gender <strong>${escapeHtml(human.gender || "-")}</strong></span>
         <span>mask <strong>${escapeHtml(human.mask || "-")}</strong></span>
         <span>hat <strong>${escapeHtml(human.hat || "-")}</strong></span>`
      : `<span>enter <strong>${escapeHtml(count.enter ?? entry.event?.enter ?? 0)}</strong></span>
         <span>exit <strong>${escapeHtml(count.exit ?? entry.event?.exit ?? 0)}</strong></span>
         <span>duplicate <strong>${escapeHtml(count.duplicatePeople ?? entry.event?.duplicatePeople ?? 0)}</strong></span>`;
    return `<div class="event-card">
      <div class="event-main">
        <span class="status-badge ${ok ? "online" : "error"}">${ok ? "成功" : "失败"}</span>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(eventType)}</span>
        <span>${escapeHtml(formatTime(entry.time))}</span>
      </div>
      <div class="event-response">deviceIndexCode: ${escapeHtml(entry.deviceIndexCode || legacy.deviceIndexCode || "-")}</div>
      <div class="event-counts">${details}</div>
      <div class="event-response">${escapeHtml(responseText)}</div>
    </div>`;
  }).join("") || `<div class="empty-state">暂无事件</div>`;
}

async function refreshLogs() {
  const data = await api("/api/logs");
  const container = $("logs");
  if (!container) return;
  container.innerHTML = (data.logs || []).map(renderLogItem).join("") || `<div class="empty-state">暂无日志</div>`;
}

function renderLogItem(log) {
  const level = log.level || "info";
  const meta = { ...log };
  delete meta.level;
  delete meta.time;
  delete meta.message;
  const tags = buildLogTags(meta);
  return `<div class="log-item ${escapeHtml(level)}">
    <span class="log-time">${escapeHtml(formatTime(log.time))}</span>
    <span class="log-level">${escapeHtml(level.toUpperCase())}</span>
    <span class="log-message">${escapeHtml(translateLogMessage(log.message))}</span>
    ${tags ? `<div class="log-tags">${tags}</div>` : ""}
  </div>`;
}

function buildLogTags(meta) {
  const tagMap = [
    ["collectorId", "collector"],
    ["shopId", "shopId"],
    ["shopName", "shop"],
    ["macAddress", "MAC"],
    ["deviceKey", "device"],
    ["ipAddress", "IP"],
    ["cidr", "CIDR"],
    ["count", "count"],
    ["deviceCount", "devices"],
    ["type", "type"],
    ["enter", "enter"],
    ["exit", "exit"],
    ["enabled", "enabled"],
    ["deviceIndexCode", "deviceIndexCode"],
    ["eventType", "event"]
  ];
  return tagMap
    .filter(([key]) => meta[key] !== undefined && meta[key] !== "")
    .map(([key, label]) => `<span>${label}: ${escapeHtml(formatLogValue(key, meta[key]))}</span>`)
    .join("");
}

function formatLogValue(key, value) {
  if (key === "type") return Number(value) === 1 ? "inside" : "outside";
  if (key === "enabled") return value ? "enabled" : "disabled";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function translateLogMessage(message) {
  const messages = {
    "local console started": "local console started",
    "legacy hik service configured": "hik-contact-data configured",
    "shop saved": "shop saved",
    "scan started": "scan started",
    "scan finished": "scan finished",
    "device bound": "device bound",
    "device bound locally": "device bound locally",
    "device register flow completed": "device register flow completed",
    "collector device registered": "collector device registered",
    "collector event received locally": "collector event received locally",
    "legacy hik event forwarded": "forwarded to hik-contact-data",
    "legacy hik event forward failed": "forward hik-contact-data failed"
  };
  return messages[message] || message || "";
}

function bindHandlers() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => showPage(tab.dataset.page);
  });
  const handlers = [
    ["refreshBtn", refresh],
    ["setupRefreshBtn", refresh],
    ["focusScanBtn", focusScanInput],
    ["scanBtn", scan],
    ["bindBtn", bindDevice],
    ["saveLegacyHikBtn", saveLegacyHikConfig],
    ["connectLegacyHikBtn", connectLegacyHik],
    ["testEventBtn", testEvent],
    ["registerCollectorBtn", registerCollectorManual],
    ["testCollectorBtn", testCollector],
    ["saveCameraDefaultsBtn", saveCameraDefaults],
    ["saveCollectorConfigBtn", saveCollectorConfig],
    ["collectorTestEventBtn", triggerCollectorTestEvent],
    ["refreshCollectorsBtn", refresh],
    ["saveReleaseBtn", saveReleaseConfig],
    ["checkReleaseBtn", checkRelease]
  ];
  handlers.forEach(([id, handler]) => {
    const element = $(id);
    if (element) element.onclick = () => runWithButton(element, handler).catch(showError);
  });
  const shopSelect = $("shopSelect");
  if (shopSelect) shopSelect.onchange = selectShop;
  document.addEventListener("click", (event) => {
    const copyButton = event.target.closest(".copy-release-url");
    if (copyButton) copyReleaseUrl(copyButton.dataset.url);
    const applyButton = event.target.closest(".apply-release");
    if (applyButton) applyReleaseUpdate(applyButton.dataset.manifestUrl, applyButton.dataset.channel).catch(showError);
  });
}

bindHandlers();
refresh().catch(showError);
setInterval(() => refresh().catch(console.error), 5000);
