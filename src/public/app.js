const $ = (id) => document.getElementById(id);

let state = null;
let shops = [];
let collectors = [];
let latestEvents = [];
let scanResults = [];

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
  if (delta < 60000) return "just now";
  if (delta < 3600000) return `${Math.floor(delta / 60000)} min ago`;
  return `${Math.floor(delta / 3600000)} h ago`;
}

function showError(error) {
  console.error(error);
  alert(error.message || String(error));
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
  setValue("shopId", state.shop.shopId || "");
  setValue("shopName", state.shop.shopName || "");
  renderModeBadge();
  renderShopSelect();
  renderInterfaces(data.interfaces || []);
  renderScanResults(scanResults.length ? scanResults : state.devices || []);
  renderCollectors(data.collectors || []);
  renderEvents(latestEvents);
  renderRelease(state.release || {});
  renderMetrics();
}

function renderModeBadge() {
  const configured = Boolean(state?.server?.legacyHikBaseUrl);
  const element = $("modeBadge");
  if (!element) return;
  element.textContent = configured ? "hik-contact-data" : "not configured";
  element.className = `status-badge ${configured ? "online" : "muted"}`;
}

function renderMetrics() {
  if (!state) return;
  const onlineCount = collectors.filter((collector) => collector.status === "online").length;
  const reachableCount = collectors.filter((collector) => collector.status === "reachable").length;
  const staleCount = collectors.filter((collector) => collector.status === "stale").length;
  const lastEvent = latestEvents[0];
  const lastEventMac = lastEvent?.event?.macAddress || lastEvent?.payload?.EventNotificationAlert?.macAddress || "-";
  setText("gatewayMetric", state.server.legacyHikBaseUrl || "not configured");
  setText("shopMetric", state.shop.shopId ? `${state.shop.shopName || "Shop"} #${state.shop.shopId}` : "not selected");
  setText("deviceMetric", `${state.devices?.length || 0} registered`);
  setText("collectorMetric", `${collectors.length} total - ${onlineCount} online - ${reachableCount} reachable - ${staleCount} stale`);
  setText("eventMetric", lastEvent ? `${formatRelative(lastEvent.time)} - ${lastEventMac}` : "none");
}

