import { ensureConfig, loadConfig } from './config.js'
import { BackupService } from './service.js'
import { backupResult, date, statusMessage } from './format.js'
import { subscribeConfig } from './config-events.js'
import { BackupScheduler, createScheduledJob } from './scheduler.js'

const HELP = [
  'restic 备份（仅机器人主人可用）',
  '#初始化备份 — 首次创建加密仓库',
  '#备份 / #立即备份 — 创建完整快照，块级增量上传',
  '#备份状态 — 配置、当前进度与最近结果',
  '#备份列表 — 最近 20 个快照',
  '#检查备份 — 仓库结构与索引检查',
  '#恢复备份 latest — 恢复最新快照到单独目录',
  '#恢复备份 <快照ID> — 恢复指定快照',
  '#取消备份 — 取消当前任务',
  '配置：plugins/backup-plugin/config.json，详见插件 README.md',
].join('\n')

// 基类注入便于测试消息权限、定时注册与热重载；入口只导出一个插件类。
export function createBackupPlugin(BasePlugin, {
  service = new BackupService(), ensure = ensureConfig, load = loadConfig,
  createJob = createScheduledJob, subscribe = subscribeConfig,
  log = (level, message) => globalThis.logger?.[level]?.(`[备份插件] ${message}`),
} = {}) {
  return class ResticBackupPlugin extends BasePlugin {
    constructor() {
      super({
        name: 'restic备份', dsc: 'restic 块级增量去重备份 / 阿里云 OSS', event: 'message', priority: 100,
        rule: [{
          reg: /^#(?:备份(?:帮助|状态|列表|检查|取消)?|立即备份|初始化备份|检查备份|取消备份|恢复备份(?:\s+\S+)?)$/,
          fnc: 'handle', permission: 'master',
        }],
        task: [],
      })
      this.scheduler = new BackupScheduler({ service, load, createJob, subscribe, log })
    }

    async onLoad() {
      const revision = this.loadRevision = (this.loadRevision ?? 0) + 1
      try {
        await ensure()
        if (revision !== this.loadRevision) return
        await this.scheduler.start()
      } catch (error) {
        log('error', error.message)
      }
    }

    get scheduledJob() { return this.scheduler.job }
    reloadSchedule() { return this.scheduler.reload() }
    onUnload() { this.loadRevision = (this.loadRevision ?? 0) + 1; this.scheduler.stop() }
    scheduledBackup() { return this.scheduler.run() }

    async handle(event) {
      // 捕获此次事件，异步备份期间框架会复用插件实例并更改 this.e。
      const e = event ?? this.e
      if (!e?.isMaster) return false
      const command = e.msg.trim()
      try {
        if (command === '#备份帮助') await e.reply(HELP)
        else if (command === '#备份状态') await e.reply(statusMessage(await service.status()))
        else if (command === '#取消备份' || command === '#备份取消') {
          await e.reply(service.cancel() ? '已请求取消当前任务，请等待进程退出。' : '当前没有正在运行的任务。')
        } else {
          if (service.state.active) { await e.reply(`当前正在执行${service.state.active.name}，请用 #备份状态 查看。`); return true }
          await e.reply('正在执行，请稍候；可发送 #备份状态 查看，#取消备份 取消。')
          if (command === '#初始化备份') {
            await service.init()
            await e.reply('备份仓库初始化完成，现在可以发送 #备份。请在仓库之外保存好 restic 密码。')
          } else if (command === '#备份' || command === '#立即备份') {
            await e.reply(backupResult(await service.backup()))
          } else if (command === '#备份列表') {
            const { snapshots } = await service.snapshots()
            await e.reply(snapshots.length ? ['最近快照：', ...snapshots.map(item => `${item.id.slice(0, 8)}  ${date(item.time)}`)].join('\n') : '当前快照范围内没有备份。')
          } else if (command === '#检查备份' || command === '#备份检查') {
            await service.check()
            await e.reply('仓库结构、索引检查通过。完整数据块读取校验可在终端执行 restic check --read-data。')
          } else if (command.startsWith('#恢复备份')) {
            const { snapshotId, target } = await service.restore(command.split(/\s+/)[1] || 'latest')
            await e.reply(`恢复并校验完成：${snapshotId}\n目录：${target}\n请检查文件，停机后按需拷回机器人目录。`)
          }
        }
      } catch (error) { await e.reply(`备份插件：${error.message}`) }
      return true
    }
  }
}
