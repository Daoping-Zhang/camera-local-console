# 摄像头本地控制台

这是一个用于现场部署的视频分析本地控制台。它运行在客户侧 Windows 电脑或 Linux 设备上，负责连接海康摄像头、启动本地采集器、接收客流事件，并把数据上报到 hik 数据服务。

核心链路：

```text
海康摄像头 -> 本地采集器 3100 -> 本地控制台 3000 -> hik 数据服务 -> 数据库
```

## 核心地址

| 用途 | 地址 |
| --- | --- |
| Windows 安装包下载页 | `https://www.fenqunshuju.com/releases/camera-local-console/` |
| 本地控制台 | `http://127.0.0.1:3000` |
| 本地采集器 | `http://127.0.0.1:3100` |
| 版本更新 stable 通道 | `https://www.fenqunshuju.com/releases/camera-local-console/channels/stable.json` |
| hik 数据服务 | `http://www.fenqunshuju.com` |

## 现场部署

1. 打开下载页，下载 Windows 安装包。
2. 解压到固定目录，例如 `D:\camera-local-console`。
3. 双击 `start-all.cmd`。
4. 浏览器会先打开“正在启动本地控制台”等待页。
5. 服务启动完成后，页面会自动跳转到 `http://127.0.0.1:3000`。

默认启动不显示终端窗口，日志在控制台的“运行日志”里查看。调试人员需要看终端时，可以运行：

```bat
start-all.cmd /console
```

## 摄像头注册

现场电脑和摄像头必须在同一个局域网内。进入本地控制台后：

1. 进入摄像头页面。
2. 点击“扫描添加”。
3. 确认摄像头 IP、账号、密码和 SDK 端口。
4. 点击“注册到采集器”。
5. 等待状态变为 `Running`。

默认 SDK 端口通常是：

```text
8000
```

系统使用摄像头 MAC 地址作为唯一标识，避免同一台摄像头重复注册。

## 自启动与自恢复

部署完成后，双击：

```bat
enable-autostart.cmd
```

这会注册 Windows 计划任务：

```text
CameraLocalConsoleWatchdog
```

任务行为：

```text
Windows 用户登录时自动检查
每 1 分钟检查一次本地控制台
如果 3000 不可访问，自动后台拉起 start-all.cmd /no-browser
```

取消自启动与自恢复：

```bat
disable-autostart.cmd
```

## 在线更新

在本地控制台中进入“版本更新”：

1. 点击“检查更新”。
2. 如果有新版本，点击“更新到此版本”。
3. 系统会自动下载、校验、备份、替换文件并重启。

如果当前已经是最新版本，页面会提示“已是最新版本”，不会显示更新按钮。

更新会保留：

```text
data/
logs/
config/
```

如果更新失败，系统会尝试自动回滚到上一版本。

## Windows 打包

在开发机或 Windows 打包机上执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/package-windows.ps1 -Version 0.1.1
```

只生成目录、不生成 zip：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/package-windows.ps1 -Version 0.1.1 -NoZip
```

打包产物默认在：

```text
dist/
```

安装包根目录会包含：

```text
app/
runtime/
sdk/
config/
data/
logs/
start-all.cmd
start-console.ps1
stop-all.cmd
open-console.cmd
open-starting-page.ps1
enable-autostart.cmd
disable-autostart.cmd
update.cmd
version.json
README-WINDOWS.txt
```

`version.json` 是客户端判断当前版本的依据。上传发布时，发布后台会检查安装包内的 `version.json` 是否和填写版本一致。

## 发布管理

发布管理台用于上传 Windows 安装包、生成 SHA256、发布到通道或撤回通道。

本地临时启动：

```bash
npm run release-admin
```

默认地址：

```text
http://127.0.0.1:3200
```

服务器部署后公网路径：

```text
https://www.fenqunshuju.com/releases/camera-local-console/admin
```

发布通道：

```text
stable  稳定版
beta    测试版
canary  灰度版
```

同版本同平台只允许一个安装包内容。已经发布到通道的版本，需要先撤回通道后才能覆盖或删除。

## 开发运行

安装依赖：

```bash
npm install
```

启动本地控制台：

```bash
npm run dev
```

启动本地采集器：

```bash
npm run collector-server
```

打开：

```text
http://127.0.0.1:3000
http://127.0.0.1:3100
```

运行状态保存在：

```text
data/config.json
```

该文件不会提交到 Git。新环境可参考：

```text
data/config.example.json
```

## 海康 SDK

Windows SDK 推荐放置位置：

```text
vendor/hikvision/win-x64/
  HCNetSDK.dll
  HCNetSDKCom/
```

Linux ARM64 / RK3566 SDK 推荐放置位置：

```text
/opt/hikvision-sdk/
  libhcnetsdk.so
  libHCCore.so
  libssl.so.3
  libcrypto.so.3
  HCNetSDKCom/
```

摄像头需要开启客流统计 / PDC 报警上传，否则 SDK 可以登录成功，但不会收到 `COMM_ALARM_PDC` 事件。

## Linux / RK3566 部署

Linux 设备建议使用 Docker Compose 和 host network，方便访问摄像头网段、SDK 回调和后续设备发现。

构建 ARM64 镜像：

```bash
IMAGE_REPOSITORY=registry.example.com/camera-local-console VERSION=0.1.1 bash scripts/docker/docker-build-arm64.sh --push
```

设备侧更新：

```bash
APP_VERSION=0.1.1 IMAGE_REPOSITORY=registry.example.com/camera-local-console bash scripts/docker/docker-update-rk3566.sh
```

## 常见问题

### 双击后没看到终端

这是正常行为。默认后台启动，并打开“正在启动本地控制台”等待页。需要看终端时运行：

```bat
start-all.cmd /console
```

### 扫描不到摄像头

优先检查：

```text
电脑和摄像头是否在同一局域网
摄像头是否通电
交换机和网线是否正常
Windows 防火墙是否拦截
```

### 注册后不是 Running

优先检查：

```text
摄像头账号密码是否正确
SDK 端口是否为 8000
摄像头 IP 是否可访问
本地采集器是否在线
```

### 检查更新失败

确认客户电脑能访问：

```text
https://www.fenqunshuju.com/releases/camera-local-console/
```

## 更多文档

- [工作流手册](docs/WORKFLOWS.md)
- [开发说明](docs/DEVELOPMENT.md)
- [发布目录说明](release/README.md)
- [海康 SDK 目录说明](vendor/hikvision/README.md)
