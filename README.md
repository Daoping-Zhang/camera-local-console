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

The collector waits for the console to register devices. The console sends `gatewayUrl` during registration; the collector then reports heartbeat and events back to that gateway.

The console can register devices down to the collector:

```http
POST /api/devices/register
Content-Type: application/json
```

```json
{
  "gatewayUrl": "http://localhost:3000",
  "shopId": "10001",
  "shopName": "本地调试门店 A",
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
