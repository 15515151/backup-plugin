# JiuLi restic 备份插件

备份整个 JiuLi 机器人目录，使用 [restic](https://github.com/restic/restic) 的加密仓库和内容定义分块去重。支持阿里云 OSS 直连和本地仓库，Node.js ≥ 20。

- **块级增量去重**：直接执行 `restic backup`，大文件修改后只存储未重复的数据块，不预先打包成 zip。
- **逻辑全量、物理增量**：每次生成包含全部未排除文件的快照，未改变的数据引用仓库已有块；任意快照都能还原当时的完整文件树。
- **阿里 OSS**：使用 restic 内置 S3 后端，自动加上 `s3.bucket-lookup=dns` 和 `s3.region=oss-区域`，不需要 rclone。
- 主人命令、定时任务、实时进度、取消/超时、错误脱敏、不完整备份提示，以及恢复后的内容校验。

“快照可独立恢复”是指不需要逐个回放历史增量包；快照仍依赖仓库中引用的数据块，不能手工删除仓库的 `data`、`index` 等对象。

## 默认排除

```text
node_modules
logs
temp
data/upload_tmp
data/memes
```

按 restic 路径组件规则匹配：`node_modules`、`logs`、`temp` 在任意层级排除，`data/upload_tmp` 和 `data/memes` 匹配连续的目录组件。插件自己的 `.runtime` 目录也排除，其中存放 restic 缓存、恢复文件、工具与任务状态。额外排除项填入 `extraExcludes`；默认项始终生效，不支持使用 `!` 反选。

机器人模式的备份源固定为插件所在的 JiuLi 根目录，例如此安装为 `D:\jiuli`，与启动命令所在目录无关。独立网页模式可用 `BACKUP_SOURCE_DIR` 指定任意备份源。配置中的相对文件路径以插件目录为基准。

## 独立网页模式（无需 Yunzai / JiuLi / Guoba）

在本项目目录运行，安装 Node.js ≥ 20 和 restic 即可：

```powershell
pnpm install
pnpm start
```

打开 <http://127.0.0.1:5212>。首次启动会在终端显示随机生成的**面板登录密码**，请保存后用它登录。它与 restic 仓库密码相互独立。后续启动沿用该密码；浏览器登录有效期为 8 小时，退出登录或服务重启后会话失效。

网页共用现有 `webadapter/` 页面与 `config.json`，支持配置仓库、连接测试、定时备份、实时进度、文件浏览、下载，以及以下操作：

- **初始化仓库**：使用已保存的配置创建仓库，已有仓库不会覆盖。
- **立即备份 / 检查仓库**：后台执行，页面持续显示进度；关闭页面不停止任务。
- **恢复快照**：输入 `latest` 或快照 ID，恢复并校验到新的 `.runtime/restores/` 目录，完成后显示路径。
- **取消当前任务**：请求 restic 停止；退出登录不会取消任务，关闭服务会取消当前任务和定时计划。

先保存配置，再执行操作。备份源显示在页面顶部：项目位于 `plugins/backup-plugin` 时默认使用机器人根目录；单独克隆到其他位置时默认使用项目目录。可以通过环境变量指定：

```powershell
$env:BACKUP_SOURCE_DIR = 'D:/my-data'
$env:BACKUP_WEB_PORT = '5212'
# 可选：自行设置或重置登录密码，12～256 位；不填则首次自动生成。
$env:BACKUP_WEB_PASSWORD = 'replace-with-your-own-strong-password'
pnpm start
```

Linux 示例：

```bash
pnpm install
BACKUP_SOURCE_DIR=/srv/my-data pnpm start
```

| 环境变量 | 默认值 / 用途 |
|---|---|
| `BACKUP_SOURCE_DIR` | 如上所述；必须是已存在的目录，启动时确定 |
| `BACKUP_WEB_HOST` | `127.0.0.1`，监听地址；允许局域网访问时可设 `0.0.0.0` |
| `BACKUP_WEB_PORT` | `5212` |
| `BACKUP_WEB_ORIGIN` | 对外访问的完整站点地址，例如 `https://backup.example.com` 或 `http://192.168.1.10:5212`，不含路径 |
| `BACKUP_WEB_PASSWORD` | 可选；设置后每次启动重设登录密码，移除此环境变量后仍保留最后设置的密码 |

远程访问时同时设置 `BACKUP_WEB_ORIGIN`。HTTPS 反向代理应保留原始 `Host`（Nginx 示例：`proxy_set_header Host $http_host;`），并在独立服务设置相同的 HTTPS Origin；服务据此使用 Secure Cookie，不信任客户端提交的 `X-Forwarded-*` 头。当前独立页面部署在站点根路径，不支持子路径挂载。公网访问使用 HTTPS，避免明文传送密码与备份文件。

密码以随机盐 + scrypt 摘要保存在 `.runtime/web-auth.json`，不会通过配置 API 回显；丢失密码可设置 `BACKUP_WEB_PASSWORD` 后重启。服务使用 HttpOnly / SameSite Cookie、写请求 CSRF 校验与登录限流；附件下载也必须携带有效 Cookie，不接受 Guoba token 或 URL 中的 token。

Guoba 模式仍通过 `ctx.registerApi` 交给宿主鉴权，继续支持 `guoba-access-token` 请求头和附件 query token，不会出现独立登录页或自动监听额外端口。`jiuli` 现在是可选 peer，独立安装不会拉取机器人框架；机器人入口仍支持从 JiuLi 宿主解析框架。

独立服务启动时加载定时计划，在网页保存后立即更新；手动改 `config.json` 后需重启独立服务。网页与同进程的定时任务共用任务锁和实时状态。独立网页与机器人、CLI 是不同进程，不共享实时状态；同一份配置建议只由一个常驻进程执行定时备份，避免重复触发。

## 开始使用

1. 插件放在 `JiuLi/plugins/backup-plugin/`。在 JiuLi 根目录运行 `pnpm install`，安装插件依赖。全新框架还需要按框架说明执行 `pnpm build`。
2. 从 [restic Releases](https://github.com/restic/restic/releases) 安装适合系统的 restic，建议使用 **0.19.1 或更新版本**，网页下载需要支持 `dump --target`。本次已在 Windows 上下载并通过官方 SHA256 校验 **0.19.1**，位于 `.runtime/tools/restic_0.19.1_windows_amd64.exe`，生成的 `config.json` 已指向它。此文件不进 Git；重新克隆或迁移到 Linux 时需要重新安装。
3. 编辑 `config.json`。首次加载插件会从 `config.example.json` 创建该文件；也可以手动复制。填写仓库密码、OSS Bucket、AccessKey 和地域。
4. 启动机器人或发送 `#重载 backup-plugin`。主人发送 `#初始化备份`，成功后发送 `#备份`。

`config.json` 是严格 JSON，不能写注释或尾随逗号。没有配置凭据时只提供帮助和配置状态，不会自动初始化或上传。

### 阿里 OSS 配置

在已创建的 Bucket 中选择专用前缀，例如 `jiuli`，将以下字段填入配置，其余字段保留默认值：

```json
{
  "backend": "oss",
  "password": "请换成独立的强仓库密码",
  "oss": {
    "endpoint": "https://oss-cn-hangzhou.aliyuncs.com",
    "region": "oss-cn-hangzhou",
    "bucket": "你的-bucket-名称",
    "prefix": "jiuli",
    "accessKeyId": "你的 AccessKey ID",
    "accessKeySecret": "你的 AccessKey Secret",
    "sessionToken": ""
  }
}
```

上面的配置是字段示例；不要覆盖已有 `resticPath`。Endpoint 填地域地址，**不带 Bucket 名**。例如杭州对应 `oss-cn-hangzhou.aliyuncs.com` / `oss-cn-hangzhou`。实际仓库地址为 `s3:https://oss-cn-hangzhou.aliyuncs.com/<bucket>/jiuli`。使用内网 Endpoint 时，运行机器需要能访问该内网地址。配置方式来自 [restic 官方 OSS 文档](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html#alibaba-cloud-aliyun-object-storage-system-oss)。

仓库所用凭据需要列举 Bucket、读写前缀内对象和删除锁对象的权限（通常涉及 `oss:ListObjects`、`oss:GetObject`、`oss:PutObject`、`oss:DeleteObject`，大对象传输还需相应分片上传权限）。不要给 restic 前缀设置会独立过期或转为不可立即读取状态的 OSS 生命周期规则。

也可以把凭据放进启动机器人的环境变量：

| 环境变量 | 对应配置 |
|---|---|
| `RESTIC_PASSWORD` | 仓库密码 |
| `RESTIC_PASSWORD_FILE` | 保存仓库密码的文本文件 |
| `AWS_ACCESS_KEY_ID` | OSS AccessKey ID |
| `AWS_SECRET_ACCESS_KEY` | OSS AccessKey Secret |
| `AWS_SESSION_TOKEN` | 可选，临时凭据 Token |

密码优先级：`RESTIC_PASSWORD_FILE` → `RESTIC_PASSWORD` → `passwordFile` → `password`。AccessKey 和 Token 的非空环境变量优先于配置字段。环境变量必须传给机器人实际运行进程；在另一个终端设置不会改变已启动的机器人。插件不读取 `.env` 文件。

密码只通过子进程环境传入，不拼接进命令行。**在备份仓库之外妥善保留仓库密码**；仓库密码不是 OSS AccessKey，丢失后无法解密。`config.json` 不入 Git，但随其他源文件进入加密快照。

### 本地仓库

```json
{
  "backend": "local",
  "localRepository": "D:/jiuli-backups/restic-repo",
  "password": "请换成独立的强仓库密码"
}
```

本地仓库必须放在机器人目录之外。插件会拒绝源目录与仓库相互包含的配置，避免把仓库再次备份进仓库。

## 命令

所有聊天命令均限定机器人主人。

| 命令 | 功能 |
|---|---|
| `#备份帮助` | 显示命令 |
| `#初始化备份` | 首次创建加密仓库；已有仓库会明确报错，不覆盖 |
| `#备份` / `#立即备份` | 创建快照 |
| `#备份状态` | 显示配置、当前任务进度、最近任务结果，不主动连接远程仓库 |
| `#备份列表` | 当前 hostname / snapshotTag 的最近 20 个快照 |
| `#检查备份` / `#备份检查` | 检查整个仓库的结构与索引 |
| `#恢复备份 latest` | 恢复当前范围内最新快照 |
| `#恢复备份 <ID>` | 使用完整 ID 或至少 8 位唯一前缀恢复 |
| `#取消备份` / `#备份取消` | 取消当前备份、恢复或检查任务 |

每个机器人进程串行执行这些任务；状态查询和取消不受限制。插件热重载期间也会保留任务锁。仓库级的进程间互斥由 restic 自己管理，不会自动删除仓库锁。

restic 退出码 `3` 表示部分文件无法读取：插件将其标记为**不完整**，即使生成了快照也不会报成完整成功。定时任务结果写入机器人日志，最近任务状态保存在 `.runtime/last-result.json`。

## 锅巴面板

已提供与 Gscore-Adapter 相同的两种入口，共用现有 `config.json`，无需创建额外配置文件：

- **插件配置**：`guoba.support.js` 注册「restic 备份」，支持 restic 路径、OSS / 本地仓库、密码、定时、快照标签、限速和额外排除项。
- **扩展页面**：`webadapter/` 注册「restic 备份」独立页面，分为「存储仓库」「阿里云 OSS」「备份策略」「备份文件」，支持手机布局并跟随锅巴深浅主题。

更新后先在机器人根目录执行 `pnpm install`，再重载备份插件。进入锅巴的插件配置列表刷新；扩展页面没有出现时，在「扩展页面」中点击「重新扫描」。扩展页面需要支持 `webadapter` 的锅巴版本；较旧的锅巴仍可使用标准插件配置表单。网页支持配置、初始化、备份、恢复、检查、取消、浏览和下载，主人命令与 CLI 也继续可用。

保存前会检查字段类型、cron、OSS 地址、仓库目录和排除规则；无效输入不会覆盖原配置。保存配置不会连接或初始化 OSS 仓库。保存成功后，已加载插件会自动更新定时任务，正在运行的备份继续使用启动时的配置。若锅巴与机器人运行在不同进程，保存提示会要求启动或重载备份插件。

扩展页面提供两个测试按钮，使用当前表单输入，无需先保存，也不会更改配置或定时任务：

- **存储仓库 → 测试 restic**：在面板服务器执行 `restic version`，显示版本号，检查路径和执行权限。无需填写仓库密码或 OSS 凭据。
- **阿里云 OSS → 测试 OSS 连接**：通过 S3 签名请求列举配置前缀下最多一个对象，验证网络、凭据和 `oss:ListObjects` 权限。支持官方 HTTPS 地域 Endpoint（含内网 Endpoint）、AccessKey 和 STS；沿用非空环境变量优先的规则。空 Bucket 或未初始化的仓库也可测试，不依赖 restic 安装，不创建、上传或删除对象，不返回对象列表。

每项检测超时为 10 秒，同时只运行一项。OSS 测试通过仅代表连接和列举权限正常，**不代表对象读写、删除权限或仓库密码已验证**；这些仍由初始化、备份及检查命令验证。测试发生在锅巴所在进程，若锅巴与机器人部署在不同环境，请同时检查机器人进程的 PATH、凭据和网络。

密码、AccessKey 和 Token 回显为 `********` 占位符。保持占位符不变会保留原值，输入新值会替换，清空后保存会删除配置中的该项。环境变量仍然优先，面板不会读取或显示环境变量中的凭据。`resticPath` 等相对路径和留空的主机名会保持原样，不会被面板转换成本机绝对路径。默认五类排除项始终保留，只能增加额外排除项。

Guoba 中的扩展页面通过 `ctx.registerPage` / `ctx.registerApi` 接入，复用宿主的登录鉴权，不额外开放 HTTP 端口。单独运行 `pnpm start` 则启用上文的独立服务和密码登录。

### 查看正在执行的任务

网页顶部的 **当前任务** 区域会读取插件现有任务状态，包括聊天命令、定时计划和网页启动的备份、恢复、检查、文件浏览及下载准备。打开网页时已经运行的任务也能看到，切换配置分组不会停止刷新。任务运行时每 2 秒刷新，空闲时每 5 秒刷新，浏览器后台页面降低到每 15 秒；也可点击“刷新状态”。

备份和恢复显示 restic 提供的完成比例、已处理文件数、已处理数据量及预计剩余时间，同时显示当前阶段和总耗时。初始化、读取快照、检查等没有数值进度的阶段显示“执行中”；restic 未提供剩余时间时显示“待估算”。处理的数据量是文件处理进度，不是 OSS 实际新增存储量。结束后展示最近任务的成功、不完整、失败或取消结果，以及快照 ID 或已脱敏的错误信息。

状态查询是只读操作，不启动 restic、不访问 OSS，也不占用备份任务锁；即使配置被改坏，仍可查看正在执行的任务。刷新失败会标记旧数据并自动重试。实时状态在同一机器人进程内共享，支持插件热重载；另一进程运行的 `cli.js`、手动 restic 命令或独立部署的锅巴服务不共享实时任务。更新后重载备份插件，并在锅巴扩展页面重新扫描、刷新即可使用。

### 浏览与下载备份文件

1. 在扩展页面打开 **备份文件**。列表按备份时间倒序，显示快照 ID、主机、文件数和原始大小，支持翻页。使用**已保存的配置**，只列出当前 `hostname` 和 `snapshotTag` 对应的快照；更换服务器后找不到快照时，先填回原主机名和标签。
2. 点击 **浏览文件**，进入快照根目录。点击目录名称逐层打开，顶部路径可以返回上级目录；列表显示文件大小和修改时间。路径以快照列表为准，本插件从 `.` 备份的快照通常直接从机器人文件开始。
3. 点击文件旁的 **下载**，或选择 **下载 ZIP**、**下载当前文件夹 ZIP**、**下载整份快照 ZIP**。下方下载任务会显示准备状态及已生成大小，支持取消。
4. 状态变成“已就绪”后，点击 **下载到本机**。单个普通文件保持原始字节内容；文件夹和整份快照使用 restic 原生 `dump --archive zip` 导出，保留快照内的相对目录结构。空目录也可以导出。符号链接及特殊文件不单独导出，可随其上级目录打包；解压后对链接和特殊文件的支持取决于本机系统及解压工具。

下载准备发生在锅巴服务器，使用 `.runtime/downloads/` 暂存解密后的导出文件，需要有容纳该文件或 ZIP 的剩余磁盘空间。准备成功才开放附件下载；失败或取消时删除不完整的临时文件。网页、聊天命令和定时任务在同一进程中共用任务锁，正在备份或恢复时请稍后再浏览或准备下载。

每个插件最多保留 3 个下载任务。准备结束 30 分钟后自动清理缓存，也可手动点击“清理”；正在传输的附件会在传输结束后清理。插件热重载保留任务；进程重启后需要重新准备下载，下一次访问下载列表会清理已退出进程留下的缓存。缓存目录已排除在备份之外，导出不会覆盖机器人文件。

附件使用所在模式的登录鉴权，以浏览器原生下载方式流式传输，支持 HTTP Range，不将整份备份加载到网页内存。Guoba 使用当前登录令牌，独立模式使用 Cookie 会话；退出登录或登录过期后需要重新登录。列举和浏览每个 restic 子命令最多运行 1 分钟；导出遵循配置中的 `timeoutMinutes` 和下载限速。

## 定时备份和可选项

```json
"schedule": {
  "enabled": true,
  "cron": "0 0 4 * * *"
}
```

上例为每天凌晨 04:00，使用机器人进程的系统时区（本机为 Asia/Shanghai）。默认关闭。在面板保存会自动更新定时任务；手动编辑文件后需发送 `#重载 backup-plugin`。其他配置在下一次操作时读取。定时任务通过 `node-schedule` 注册，插件卸载或重载会取消旧任务，避免重复执行。支持 5 或 6 段数字 cron，包含 `*`、范围、逗号和 `/` 步长；不支持月份名称或 `L`、`W` 等扩展语法。

| 配置项 | 默认值 / 含义 |
|---|---|
| `resticPath` | `restic`，或可执行文件绝对路径 / 相对插件目录的路径，不接受 shell 命令 |
| `passwordFile` | 空；可指定单行密码文件 |
| `snapshotTag` | `jiuli-backup`；同一仓库备份多个机器人时，各机器人使用不同标签 |
| `hostname` | 空则使用当前机器名；迁移恢复时可填原机器名 |
| `extraExcludes` | `[]`，例如 `[".git", "*.bak"]` |
| `timeoutMinutes` | `120`，每个 restic 子命令的超时分钟数 |
| `limitUploadKiB` / `limitDownloadKiB` | `0` 不限速，否则为 KiB/s |

备份直接读取磁盘文件。需要 SQLite 等数据库的事务一致性时，应在备份前停写/停机，或先导出一致性副本；Redis 等外部服务的内存数据需要单独导出。被排除的 `node_modules` 可在恢复后通过 `pnpm install` 重建。

## 恢复与终端使用

恢复会创建全新的 `.runtime/restores/<快照ID前缀>-<随机后缀>/`，并执行 `restic restore --verify`。不会自动覆盖正在运行的机器人。检查恢复目录后，停机并按需拷回文件；目录层级以 restic 恢复结果为准。失败或取消产生的部分恢复文件会保留，消息中会给出路径。确认不需要后可手动删除这些恢复目录。

机器人无法启动时，也可以直接从插件目录运行无额外 npm 依赖的 CLI：

```powershell
node cli.js status
node cli.js init
node cli.js backup
node cli.js snapshots
node cli.js check
node cli.js restore latest
```

CLI 使用同一份配置和排除规则，Ctrl+C 可取消。退出码 `0` 为成功，`1` 为失败，`2` 为不完整备份。初始化只需执行一次。迁移机器后，设置原先的 `hostname` 和 `snapshotTag` 才能通过插件筛选到历史快照；也可直接用 restic CLI 查询整个仓库。

普通 `check` 检查结构与索引，不下载全部数据块；需要全面读取校验时，在设置相同仓库地址、密码和 OSS 参数的终端运行 `restic check --read-data`。插件不会自动删除历史快照；要回收空间，应在确认保留策略后使用 restic 官方的 `forget` / `prune`。

## 测试

```powershell
node --test test/*.test.js
$env:TEST_RESTIC_PATH = (Resolve-Path .runtime/tools/restic_0.19.1_windows_amd64.exe).Path
node --test test/*.test.js
```

第一种运行配置、消息权限、任务互斥、子进程取消/超时等测试；设置 `TEST_RESTIC_PATH` 后还执行真实仓库测试：排除目录、重复备份不新增内容块、大文件局部修改去重、完整快照、历史文件恢复，以及 `check --read-data`。测试数据只写入隔离临时目录并在结束时清理，不访问配置中的实际 OSS 仓库。

真实仓库测试还覆盖网页文件浏览、二进制文件导出、中文和特殊字符目录 ZIP、空目录及整份快照 ZIP 的解压内容。若需要运行网页 DOM 交互测试，可在隔离工具目录安装 `jsdom`，将 `TEST_JSDOM_PATH` 设置为该 `jsdom` 包的绝对路径后运行测试；插件运行本身不依赖 jsdom。

独立网页测试覆盖未登录接口拦截、密码摘要持久化、登录限流、会话过期与注销、CSRF / Origin / Host 校验、任务互斥与取消、定时更新。设置 `TEST_RESTIC_PATH` 后还执行通过 HTTP 登录、初始化、备份、浏览、Range 下载、恢复及检查的完整流程。可选设置 `TEST_GUOBA_PATH` 为本机 Guoba 插件目录，验证实际的扩展页面注册、引导脚本注入与 API 路由兼容。
