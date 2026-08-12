# Camera Local Console

MVP for a local camera gateway console.

It does not change the remote server. It calls existing endpoints:

- `POST /user/login`
- `POST /shop/insertDevice`
- `POST /contact/sync/cameraData`

Local debug mode uses local shops and local device binding. Event reporting can still be forwarded to the configured server.

## Run

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Runtime state is stored in `data/config.json`. This file is intentionally ignored by Git.
Use `data/config.example.json` as the template for a new device.

## Fake Collector

```bash
npm run fake-collector
```

## Collector Server

Run an HTTP collector adapter:

```bash
npm run collector-server
```

Default collector URL:

```text
http://localhost:3100
```

## Hikvision HCNetSDK Collector

For real Hikvision people-counting data, run the HTTP collector in Hikvision mode on the machine or board that can reach the camera SDK port.
The console still scans the subnet and registers devices to the collector. The collector then starts one HCNetSDK worker per registered device,
logs in to the camera, arms alarms, parses `COMM_ALARM_PDC`, and posts people-counting events to the local console.

Windows Git Bash example:

```bash
bash scripts/start-real-collector.sh
```

Windows CMD example:

```bat
scripts\start-real-collector.cmd
```

The preferred SDK runtime layout is:

```text
vendor/hikvision/
  win-x64/
  linux-x64/
  linux-arm64/
```

Prepare local SDK runtime directories from the unpacked SDK packages:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-hikvision-sdk.ps1
```

Override the SDK path when needed:

```bash
HIK_SDK_DIR="/d/path/to/hikvision-runtime" bash scripts/start-real-collector.sh
```

For Linux ARM64 board deployment, mount or copy the arm64 HCNetSDK runtime files to:

```text
/opt/hikvision-sdk/
  libhcnetsdk.so
  libHCCore.so
  libssl.so.3
  libcrypto.so.3
  HCNetSDKCom/
```

Then run:

```bash
HIK_SDK_DIR=/opt/hikvision-sdk COLLECTOR_ADAPTER=hikvision PYTHON_PATH=python3 node scripts/collector-server.js
```

The camera must have people-counting/PDC alarm upload enabled, otherwise the SDK can log in and arm successfully but no `COMM_ALARM_PDC` events will arrive.

The collector waits for the console to register devices. The console sends `gatewayUrl` during registration; the collector then reports heartbeat and events back to that gateway.

## Windows Portable Package

Build a portable Windows package:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-windows.ps1
```

