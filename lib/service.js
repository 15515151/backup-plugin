import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PLUGIN_DIR, loadConfig, connection, redact } from './config.js'
import { runRestic } from './runner.js'

// JiuLi 热重载会重新求值整个模块图；运行任务仍然共享同一把锁。
const stateKey = Symbol.for('jiuli.backup-plugin.jobs.v1')
const states = globalThis[stateKey] ??= new Map()

export class BackupService {
  constructor({ pluginDir = PLUGIN_DIR, configLoader, runner = runRestic, environment = process.env } = {}) {
    this.pluginDir = path.resolve(pluginDir)
    this.configLoader = configLoader ?? (() => loadConfig({ pluginDir: this.pluginDir }))
    this.runner = runner
    this.environment = environment
    if (!states.has(this.pluginDir)) states.set(this.pluginDir, { active: null, last: null })
    this.state = states.get(this.pluginDir)
  }

  async status() {
    const config = await this.configLoader()
    let readiness = '已配置'
    try { await connection(config, this.environment) } catch (error) { readiness = error.message }
    if (!this.state.last) {
      try { this.state.last = JSON.parse(await fs.readFile(path.join(config.runtimeDir, 'last-result.json'), 'utf8')) }
      catch { /* 首次使用无历史记录 */ }
    }
    const active = this.state.active
    return {
      config, readiness, last: this.state.last,
      active: active ? { name: active.name, startedAt: active.startedAt, progress: active.progress, cancelled: active.cancelled } : null,
    }
  }

  cancel() {
    const job = this.state.active
    if (!job) return false
    job.cancelled = true
    job.stop?.()
    return true
  }

  async execute(name, operation) {
    if (this.state.active) throw new Error(`已有任务正在执行：${this.state.active.name}，可用 #备份状态 查看`)
    const job = { id: randomUUID(), name, startedAt: new Date().toISOString(), cancelled: false, progress: null }
    this.state.active = job
    let config
    let conn
    let outcome
    try {
      config = await this.configLoader()
      conn = await connection(config, this.environment)
      await fs.mkdir(config.runtimeDir, { recursive: true })
      const result = await operation(config, conn, job)
      outcome = { status: result.partial ? 'partial' : 'success', ...result }
      return result
    } catch (error) {
      // 不保留含环境变量/子进程对象的原始 Error，避免框架 debug 日志泄露凭据。
      const message = redact(error.message, conn?.secrets)
      outcome = { status: job.cancelled ? 'cancelled' : 'error', error: message }
      throw new Error(message)
    } finally {
      const record = {
        name, startedAt: job.startedAt, finishedAt: new Date().toISOString(),
        status: outcome?.status ?? 'error',
        ...(outcome?.error ? { error: outcome.error } : {}),
        ...(outcome?.snapshotId ? { snapshotId: outcome.snapshotId } : {}),
        ...(outcome?.target ? { target: outcome.target } : {}),
      }
      this.state.last = record
      try {
        if (config) {
          const target = path.join(config.runtimeDir, 'last-result.json')
          const temporary = `${target}.${job.id}.tmp`
          await fs.writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 })
          await fs.rename(temporary, target)
        }
      } catch { /* 状态文件写失败不能把已完成的备份误报为失败 */ }
      this.state.active = null
    }
  }

  scope(config) { return ['--host', config.hostname, '--tag', config.snapshotTag] }

  init() {
    return this.execute('初始化仓库', async (config, conn, job) => {
      await this.runner(config, conn, ['init', '--repository-version', '2'], job)
      return {}
    })
  }

  backup() {
    return this.execute('备份', async (config, conn, job) => {
      const args = ['backup', '--json', ...this.scope(config)]
      for (const pattern of config.excludes) args.push('--exclude', pattern)
      // 始终从机器人根目录备份同一个路径，restic 自动选父快照，保留块级去重。
      args.push('--', '.')
      const result = await this.runner(config, conn, args, job, { json: true })
      if (!result.summary?.snapshot_id) throw new Error('restic 没有返回快照 ID，无法确认备份成功，请检查仓库')
      return {
        snapshotId: result.summary.snapshot_id,
        partial: result.code === 3,
        summary: result.summary,
        warning: result.code === 3 ? result.stderr || '部分源文件无法读取，请检查权限、文件占用情况后重试' : '',
      }
    })
  }

  async readSnapshots(config, conn, job, last = null) {
    const args = ['snapshots', '--json', ...this.scope(config)]
    if (last) args.push('--latest', String(last))
    const result = await this.runner(config, conn, args, job)
    let snapshots
    try { snapshots = JSON.parse(result.stdout) }
    catch { throw new Error('restic 快照列表不是有效 JSON') }
    if (!Array.isArray(snapshots) || snapshots.some(item => !/^[0-9a-f]{64}$/.test(item.id) || !Number.isFinite(Date.parse(item.time)))) {
      throw new Error('restic 快照列表格式异常')
    }
    return snapshots.sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
  }

  snapshots() {
    return this.execute('快照列表', async (config, conn, job) => ({
      snapshots: (await this.readSnapshots(config, conn, job, 20)).slice(0, 20),
    }))
  }

  check() {
    return this.execute('仓库检查', async (config, conn, job) => {
      await this.runner(config, conn, ['check'], job)
      return {}
    })
  }

  restore(selector = 'latest') {
    if (selector !== 'latest' && !/^[0-9a-f]{8,64}$/i.test(selector)) return Promise.reject(new Error('恢复格式：#恢复备份 latest 或 #恢复备份 <至少 8 位快照 ID>'))
    return this.execute('恢复', async (config, conn, job) => {
      const snapshots = await this.readSnapshots(config, conn, job, selector === 'latest' ? 1 : null)
      const matches = selector === 'latest' ? snapshots.slice(0, 1) : snapshots.filter(item => item.id.startsWith(selector.toLowerCase()))
      if (!matches.length) throw new Error('未找到属于当前 hostname 和 snapshotTag 的快照')
      if (matches.length !== 1) throw new Error('快照 ID 前缀不唯一，请使用更长的 ID')
      const snapshotId = matches[0].id
      const restoreDir = path.join(config.runtimeDir, 'restores')
      await fs.mkdir(restoreDir, { recursive: true })
      const target = await fs.mkdtemp(path.join(restoreDir, `${snapshotId.slice(0, 8)}-`))
      try {
        await this.runner(config, conn, ['restore', snapshotId, '--target', target, '--verify'], job)
      } catch (error) {
        throw new Error(`${error.message}\n未完成的恢复文件保留在：${target}`)
      }
      return { snapshotId, target }
    })
  }
}
