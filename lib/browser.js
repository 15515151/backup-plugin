import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BackupService } from './service.js'
import { isWithin } from './config.js'

const registries = globalThis[Symbol.for('jiuli.backup-plugin.downloads.v1')] ??= new Map()
const TTL = 30 * 60_000
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function snapshotId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('请选择列表中的完整快照 ID')
  return value
}

export function snapshotPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value)
    || (value !== '/' && value.slice(1).split('/').some(part => !part || part === '.' || part === '..'))) {
    throw new Error('快照路径无效，请从文件列表选择文件或目录')
  }
  return value
}

function pageOffset(value = 0) {
  const offset = Number(value)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('分页参数无效')
  return offset
}

function page(items, offset, limit) {
  return { items: items.slice(offset, offset + limit), total: items.length, offset, nextOffset: offset + limit < items.length ? offset + limit : null }
}

function publicSnapshot(item) {
  return {
    id: item.id, time: item.time, hostname: item.hostname || '', tags: item.tags || [], paths: item.paths || [],
    files: item.summary?.total_files_processed ?? null, bytes: item.summary?.total_bytes_processed ?? null,
  }
}

function filename(value) {
  const clean = [...value.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')].slice(0, 100).join('').replace(/[. ]+$/, '')
  return clean && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? clean : `file-${clean || 'download'}`
}

export class BackupBrowser {
  constructor({ service = new BackupService(), ttl = TTL } = {}) {
    this.service = service
    this.ttl = ttl
    this.root = path.join(service.pluginDir, '.runtime', 'downloads')
    if (!registries.has(service.pluginDir)) registries.set(service.pluginDir, { entries: new Map() })
    this.registry = registries.get(service.pluginDir)
  }

  async select(config, conn, job, id) {
    const snapshots = await this.service.readSnapshots(config, conn, job)
    const selected = snapshots.find(item => item.id === id)
    if (!selected) throw new Error('未找到属于当前 hostname 和 snapshotTag 的快照，请刷新备份列表')
    return selected
  }

  snapshots(offset = 0) {
    offset = pageOffset(offset)
    return this.service.execute('网页快照列表', async (config, conn, job) => {
      const snapshots = await this.service.readSnapshots({ ...config, timeoutMinutes: 1 }, conn, job)
      return { ...page(snapshots.map(publicSnapshot), offset, 30), hostname: config.hostname, tag: config.snapshotTag }
    })
  }

  async readDirectory(config, conn, job, id, directory) {
    const result = await this.service.runner({ ...config, timeoutMinutes: 1 }, conn, ['ls', '--json', '--', id, directory], job)
    let nodes
    try {
      nodes = result.stdout.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
        .filter(item => item.type && typeof item.path === 'string')
    } catch { throw new Error('restic 文件列表格式异常') }
    for (const node of nodes) snapshotPath(node.path)
    if (directory !== '/' && !nodes.some(node => node.path === directory && node.type === 'dir')) {
      throw new Error('目录不存在或不是可浏览的目录')
    }
    return nodes.filter(node => node.path !== directory && path.posix.dirname(node.path) === directory).map(node => ({
      name: path.posix.basename(node.path), path: node.path, type: node.type,
      size: Number.isSafeInteger(node.size) && node.size >= 0 ? node.size : null,
      mtime: node.mtime || null, downloadable: ['file', 'dir'].includes(node.type),
    })).sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name, 'zh-CN'))
  }

  files(id, directory = '/', offset = 0) {
    snapshotId(id)
    snapshotPath(directory)
    offset = pageOffset(offset)
    return this.service.execute('网页浏览文件', async (config, conn, job) => {
      await this.select({ ...config, timeoutMinutes: 1 }, conn, job, id)
      const entries = await this.readDirectory(config, conn, job, id, directory)
      return { ...page(entries, offset, 100), snapshotId: id, path: directory }
    })
  }

  view(entry) {
    return {
      id: entry.id, snapshotId: entry.snapshotId, path: entry.path, name: entry.name,
      status: entry.status, bytes: entry.bytes, createdAt: entry.createdAt,
      expiresAt: entry.expiresAt, error: entry.error || '',
    }
  }

  get(id) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('下载任务 ID 无效')
    const entry = this.registry.entries.get(id)
    if (!entry || entry.removing || (entry.expiresAt && Date.now() >= entry.expiresAt)) throw new Error('下载任务已过期或已清理，请重新准备下载')
    return entry
  }

  async status(id) {
    const entry = this.get(id)
    if (entry.status === 'preparing' && entry.directory) {
      const stat = await fs.stat(path.join(entry.directory, 'payload.part')).catch(() => null)
      // 轮询只读进度，不能在导出完成/重命名的竞态中覆盖最终文件大小。
      if (entry.status === 'preparing') return { ...this.view(entry), bytes: stat?.size ?? entry.bytes }
    }
    return this.view(entry)
  }

  async listDownloads() {
    await this.cleanup()
    const entries = [...this.registry.entries.values()].filter(entry => !entry.removing && (!entry.expiresAt || entry.expiresAt > Date.now()))
    return (await Promise.all(entries.map(entry => this.status(entry.id).catch(() => null)))).filter(Boolean)
  }

  async removeDirectory(directory) {
    // 仅清理本插件 downloads 下已知 UUID 目录，绝不接受客户端文件路径。
    if (path.dirname(directory) !== this.root || !idPattern.test(path.basename(directory)) || !isWithin(this.root, directory)) {
      throw new Error('下载缓存路径无效')
    }
    const stat = await fs.lstat(directory).catch(() => null)
    if (stat?.isDirectory() && !stat.isSymbolicLink()) await fs.rm(directory, { recursive: true, force: true })
  }

  async cleanup() {
    for (const entry of this.registry.entries.values()) {
      if (entry.status !== 'preparing' && entry.expiresAt && entry.expiresAt <= Date.now() && !entry.readers) await this.remove(entry.id, true)
    }
    // 重启后清理由已退出进程留下的明文临时文件；活跃进程的任务不受影响。
    for (const name of await fs.readdir(this.root).catch(() => [])) {
      if (!idPattern.test(name) || this.registry.entries.has(name)) continue
      const directory = path.join(this.root, name)
      const stat = await fs.lstat(directory).catch(() => null)
      if (!stat?.isDirectory() || stat.isSymbolicLink()) continue
      let owner
      try { owner = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8')) } catch { continue }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue
      try { process.kill(owner.pid, 0) } catch (error) {
        if (error.code === 'ESRCH') await this.removeDirectory(directory)
      }
    }
  }

  start(id, selectedPath = '/') {
    snapshotId(id)
    snapshotPath(selectedPath)
    if (this.service.state.active || [...this.registry.entries.values()].some(entry => entry.status === 'preparing')) {
      throw new Error('已有备份或下载准备任务正在运行，请等待完成后重试')
    }
    if (this.registry.entries.size >= 3) throw new Error('最多保留 3 个下载任务，请先清理已完成的任务')
    const entry = {
      id: randomUUID(), snapshotId: id, path: selectedPath, status: 'preparing', bytes: 0,
      name: selectedPath === '/' ? `backup-${id.slice(0, 8)}.zip` : filename(path.posix.basename(selectedPath)),
      createdAt: new Date().toISOString(), expiresAt: null, readers: 0,
    }
    this.registry.entries.set(entry.id, entry)
    entry.promise = this.service.execute('网页准备下载', async (config, conn, job) => {
      entry.job = job
      if (entry.cancelRequested) job.cancelled = true
      await this.select({ ...config, timeoutMinutes: 1 }, conn, job, id)
      let type = 'dir'
      let expectedSize
      if (selectedPath !== '/') {
        const siblings = await this.readDirectory(config, conn, job, id, path.posix.dirname(selectedPath))
        const node = siblings.find(item => item.path === selectedPath)
        if (!node?.downloadable) throw new Error('该路径不存在或不是普通文件/文件夹；符号链接请随其上级目录打包下载')
        type = node.type
        expectedSize = node.size
        if (type === 'dir') entry.name += '.zip'
      }
      if (job.cancelled) throw new Error('下载准备已取消')
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
      entry.directory = path.join(this.root, entry.id)
      await fs.mkdir(entry.directory, { mode: 0o700 })
      await fs.writeFile(path.join(entry.directory, 'owner.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
      const partial = path.join(entry.directory, 'payload.part')
      await fs.writeFile(partial, '', { flag: 'wx', mode: 0o600 })
      await this.service.runner(config, conn, ['dump', '--archive', 'zip', '--target', partial, '--', id, selectedPath], job)
      if (job.cancelled) throw new Error('下载准备已取消')
      entry.bytes = (await fs.stat(partial)).size
      if (type === 'file' && expectedSize !== null && entry.bytes !== expectedSize) throw new Error('导出文件大小与快照记录不符，下载已停止')
      await fs.rename(partial, path.join(entry.directory, 'payload'))
      return { snapshotId: id }
    }).then(() => {
      entry.status = entry.cancelRequested || entry.job?.cancelled ? 'cancelled' : 'ready'
    }, error => {
      entry.status = entry.cancelRequested || entry.job?.cancelled ? 'cancelled' : 'error'
      entry.error = entry.status === 'cancelled' ? '下载准备已取消' : error.message
    }).then(async () => {
      entry.job = null
      if (entry.status !== 'ready' && entry.directory) await this.removeDirectory(entry.directory).catch(() => {})
      entry.expiresAt = Date.now() + this.ttl
      entry.timer = setTimeout(() => this.cleanup().catch(() => {}), this.ttl + 10)
      entry.timer.unref?.()
    })
    return this.view(entry)
  }

  cancel(id) {
    const entry = this.get(id)
    if (entry.status === 'preparing') {
      entry.cancelRequested = true
      if (entry.job) { entry.job.cancelled = true; entry.job.stop?.() }
    }
    return this.view(entry)
  }

  async remove(id, expired = false) {
    const entry = expired ? this.registry.entries.get(id) : this.get(id)
    if (!entry) return
    if (entry.removal) return entry.removal
    if (entry.status === 'preparing') throw new Error('请先取消下载准备，再清理任务')
    if (entry.readers) throw new Error('文件正在下载，请下载结束后再清理')
    entry.removing = true
    entry.removal = (async () => {
      try {
        if (entry.directory) await this.removeDirectory(entry.directory)
        clearTimeout(entry.timer)
        this.registry.entries.delete(id)
      } finally { entry.removing = false; entry.removal = null }
    })()
    return entry.removal
  }

  async acquire(id) {
    const entry = this.get(id)
    if (entry.status !== 'ready') throw new Error('下载尚未准备完成')
    entry.readers++
    try {
      const target = path.join(entry.directory, 'payload')
      const stat = await fs.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes) throw new Error('下载文件不可用，请重新准备')
      let released = false
      return { target, name: entry.name, size: entry.bytes, release: () => {
        if (released) return
        released = true
        entry.readers--
        if (entry.expiresAt <= Date.now()) this.cleanup().catch(() => {})
      } }
    } catch (error) { entry.readers--; throw error }
  }
}