Fast directory-only export without zip:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-windows.ps1 -NoZip
```

The package includes:

- application files under `app/`
- `node.exe`
- a lightweight Python runtime for `hikvision-collector.py`
- Hikvision Win64 SDK runtime files
- `start-all.cmd`, `stop-all.cmd`, `open-console.cmd`
- `update.cmd`

The lightweight Python runtime only keeps the standard library needed by the collector and excludes large generic packages such as pandas, numpy, PDF, Word, and spreadsheet libraries.

## Windows Remote Updates

Clients check:

```text
http://www.fenqunshuju.com/releases/camera-local-console/version.json
```

Manifest example:

```json
{
  "version": "0.1.1",
  "channel": "stable",
  "url": "http://www.fenqunshuju.com/releases/camera-local-console/camera-local-console-win-x64-0.1.1.zip",
  "sha256": "replace-with-package-sha256",
  "required": false,
  "notes": "Describe changes here."
}
```

Run the client updater:

```bat
update.cmd
```

The updater preserves `config/`, `data/`, and `logs/`, replaces app/runtime/SDK files, writes local `version.json`, and keeps a `.backup-<timestamp>` rollback copy.

The console can register devices down to the collector:

```http
POST /api/devices/register
Content-Type: application/json
```

```json
{
  "gatewayUrl": "http://localhost:3000",
  "shopId": "10001",
  "shopName": "鏈湴璋冭瘯闂ㄥ簵 A",
  "deviceKey": "local-camera-001",
  "deviceName": "Local Debug Camera",
  "ipAddress": "192.168.1.20",
  "macAddress": "local-camera-001",
  "role": "outside",
  "type": 0,
  "sdk": {
    "vendor": "hikvision",
    "port": 8000,
    "username": "admin",
    "password": ""
  }
}
```

Environment variables:

```text
GATEWAY_URL=http://127.0.0.1:3000
COLLECTOR_ID=collector-local-fake
MAC_ADDRESS=local-camera-001
CAMERA_IP=192.168.1.20
INTERVAL_MS=10000
HEARTBEAT_INTERVAL_MS=10000
ONCE=1
```

## Collector Contract

Collectors are separate processes. A collector never calls the remote server directly. It only reports to the local gateway.

### Heartbeat

```http
POST /api/collector/heartbeat
Content-Type: application/json
```

```json
{
  "collectorId": "collector-local-fake",
  "version": "0.1.0",
  "adapter": "fake",
  "host": "local",
  "devices": [
    {
      "deviceKey": "local-camera-001",
      "ipAddress": "192.168.1.20",
      "macAddress": "local-camera-001",
      "status": "online"
    }
  ]
}
```

Required fields:

- `collectorId`
- `devices[].deviceKey`
- `devices[].status`

### Event

Collectors post unified events to the console:

```http
POST /api/collector/events
Content-Type: application/json
```

```json
{
  "collectorId": "collector-local-fake",
  "source": "fake",
  "deviceKey": "local-camera-001",
  "macAddress": "local-camera-001",
  "ipAddress": "192.168.1.20",
  "channelId": 1,
  "eventType": "PeopleCounting",
  "occurredAt": "2026-08-01 10:00:00",
  "enter": 10,
  "exit": 3,
  "duplicatePeople": 0,
  "raw": {}
}
```

Required fields:

- `deviceKey` or `macAddress`
- `eventType`
- `enter`
- `exit`

Recommended fields:

- `collectorId`
- `ipAddress`
- `channelId`
- `occurredAt`
- `duplicatePeople`
- `raw`

The console converts it to the current server payload shape and posts it to `/contact/sync/cameraData`.

## Docker Deploy

The recommended board deployment uses Docker Compose with host networking.
Host networking keeps camera subnet access, SDK callbacks, ARP, and future SADP discovery simpler.

```bash
docker compose up -d --build
```

Open:

```text
http://<board-ip>:3000
http://<board-ip>:3100
```

For local Docker Desktop testing on Windows or macOS, use the local override file.
Docker Desktop does not expose host-networked containers the same way a Linux board does,
so the override switches to bridge networking and publishes the ports explicitly:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

Open:

```text
http://localhost:3000
http://localhost:3100
```

If you need subnet scanning from a Windows development machine, run the console on the host instead of Docker.
Docker Desktop bridge networking exposes the web ports, but the container sees Docker's virtual network interfaces,
not all of the host's physical LAN adapters:

```bash
npm run dev
```

In another terminal:

```bash
npm run collector-server
```

If Node/npm is not installed on the Windows host, this repository also includes helper scripts
that use the Node runtime bundled with Codex Desktop:

```bat
scripts\start-console.cmd
scripts\start-collector.cmd
```

From Git Bash:

```bash
bash scripts/start-console.sh
bash scripts/start-collector.sh
```

Open:

```text
http://localhost:3000
http://localhost:3100
```

Use the Docker host-network deployment for the Linux board, where the containers share the board network namespace and can scan the camera subnet directly.

The compose file starts two processes:

- `firtree-console`: local web console on port `3000`
- `firtree-collector`: local collector on port `3100`

The Hikvision SDK is mounted from the host instead of baked into the image:

```text
/opt/firtree/sdk/hikvision-arm64 -> /opt/hikvision-sdk
```

Suggested board layout:

```text
/opt/firtree/
  app/
    camera-local-console/
  sdk/
    hikvision-arm64/
      libhcnetsdk.so
      libHCCore.so
      libssl.so.3
      libcrypto.so.3
      HCNetSDKCom/
  data/
  logs/
```

For a production board, copy `data/config.example.json` to `data/config.json` before first boot:

```bash
cp data/config.example.json data/config.json
```

## GitHub

This folder is intended to be a standalone repository. Do not initialize Git from `/Users/zhangdaoping`,
because that parent directory contains many unrelated files.

Create and push a remote repository:

```bash
git init
git add .
git commit -m "Initial camera local console"
git branch -M main
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main
```

## Productized Deployment Overview

`camera-local-console` is now organized as a local camera gateway plus a release-managed client package.

Runtime flow:

```text
Hikvision camera -> collector on 3100 -> local console on 3000 -> hik-contact-data -> MySQL
```

Deployment targets:

- Windows portable package for customer PCs without Docker.
- Linux ARM64/RK3566 Docker deployment with host networking.
- File-based release channels for canary/beta/stable updates.
- A separate release admin for package import, SHA256 generation, and channel promotion.

Key documents:

- [Development Guide](docs/DEVELOPMENT.md)
- [Release Guide](release/README.md)
- [Hikvision SDK Layout](vendor/hikvision/README.md)

### Release Admin

Run the file-based release admin:

```bash
npm run release-admin
```

Open:

```text
http://127.0.0.1:3200
```

The release admin manages package import, SHA256 calculation, manifest generation, canary/beta/stable promotion, and channel history.

### RK3566 / Linux ARM64 Docker

Build ARM64 image:

```bash
IMAGE_REPOSITORY=registry.example.com/firtree/camera-local-console VERSION=0.1.1 bash scripts/docker-build-arm64.sh --push
```

Run/update on RK3566:

```bash
APP_VERSION=0.1.1 IMAGE_REPOSITORY=registry.example.com/firtree/camera-local-console bash scripts/docker-update-rk3566.sh
```

Use a domestic/private registry such as Aliyun ACR or Harbor when GitHub/Docker Hub access is unreliable.
