import { createPanelConfig } from '../lib/panel-config.js'
import { createDiagnostics } from '../lib/diagnostics.js'
import { BackupService } from '../lib/service.js'
import { BackupBrowser } from '../lib/browser.js'

// 只注册业务路由；Guoba 和独立服务分别在挂载前完成各自的鉴权。
export function init(ctx, {
  store = createPanelConfig(), diagnostics = createDiagnostics(),
  browser = new BackupBrowser({ service: new BackupService({ pluginDir: store.pluginDir, configLoader: () => store.resolve({}) }) }),
} = {}) {
  ctx.registerPage({
    id: 'restic-backup', title: 'restic 备份', icon: 'mdi:backup-restore', priority: 45,
    src: 'page.html', style: 'page.css', script: 'client.js',
  })
  ctx.registerApi('get', '/backup-plugin/config', async (_req, res) => {
    res.set?.('Cache-Control', 'no-store')
    try { res.json({ ok: true, ...await store.get() }) }
    catch (error) { res.status(500).json({ ok: false, error: error.message }) }
  })
  ctx.registerApi('post', '/backup-plugin/config', async (req, res) => {
    res.set?.('Cache-Control', 'no-store')
    try { res.json({ ok: true, ...await store.save(req.body) }) }
    catch (error) { res.status(400).json({ ok: false, error: error.message }) }
  })
  for (const kind of ['restic', 'oss']) {
    ctx.registerApi('post', `/backup-plugin/test/${kind}`, async (req, res) => {
      res.set?.('Cache-Control', 'no-store')
      try {
        const config = await store.resolve(req.body)
        res.json({ ok: true, result: await diagnostics.test(kind, config) })
      } catch (error) {
        res.status(error.code === 'BUSY' ? 409 : 400).json({ ok: false, error: error.message })
      }
    })
  }
  const api = (method, route, action, status = 200) => ctx.registerApi(method, `/backup-plugin/${route}`, async (req, res) => {
    res.set?.('Cache-Control', 'no-store')
    try { res.status(status).json({ ok: true, ...await action(req) }) }
    catch (error) { res.status(error.status || 400).json({ ok: false, error: error.message }) }
  })
  api('get', 'status', () => browser.service.taskStatus())
  api('post', 'tasks', req => {
    const { action, selector = 'latest' } = req.body || {}
    if (!['init', 'backup', 'check', 'restore'].includes(action)) throw new Error('不支持的备份操作')
    if (action === 'restore' && (typeof selector !== 'string' || (selector !== 'latest' && !/^[a-f0-9]{8,64}$/i.test(selector)))) throw new Error('请输入 latest 或至少 8 位快照 ID')
    const service = browser.service
    if (service.state.active) throw Object.assign(new Error('已有任务正在执行，请等待完成或取消'), { status: 409 })
    // execute 同步取得任务锁，结果和已脱敏的错误由 status 查询。
    const pending = service[action](selector)
    pending.catch(() => {})
    return { taskId: service.state.active?.id }
  }, 202)
  api('post', 'tasks/cancel', req => {
    const service = browser.service
    if (!req.body?.taskId || service.state.active?.id !== req.body.taskId) throw Object.assign(new Error('任务已结束或已更换，请刷新状态'), { status: 409 })
    return { cancelled: service.cancel() }
  })
  api('get', 'snapshots', req => browser.snapshots(req.query?.offset))
  api('get', 'files', req => browser.files(req.query?.snapshot, req.query?.path ?? '/', req.query?.offset))
  api('get', 'downloads', async () => ({ downloads: await browser.listDownloads() }))
  api('post', 'downloads', async req => {
    await browser.cleanup()
    return { download: browser.start(req.body?.snapshotId, req.body?.path ?? '/') }
  }, 202)
  api('get', 'downloads/:id', async req => ({ download: await browser.status(req.params.id) }))
  api('post', 'downloads/:id/cancel', req => ({ download: browser.cancel(req.params.id) }))
  api('delete', 'downloads/:id', async req => { await browser.remove(req.params.id); return {} })
  ctx.registerApi('get', '/backup-plugin/downloads/:id/file', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Referrer-Policy', 'no-referrer')
    let lease
    try {
      lease = await browser.acquire(req.params.id)
      res.once('close', lease.release)
      // 使用宿主鉴权和原生附件响应，支持 Range，不把整个下载装进浏览器内存。
      await new Promise(resolve => res.download(lease.target, lease.name, {
        headers: { 'Content-Type': 'application/octet-stream' }, dotfiles: 'allow',
      }, error => {
        lease.release()
        res.off('close', lease.release)
        if (error) {
          if (!res.headersSent) res.status(410).json({ ok: false, error: '下载文件已不可用，请重新准备下载' })
          else res.destroy()
        }
        resolve()
      }))
    } catch (error) {
      lease?.release()
      if (!res.headersSent) res.status(400).json({ ok: false, error: error.message })
    }
  })
}
