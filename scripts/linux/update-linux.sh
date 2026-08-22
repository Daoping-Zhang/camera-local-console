#!/bin/bash
# ============================================================
# camera-local-console · Linux 远程更新执行器（由控制台检测到任务后调用）
# 用法：bash update-linux.sh <下载URL> <sha256> <版本> [安装目录] [serverUrl] [token] [storeId]
# 流程：下载 → SHA256 校验 → 备份 src → 解压替换 → 重启 systemd 服务 → 上报结果
# 说明：脚本以 detached 方式运行（不受控制台服务重启影响），完成后自行上报后端
# ============================================================
set -euo pipefail

URL="${1:-}"
SHA="${2:-}"
VERSION="${3:-}"
INSTALL_DIR="${4:-/opt/camera-local-console}"
SERVER_URL="${5:-}"
TOKEN="${6:-}"
STORE_ID="${7:-}"

report() { # report <ok> <message>
  if [ -n "$SERVER_URL" ] && [ -n "$TOKEN" ]; then
    curl -fsSL -X POST -H "X-Access-Token: $TOKEN" -H "Content-Type: application/json" \
      -d "{\"ok\":$1,\"message\":\"$2\"}" "${SERVER_URL}/api/edge/update-result" >/dev/null 2>&1 || true
  fi
}

if [ -z "$URL" ] || [ -z "$SHA" ] || [ -z "$VERSION" ]; then
  echo "参数缺失：需要 URL / sha256 / version"
  report false "参数缺失"
  exit 1
fi

echo "==> 远程更新控制台 → ${VERSION}"
echo "    URL: $URL"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------- 1. 下载 + 校验 ----------
echo "==> 下载安装包..."
if ! curl -fsSL -o "$TMP/pkg.tar.gz" "$URL"; then
  echo "下载失败"; report false "下载失败"; exit 1
fi
echo "==> SHA256 校验..."
if command -v sha256sum >/dev/null 2>&1; then
  CHECK_OK=$(echo "$SHA  $TMP/pkg.tar.gz" | sha256sum -c - >/dev/null 2>&1 && echo yes || echo no)
else
  ACTUAL="$(shasum -a 256 "$TMP/pkg.tar.gz" | awk '{print $1}')"
  [ "$ACTUAL" = "$SHA" ] && CHECK_OK=yes || CHECK_OK=no
fi
if [ "$CHECK_OK" != "yes" ]; then
  echo "❌ SHA256 校验失败，更新中止"; report false "SHA256 校验失败"; exit 1
fi

# ---------- 2. 解压到临时目录 ----------
echo "==> 解压..."
tar -xzf "$TMP/pkg.tar.gz" -C "$TMP"
PKG_DIR="$(find "$TMP" -maxdepth 1 -type d -name 'camera-local-console-*' | head -1)"
if [ -z "$PKG_DIR" ] || [ ! -d "$PKG_DIR/src" ]; then
  echo "❌ 安装包结构不正确（缺少 src/）"; report false "安装包结构不正确"; exit 1
fi

# ---------- 3. 备份并替换（服务运行中替换文件安全：Node 已加载模块在内存） ----------
echo "==> 备份并替换..."
rm -rf "$INSTALL_DIR/src.bak"
[ -d "$INSTALL_DIR/src" ] && mv "$INSTALL_DIR/src" "$INSTALL_DIR/src.bak"
cp -R "$PKG_DIR/src" "$INSTALL_DIR/src"
[ -f "$PKG_DIR/package.json" ] && cp "$PKG_DIR/package.json" "$INSTALL_DIR/package.json" 2>/dev/null || true
[ -d "$PKG_DIR/scripts" ] && cp -R "$PKG_DIR/scripts" "$INSTALL_DIR/" 2>/dev/null || true
[ -f "$PKG_DIR/version.json" ] && cp "$PKG_DIR/version.json" "$INSTALL_DIR/version.json" 2>/dev/null || true

# ---------- 4. 重启服务（脚本 detached，不受影响） ----------
echo "==> 重启控制台服务..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl restart camera-local-console 2>/dev/null || true
fi
rm -rf "$INSTALL_DIR/src.bak"

echo "✅ 更新完成: ${VERSION}"
report true "更新完成 ${VERSION}"
exit 0
