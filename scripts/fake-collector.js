const gatewayUrl = (process.env.GATEWAY_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const consoleUrl = process.env.CONSOLE_URL || `${gatewayUrl}/api/collector/events`;
const heartbeatUrl = process.env.HEARTBEAT_URL || `${gatewayUrl}/api/collector/heartbeat`;
const collectorId = process.env.COLLECTOR_ID || "collector-local-fake";
const macAddress = process.env.MAC_ADDRESS || "local-camera-001";
const ipAddress = process.env.CAMERA_IP || "192.168.1.20";
const intervalMs = Number(process.env.INTERVAL_MS || 10000);
const heartbeatIntervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || 10000);
const runOnce = process.env.ONCE === "1";

let enter = Number(process.env.START_ENTER || 0);
let exit = Number(process.env.START_EXIT || 0);
let duplicatePeople = Number(process.env.START_DUPLICATE || 0);

console.log(`Fake collector posting to ${consoleUrl}`);
console.log(`Fake collector heartbeat to ${heartbeatUrl}`);
console.log(`collector=${collectorId}, MAC=${macAddress}, interval=${intervalMs}ms, once=${runOnce}`);

if (runOnce) {
  sendHeartbeat()
    .then(sendEvent)
    .finally(() => process.exit(0));
} else {
  setInterval(sendHeartbeat, heartbeatIntervalMs);
  setInterval(sendEvent, intervalMs);
  sendHeartbeat();
  sendEvent();
}

async function sendHeartbeat() {
  const heartbeat = {
    collectorId,
    version: "0.1.0",
    adapter: "fake",
    host: process.env.HOSTNAME || "local",
    devices: [
      {
        deviceKey: macAddress,
        ipAddress,
        macAddress,
        status: "online"
      }
    ]
  };
  await postJson(heartbeatUrl, heartbeat, "heartbeat");
}

async function sendEvent() {
  enter += Math.floor(Math.random() * 3);
  exit += Math.floor(Math.random() * 2);
  duplicatePeople += Math.random() > 0.85 ? 1 : 0;

  const event = {
    collectorId,
    source: "fake",
    deviceKey: macAddress,
    macAddress,
    ipAddress,
    channelId: 1,
    eventType: "PeopleCounting",
    occurredAt: formatLocalDate(new Date()),
    enter,
    exit,
    duplicatePeople,
    raw: {
      generatedBy: "fake-collector"
    }
  };

  await postJson(consoleUrl, event, "event");
}

async function postJson(url, body, label) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    console.log(`[${new Date().toISOString()}] ${label} status=${response.status} ${text}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${label} failed`, error.message);
  }
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
