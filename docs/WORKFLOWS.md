# Camera Local Console Workflows

本文档定义本项目的主要操作流程：服务器部署、版本发布、Windows 客户端安装与更新、版本撤回/覆盖/删除、以及异常恢复。

## 角色与组件

```text
3000 local console
- Windows 客户端主控制台
- 保存 data/config.json
- 自动拉起本地采集器
- 检查更新并启动 3219 更新进度页

3100 local collector
- 本地采集器
- 由 3000 管理启动
- 接收 3000 下发的摄像头快照
- 负责 Hikvision SDK 登录、心跳和事件回传

3200 release-admin
- 服务器端版本发布管理台
- 上传安装包
- 生成 manifest 和 SHA256
- 发布/撤回 stable、beta、canary 通道

3219 update-runner
- Windows 本机更新进度页
- 使用 .update/updater-runtime/node.exe 独立运行
- 停止 3000/3100，覆盖新版，启动新版
```

## 服务器部署 release-admin

服务器已有自编译 Nginx，路径类似：

```text
/usr/local/nginx/sbin/nginx
/usr/local/nginx/conf/nginx.conf
```

检查 Nginx：

```bash
ps -ef | grep nginx | grep -v grep
/usr/local/nginx/sbin/nginx -t -c /usr/local/nginx/conf/nginx.conf
ss -lntp | grep -E ':80|:443|:3200'
```

启动 release-admin：

```bash
cd /project/camera-local-console
cp .env.release.example .env.release
vi .env.release
docker compose --env-file .env.release -f docker-compose.release.yml up -d --build
```

如果当前 Docker CLI 实际是 Podman，会看到：

```text
Emulate Docker CLI using podman
```

这是可以接受的，只要 `podman-compose` 可用即可。

推荐 `.env.release`：

```text
RELEASE_ADMIN_HOST=0.0.0.0
RELEASE_ADMIN_PORT=3200
RELEASE_BASE_URL=https://www.fenqunshuju.com/releases/camera-local-console
RELEASE_ADMIN_USER=admin
RELEASE_ADMIN_PASSWORD=<change-me>
```

Docker 部署时，宿主机目录 `./release/out` 会挂载到容器内 `/app/release/out`。不要在 `.env.release` 里额外改 `RELEASE_ROOT`，除非同步修改 compose volume。

Nginx 应把公网路径转发到本机 3200：

```nginx
location /releases/camera-local-console/ {
    proxy_pass http://127.0.0.1:3200/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

重载 Nginx：

```bash
/usr/local/nginx/sbin/nginx -t -c /usr/local/nginx/conf/nginx.conf
/usr/local/nginx/sbin/nginx -s reload
```

访问入口：

```text
用户下载页:
https://www.fenqunshuju.com/releases/camera-local-console/

发布管理台:
https://www.fenqunshuju.com/releases/camera-local-console/admin

客户端更新清单:
https://www.fenqunshuju.com/releases/camera-local-console/channels/stable.json
```

## Windows 打包

在 Windows 机器上构建安装包。建议先确认项目代码是最新：

```powershell
git pull
```

构建 zip：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/package-windows.ps1 -Version 0.1.1
```

输出位置：

```text
release/out/packages/win-x64/camera-local-console-win-x64-0.1.1.zip
```

安装包结构：

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

## 发布新版本

进入 release-admin：

```text
https://www.fenqunshuju.com/releases/camera-local-console/admin
```

上传流程：

1. 选择 Windows zip 安装包。
2. 填写版本号，例如 `0.1.1`。
3. 平台选择 `Windows x64`。
4. 填写更新说明。
5. 点击“上传并生成清单”。
6. 确认 SHA256 和包信息。
7. 先发布到 `canary`。
8. 测试通过后再发布到 `beta` 或 `stable`。

推荐通道流：

```text
canary -> beta -> stable
```

发布到通道只会更新：

```text
release/out/channels/<channel>.json
```

不会重新上传安装包。

## 版本撤回、覆盖、删除规则

### 撤回

用于快速止损。

效果：

- 删除对应通道 JSON。
- 客户端检查更新不再看到该通道版本。
- 安装包文件保留。
- manifest 保留。
- registry 和历史记录保留。

操作：

```text
release-admin -> 发布通道 -> 撤回通道
```

### 覆盖同版本

允许场景：

```text
同 version + platform 未发布
同 version + platform 已撤回
```

禁止场景：

```text
同 version + platform 正在 stable/beta/canary 任一通道发布
```

如果版本正在发布，必须先撤回，再覆盖。

覆盖行为：

- 先复制到临时文件。
- 计算新 SHA256。
- 成功后原子替换目标安装包。
- 覆盖 manifest。
- registry 记录 `overwrittenAt` 和 `previousSha256`。
- 发布历史记录 `overwrite`。

这样保证：**对线上可见的同一个版本，不会在发布中悄悄改变内容。**

### 删除

删除只允许未发布或已撤回的包。

效果：

- 删除 package 文件。
- 删除 manifest。
- 从 registry 移除。
- 发布历史记录 `delete`。

如果包仍在某个通道中，删除会被拒绝，需要先撤回。

## Windows 客户端首次安装

客户访问：

```text
https://www.fenqunshuju.com/releases/camera-local-console/
```

首次安装：

1. 下载 Windows zip。
2. 解压到目标目录。
3. 运行：

```bat
start-all.cmd
```

默认端口：

```text
3000 local console
3100 local collector
```

如果端口冲突，编辑：

```text
config\ports.env
```

示例：

```text
PORT=3000
COLLECTOR_PORT=3100
```

