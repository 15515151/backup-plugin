import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { PLUGIN_DIR, loadConfig } from '../lib/config.js'
import { BackupService } from '../lib/service.js'
import { startWebServer } from '../lib/web-server.js'
import { init } from '../webadapter/index.js'
import { createPanelConfig } from '../lib/panel-config.js'

const password = 'fixture-web-password'
const json = { 'Content-Type': 'application/json' }
const snapshot = 'a'.repeat(64)

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-web-'))
  const pluginDir = path.join(directory, 'plugin')
  const sourceDir = path.join(directory, 'source')
  await fs.mkdir(pluginDir)
  await fs.mkdir(sourceDir)
  await fs.copyFile(path.join(PLUGIN_DIR, 'config.example.json'), path.join(pluginDir, 'config.example.json'))
  await fs.writeFile(path.join(pluginDir, 'config.json'), JSON.stringify({ backend: 'local', password: 'fixture-repository-secret',
    localRepository: path.join(directory, 'repo'), resticPath: process.env.TEST_RESTIC_PATH || 'restic' }))
  const runtimes = []
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close()
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    await fs.rm(directory, { recursive: true, force: true })
  })
  const start = async (extra = {}) => {
    const runtime = await startWebServer({ pluginDir, sourceDir, password, port: 0, log() {}, ...options, ...extra })
    runtimes.push(runtime)
    return runtime
  }
  const runtime = await start()
  return { directory, pluginDir, sourceDir, runtime, start }
}

