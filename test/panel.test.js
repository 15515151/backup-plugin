import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { PLUGIN_DIR, readConfig } from '../lib/config.js'
import { createPanelConfig, mergePanelConfig, SECRET_MASK, CONFIG_FIELDS } from '../lib/panel-config.js'
import { subscribeConfig, notifyConfigChanged } from '../lib/config-events.js'
import { createGuobaSupport } from '../guoba.support.js'
import { init } from '../webadapter/index.js'

async function fixture(t) {
  const pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jiuli-panel-'))
  t.after(() => fs.rm(pluginDir, { recursive: true, force: true }))
  await fs.copyFile(path.join(PLUGIN_DIR, 'config.example.json'), path.join(pluginDir, 'config.example.json'))
  const store = createPanelConfig({ pluginDir, frameworkDir: pluginDir })
  return { store, pluginDir }
}

test('both panel forms expose all editable fields', () => {
  const support = createGuobaSupport({})
  const fields = support.configInfo.schemas.map(item => item.field).filter(Boolean)
  assert.deepEqual([...fields].sort(), [...CONFIG_FIELDS].sort())
  assert.equal(support.pluginInfo.isV3, true)
  for (const field of ['password', 'oss.accessKeyId', 'oss.accessKeySecret', 'oss.sessionToken']) {
    assert.equal(support.configInfo.schemas.find(item => item.field === field).component, 'InputPassword')
  }
})

test('panel configuration preserves relative paths, blank host, unrelated settings and secrets', async t => {
  const { store, pluginDir } = await fixture(t)
  await store.get()
  const current = await readConfig(pluginDir)
  Object.assign(current, { password: 'real-password', resticPath: './bin/restic', customSetting: { keep: true } })
  Object.assign(current.oss, { accessKeyId: 'real-id', accessKeySecret: 'real-secret', sessionToken: 'real-token', futureOption: true })
  await fs.writeFile(path.join(pluginDir, 'config.json'), JSON.stringify(current))
  const shown = await store.get()
  assert.equal(shown.config.password, SECRET_MASK)
  assert.equal(shown.config.oss.accessKeySecret, SECRET_MASK)
  assert.equal(JSON.stringify(shown).includes('real-'), false)
  assert.equal(shown.config.resticPath, './bin/restic')
  assert.equal(shown.config.hostname, '')
  const result = await store.save({ ...shown.config, timeoutMinutes: 240 })
  assert.equal(result.config.password, SECRET_MASK)
  const saved = await readConfig(pluginDir)
  assert.equal(saved.password, 'real-password')
  assert.equal(saved.oss.accessKeySecret, 'real-secret')
  assert.equal(saved.oss.sessionToken, 'real-token')
  assert.equal(saved.resticPath, './bin/restic')
  assert.equal(saved.hostname, '')
  assert.deepEqual(saved.customSetting, { keep: true })
  assert.equal(saved.oss.futureOption, true)
  assert.equal(saved.timeoutMinutes, 240)
  await store.save({ 'oss.accessKeySecret': 'replacement-secret', password: '' })
  const changed = await readConfig(pluginDir)
  assert.equal(changed.password, '')
  assert.equal(changed.oss.accessKeySecret, 'replacement-secret')
})

test('flat Guoba patches, concurrent writes and protected default exclusions', async t => {
  const { store, pluginDir } = await fixture(t)
  await Promise.all([
    store.save({ 'oss.bucket': 'backup-bucket' }),
    store.save({ 'schedule.enabled': true, 'schedule.cron': '0 0 5 * * *', extraExcludes: ['.git'] }),
  ])
  const saved = await readConfig(pluginDir)
  assert.equal(saved.oss.bucket, 'backup-bucket')
  assert.equal(saved.schedule.enabled, true)
  assert.equal(saved.schedule.cron, '0 0 5 * * *')
  assert.deepEqual((await store.get()).defaultExcludes, ['node_modules', 'logs', 'temp', 'data/upload_tmp', 'data/memes'])
  await assert.rejects(store.save({ extraExcludes: ['!node_modules'] }), /反选/)
  assert.deepEqual((await readConfig(pluginDir)).extraExcludes, ['.git'])
})

