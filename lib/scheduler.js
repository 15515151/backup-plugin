import { subscribeConfig } from './config-events.js'
import { backupResult } from './format.js'

export async function createScheduledJob(cron, callback) {
  const { default: schedule } = await import('node-schedule')
  return schedule.scheduleJob(cron, callback)
}

/** 机器人与独立网页复用同一套定时任务生命周期。 */
export class BackupScheduler {
  constructor({ service, load, createJob = createScheduledJob, subscribe = subscribeConfig, log = () => {} }) {
    Object.assign(this, { service, load, createJob, subscribe, log, closed: true, revision: 0, job: null })
  }

  async start() {
    this.closed = false
    this.unsubscribe?.()
    this.unsubscribe = this.subscribe(() => this.reload())
    await this.reload()
  }

  async reload() {
    const revision = ++this.revision
    let nextJob
    try {
      const config = await this.load()
      if (this.closed || revision !== this.revision) return
      if (config.schedule.enabled) {
        nextJob = await this.createJob(config.schedule.cron, () => this.run())
        if (!nextJob) throw new Error('定时表达式没有可执行的时间，请检查 schedule.cron')
      }
      if (this.closed || revision !== this.revision) { nextJob?.cancel(); return }
      this.job?.cancel()
      this.job = nextJob
    } catch (error) {
      nextJob?.cancel()
      if (revision === this.revision) { this.job?.cancel(); this.job = null }
      this.log('error', `更新定时任务失败：${error.message}`)
      throw error
    }
  }

  stop() {
    this.closed = true
    ++this.revision
    this.unsubscribe?.()
    this.unsubscribe = null
    this.job?.cancel()
    this.job = null
  }

  async run() {
    try {
      if (this.closed) return
      const config = await this.load()
      if (this.closed || !config.schedule.enabled) return
      if (this.service.state.active) { this.log('warn', '已有任务运行，本次定时备份跳过'); return }
      const result = await this.service.backup()
      this.log(result.partial ? 'warn' : 'info', backupResult(result))
    } catch (error) { this.log('error', `定时备份失败：${error.message}`) }
  }
}