function renderRelease(release) {
  setValue("releaseVersion", release.version || "-");
  setValue("releaseChannel", release.channel || "stable");
  setValue("releaseManifestUrl", release.manifestUrl || "");
  const result = release.lastCheckResult;
  if (!result) {
    setText("releaseState", release.lastCheckAt ? `last check: ${formatTime(release.lastCheckAt)}` : "not checked");
    setText("releaseManifest", "");
    return;
  }
  const status = result.updateAvailable ? `update available: ${result.currentVersion} -> ${result.latestVersion}` : "already up to date";
  setText("releaseState", `${status}; last check: ${formatTime(release.lastCheckAt)}`);
  setText("releaseManifest", JSON.stringify(result.manifest || result, null, 2));
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
  const data = await api("/api/release/check", {
    method: "POST",
    body: JSON.stringify({ manifestUrl: $("releaseManifestUrl")?.value })
  });
  renderRelease(data.release || {});
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
    const rcv = endpoints.eventRcv?.ok ? "eventRcv OK" : `eventRcv failed: ${endpoints.eventRcv?.message || "-"}`;
    const rtbw = endpoints.eventRtbw?.ok ? "eventRtbw OK" : `eventRtbw failed: ${endpoints.eventRtbw?.message || "-"}`;
    setText("legacyHikState", `${data.result?.reachable ? "connected" : "saved but probe failed"}: ${rcv}; ${rtbw}`);
    await refresh();
  } catch (error) {
    setText("legacyHikState", `hik-contact-data failed: ${error.message}`);
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
    const deviceIndexCode = normalizeDeviceIndexCode(device.deviceIndexCode || device.macAddress || device.deviceKey || device.ipAddress);
    const bound = device.bound
      ? `<span class="status-badge online">registered</span>`
      : `<span class="status-badge muted">new</span>`;
    return `<div class="device-card" data-device-index-code="${escapeHtml(deviceIndexCode)}">
      <div class="device-title"><strong>${escapeHtml(device.ipAddress)}</strong>${bound}</div>
      <p>MAC: ${escapeHtml(device.macAddress || "-")}</p>
      <p>deviceIndexCode: ${escapeHtml(deviceIndexCode || "-")}</p>
      <p>${escapeHtml(device.hostname || device.vendor || "")}</p>
      <div class="inline-form">
        <input placeholder="Device ID" value="${escapeHtml(device.deviceId || deviceIndexCode || "")}" data-field="deviceId">
        <input placeholder="Device Name" value="${escapeHtml(device.deviceName || device.hostname || "")}" data-field="deviceName">
        <input placeholder="Username" value="${escapeHtml(device.username || $("cameraUsername")?.value || "admin")}" data-field="username" autocomplete="off">
        <input placeholder="Password" type="password" value="${escapeHtml(device.password || $("cameraPassword")?.value || "")}" data-field="password" autocomplete="off">
        <input placeholder="SDK Port" type="number" value="${escapeHtml(device.sdkPort || $("sdkPort")?.value || $("collectorDefaultSdkPort")?.value || 8000)}" data-field="sdkPort">
        <select data-field="type">
          <option value="0" ${Number(device.type || 0) === 0 ? "selected" : ""}>outside</option>
          <option value="1" ${Number(device.type || 0) === 1 ? "selected" : ""}>inside</option>
        </select>
        <button data-action="open-login" data-web-url="${escapeHtml(device.webUrl || defaultCameraWebUrl(device))}">open login</button>
        <button data-action="register" data-ip="${escapeHtml(device.ipAddress)}" data-mac="${escapeHtml(device.macAddress || "")}" data-device-index-code="${escapeHtml(deviceIndexCode)}">bind and register</button>
        <button data-action="delete" data-ip="${escapeHtml(device.ipAddress)}" data-mac="${escapeHtml(device.macAddress || "")}" data-device-index-code="${escapeHtml(deviceIndexCode)}">delete</button>
      </div>
      <p class="hint" data-role="scan-status">${escapeHtml(device.lastError || device.statusText || "")}</p>
    </div>`;
  }).join("") || `<div class="empty-state">No devices</div>`;
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

function mergeScanResults(devices) {
  const previous = new Map(scanResults.map((device) => [
    normalizeDeviceIndexCode(device.deviceIndexCode || device.macAddress || device.deviceKey || device.ipAddress),
    device
  ]));
  return devices.map((device) => {
    const key = normalizeDeviceIndexCode(device.deviceIndexCode || device.macAddress || device.deviceKey || device.ipAddress);
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
    const deviceKey = normalizeDeviceIndexCode(device.deviceIndexCode || device.macAddress || device.deviceKey || device.ipAddress);
    if (deviceKey !== key) return device;
    return { ...device, [field]: field === "type" ? Number(input.value) : input.value };
  });
}

async function bindAndRegister(button) {
  const card = button.closest(".device-card");
  const read = (field) => card.querySelector(`[data-field="${field}"]`)?.value || "";
  setScanCardStatus(button.dataset.deviceIndexCode, "registering...");
  try {
    await api("/api/devices/register-flow", {
      method: "POST",
      body: JSON.stringify({
        collectorUrl: $("manualCollectorUrl")?.value || $("downCollectorUrl")?.value,
        device: {
          gatewayUrl: location.origin,
          shopId: $("shopId")?.value,
          shopName: $("shopName")?.value,
          ipAddress: button.dataset.ip,
          macAddress: button.dataset.mac,
          deviceKey: button.dataset.deviceIndexCode || button.dataset.mac || button.dataset.ip,
          deviceIndexCode: button.dataset.deviceIndexCode,
          deviceId: read("deviceId") || button.dataset.deviceIndexCode,
          deviceName: read("deviceName"),
          type: Number(read("type")),
          sdkPort: Number(read("sdkPort") || $("sdkPort")?.value || $("collectorDefaultSdkPort")?.value || 8000),
          username: read("username") || $("cameraUsername")?.value,
          password: read("password") || $("cameraPassword")?.value
        }
      })
    });
    scanResults = scanResults.map((device) => {
      const key = normalizeDeviceIndexCode(device.macAddress || device.deviceKey || device.ipAddress);
      return key && key === button.dataset.deviceIndexCode ? { ...device, bound: true, statusText: "registered, waiting for SDK status", lastError: "" } : device;
    });
    await refresh();
  } catch (error) {
    setScanCardStatus(button.dataset.deviceIndexCode, error.message);
    throw error;
  }
}

