import { createPanelConfig } from '../lib/panel-config.js'

// 由锅巴扩展页面宿主提供鉴权、静态资源与 API 路由，不单独监听端口。
export function init(ctx, { store = createPanelConfig() } = {}) {
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
}
