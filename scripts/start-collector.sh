#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

NODE_EXE="/c/Users/Yang XinTong/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"
if [[ -x "$NODE_EXE" ]]; then
  exec "$NODE_EXE" scripts/collector-server.js
fi

if command -v node >/dev/null 2>&1; then
  exec node scripts/collector-server.js
fi

echo "Node.js was not found. Install Node.js 20 or newer, then run: node scripts/collector-server.js" >&2
exit 1