test('bad panel input never corrupts the existing configuration', async t => {
  const { store, pluginDir } = await fixture(t)
  await store.get()
  const before = await fs.readFile(path.join(pluginDir, 'config.json'), 'utf8')
  for (const invalid of [
    null, [], { timeoutMinutes: -1 }, { schedule: { cron: '* * * broken *' } },
    { password: 123 }, { 'oss.endpoint': 'http://example.com' }, { 'oss.bucket': 'BAD Bucket' },
    { backend: 'local', localRepository: path.join(pluginDir, 'nested-repo') },
  ]) await assert.rejects(store.save(invalid))
  assert.equal(await fs.readFile(path.join(pluginDir, 'config.json'), 'utf8'), before)
  await fs.writeFile(path.join(pluginDir, 'config.json'), '{"password":"sensitive",}')
  await assert.rejects(store.save({ backend: 'local' }), error => !error.message.includes('sensitive'))
  assert.equal(await fs.readFile(path.join(pluginDir, 'config.json'), 'utf8'), '{"password":"sensitive",}')
})

test('unknown paths and prototype properties cannot modify runtime or pollute objects', () => {
  const malicious = JSON.parse('{"__proto__":{"polluted":true},"oss.__proto__.polluted":true,"schedule":{"constructor":{"prototype":{"polluted":true}}},"runtimeDir":"/bad","backend":"local"}')
  const merged = mergePanelConfig({ backend: 'oss', oss: {}, schedule: {} }, malicious)
  assert.equal(merged.backend, 'local')
  assert.equal(merged.runtimeDir, undefined)
  assert.equal({}.polluted, undefined)
  assert.equal(Object.hasOwn(merged, '__proto__'), false)
})

test('panel saves notify the active plugin only after persistence and unsubscribe works', async t => {
  const { store, pluginDir } = await fixture(t)
  let calls = 0
  const unsubscribe = subscribeConfig(async () => {
    assert.equal((await readConfig(pluginDir)).schedule.enabled, true)
    calls++
  }, pluginDir)
  t.after(unsubscribe)
  const result = await store.save({ 'schedule.enabled': true })
  assert.match(result.message, /定时任务已更新/)
  assert.equal(calls, 1)
  unsubscribe()
  assert.deepEqual(await notifyConfigChanged(pluginDir), { applied: false, failed: false })
})

test('Guoba get/save contract returns Result and does not echo secrets', async t => {
  const { store } = await fixture(t)
  const { configInfo } = createGuobaSupport(store)
  const Result = { ok: (data, message) => ({ ok: true, data, message }), error: message => ({ ok: false, message }) }
  assert.ok((await configInfo.getConfigData()).oss)
  const good = await configInfo.setConfigData({ password: 'a-new-secret' }, { Result })
  assert.equal(good.ok, true)
  assert.ok(!JSON.stringify(good).includes('a-new-secret'))
  assert.equal((await configInfo.getConfigData()).password, SECRET_MASK)
  const bad = await configInfo.setConfigData({ timeoutMinutes: 0 }, { Result })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /timeoutMinutes/)
})

test('WebAdapter registers declared assets and configuration endpoints', async t => {
  const { store } = await fixture(t)
  const pages = []
  const routes = new Map()
  init({ registerPage: page => pages.push(page), registerApi: (method, route, handler) => routes.set(`${method} ${route}`, handler) }, { store })
  assert.equal(pages.length, 1)
  for (const property of ['src', 'style', 'script']) await fs.access(path.join(PLUGIN_DIR, 'webadapter', pages[0][property]))
  const response = () => ({ statusCode: 200, headers: {}, set(name, value) { this.headers[name] = value; return this }, status(code) { this.statusCode = code; return this }, json(data) { this.data = data; return this } })
  const read = response()
  await routes.get('get /backup-plugin/config')({}, read)
  assert.equal(read.data.ok, true)
  assert.equal(read.headers['Cache-Control'], 'no-store')
  const write = response()
  await routes.get('post /backup-plugin/config')({ body: { password: 'private-test-value' } }, write)
  assert.equal(write.statusCode, 200)
  assert.equal(write.data.config.password, SECRET_MASK)
  assert.ok(!JSON.stringify(write.data).includes('private-test-value'))
  const bad = response()
  await routes.get('post /backup-plugin/config')({ body: { backend: 'invalid' } }, bad)
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.data.ok, false)
})

