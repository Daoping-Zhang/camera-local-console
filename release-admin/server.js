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
const BASE_PATH = new URL(BASE_URL).pathname.replace(/\/$/, "") || "";
const CHANNELS = ["canary", "beta", "stable"];
const PLATFORMS = ["win-x64", "linux-arm64"];
const ADMIN_USER = process.env.RELEASE_ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.RELEASE_ADMIN_PASSWORD || "admin123";
const sessions = new Set();

ensureLayout();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const releasePathname = toReleasePathname(url.pathname);
    const readable = req.method === "GET" || req.method === "HEAD";
    if (readable && (releasePathname === "/" || releasePathname === "/download")) return sendHtml(res, downloadHtml());
    if (readable && releasePathname.startsWith("/channels/")) return serveReleaseFile(res, releasePathname);
    if (readable && releasePathname.startsWith("/manifests/")) return serveReleaseFile(res, releasePathname);
    if (readable && releasePathname.startsWith("/packages/")) return serveReleaseFile(res, releasePathname);
    if (readable && (url.pathname === "/login" || releasePathname === "/login")) return redirect(res, joinBasePath("/admin/login"));
    if (readable && releasePathname === "/admin/login") return sendHtml(res, loginHtml());
    if (req.method === "POST" && releasePathname === "/api/login") {
      const body = await readJson(req);
      return handleLogin(res, body);
    }
    if (readable && url.pathname === "/") return redirect(res, joinBasePath("/"));
    if (!isAuthenticated(req)) {
      if (releasePathname.startsWith("/api/")) return sendJson(res, 401, { ok: false, error: "请先登录" });
      return redirect(res, joinBasePath("/admin/login"));
    }
    if (readable && releasePathname === "/admin") return sendHtml(res, pageHtml());
    if (req.method === "POST" && releasePathname === "/api/logout") return handleLogout(req, res);
    if (req.method === "GET" && releasePathname === "/api/state") return sendJson(res, 200, state());
    if (req.method === "POST" && releasePathname === "/api/packages/upload") {
      const result = await uploadPackage(req);
      return sendJson(res, 200, { ok: true, result, state: state() });
    }
    if (req.method === "POST" && releasePathname === "/api/packages/import") {
      const body = await readJson(req);
      const result = importPackage(body);
      return sendJson(res, 200, { ok: true, result, state: state() });
    }
    if (req.method === "POST" && releasePathname === "/api/channels/promote") {
      const body = await readJson(req);
      const result = promoteChannel(body);
      return sendJson(res, 200, { ok: true, result, state: state() });
    }
    if (req.method === "POST" && releasePathname === "/api/channels/rollback") {
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
    currentVersion: readPackageVersion(),
    suggestedNextVersion: suggestNextVersion(registry.packages || []),
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

  const extension = safePackageExtension(sourcePath);
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

async function uploadPackage(req) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("请选择要上传的安装包");
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const body = await readBuffer(req, 1024 * 1024 * 1024);
  const form = parseMultipart(body, boundary);
  const file = form.files.packageFile;
  const version = String(form.fields.version || "").trim();
  const platform = String(form.fields.platform || "win-x64").trim();
  const notes = String(form.fields.notes || "");
  if (!file || !file.data.length) throw new Error("请选择要上传的安装包");
  if (!version) throw new Error("请填写版本号");
  if (!PLATFORMS.includes(platform)) throw new Error(`平台只能是：${PLATFORMS.join(", ")}`);

  const uploadDir = path.join(RELEASE_ROOT, "uploads");
  fs.mkdirSync(uploadDir, { recursive: true });
  const extension = safePackageExtension(file.filename);
  const uploadPath = path.join(uploadDir, `${Date.now()}-${safeName(file.filename || `package${extension}`)}`);
  fs.writeFileSync(uploadPath, file.data);
  return importPackage({ sourcePath: uploadPath, version, platform, notes });
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

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8").replace(/^\uFEFF/, ""));
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function suggestNextVersion(packages) {
  const versions = [readPackageVersion(), ...packages.map((item) => item.version)].filter(Boolean);
  const latest = versions.sort(compareVersions).at(-1) || "0.0.0";
  const match = latest.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) return latest;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] || ""}`;
}

function compareVersions(a, b) {
  const left = String(a).match(/^(\d+)\.(\d+)\.(\d+)/);
  const right = String(b).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!left || !right) return String(a).localeCompare(String(b));
  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(left[index]) - Number(right[index]);
    if (diff) return diff;
  }
  return String(a).localeCompare(String(b));
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

function readBuffer(req, maxBytes = 20_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("上传文件过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const result = { fields: {}, files: {} };
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(delimiter, cursor);
    if (start === -1) break;
    const partStart = start + delimiter.length;
    if (buffer.slice(partStart, partStart + 2).toString() === "--") break;
    const headerStart = buffer.slice(partStart, partStart + 2).toString() === "\r\n" ? partStart + 2 : partStart;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) break;
    const next = buffer.indexOf(delimiter, headerEnd + 4);
    if (next === -1) break;
    const header = buffer.slice(headerStart, headerEnd).toString("utf8");
    let data = buffer.slice(headerEnd + 4, next);
    if (data.slice(-2).toString() === "\r\n") data = data.slice(0, -2);
    const disposition = header.match(/content-disposition:[^\n]+/i)?.[0] || "";
    const name = disposition.match(/name="([^"]+)"/)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/)?.[1];
    if (name && filename !== undefined) {
      result.files[name] = { filename, data };
    } else if (name) {
      result.fields[name] = data.toString("utf8");
    }
    cursor = next;
  }
  return result;
}

function safePackageExtension(filename) {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".zip")) return ".zip";
  return path.extname(filename || "") || ".zip";
}

function safeName(value) {
  const cleaned = path.basename(String(value || "package.zip")).replace(/[^a-zA-Z0-9._-]/g, "-");
  return cleaned || "package.zip";
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function toReleasePathname(pathname) {
  if (BASE_PATH && pathname.startsWith(`${BASE_PATH}/`)) return pathname.slice(BASE_PATH.length);
  if (BASE_PATH && pathname === BASE_PATH) return "/";
  return pathname;
}

function joinBasePath(pathname) {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${BASE_PATH}${normalized}` || normalized;
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function handleLogin(res, body) {
  const username = String(body.username || "");
  const password = String(body.password || "");
  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
    sendJson(res, 401, { ok: false, error: "账号或密码不正确" });
    return;
  }
  const token = crypto.randomBytes(24).toString("hex");
  sessions.add(token);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": `release_admin_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`
  });
  res.end(JSON.stringify({ ok: true }));
}