## Windows 客户端自启动与自恢复

启用自启动与自恢复：

```bat
enable-autostart.cmd
```

取消自启动与自恢复：

```bat
disable-autostart.cmd
```

启用后会注册 Windows 计划任务：

```text
CameraLocalConsoleWatchdog
```

任务行为：

```text
1. Windows 用户登录时执行一次
2. 每 1 分钟执行一次健康检查
3. 检查 http://127.0.0.1:PORT/api/state
4. 如果 3000 控制台不可访问，自动后台运行 start-all.cmd /background /no-browser
```

因此它不仅能处理电脑重启后的自动启动，也能处理 3000 进程意外退出后的自动恢复。

首次现场调试可以直接双击 `start-all.cmd`，保留终端窗口方便看错误；启用计划任务后，自恢复启动会隐藏终端窗口，降低客户误关风险。

## Windows 本机更新

在 3000 控制台中：

```text
版本更新 -> 检查更新 -> 选择版本 -> 更新到此版本
```

更新流程：

1. 3000 创建 `.update/updater-runtime/node.exe`。
2. 3000 使用独立 Node 启动 3219 更新进度页。
3. 浏览器跳转到：

```text
http://127.0.0.1:3219/
```

4. 3219 下载 package。
5. 校验 SHA256。
6. 解压 package。
7. 停止 3000/3100。
8. 备份旧版本到 `.backup-YYYYMMDDHHMMSS`。
9. 覆盖新版文件。
10. 保留本地目录：

```text
data/
config/
logs/
.update/
```

11. 启动新版 3000。
12. 检查新版健康状态。
13. 成功后新版 3000 延迟清理 `.update/`。

注意：

- 3219 使用 `.update/updater-runtime/node.exe`，不占用主 `runtime/node/node.exe`。
- 因此主 `runtime/` 可以被新版覆盖。
- 关闭浏览器不会终止更新。

## 更新失败与回滚

更新失败分两类。

### 覆盖前失败

例如：

```text
manifest 读取失败
下载失败
SHA256 不匹配
zip 解压失败
```

结果：

- 旧版本未被覆盖。
- 不需要回滚。
- 3219 页面显示失败原因。

### 覆盖后失败

例如：

```text
新版启动失败
新版 60 秒内健康检查失败
```

结果：

- 自动从 `.backup-*` 恢复旧版本。
- 尝试启动旧版本。
- 3219 页面显示“已回滚到旧版本”。

## 中断恢复

如果更新过程中断电、脚本被杀、机器重启：

1. 用户再次运行：

```bat
start-all.cmd
```

2. `start-all.cmd` 会先运行：

```bat
recovery-check.ps1
```

3. 如果 `.update/update-state.json` 显示处于中间状态，会自动恢复备份。

恢复时保留：

```text
data/
config/
logs/
runtime/
```

这里保留 `runtime/` 是因为恢复检查本身发生在启动阶段，不能删除当前启动脚本正在使用的运行时。

## 手动停止与收尾

正常停止：

```bat
stop-all.cmd
```

新版 `stop-all.cmd` 会调用：

```bat
stop-all.ps1
```

停止逻辑：

- 读取 `config\ports.env`
- 找到 `PORT` 和 `COLLECTOR_PORT` 对应监听 PID
- 停止对应进程树
- 使用窗口标题作为兜底

如果旧版本 `stop-all.cmd` 失效，可手动执行：

```bat
taskkill /IM node.exe /F
```

然后重新启动：

```bat
start-all.cmd
```

## 摄像头注册与状态同步

核心规则：

- 3000 是有状态控制台。
- 3100 是无状态本地采集器。
- 摄像头唯一标识使用归一化 MAC：

```text
08:CC:81:C4:79:9E -> 08cc81c4799e
```

3000 保存：

```text
data/config.json
```

3100 不保存长期配置，只接收 3000 下发的 runtime snapshot。

注册流程：

1. 扫描摄像头。
2. 使用 MAC 生成 `deviceIndexCode`。
3. 保存到 `data/config.json`。
4. 3000 下发 snapshot 到 3100。
5. 3100 启动 Hikvision worker。
6. worker 登录成功后回传心跳。
7. 3000 页面显示在线。

如果网络或摄像头未就绪：

- 3100 会按退避策略重试。
- 配置存在但摄像头暂时不可达，不会丢失配置。

## 服务器更新 release-admin

服务器拉取代码：

```bash
cd /project/camera-local-console
git pull
```

重建并启动：

```bash
docker compose --env-file .env.release -f docker-compose.release.yml up -d --build
```

查看状态：

```bash
docker ps
docker logs camera-release-admin --tail 100
```

如果实际使用 Podman：

```bash
podman ps
podman logs camera-release-admin --tail 100
```

重新部署 release-admin 不会清空版本数据，因为安装包和清单都挂载在宿主机：

```text
/project/camera-local-console/release/out
```

## 推荐发布检查清单

发布前：

- Windows 包能解压。
- `start-all.cmd` 能启动 3000。
- 3000 能自动拉起 3100。
- 摄像头注册后能显示 MAC index。
- 检查更新能看到目标通道版本。

发布时：

- 先发 canary。
- Windows 测试机更新成功。
- 验证 `data/config.json` 保留。
- 验证摄像头配置保留。
- 验证 3000/3100 重启后自动恢复工作。
- 再发布 beta/stable。

发现问题：

- 立即撤回通道。
- 如果需要复用同版本，先撤回，再覆盖上传。
- 覆盖后重新发布到 canary 验证。
