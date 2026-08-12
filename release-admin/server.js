import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.RELEASE_ADMIN_PORT || 3200);
const HOST = process.env.RELEASE_ADMIN_HOST || "127.0.0.1";
const RELEASE_ROOT = path.resolve(process.env.RELEASE_ROOT || path.join(PROJECT_ROOT, "release", "out"));
const BASE_URL = process.env.RELEASE_BASE_URL || "http://www.fenqunshuju.com/releases/camera-local-console";
const CHANNELS = ["canary", "beta", "stable"];
const PLATFORMS = ["win-x64", "linux-arm64"];

ensureLayout();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return sendHtml(res, pageHtml());
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, state());
    if (req.method === "POST" && url.pathname === "/api/packages/import") {
      const body = await readJson(req);
      const result = importPackage(body);
      return sendJson(res, 200, { ok: true, result, state: state() });
    }
    if (req.method === "POST" && url.pathname === "/api/channels/promote") {
      const body = await readJson(req);
      const result = promoteChannel(body);
      return sendJson(res, 200, { ok: true, result, state: state() });
    }
    if (req.method === "POST" && url.pathname === "/api/channels/rollback") {
      const body = await readJson(req);
      const result = rollbackChannel(body);
      return sendJson(res, 200, { ok: true, result, state: state() });
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`release admin listening on http://${HOST}:${PORT}`);
  console.log(`release root: ${RELEASE_ROOT}`);
});