function handleLogout(req, res) {
  const token = cookieValue(req, "release_admin_session");
  if (token) sessions.delete(token);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": "release_admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  });
  res.end(JSON.stringify({ ok: true }));
}

function isAuthenticated(req) {
  const token = cookieValue(req, "release_admin_session");
  return Boolean(token && sessions.has(token));
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || "").split(";").map((item) => item.trim());
  const prefix = `${name}=`;
  const found = cookies.find((item) => item.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : "";
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".json": "application/json; charset=utf-8",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar"
  };
  const headers = { "Content-Type": contentTypes[ext] || "application/octet-stream" };
  if (ext === ".zip" || ext === ".gz" || ext === ".tar") {
    headers["Content-Disposition"] = `attachment; filename="${path.basename(filePath).replaceAll('"', "")}"`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function serveReleaseFile(res, pathname) {
  const filePath = path.normalize(path.join(RELEASE_ROOT, pathname));
  if (!filePath.startsWith(RELEASE_ROOT)) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { ok: false, error: "not found" });
    return;
  }
  sendFile(res, filePath);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function downloadHtml() {
  const channels = Object.fromEntries(CHANNELS.map((channel) => [channel, readChannel(channel)]));
  const stable = channels.stable || channels.beta || channels.canary;
  const title = stable ? `当前版本 ${stable.version}` : "暂无可下载版本";
  const cards = CHANNELS.map((channel) => channelCard(channel, channels[channel])).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>摄像头本地控制台下载</title>
  <style>
    body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:0;background:#f5f7fb;color:#111827}
    header{padding:28px;background:#0f172a;color:white}
    main{padding:24px;display:grid;gap:16px;max-width:980px;margin:0 auto}
    h1,h2,p{margin:0}
    .hero{display:grid;gap:8px}
    .hero p{color:#cbd5e1}
    .card{background:white;border:1px solid #d8dee9;border-radius:10px;padding:18px;display:grid;gap:12px}
    .install-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
    .install-box{border:1px solid #e5e7eb;border-radius:8px;padding:14px;display:grid;gap:8px}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .muted{color:#64748b}
    .pill{padding:4px 8px;border-radius:999px;background:#eef2ff;color:#3730a3;font-weight:700;font-size:12px}
    .button{display:inline-block;padding:10px 14px;border-radius:8px;background:#047857;color:white;text-decoration:none;font-weight:700}
    .secondary{background:white;color:#344054;border:1px solid #cbd5e1}
    code{background:#f1f5f9;padding:2px 6px;border-radius:5px;overflow-wrap:anywhere}
    pre{white-space:pre-wrap;background:#0f172a;color:#dbeafe;padding:12px;border-radius:8px;overflow:auto}
  </style>
</head>
<body>
  <header>
    <div class="hero">
      <h1>摄像头本地控制台</h1>
      <p>${escapeHtml(title)}。下载压缩包后解压，运行 start-all.cmd 即可启动。</p>
    </div>
  </header>
  <main>
    ${cards || `<section class="card"><h2>暂无发布包</h2><p class="muted">请先在版本发布管理台导入包，并发布到 stable、beta 或 canary。</p></section>`}
    <section class="card">
      <h2>安装说明</h2>
      <div class="install-grid">
        <div class="install-box">
          <h3>Windows x64</h3>
          <p>首次安装：下载 zip，解压到目标目录，运行 <code>start-all.cmd</code>。</p>
          <p>已有安装：打开本机控制台的“版本更新”，点击“立即更新本机”。人工兜底时也可以进入原目录运行 <code>update.cmd</code>。</p>
        </div>
        <div class="install-box">
          <h3>Linux ARM64 / RK3566</h3>
          <p>推荐使用镜像方式部署，按版本拉取或更新镜像。</p>
          <p>已有设备更新：运行 <code>scripts/docker/docker-update-rk3566.sh</code>，并传入 <code>APP_VERSION</code> 和镜像仓库地址。</p>
        </div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function channelCard(channel, manifest) {
  if (!manifest) {
    return `<section class="card"><div class="row"><h2>${escapeHtml(channelName(channel))}</h2><span class="pill">未发布</span></div><p class="muted">该通道暂无版本。</p></section>`;
  }
  const manifestUrl = `${BASE_URL}/channels/${channel}.json`;
  return `<section class="card">
    <div class="row"><h2>${escapeHtml(channelName(channel))}</h2><span class="pill">${escapeHtml(manifest.platform || "unknown")}</span></div>
    <p><strong>版本：</strong>${escapeHtml(manifest.version || "-")}</p>
    <p><strong>更新说明：</strong>${escapeHtml(manifest.notes || "暂无说明")}</p>
    <div class="row">
      <a class="button" href="${escapeHtml(manifest.url || "#")}">下载安装包</a>
      <a class="button secondary" href="${escapeHtml(manifestUrl)}">查看更新清单</a>
    </div>
    <p class="muted">SHA256：<code>${escapeHtml(manifest.sha256 || "-")}</code></p>
  </section>`;
}

function channelName(channel) {
  return {
    stable: "稳定版 stable",
    beta: "测试版 beta",
    canary: "灰度版 canary"
  }[channel] || channel;
}

function loginHtml() {
  const adminUrl = joinBasePath("/admin");
  const loginApiUrl = joinBasePath("/api/login");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登录版本发布管理台</title>
  <style>
    body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#111827}
    main{width:min(420px,calc(100vw - 32px));background:white;border:1px solid #d8dee9;border-radius:8px;padding:24px;box-shadow:0 18px 50px rgba(15,23,42,.08)}
    h1,p{margin:0}
    h1{font-size:22px}
    p{margin-top:8px;color:#64748b}
    form{display:grid;gap:14px;margin-top:22px}
    label{display:grid;gap:6px;font-size:13px;color:#475569}
    input{height:40px;border:1px solid #cbd5e1;border-radius:6px;padding:0 10px;font-size:14px}
    button{height:40px;border:0;border-radius:6px;background:#047857;color:white;font-weight:700;cursor:pointer}
    .error{min-height:20px;color:#b42318;font-weight:700}
  </style>
</head>
<body>
  <main>
    <h1>版本发布管理台</h1>
    <p>请输入管理员账号后再导入安装包或发布通道。</p>
    <form id="loginForm">
      <label>账号<input id="username" autocomplete="username" value="${escapeHtml(ADMIN_USER)}"></label>
      <label>密码<input id="password" type="password" autocomplete="current-password" autofocus></label>
      <button type="submit">登录</button>
      <div id="error" class="error"></div>
    </form>
  </main>
  <script>
    loginForm.onsubmit = async (event) => {
      event.preventDefault();
      error.textContent = "";
      const res = await fetch("${escapeHtml(loginApiUrl)}", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ username: username.value, password: password.value })
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        error.textContent = data.error || "登录失败";
        return;
      }
      location.href = "${escapeHtml(adminUrl)}";
    };
  </script>
</body>
</html>`;
}

function pageHtml() {
  const downloadUrl = joinBasePath("/");
  const loginUrl = joinBasePath("/admin/login");
  const apiBaseUrl = joinBasePath("/api");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>版本发布管理台</title>
  <style>
    body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:0;background:#f5f7fb;color:#111827}
    header{padding:24px 28px;background:#0f172a;color:white}
    main{padding:24px;display:grid;gap:18px;max-width:1200px;margin:0 auto}
    section{background:white;border:1px solid #d8dee9;border-radius:8px;padding:18px}
    h1,h2,h3,p{margin:0}
    h1{font-size:24px}
    h2{font-size:18px;margin-bottom:6px}
    h3{font-size:15px;margin-bottom:4px}
    label{display:grid;gap:6px;font-size:13px;color:#475569}
    input,select,textarea{padding:10px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px}
    input[type=file]{height:auto;background:#f8fafc}
    textarea{min-height:72px}
    button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 14px;border:0;border-radius:6px;background:#047857;color:white;font-weight:700;cursor:pointer;text-decoration:none}
    button.secondary,.button.secondary{border:1px solid #cbd5e1;background:white;color:#344054}
    button.warn{background:#b42318}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
    .hero{display:grid;gap:8px}
    .hero p{color:#cbd5e1}
    .meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-top:14px}
    .meta div{border:1px solid #334155;border-radius:8px;padding:10px;color:#cbd5e1}
    .meta strong{display:block;color:white;margin-top:4px;overflow-wrap:anywhere}
    .channel-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
    .channel-card{border:1px solid #e5e7eb;border-left:4px solid #94a3b8;border-radius:8px;padding:14px;display:grid;gap:8px}
    .channel-card.active{border-left-color:#047857;background:#f3fbf7}
    .pill{display:inline-flex;width:max-content;padding:4px 8px;border-radius:999px;background:#eef2ff;color:#3730a3;font-size:12px;font-weight:700}
    .table-wrap{overflow:auto}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border-bottom:1px solid #e5e7eb;padding:9px;text-align:left;vertical-align:top}
    code{background:#eef2ff;padding:2px 5px;border-radius:4px}
    pre{background:#0f172a;color:#dbeafe;padding:12px;border-radius:8px;overflow:auto}
    .muted{color:#64748b}
    .status{min-height:20px;color:#047857;font-weight:700}
    .field-help{color:#64748b;font-size:12px}
    .link-button{height:auto;min-height:0;padding:0;border:0;background:transparent;color:#047857}
    .progress{display:none;width:100%;height:8px;margin-top:10px;border-radius:999px;background:#e5e7eb;overflow:hidden}
    .progress.active{display:block}
    .progress span{display:block;width:0;height:100%;background:#047857;transition:width .15s ease}
    .empty{border:1px dashed #cbd5e1;border-radius:8px;padding:16px;text-align:center;color:#64748b}
  </style>
</head>
<body>
  <header>
    <div class="hero">
      <div class="head">
        <div>
          <h1>版本发布管理台</h1>
          <p>导入安装包，生成 SHA256 和更新清单，然后发布到 stable、beta 或 canary 通道。</p>
        </div>
        <div class="row">
          <a class="button secondary" href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener">打开用户下载页</a>
          <button class="secondary" onclick="logout()">退出登录</button>
        </div>
      </div>
      <div class="meta">
        <div>发布目录<strong id="releaseRoot">-</strong></div>
        <div>公开地址<strong id="baseUrl">-</strong></div>
      </div>
    </div>
  </header>
  <main>
    <section>
      <div class="head">
        <div>
          <h2>发布通道</h2>
          <p class="muted">用户下载页和客户端检查更新都会读取这里的通道版本。</p>
        </div>
        <button class="secondary" onclick="refresh()">刷新状态</button>
      </div>
      <div id="channels"></div>
    </section>
    <section>
      <h2>导入发布包</h2>
      <p class="muted">优先直接选择安装包上传；如果安装包已经在服务器上，也可以用服务器本地路径导入。</p>
      <div class="grid">
        <label>上传安装包<input id="packageFile" type="file" accept=".zip,.gz,.tar,.tgz,application/zip,application/gzip"></label>
        <label>版本号<input id="version" placeholder="0.1.1"><span id="versionHelp" class="field-help"></span></label>
        <label>平台<select id="platform"><option value="win-x64">Windows x64</option><option value="linux-arm64">Linux ARM64</option></select></label>
        <label>更新说明<textarea id="notes" placeholder="说明这次修复或新增了什么"></textarea></label>
      </div>
      <div id="uploadProgress" class="progress"><span></span></div>
      <p class="row"><button onclick="uploadPackage()">上传并生成清单</button><span id="status" class="status"></span></p>
      <details>
        <summary class="muted">安装包已经在服务器上？使用本地路径导入</summary>
        <div class="grid" style="margin-top:12px">
          <label>服务器上的安装包路径<input id="sourcePath" placeholder="/path/to/camera-local-console-win-x64-0.1.1.zip"></label>
        </div>
        <p class="row"><button class="secondary" onclick="importPackage()">从服务器路径导入</button></p>
      </details>
    </section>
    <section>
      <h2>已导入安装包</h2>
      <p class="muted">确认版本和平台无误后，把它发布到对应通道。</p>
      <div id="packages"></div>
    </section>
    <section>
      <h2>发布历史</h2>
      <pre id="history"></pre>
    </section>
  </main>
  <script>
    let appState = null;
    async function api(path, body) {
      const options = body instanceof FormData
        ? { method: "POST", body }
        : (body ? { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) } : {});
      const res = await fetch("${escapeHtml(apiBaseUrl)}" + path, options);
      const data = await res.json();
      if (res.status === 401) location.href = "${escapeHtml(loginUrl)}";
      if (!res.ok || data.ok === false) throw new Error(data.error || "请求失败");
      return data;
    }
    async function refresh() {
      appState = await api("/state");
      document.getElementById("releaseRoot").textContent = appState.releaseRoot;
      document.getElementById("baseUrl").textContent = appState.baseUrl;
      renderChannels();
      renderPackages();
      renderHistory();
      renderVersionSuggestion();
    }
    function renderChannels() {
      document.getElementById("channels").innerHTML = '<div class="channel-grid">' + Object.entries(appState.channels).map(([name, manifest]) => {
        if (!manifest) {
          return '<div class="channel-card"><h3>' + channelName(name) + '</h3><span class="pill">未发布</span><p class="muted">暂无版本</p></div>';
        }
        return '<div class="channel-card active"><h3>' + channelName(name) + '</h3><span class="pill">' + escapeHtml(manifest.platform || '-') + '</span><p><strong>版本：</strong>' + escapeHtml(manifest.version || '-') + '</p><p class="muted">' + escapeHtml(manifest.notes || '暂无更新说明') + '</p><p><a class="button secondary" href="' + escapeHtml(appState.baseUrl + '/channels/' + name + '.json') + '" target="_blank" rel="noopener">查看清单</a></p></div>';
      }).join("") + '</div>';
    }
    function renderPackages() {
      if (!appState.packages || !appState.packages.length) {
        document.getElementById("packages").innerHTML = '<div class="empty">还没有导入安装包。</div>';
        return;
      }
      const rows = appState.packages.map((pkg) => '<tr><td><strong>' + escapeHtml(pkg.version) + '</strong></td><td>' + escapeHtml(pkg.platform) + '</td><td><code>' + escapeHtml(pkg.sha256) + '</code></td><td>' + escapeHtml(pkg.notes || '暂无说明') + '</td><td><div class="row">' + ["canary","beta","stable"].map(c => '<button onclick="promote(\\'' + c + '\\',\\'' + escapeHtml(pkg.version) + '\\',\\'' + escapeHtml(pkg.platform) + '\\')">发布到 ' + c + '</button>').join(' ') + '</div></td></tr>').join("");
      document.getElementById("packages").innerHTML = '<div class="table-wrap"><table><thead><tr><th>版本</th><th>平台</th><th>SHA256</th><th>更新说明</th><th>发布操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }
    function renderHistory() {
      const history = appState.channelHistory || [];
      document.getElementById("history").textContent = history.length ? history.map((item) => item.at + '  ' + channelName(item.channel) + ' -> ' + item.version + ' / ' + item.platform).join("\\n") : "暂无发布历史";
    }
    function renderVersionSuggestion() {
      const suggested = appState.suggestedNextVersion || "";
      if (!version.value && suggested) version.value = suggested;
      version.placeholder = suggested || "0.1.1";
      versionHelp.innerHTML = suggested
        ? '建议下一个版本号：<button class="link-button" onclick="useSuggestedVersion()" type="button">' + escapeHtml(suggested) + '</button>'
        : '可以手动填写版本号';
    }
    function useSuggestedVersion() {
      version.value = appState.suggestedNextVersion || version.placeholder;
    }
    async function importPackage() {
      await api("/packages/import", { sourcePath: sourcePath.value, version: version.value, platform: platform.value, notes: notes.value });
      document.getElementById("status").textContent = "导入成功，已生成安装包清单";
      await refresh();
    }
    async function uploadPackage() {
      if (!packageFile.files.length) throw new Error("请选择要上传的安装包");
      const form = new FormData();
      form.append("packageFile", packageFile.files[0]);
      form.append("version", version.value);
      form.append("platform", platform.value);
      form.append("notes", notes.value);
      document.getElementById("status").textContent = "正在上传并生成清单...";
      await uploadWithProgress("/packages/upload", form);
      document.getElementById("status").textContent = "上传成功，已生成安装包清单";
      packageFile.value = "";
      await refresh();
    }
    function uploadWithProgress(path, form) {
      return new Promise((resolve, reject) => {
        const progress = document.getElementById("uploadProgress");
        const bar = progress.querySelector("span");
        progress.classList.add("active");
        bar.style.width = "0%";
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "${escapeHtml(apiBaseUrl)}" + path);
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable) return;
          const percent = Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)));
          bar.style.width = percent + "%";
          document.getElementById("status").textContent = "正在上传：" + percent + "%";
        };
        xhr.onload = () => {
          let data = {};
          try { data = JSON.parse(xhr.responseText || "{}"); } catch {}
          if (xhr.status === 401) {
            location.href = "${escapeHtml(loginUrl)}";
            return;
          }
          if (xhr.status < 200 || xhr.status >= 300 || data.ok === false) {
            progress.classList.remove("active");
            reject(new Error(data.error || "上传失败"));
            return;
          }
          bar.style.width = "100%";
          setTimeout(() => progress.classList.remove("active"), 600);
          resolve(data);
        };
        xhr.onerror = () => {
          progress.classList.remove("active");
          reject(new Error("上传失败，请检查网络或服务状态"));
        };
        xhr.send(form);
      });
    }
    async function promote(channel, version, platform) {
      await api("/channels/promote", { channel, version, platform });
      document.getElementById("status").textContent = "已发布 " + version + " 到 " + channelName(channel);
      await refresh();
    }
    async function logout() {
      await api("/logout", {});
      location.href = "${escapeHtml(loginUrl)}";
    }
    function channelName(channel) {
      return { stable: "稳定版 stable", beta: "测试版 beta", canary: "灰度版 canary" }[channel] || channel;
    }
    function escapeHtml(value) {
      return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
    }
    refresh().catch(e => {
      document.getElementById("status").textContent = e.message;
      alert(e.message);
    });
  </script>
</body>
</html>`;
}