test('diagnostics resolve unsaved input and secret masks without saving or rescheduling', async t => {
  const { store, pluginDir } = await fixture(t)
  await store.save({ password: 'private-password', 'oss.accessKeyId': 'private-id', 'oss.accessKeySecret': 'private-secret' })
  let notifications = 0
  const unsubscribe = subscribeConfig(() => { notifications++ }, pluginDir)
  t.after(unsubscribe)
  const before = await fs.readFile(path.join(pluginDir, 'config.json'), 'utf8')
  const shown = await store.get()
  const candidate = await store.resolve({ ...shown.config, resticPath: './new-restic', oss: { ...shown.config.oss, bucket: 'unsaved-bucket' } })
  assert.equal(candidate.resticPath, path.resolve(pluginDir, 'new-restic'))
  assert.equal(candidate.oss.bucket, 'unsaved-bucket')
  assert.equal(candidate.oss.accessKeySecret, 'private-secret')
  assert.equal(candidate.password, 'private-password')
  assert.equal((await store.resolve({ 'oss.accessKeySecret': '' })).oss.accessKeySecret, '')
  assert.equal((await store.resolve({ 'oss.accessKeySecret': 'new-secret' })).oss.accessKeySecret, 'new-secret')
  assert.equal(notifications, 0)
  assert.equal(await fs.readFile(path.join(pluginDir, 'config.json'), 'utf8'), before)
})

test('diagnostic routes use current input, return only results and handle failure and busy states', async t => {
  const { store, pluginDir } = await fixture(t)
  await store.save({ 'oss.accessKeySecret': 'private-secret' })
  const before = await fs.readFile(path.join(pluginDir, 'config.json'), 'utf8')
  const routes = new Map()
  let calls = 0
  let failure
  init({ registerPage() {}, registerApi: (method, route, handler) => routes.set(`${method} ${route}`, handler) }, {
    store,
    diagnostics: { async test(kind, config) {
      calls++
      if (failure) throw failure
      assert.ok(['restic', 'oss'].includes(kind))
      assert.equal(config.oss.accessKeySecret, 'private-secret')
      assert.equal(config.oss.bucket, 'unsaved-bucket')
      return { message: 'test passed', elapsedMs: 12 }
    } },
  })
  const response = () => ({ statusCode: 200, headers: {}, set(name, value) { this.headers[name] = value; return this }, status(code) { this.statusCode = code; return this }, json(data) { this.data = data; return this } })
  for (const kind of ['restic', 'oss']) {
    const res = response()
    await routes.get(`post /backup-plugin/test/${kind}`)({ body: { oss: { bucket: 'unsaved-bucket', accessKeySecret: SECRET_MASK } } }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['Cache-Control'], 'no-store')
    assert.deepEqual(res.data, { ok: true, result: { message: 'test passed', elapsedMs: 12 } })
  }
  const bad = response()
  await routes.get('post /backup-plugin/test/oss')({ body: null }, bad)
  assert.equal(bad.statusCode, 400)
  assert.equal(calls, 2)
  for (const [code, status] of [['BUSY', 409], ['FAILED', 400]]) {
    failure = Object.assign(new Error('test unavailable'), { code })
    const res = response()
    await routes.get('post /backup-plugin/test/restic')({ body: {} }, res)
    assert.equal(res.statusCode, status)
    assert.deepEqual(res.data, { ok: false, error: 'test unavailable' })
  }
  assert.equal(await fs.readFile(path.join(pluginDir, 'config.json'), 'utf8'), before)
})