async function login(runtime, value = password) {
  const response = await fetch(runtime.url + '/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ password: value }) })
  assert.equal(response.status, 200, await response.clone().text())
  const data = await response.json()
  const cookie = response.headers.get('set-cookie')
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  return { cookie: cookie.split(';')[0], csrf: data.csrf }
}

function client(runtime, session) {
  return (route, { method = 'GET', body, headers = {} } = {}) => fetch(runtime.url + '/api/' + route, {
    method, headers: { ...json, Cookie: session.cookie, 'X-Backup-CSRF': session.csrf, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

test('standalone protects every API and attachment, checks CSRF/origin/host, and never exposes configuration as static files', async t => {
  const { runtime } = await fixture(t)
  const page = await fetch(runtime.url)
  assert.match(await page.text(), /data-mode="standalone"/)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  for (const filename of ['config.json', '.runtime/web-auth.json', 'index.js', 'web.js', 'lib/config.js', '../config.json']) {
    assert.equal((await fetch(`${runtime.url}/${filename}`)).status, 404)
  }
  for (const [method, route] of [['GET', 'config'], ['POST', 'config'], ['GET', 'status'], ['POST', 'tasks'], ['POST', 'tasks/cancel'],
    ['GET', 'snapshots'], ['GET', 'files'], ['POST', 'test/oss'], ['POST', 'test/restic'], ['POST', 'downloads'],
    ['GET', 'downloads/x/file'], ['DELETE', 'downloads/x'], ['POST', 'downloads/x/cancel']]) {
    const response = await fetch(`${runtime.url}/api/backup-plugin/${route}?token=fake-guoba-token`, { method, headers: { 'guoba-access-token': 'fake-guoba-token' } })
    assert.equal(response.status, 401, `${method} ${route}`)
  }
  assert.equal((await fetch(runtime.url + '/api/auth/login', { method: 'POST', headers: { ...json, Origin: 'https://evil.example' }, body: '{}' })).status, 403)
  const rebound = await new Promise((resolve, reject) => {
    http.get(runtime.url, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode) }).on('error', reject)
  })
  assert.equal(rebound, 403)
  assert.equal((await fetch(runtime.url + '/api/auth/login', { method: 'POST', body: 'password=anything' })).status, 415)
  assert.equal((await fetch(runtime.url + '/api/auth/login', { method: 'POST', headers: json, body: '{"private-password' })).status, 400)
  const session = await login(runtime)
  const request = client(runtime, session)
  const config = await request('backup-plugin/config')
  const shown = await config.json()
  assert.equal(shown.config.password, '********')
  assert.ok(!JSON.stringify(shown).includes('fixture-repository-secret'))
  assert.equal(config.headers.get('cache-control'), 'no-store')
  assert.equal((await request('backup-plugin/config', { method: 'POST', body: {}, headers: { 'X-Backup-CSRF': '' } })).status, 403)
  assert.equal((await request('backup-plugin/config', { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await request('backup-plugin/config', { method: 'POST', body: { hostname: 'web-fixture' } })).status, 200)
  assert.equal((await (await request('backup-plugin/config')).json()).config.hostname, 'web-fixture')
  const malformed = await fetch(runtime.url + '/api/backup-plugin/config', { method: 'POST', headers: { ...json, Cookie: session.cookie, 'X-Backup-CSRF': session.csrf }, body: '{"private-password' })
  assert.equal(malformed.status, 400)
  assert.ok(!(await malformed.text()).includes('private-password'))
  assert.equal((await request('backup-plugin/config', { method: 'POST', body: { large: 'x'.repeat(70000) } })).status, 413)
  assert.equal((await request('auth/logout', { method: 'POST' })).status, 200)
  assert.equal((await request('backup-plugin/config')).status, 401)
  assert.equal((await request('backup-plugin/downloads/x/file')).status, 401)
})

test('generated password persists only as a salted hash; sessions expire, rotate and are invalidated by restart/password reset', async t => {
  let now = Date.now()
  const { runtime, pluginDir, start } = await fixture(t, { password: undefined, authOptions: { now: () => now, sessionMs: 1000 } })
  const initial = runtime.initialPassword
  assert.ok(initial.length >= 24)
  const saved = await fs.readFile(path.join(pluginDir, '.runtime/web-auth.json'), 'utf8')
  assert.ok(!saved.includes(initial))
  const session = await login(runtime, initial)
  const request = client(runtime, session)
  assert.equal((await request('auth/session')).status, 200)
  now += 1001
  assert.equal((await request('auth/session')).status, 401)
  const fresh = await login(runtime, initial)
  assert.notEqual(fresh.cookie, session.cookie)
  await runtime.close()
  const restarted = await start({ password: undefined })
  assert.equal(restarted.initialPassword, undefined)
  assert.equal((await client(restarted, fresh)('auth/session')).status, 401)
  await login(restarted, initial)
  await restarted.close()
  const reset = await start({ password: 'a-replacement-password' })
  assert.equal((await fetch(reset.url + '/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ password: initial }) })).status, 401)
  await login(reset, 'a-replacement-password')
  await reset.close()
  await fs.writeFile(path.join(pluginDir, '.runtime/web-auth.json'), '{invalid')
  await assert.rejects(start({ password: undefined }), /凭据无法读取/)
})

test('login attempts are rate limited and retry becomes available after the window', async t => {
  let now = Date.now()
  const { runtime } = await fixture(t, { authOptions: { now: () => now } })
  for (let count = 0; count < 10; count++) {
    assert.equal((await fetch(runtime.url + '/api/auth/login', { method: 'POST', headers: json, body: '{"password":"wrong"}' })).status, 401)
  }
  const limited = await fetch(runtime.url + '/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ password }) })
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  now += 15 * 60 * 1000
  await login(runtime)
})

test('web task starts asynchronously, shares the lock and cancels by task ID; schedule saves apply and shutdown removes jobs', async t => {
  const jobs = []
  const { pluginDir, sourceDir, runtime } = await fixture(t, { createJob: async (cron, callback) => {
    const job = { cron, callback, cancelled: false, cancel() { this.cancelled = true } }
    jobs.push(job)
    return job
  } })
  const request = client(runtime, await login(runtime))
  let finish
  runtime.service.runner = (_config, _connection, _command, job) => new Promise((resolve, reject) => {
    if (job.cancelled) { reject(new Error('cancelled fixture')); return }
    finish = () => resolve({ code: 0, summary: { snapshot_id: snapshot } })
    job.stop = () => reject(new Error('cancelled fixture'))
  })
  assert.equal((await request('backup-plugin/tasks', { method: 'POST', body: { action: 'constructor' } })).status, 400)
  assert.equal((await request('backup-plugin/tasks', { method: 'POST', body: { action: 'restore', selector: '../bad' } })).status, 400)
  const started = await request('backup-plugin/tasks', { method: 'POST', body: { action: 'backup' } })
  assert.equal(started.status, 202)
  const { taskId } = await started.json()
  assert.ok(taskId)
  assert.equal((await (await request('backup-plugin/status')).json()).active.id, taskId)
  const shared = new BackupService({ pluginDir, configLoader: () => loadConfig({ pluginDir, frameworkDir: sourceDir }) })
  await assert.rejects(shared.backup(), /已有任务/)
  assert.equal((await request('backup-plugin/tasks', { method: 'POST', body: { action: 'backup' } })).status, 409)
  assert.equal((await request('backup-plugin/tasks/cancel', { method: 'POST', body: { taskId: 'old-task' } })).status, 409)
  assert.equal((await request('backup-plugin/tasks/cancel', { method: 'POST', body: { taskId } })).status, 200)
  await settled(request)
  assert.equal((await (await request('backup-plugin/status')).json()).last.status, 'cancelled')
  for (const [enabled, cron] of [[true, '0 0 4 * * *'], [true, '0 0 5 * * *'], [false, '0 0 5 * * *'], [true, '0 0 6 * * *']]) {
    const result = await (await request('backup-plugin/config', { method: 'POST', body: { schedule: { enabled, cron } } })).json()
    assert.match(result.message, /定时任务已更新/)
  }
  assert.equal(jobs.length, 3)
  assert.ok(jobs.slice(0, 2).every(job => job.cancelled))
  assert.equal(jobs[2].cancelled, false)
  const running = jobs[2].callback()
  for (let i = 0; i < 200 && !runtime.service.state.active?.stop; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(runtime.service.state.active?.stop)
  finish()
  await running
  await runtime.close()
  assert.equal(jobs[2].cancelled, true)
})

async function settled(request) {
  for (let i = 0; i < 1000; i++) {
    const state = await (await request('backup-plugin/status')).json()
    if (!state.active) return state.last
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('task did not settle')
}

test('real restic over authenticated HTTP: initialize, back up, browse, ranged download, restore and check', { skip: !process.env.TEST_RESTIC_PATH, timeout: 120000 }, async t => {
  const { runtime, sourceDir } = await fixture(t)
  const content = Buffer.from([0, 255, 13, 10, 4, 9])
  await fs.writeFile(path.join(sourceDir, '中文.bin'), content)
  const session = await login(runtime)
  const request = client(runtime, session)
  for (const action of ['init', 'backup', 'check']) {
    assert.equal((await request('backup-plugin/tasks', { method: 'POST', body: { action } })).status, 202)
    const last = await settled(request)
    assert.equal(last.status, 'success', JSON.stringify(last))
  }
  const { items } = await (await request('backup-plugin/snapshots')).json()
  const files = await (await request(`backup-plugin/files?snapshot=${items[0].id}&path=/`)).json()
  assert.ok(files.items.some(item => item.name === '中文.bin'))
  const { download } = await (await request('backup-plugin/downloads', { method: 'POST', body: { snapshotId: items[0].id, path: '/中文.bin' } })).json()
  await settled(request)
  const file = await request(`backup-plugin/downloads/${download.id}/file`)
  assert.equal(file.status, 200)
  assert.match(file.headers.get('content-disposition'), /attachment/)
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), content)
  const range = await request(`backup-plugin/downloads/${download.id}/file`, { headers: { Range: 'bytes=1-3' } })
  assert.equal(range.status, 206)
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), content.subarray(1, 4))
  assert.equal((await fetch(`${runtime.url}/api/backup-plugin/downloads/${download.id}/file`)).status, 401)
  assert.equal((await request('backup-plugin/tasks', { method: 'POST', body: { action: 'restore', selector: items[0].id } })).status, 202)
  const last = await settled(request)
  assert.equal(last.status, 'success', JSON.stringify(last))
  assert.ok(last.target)
  assert.deepEqual(await fs.readFile(path.join(last.target, '中文.bin')), content)
})

test('Guoba host retains its auth gate and original adapter assets with no standalone login', async t => {
  const { pluginDir, sourceDir } = await fixture(t)
  const store = createPanelConfig({ pluginDir, frameworkDir: sourceDir })
  const app = express()
  app.use(express.json())
  const router = express.Router()
  const pages = []
  init({ registerPage: page => pages.push(page), registerApi: (method, route, handler) => router[method](route, handler) }, { store })
  app.use('/guoba/api/web-page/api/backup-plugin', (req, res, next) => {
    if (req.get('guoba-access-token') !== 'guoba-fixture-token') return res.sendStatus(401)
    next()
  }, router)
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) })
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}/guoba/api/web-page/api/backup-plugin/backup-plugin/config`
  assert.equal((await fetch(url)).status, 401)
  const accepted = await fetch(url, { headers: { 'guoba-access-token': 'guoba-fixture-token' } })
  assert.equal(accepted.status, 200)
  assert.equal((await accepted.json()).config.password, '********')
  assert.ok(!(await fs.readFile(path.join(PLUGIN_DIR, 'webadapter', pages[0].src), 'utf8')).includes('data-mode="standalone"'))
})

test('real Guoba registry loads and mounts the adapter using its native routes', { skip: !process.env.TEST_GUOBA_PATH }, async t => {
  const root = process.env.TEST_GUOBA_PATH
  const { ExtensionRegistry } = await import(pathToFileURL(path.join(root, 'server/utils/extensionRegistry.js')))
  const { buildPluginApiRouter } = await import(pathToFileURL(path.join(root, 'server/utils/extensionRouter.js')))
  const hostExpress = createRequire(path.join(root, 'package.json'))('express')
  const { pluginDir, sourceDir } = await fixture(t)
  const registry = new ExtensionRegistry({ pluginsDir: path.dirname(PLUGIN_DIR), getMountPrefix: () => '/guoba' })
  const { entry, error } = await registry.loadPlugin('backup-plugin', PLUGIN_DIR, path.join(PLUGIN_DIR, 'webadapter'))
  assert.ok(entry, error)
  entry.apis = []
  init(registry.createContext(entry), { store: createPanelConfig({ pluginDir, frameworkDir: sourceDir }) })
  entry.router = buildPluginApiRouter(entry)
  registry.registry.set('backup-plugin', entry)
  registry.scannedAt = Date.now()
  const app = hostExpress()
  app.use('/guoba/api/web-page', (req, res, next) => {
    if (req.path.startsWith('/api/') && req.get('guoba-access-token') !== 'guoba-test') return res.sendStatus(401)
    return registry.handleRequest(req, res, next)
  })
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) })
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}/guoba/api/web-page`
  const page = await (await fetch(url + '/asset/backup-plugin/page.html')).text()
  assert.match(page, /guoba-ext-bootstrap/)
  assert.ok(!page.includes('data-mode="standalone"'))
  const api = url + '/api/backup-plugin/backup-plugin/config'
  assert.equal((await fetch(api)).status, 401)
  assert.equal((await fetch(api, { headers: { 'guoba-access-token': 'guoba-test' } })).status, 200)
})
