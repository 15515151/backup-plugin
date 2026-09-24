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

备份源固定为插件所在的 JiuLi 根目录，例如此安装为 `D:\jiuli`，与启动命令所在目录无关。配置中的相对文件路径以插件目录为基准。

## 开始使用

1. 插件放在 `JiuLi/plugins/backup-plugin/`。在 JiuLi 根目录运行 `pnpm install`，建立插件声明的 `jiuli` 框架链接。全新框架还需要按框架说明执行 `pnpm build`。
2. 从 [restic Releases](https://github.com/restic/restic/releases) 安装适合系统的 restic，建议使用 0.17 或更新版本。本次已在 Windows 上下载并通过官方 SHA256 校验 **0.19.1**，位于 `.runtime/tools/restic_0.19.1_windows_amd64.exe`，生成的 `config.json` 已指向它。此文件不进 Git；重新克隆或迁移到 Linux 时需要重新安装。
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
- **扩展页面**：`webadapter/` 注册「restic 备份」独立页面，分为「存储仓库」「阿里云 OSS」「备份策略」，支持手机布局并跟随锅巴深浅主题。

更新后先在机器人根目录执行 `pnpm install`，再重载备份插件。进入锅巴的插件配置列表刷新；扩展页面没有出现时，在「扩展页面」中点击「重新扫描」。独立页面需要支持 `webadapter` 的锅巴版本（参考插件所使用的版本）；较旧的锅巴仍可使用标准插件配置表单。面板负责配置管理，备份、初始化和恢复仍使用主人命令或 CLI。

保存前会检查字段类型、cron、OSS 地址、仓库目录和排除规则；无效输入不会覆盖原配置。保存配置不会连接或初始化 OSS 仓库。保存成功后，已加载插件会自动更新定时任务，正在运行的备份继续使用启动时的配置。若锅巴与机器人运行在不同进程，保存提示会要求启动或重载备份插件。

扩展页面提供两个测试按钮，使用当前表单输入，无需先保存，也不会更改配置或定时任务：

- **存储仓库 → 测试 restic**：在面板服务器执行 `restic version`，显示版本号，检查路径和执行权限。无需填写仓库密码或 OSS 凭据。
- **阿里云 OSS → 测试 OSS 连接**：通过 S3 签名请求列举配置前缀下最多一个对象，验证网络、凭据和 `oss:ListObjects` 权限。支持官方 HTTPS 地域 Endpoint（含内网 Endpoint）、AccessKey 和 STS；沿用非空环境变量优先的规则。空 Bucket 或未初始化的仓库也可测试，不依赖 restic 安装，不创建、上传或删除对象，不返回对象列表。

每项检测超时为 10 秒，同时只运行一项。OSS 测试通过仅代表连接和列举权限正常，**不代表对象读写、删除权限或仓库密码已验证**；这些仍由初始化、备份及检查命令验证。测试发生在锅巴所在进程，若锅巴与机器人部署在不同环境，请同时检查机器人进程的 PATH、凭据和网络。

密码、AccessKey 和 Token 回显为 `********` 占位符。保持占位符不变会保留原值，输入新值会替换，清空后保存会删除配置中的该项。环境变量仍然优先，面板不会读取或显示环境变量中的凭据。`resticPath` 等相对路径和留空的主机名会保持原样，不会被面板转换成本机绝对路径。默认五类排除项始终保留，只能增加额外排除项。

扩展页面通过锅巴的 `ctx.registerPage` / `ctx.registerApi` 接入，复用宿主的登录鉴权，不额外开放 HTTP 端口。

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
