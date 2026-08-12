# Scripts Layout

Scripts are grouped by purpose.

```text
scripts/
  runtime/
    collector-server.js
    hikvision-collector.py
    fake-collector.js
    mock-hik-contact-data.js

  start/
    start-console.cmd
    start-console.sh
    start-real-collector.cmd
    start-real-collector.sh
    start-release-admin.cmd
    start-release-admin.sh
    ...

  windows/
    package-windows.ps1
    release-windows.ps1
    update-windows.ps1
    prepare-hikvision-sdk.ps1

  docker/
    docker-build-arm64.sh
    docker-update-rk3566.sh
```

Use `runtime/` for long-running service code, `start/` for local launch wrappers, `windows/` for package/update/release tooling, and `docker/` for RK3566/Linux image workflows.
