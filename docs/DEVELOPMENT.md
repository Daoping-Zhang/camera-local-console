# Development Guide

This document describes the project architecture, local development workflow, deployment packages, and release process.

## Architecture

```text
Camera LAN
  Hikvision camera
    |
    | HCNetSDK alarm callback
    v
  Collector, port 3100
    |
    | POST /api/collector/heartbeat
    | POST /api/collector/events
    v
  Local console, port 3000
    |
    | POST /api/hik/eventRcv
    | POST /api/hik/eventRtbw
    v
  hik-contact-data
    |
    v
  MySQL
```

## Components

- `src/server.js`: local web console and gateway on port 3000.
- `scripts/runtime/collector-server.js`: collector manager on port 3100.
- `scripts/runtime/hikvision-collector.py`: HCNetSDK worker used by the collector.
- `src/public/`: browser UI for local registration, logs, collectors, and release status.
- `release-admin/server.js`: independent release management backend.
- `scripts/windows/package-windows.ps1`: creates Windows portable packages.
- `scripts/windows/release-windows.ps1`: creates Windows release package and channel manifest files.
- `docker-compose.rk3566.yml`: RK3566/Linux ARM64 runtime compose file.

## Local Development

Start the console:

```bash
npm run dev
```

Start the collector:

```bash
npm run collector-server
```

or on Windows:

```bat
scripts\start\start-real-collector.cmd
```

Open:

```text
http://127.0.0.1:3000
```

Runtime state is stored in:

```text
data/config.json
```

This file is not committed.

## Hikvision SDK Layout

Preferred runtime layout:

```text
vendor/hikvision/
  win-x64/
  linux-x64/
  linux-arm64/
```

Prepare local SDK files from the unpacked SDK packages:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/prepare-hikvision-sdk.ps1
```

Override the SDK path:

```bash
HIK_SDK_DIR=/path/to/hikvision-sdk npm run collector-server
```

## Windows Portable Package

Build a directory package without zip:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/package-windows.ps1 -NoZip
```

Build a zip package:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/package-windows.ps1
```

The package contains:

```text
app/
runtime/node/
runtime/python/
sdk/hikvision/
config/
data/
logs/
start-all.cmd
stop-all.cmd
open-console.cmd
update.cmd
version.json
```

`runtime/python` is intentionally lightweight. It keeps only the Python standard library required by `hikvision-collector.py` and excludes large generic packages such as pandas, numpy, PDF, Word, and spreadsheet libraries.

## Windows Release Channels

Generate a release:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/release-windows.ps1 -Version 0.1.1 -Channel canary
```

Generated files:

```text
release/out/
  packages/win-x64/camera-local-console-win-x64-0.1.1.zip
  manifests/0.1.1-win-x64.json
  channels/canary.json
```

Recommended channel flow:

```text
canary -> beta -> stable
```

The package is uploaded once. Promotion only changes the channel JSON.

## Release Server

Recommended public layout:

```text
http://www.fenqunshuju.com/releases/camera-local-console/
  channels/
    canary.json
    beta.json
    stable.json
  packages/
    win-x64/
      camera-local-console-win-x64-0.1.1.zip
  manifests/
    0.1.1-win-x64.json
```

CI is optional. For domestic deployment, a simple manual flow is acceptable:

```text
private repo
-> build release on trusted local/server machine
-> upload release/out to www.fenqunshuju.com
-> set canary channel
-> verify selected clients
-> promote to beta/stable
```

## Release Admin

Run:

```bash
npm run release-admin
```

Open:

```text
http://127.0.0.1:3200
```

Environment variables:

```text
RELEASE_ADMIN_HOST=127.0.0.1
RELEASE_ADMIN_PORT=3200
RELEASE_ROOT=release/out
RELEASE_BASE_URL=http://www.fenqunshuju.com/releases/camera-local-console
```

First version supports:

- import an existing package on the server
- calculate SHA256
- generate version manifest
- promote a version to canary/beta/stable
- view channel history

For production, do not expose this directly to the public internet. Put it behind nginx basic auth, VPN, or an internal firewall rule.

## RK3566 / Linux ARM64

Use Docker with host networking so subnet scanning and camera SDK networking work predictably.

Build and push ARM64 image:

```bash
IMAGE_REPOSITORY=registry.example.com/firtree/camera-local-console VERSION=0.1.1 bash scripts/docker/docker-build-arm64.sh --push
```

Update device:

```bash
APP_VERSION=0.1.1 IMAGE_REPOSITORY=registry.example.com/firtree/camera-local-console bash scripts/docker/docker-update-rk3566.sh
```

Use a domestic/private registry such as Aliyun ACR or Harbor if GitHub/Docker Hub access is unreliable.

## Database Mapping

`hik-contact-data` receives the forwarded payloads and writes:

- `/api/hik/eventRcv` -> `cd_sync_people_count_data`
- `/api/hik/eventRtbw` -> `cd_sync_human_body_data`

The database column is named `mac_address`, but this project writes the normalized `deviceIndexCode`, for example:

```text
08:CC:81:C4:79:9E -> 08cc81c4799e
```

`cd_device_record` is the device configuration table. Event APIs do not automatically create device configuration rows.

## Future Work

- Replace the Python HCNetSDK worker with a native C++ worker for cleaner deployment.
- Add client update result reporting to the release admin.
- Add authentication and audit logs to release admin.
- Add rollback buttons for channels.
- Add Linux ARM64 image manifests to release admin.

