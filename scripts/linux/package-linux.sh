#!/bin/bash
# ============================================================
# camera-local-console · Linux 安装包打包脚本（arm64 / x64）
# 产出 tar.gz（裸机安装用，systemd 直接跑 node src/server.js）
# 用法：bash scripts/linux/package-linux.sh [arm64|x64] [输出目录]
#   默认架构 = 当前机器架构；输出目录默认 dist/
#   打包后把 tar.gz 上传到 Web 管理面板「发布管理」→ 上传安装包（平台选 linux-arm64/linux-x64）
# ============================================================
set -euo pipefail

ARCH="${1:-}"
if [ -z "$ARCH" ]; then
  MACHINE="$(uname -m)"
  case "$MACHINE" in
    aarch64|arm64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *) echo "无法识别架构: ${MACHINE}，请显式指定 arm64 或 x64"; exit 1 ;;
  esac
fi
case "$ARCH" in
  arm64|aarch64) PLATFORM="linux-arm64" ;;
  x64|x86_64|amd64) PLATFORM="linux-x64" ;;
  *) echo "❌ 不支持的架构: $ARCH（支持 arm64 / x64）"; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_ROOT="${2:-$ROOT/dist}"
VERSION="$(node -e "console.log(require('$ROOT/package.json').version)" 2>/dev/null || echo "0.0.0")"
PACKAGE_DIR="$OUT_ROOT/camera-local-console-$PLATFORM-$VERSION"
TARBALL="$OUT_ROOT/camera-local-console-$PLATFORM-$VERSION.tar.gz"

echo "==> camera-local-console Linux 打包"
echo "    版本: $VERSION   平台: $PLATFORM"

# ---------- 1. 组装包目录 ----------
rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR"
cp -R "$ROOT/src" "$PACKAGE_DIR/src"
cp "$ROOT/package.json" "$PACKAGE_DIR/package.json"
mkdir -p "$PACKAGE_DIR/scripts/runtime" "$PACKAGE_DIR/scripts/linux"
cp "$ROOT/scripts/runtime/"*.js "$ROOT/scripts/runtime/"*.py "$PACKAGE_DIR/scripts/runtime/" 2>/dev/null || true
cp "$ROOT/scripts/linux/update-linux.sh" "$PACKAGE_DIR/scripts/linux/update-linux.sh"
chmod +x "$PACKAGE_DIR/scripts/linux/update-linux.sh"
printf '{\n  "version": "%s",\n  "channel": "stable"\n}\n' "$VERSION" > "$PACKAGE_DIR/version.json"
# Linux 启动脚本（systemd 用）
cat > "$PACKAGE_DIR/start.sh" <<'EOF'
#!/bin/bash
cd "$(dirname "$0")"
exec node src/server.js
EOF
chmod +x "$PACKAGE_DIR/start.sh"

# ---------- 2. 打包 tar.gz + SHA256 ----------
cd "$OUT_ROOT"
tar -czf "$TARBALL" "$(basename "$PACKAGE_DIR")"
SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"

echo ""
echo "============================================================"
echo " ✅ 打包完成"
echo "    安装包: $TARBALL"
echo "    SHA256: $SHA"
echo "    大小:   $(du -h "$TARBALL" | awk '{print $1}')"
echo ""
echo "    下一步：Web 管理面板 → 发布管理 → 上传安装包"
echo "            平台选 ${PLATFORM}，版本填 ${VERSION}，然后发布到 stable 通道"
echo "============================================================"