async function deleteDevice(button) {
  const collectorUrl = $("manualCollectorUrl")?.value || $("downCollectorUrl")?.value;
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
    }).catch((error) => setScanCardStatus(button.dataset.deviceIndexCode, `collector delete failed: ${error.message}`));
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
      body: JSON.stringify({ collectorUrl: $("downCollectorUrl")?.value })
    });
    setText("downCollectorState", `collector reachable: ${data.result?.collector?.collectorId || "ok"}`);
    await refresh();
  } catch (error) {
    setText("downCollectorState", `collector failed: ${error.message}`);
  }
}

async function registerCollectorManual() {
  try {
    const deviceIndexCode = normalizeDeviceIndexCode($("bindMac")?.value || $("bindDeviceId")?.value || $("bindIp")?.value);
    const response = await api("/api/collector-proxy/register-device", {
      method: "POST",
      body: JSON.stringify({
        collectorUrl: $("manualCollectorUrl")?.value,
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
    setText("manualCollectorState", `registered: ${response.result?.collectorId || "ok"}`);
    await refresh();
  } catch (error) {
    setText("manualCollectorState", `register failed: ${error.message}`);
  }
}

async function triggerCollectorTestEvent() {
  try {
    const data = await api("/api/collector-proxy/test-event", {
      method: "POST",
      body: JSON.stringify({ collectorUrl: $("manualCollectorUrl")?.value })
    });
    setText("manualCollectorState", data.result?.event ? "collector test event sent" : "collector has no device");
    await refresh();
  } catch (error) {
    setText("manualCollectorState", `collector test failed: ${error.message}`);
  }
}

function renderCollectors(items) {
  collectors = items;
  syncCollectorDeviceStatus(items);
  setValue("collectorEventUrl", `${location.origin}/api/collector/events`);
  setValue("collectorHeartbeatUrl", `${location.origin}/api/collector/heartbeat`);
  const container = $("collectors");
  if (!container) return;
  container.innerHTML = collectors.map(renderCollectorCard).join("") || `<div class="empty-state">No collectors</div>`;
  container.querySelectorAll('[data-action="collector-delete"]').forEach((button) => {
    button.onclick = () => deleteCollectorDevice(button).catch(showError);
  });
}

function renderCollectorCard(collector) {
  const status = collector.status || "unknown";
  const devices = collector.devices || [];
  return `<div class="collector-card">
    <div class="device-title">
      <strong>${escapeHtml(collector.collectorId)}</strong>
      <span class="status-badge ${status === "online" ? "online" : status === "reachable" ? "muted" : "error"}">${escapeHtml(status)}</span>
    </div>
    <p>${escapeHtml(collector.baseUrl || collector.host || "")}</p>
    <p>last heartbeat: ${escapeHtml(formatRelative(collector.lastSeen || collector.lastHeartbeatAt))}</p>
    <div class="device-list">
      ${devices.map((device) => renderCollectorDevice(device, collector)).join("") || "<span>No devices</span>"}
    </div>
  </div>`;
}

function renderCollectorDevice(device, collector) {
  const error = device.lastError || device.worker?.lastError || "";
  const workerStatus = device.worker?.status || device.connectionStatus || device.status || "-";
  const key = normalizeDeviceIndexCode(device.deviceKey || device.macAddress || device.ipAddress);
  return `<span>
    ${escapeHtml(device.macAddress || device.deviceKey || device.ipAddress)}
    (${escapeHtml(workerStatus)})
    ${error ? `<strong class="error-text">${escapeHtml(error)}</strong>` : ""}
    <button data-action="collector-delete" data-collector-url="${escapeHtml($("downCollectorUrl")?.value || collector.baseUrl || collector.host || "")}" data-device-key="${escapeHtml(device.deviceKey || key)}" data-mac="${escapeHtml(device.macAddress || "")}">delete</button>
  </span>`;
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
  const collectorUrl = button.dataset.collectorUrl || $("downCollectorUrl")?.value;
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

function renderEvents(events) {
  const container = $("events");
  if (!container) return;
  container.innerHTML = events.map((entry) => {
    const isHumanBody = entry.event?.eventType === "HumanBodyComparison";
    const alert = entry.payload?.EventNotificationAlert || {};
    const count = alert.peopleCounting || {};
    const legacy = entry.legacy || {};
    const ok = legacy.enabled ? legacy.ok : (entry.response?.ok && entry.response?.data?.code === 200);
    const title = entry.event?.macAddress || entry.event?.deviceKey || alert.macAddress || "-";
    const eventType = entry.event?.eventType || alert.eventType || "-";
    const human = entry.event?.raw?.isapi?.HumanBodyComparison?.[0]?.HumanInfo || {};
    const responseText = legacy.enabled
      ? (legacy.ok ? `write ok - ${legacy.path}` : `write failed - ${legacy.error || legacy.response?.data?.message || JSON.stringify(legacy.response?.data || legacy.response)}`)
      : "hik-contact-data not configured";
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
        <span class="status-badge ${ok ? "online" : "error"}">${ok ? "ok" : "failed"}</span>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(eventType)}</span>
        <span>${escapeHtml(formatTime(entry.time))}</span>
      </div>
      <div class="event-response">deviceIndexCode: ${escapeHtml(entry.deviceIndexCode || legacy.deviceIndexCode || "-")}</div>
      <div class="event-counts">${details}</div>
      <div class="event-response">${escapeHtml(responseText)}</div>
    </div>`;
  }).join("") || `<div class="empty-state">No events</div>`;
}

async function refreshLogs() {
  const data = await api("/api/logs");
  const container = $("logs");
  if (!container) return;
  container.innerHTML = (data.logs || []).map(renderLogItem).join("") || `<div class="empty-state">No logs</div>`;
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
    "collector heartbeat received": "collector heartbeat received",
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
    ["refreshBtn", () => refresh().catch(showError)],
    ["scanBtn", () => scan().catch(showError)],
    ["bindBtn", () => bindDevice().catch(showError)],
    ["connectLegacyHikBtn", connectLegacyHik],
    ["loadShopsBtn", () => loadShops().catch(showError)],
    ["saveShopBtn", () => saveShop().catch(showError)],
    ["testEventBtn", () => testEvent().catch(showError)],
    ["registerCollectorBtn", () => registerCollectorManual().catch(showError)],
    ["testCollectorBtn", () => testCollector().catch(showError)],
    ["collectorTestEventBtn", () => triggerCollectorTestEvent().catch(showError)],
    ["refreshCollectorsBtn", () => refresh().catch(showError)],
    ["saveReleaseBtn", () => saveReleaseConfig().catch(showError)],
    ["checkReleaseBtn", () => checkRelease().catch(showError)]
  ];
  handlers.forEach(([id, handler]) => {
    const element = $(id);
    if (element) element.onclick = handler;
  });
  const shopSelect = $("shopSelect");
  if (shopSelect) shopSelect.onchange = selectShop;
}

bindHandlers();
refresh().catch(showError);
setInterval(() => refresh().catch(console.error), 5000);
