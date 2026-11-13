# 篮球战术板

一个网页版篮球回合战术编辑器，支持浏览器离线编辑，也支持通过 Node 服务保存到 MySQL 8.0。

## LitePaaS / Docker 部署

项目已提供单容器 Docker 配置。前端、静态资源和 Node API 在同一个容器中运行，业务数据保存在 MySQL，不需要挂载本地数据卷。

### 打包源码

Windows 双击：

```powershell
.\scripts\pack-source.bat
```

或在 PowerShell 中执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\pack-source.ps1
```

上传 `dist/basketball-tactics-source_*.tar.gz` 到 LitePaaS。源码包根目录包含 `Dockerfile` 和 `paas.json`，LitePaaS 会在服务器构建并启动 `basketball-tactics` 容器。

### LitePaaS 新建应用

上传源码包后，确认环境变量：

| 变量 | 示例 | 说明 |
|---|---|---|
| `PORT` | `4173` | 容器监听端口 |
| `MYSQL_HOST` | `host.docker.internal` | ECS 上 MySQL 所在地址 |
| `MYSQL_PORT` | `3306` | 按 ECS 实际 MySQL 端口填写 |
| `MYSQL_DATABASE` | `basketball` | 应用数据库 |
| `MYSQL_USER` | `basketball` | 需要能创建数据库和表，或提前执行 `schema.sql` |
| `MYSQL_PASSWORD` | 实际密码 | 不要使用示例值 |

对外访问端口是 `4173`。首次启动会自动创建数据库和 `workspaces` 表；如果数据库账号没有建库权限，请先执行 `schema.sql` 并给账号授予对应权限。

### 日常迭代

修改代码后再次执行 `scripts\pack-source.bat`，上传新的源码包并部署。数据在 MySQL 中，重建容器不会清除战术数据。

Dockerfile 默认使用国内 DaoCloud Node 镜像和 npmmirror npm 源：

```dockerfile
ARG NODE_BASE_IMAGE=docker.m.daocloud.io/library/node:20-alpine
```

如有企业私有镜像，可在直接构建时通过 `--build-arg NODE_BASE_IMAGE=...` 替换。

## 运行

```bash
npm install
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_DATABASE=basketball MYSQL_USER=basketball MYSQL_PASSWORD='your-password' npm start
```

浏览器打开 `http://localhost:4173`。服务首次启动会自动创建 `basketball` 数据库和 `workspaces` 表（数据库用户需要有建库权限）；也可以先执行 `schema.sql`，再给应用用户只授予该表的 `SELECT`、`INSERT`、`UPDATE` 权限。MySQL 只需要允许应用服务器所在内网访问，不需要对公网开放 3306。

如果直接双击打开 `index.html`，仍可使用浏览器本地保存，但不会连接 MySQL。通过服务地址访问时，页面会优先加载数据库数据，编辑后的内容会自动同步；数据库暂时不可用时会退回本地缓存。当前默认使用一个 `default` 工作区，内网访问者共享这套战术数据。

## 使用

1. 点击“新建”创建一套空白战术，再在第 0 回合拖动红、蓝两队球员和篮球设置初始位置。
2. 点击“新增回合”，继续调整下一回合的位置。
3. 选择第 1 回合或之后的回合，在球场下方“路径”栏点击 `+` 添加转折点；切换“转折 1…终点”后拖动球员或篮球设置该位置。
4. 在“潜在机会”栏选择传球球员和接球队员，点击“添加箭头”；该虚线箭头只属于当前回合，可随时更新或移除。
5. 设置每回合用时，点击“运行”查看连续轨迹。
6. 从“导出”菜单下载微信可用的 H.264 MP4 视频，也可以选择 WebM 视频或 GIF 动图。

战术列表和回合时间线标题栏的铅笔按钮可进入编辑模式，进入后每项右侧会显示改名/删除按钮；删除操作需要再次确认。

MP4 导出优先使用浏览器原生能力；不支持时会在线加载编码组件，因此首次导出需要保持联网。建议使用最新版 Chrome、Edge 或 Safari。

“保存”会下载同时包含全场和半场战术的 JSON 文件，“打开”可恢复该文件。编辑内容也会自动保存在当前浏览器中。