function ensureLayout() {
  for (const dir of [
    RELEASE_ROOT,
    path.join(RELEASE_ROOT, "channels"),
    path.join(RELEASE_ROOT, "manifests"),
    path.join(RELEASE_ROOT, "packages", "win-x64"),
    path.join(RELEASE_ROOT, "packages", "linux-arm64")
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const registryPath = registryFile();
  if (!fs.existsSync(registryPath)) {
    writeJson(registryPath, { packages: [], channelHistory: [] });
  }
}

function state() {
  const registry = readRegistry();
  return {
    ok: true,
    releaseRoot: RELEASE_ROOT,
    baseUrl: BASE_URL,
    channels: Object.fromEntries(CHANNELS.map((channel) => [channel, readChannel(channel)])),
    packages: registry.packages || [],
    channelHistory: registry.channelHistory || []
  };
}

function importPackage(body) {
  const sourcePath = path.resolve(String(body.sourcePath || ""));
  const version = String(body.version || "").trim();
  const platform = String(body.platform || "win-x64").trim();
  const notes = String(body.notes || "");
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error("sourcePath not found");
  if (!version) throw new Error("version is required");
  if (!PLATFORMS.includes(platform)) throw new Error(`platform must be one of: ${PLATFORMS.join(", ")}`);

  const extension = sourcePath.endsWith(".zip") ? ".zip" : path.extname(sourcePath) || ".zip";
  const packageName = `camera-local-console-${platform}-${version}${extension}`;
  const targetPath = path.join(RELEASE_ROOT, "packages", platform, packageName);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);

  const sha256 = fileSha256(targetPath);
  const manifest = {
    version,
    channel: "",
    platform,
    url: `${BASE_URL}/packages/${platform}/${packageName}`,
    sha256,
    required: Boolean(body.required),
    notes
  };
  const manifestPath = path.join(RELEASE_ROOT, "manifests", `${version}-${platform}.json`);
  writeJson(manifestPath, manifest);

  const registry = readRegistry();
  registry.packages = [
    { ...manifest, packageName, importedAt: new Date().toISOString() },
    ...(registry.packages || []).filter((item) => !(item.version === version && item.platform === platform))
  ];
  writeRegistry(registry);
  return manifest;
}

function promoteChannel(body) {
  const channel = String(body.channel || "").trim();
  const version = String(body.version || "").trim();
  const platform = String(body.platform || "win-x64").trim();
  if (!CHANNELS.includes(channel)) throw new Error(`channel must be one of: ${CHANNELS.join(", ")}`);
  if (!version) throw new Error("version is required");

  const manifestPath = path.join(RELEASE_ROOT, "manifests", `${version}-${platform}.json`);
  if (!fs.existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
  const manifest = readJsonFile(manifestPath);
  manifest.channel = channel;
  writeJson(path.join(RELEASE_ROOT, "channels", `${channel}.json`), manifest);

  const registry = readRegistry();
  registry.channelHistory = [
    { action: "promote", channel, version, platform, at: new Date().toISOString() },
    ...(registry.channelHistory || [])
  ].slice(0, 200);
  writeRegistry(registry);
  return manifest;
}

function rollbackChannel(body) {
  return promoteChannel({ ...body, channel: body.channel });
}

function readChannel(channel) {
  const file = path.join(RELEASE_ROOT, "channels", `${channel}.json`);
  return fs.existsSync(file) ? readJsonFile(file) : null;
}

function registryFile() {
  return path.join(RELEASE_ROOT, "registry.json");
}

function readRegistry() {
  return readJsonFile(registryFile());
}

function writeRegistry(registry) {
  writeJson(registryFile(), registry);
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function fileSha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) reject(new Error("request body too large"));
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

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Release Admin</title>
  <style>
    body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:0;background:#f5f7fb;color:#111827}
    header{padding:22px 28px;background:#0f172a;color:white}
    main{padding:24px;display:grid;gap:18px;max-width:1200px;margin:0 auto}
    section{background:white;border:1px solid #d8dee9;border-radius:10px;padding:18px}
    h1,h2{margin:0 0 10px}
    label{display:grid;gap:6px;font-size:13px;color:#475569}
    input,select,textarea{padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px}
    textarea{min-height:72px}
    button{padding:10px 14px;border:0;border-radius:8px;background:#047857;color:white;font-weight:700;cursor:pointer}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border-bottom:1px solid #e5e7eb;padding:9px;text-align:left;vertical-align:top}
    code{background:#eef2ff;padding:2px 5px;border-radius:4px}
    pre{background:#0f172a;color:#dbeafe;padding:12px;border-radius:8px;overflow:auto}
    .muted{color:#64748b}
  </style>
</head>
<body>
  <header>
    <h1>Release Admin</h1>
    <div id="root" class="muted"></div>
  </header>
  <main>
    <section>
      <h2>Channels</h2>
      <div id="channels"></div>
    </section>
    <section>
      <h2>Import Package</h2>
      <div class="grid">
        <label>Package path on server<input id="sourcePath" placeholder="/path/to/camera-local-console-win-x64-0.1.1.zip"></label>
        <label>Version<input id="version" placeholder="0.1.1"></label>
        <label>Platform<select id="platform"><option value="win-x64">win-x64</option><option value="linux-arm64">linux-arm64</option></select></label>
        <label>Notes<textarea id="notes"></textarea></label>
      </div>
      <p><button onclick="importPackage()">Import</button></p>
    </section>
    <section>
      <h2>Packages</h2>
      <div id="packages"></div>
    </section>
    <section>
      <h2>History</h2>
      <pre id="history"></pre>
    </section>
  </main>
  <script>
    let appState = null;
    async function api(path, body) {
      const res = await fetch(path, body ? { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) } : {});
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || "request failed");
      return data;
    }
    async function refresh() {
      appState = await api("/api/state");
      document.getElementById("root").textContent = "root: " + appState.releaseRoot + " | base: " + appState.baseUrl;
      renderChannels();
      renderPackages();
      document.getElementById("history").textContent = JSON.stringify(appState.channelHistory || [], null, 2);
    }
    function renderChannels() {
      document.getElementById("channels").innerHTML = Object.entries(appState.channels).map(([name, manifest]) => {
        return '<p><strong>' + name + '</strong>: ' + (manifest ? manifest.version + ' ' + manifest.platform : 'empty') + '</p>';
      }).join("");
    }
    function renderPackages() {
      const rows = (appState.packages || []).map((pkg) => '<tr><td>' + pkg.version + '</td><td>' + pkg.platform + '</td><td><code>' + pkg.sha256 + '</code></td><td>' + (pkg.notes || '') + '</td><td>' + ["canary","beta","stable"].map(c => '<button onclick="promote(\\'' + c + '\\',\\'' + pkg.version + '\\',\\'' + pkg.platform + '\\')">' + c + '</button>').join(' ') + '</td></tr>').join("");
      document.getElementById("packages").innerHTML = '<table><thead><tr><th>Version</th><th>Platform</th><th>SHA256</th><th>Notes</th><th>Promote</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    async function importPackage() {
      await api("/api/packages/import", { sourcePath: sourcePath.value, version: version.value, platform: platform.value, notes: notes.value });
      await refresh();
    }
    async function promote(channel, version, platform) {
      await api("/api/channels/promote", { channel, version, platform });
      await refresh();
    }
    refresh().catch(e => alert(e.message));
  </script>
</body>
</html>`;
}
