# Release Update Server

Deploy Windows update files under:

```text
http://www.fenqunshuju.com/releases/camera-local-console/
```

Required files:

```text
channels/stable.json
channels/beta.json
channels/canary.json
packages/win-x64/camera-local-console-win-x64-<version>.zip
```

Channel manifest format:

```json
{
  "version": "0.1.1",
  "channel": "stable",
  "platform": "win-x64",
  "url": "http://www.fenqunshuju.com/releases/camera-local-console/camera-local-console-win-x64-0.1.1.zip",
  "sha256": "replace-with-package-sha256",
  "required": false,
  "notes": "Describe changes here."
}
```

Windows clients run:

```bat
update.cmd
```

The updater preserves:

- `config/`
- `data/`
- `logs/`

It replaces application/runtime/SDK files from the downloaded package, writes a local `version.json`, and keeps a `.backup-<timestamp>` directory for rollback.

Generate a Windows release locally:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release-windows.ps1 -Version 0.1.1 -Channel canary
```

CI is optional. For China-hosted deployments, a clean manual flow is:

```text
private repo -> build on a trusted Windows/server machine -> upload release/out to www.fenqunshuju.com -> update canary/beta/stable channel JSON
```

This avoids depending on GitHub availability. CI can be added later with a domestic runner or a self-hosted runner.

Promote a version by copying the generated channel JSON:

```text
release/out/channels/canary.json -> server channels/canary.json
release/out/channels/beta.json   -> server channels/beta.json
release/out/channels/stable.json -> server channels/stable.json
```

Docker images are recommended for RK3566/Linux ARM64 deployments. Use an image repository such as Aliyun ACR, Harbor, Docker Hub, or another private registry:

```bash
IMAGE_REPOSITORY=registry.example.com/firtree/camera-local-console VERSION=0.1.1 bash scripts/docker-build-arm64.sh --push
```

RK3566 devices update with:

```bash
APP_VERSION=0.1.1 IMAGE_REPOSITORY=registry.example.com/firtree/camera-local-console bash scripts/docker-update-rk3566.sh
```

## Release Admin

Run a local or server-side release admin:

```bash
npm run release-admin
```

or:

```bat
scripts\start-release-admin.cmd
```

Defaults:

```text
URL: http://127.0.0.1:3200
RELEASE_ROOT: release/out
RELEASE_BASE_URL: http://www.fenqunshuju.com/releases/camera-local-console
```

The admin manages file-based release metadata:

```text
release/out/
  registry.json
  channels/
    canary.json
    beta.json
    stable.json
  manifests/
    <version>-<platform>.json
  packages/
    win-x64/
    linux-arm64/
```

First version supports:

- import a package already present on the server
- calculate SHA256
- write per-version manifest
- promote a version to canary/beta/stable
- view channel history

For production, put it behind nginx basic auth, VPN, or an internal-only firewall rule.
