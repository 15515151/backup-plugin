import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { PLUGIN_DIR, FRAMEWORK_DIR, ensureConfig } from './config.js'
import { createPanelConfig } from './panel-config.js'
import { BackupService } from './service.js'
import { BackupBrowser } from './browser.js'
import { subscribeConfig } from './config-events.js'
import { BackupScheduler } from './scheduler.js'
import { createWebAuth } from './web-auth.js'
import { init } from '../webadapter/index.js'

export const DEFAULT_SOURCE_DIR = path.basename(path.dirname(PLUGIN_DIR)).toLowerCase() === 'plugins' ? FRAMEWORK_DIR : PLUGIN_DIR

export async function startWebServer({
  pluginDir = PLUGIN_DIR, sourceDir = DEFAULT_SOURCE_DIR, host = '127.0.0.1', port = 5212,
  origin, password, log = (level, message) => console[level](message),
  createJob, service: suppliedService, browser: suppliedBrowser, diagnostics,
  authOptions = {},
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('BACKUP_WEB_PORT 必须为 0～65535 的整数')
  let publicOrigin
  if (origin) {
    try {
      const parsed = new URL(origin)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('invalid')
      publicOrigin = parsed.origin
    } catch { throw new Error('BACKUP_WEB_ORIGIN 必须是完整的 http(s) 站点地址，不包含路径') }
  }
  const source = await fs.realpath(path.resolve(sourceDir))
  if (!(await fs.stat(source)).isDirectory()) throw new Error('BACKUP_SOURCE_DIR 必须是存在的目录')
  await ensureConfig(pluginDir)
  const store = createPanelConfig({ pluginDir, frameworkDir: source })
  const service = suppliedService ?? new BackupService({ pluginDir, configLoader: () => store.resolve({}) })
  const browser = suppliedBrowser ?? new BackupBrowser({ service })
  const auth = await createWebAuth({ ...authOptions, pluginDir, password, secure: publicOrigin?.startsWith('https:') === true })
  const scheduler = new BackupScheduler({ service, load: () => store.resolve({}), createJob,
    subscribe: listener => subscribeConfig(listener, pluginDir), log })
  const app = express()
  const server = http.createServer(app)
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" })
    const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', host.includes(':') && !host.startsWith('[') ? `[${host}]` : host])
    const boundPort = server.address()?.port
    const localOrigins = [...localHosts].map(name => `http://${name}:${boundPort}`)
    const allowed = publicOrigin ? [publicOrigin] : localOrigins
    // 不信任转发头；反向代理须保留 Host，并显式配置公网 Origin。
    if (!allowed.some(value => new URL(value).host === req.get('host'))) return res.status(403).json({ ok: false, error: '访问地址不匹配，请检查 BACKUP_WEB_ORIGIN 与代理 Host' })
    if ((req.get('origin') && !allowed.includes(req.get('origin'))) || req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ ok: false, error: '不允许跨站访问备份面板' })
    }
    next()
  })
  const json = express.json({ limit: '64kb' })
  const requireJson = (req, res, next) => {
    if (!req.is('application/json')) return res.status(415).json({ ok: false, error: '请求需要 application/json' })
    next()
  }
  app.post('/api/auth/login', requireJson, json, (req, res) => auth.login(req, res))
  app.use('/api', auth.requireSession)
  app.get('/api/auth/session', (req, res) => res.json({ ok: true, ...auth.session(req), sourceDir: source }))
  app.post('/api/auth/logout', (req, res) => auth.logout(req, res))
  app.use('/api', (req, res, next) => ['POST', 'PUT', 'PATCH'].includes(req.method) ? requireJson(req, res, next) : next(), json)
  const router = express.Router()
  init({ registerPage() {}, registerApi(method, route, handler) { router[method](route, handler) } }, { store, browser, diagnostics })
  app.use('/api', router)
  const assets = path.join(PLUGIN_DIR, 'webadapter')
  app.get(['/', '/page.html'], async (_req, res) => {
    const html = await fs.readFile(path.join(assets, 'page.html'), 'utf8')
    // 模式由服务端标记；Guoba 加载原始页面时保持自己的登录流程。
    res.type('html').send(html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-mode="standalone">'))
  })
  for (const name of ['client.js', 'page.css']) app.get(`/${name}`, (_req, res) => res.sendFile(path.join(assets, name)))
  app.use((_req, res) => res.status(404).json({ ok: false, error: '页面或接口不存在' }))
  app.use((error, _req, res, _next) => {
    if (res.headersSent) { res.destroy(); return }
    const code = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500
    res.status(code).json({ ok: false, error: code === 413 ? '请求内容过大' : code === 400 ? 'JSON 格式无效' : '服务暂不可用，请稍后重试' })
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => { server.off('error', reject); resolve() })
    })
    // 配置异常仍开放已鉴权面板，便于查看任务与诊断；修复配置后可重启。
    await scheduler.start().catch(error => log('error', error.message))
  } catch (error) { scheduler.stop(); auth.close(); throw error }
  let closing
  return {
    app, server, service, scheduler, sourceDir: source,
    url: publicOrigin ?? `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host}:${server.address().port}`,
    initialPassword: auth.initialPassword,
    close() {
      return closing ??= (async () => {
        scheduler.stop()
        auth.close()
        service.cancel()
        const closed = new Promise(resolve => server.close(resolve))
        server.closeAllConnections()
        await closed
      })()
    },
  }
}
