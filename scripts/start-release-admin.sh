#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

NODE_EXE="/c/Users/Yang XinTong/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"
if [[ -x "$NODE_EXE" ]]; then
  exec "$NODE_EXE" release-admin/server.js
fi

exec node release-admin/server.js
