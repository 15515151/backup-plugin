import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { PLUGIN_DIR } from '../lib/config.js'

const enabled = Boolean(process.env.TEST_JSDOM_PATH)
const id = 'a'.repeat(64)
const taskId = 'ac21a7ac-f8be-4a6a-8af2-782836858309'
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate) {
  for (let count = 0; count < 100; count++) { if (predicate()) return; await tick() }
  assert.fail('DOM state did not settle')
}

test('webpage navigates snapshots, preserves literal filenames, prepares and downloads without buffering, and blocks unsaved config', { skip: !enabled }, async t => {
  const { JSDOM } = createRequire(import.meta.url)(process.env.TEST_JSDOM_PATH)
  const html = await fs.readFile(`${PLUGIN_DIR}/webadapter/page.html`, 'utf8')
  const script = await fs.readFile(`${PLUGIN_DIR}/webadapter/client.js`, 'utf8')
  const config = JSON.parse(await fs.readFile(`${PLUGIN_DIR}/config.example.json`, 'utf8'))
  const dom = new JSDOM(html, { url: 'https://panel.example/guoba/api/web-page/asset/backup-plugin/page.html', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  const { document } = window
  const events = []
  let downloads = []
  let downloaded
  window.HTMLElement.prototype.scrollIntoView = () => {}
  window.HTMLAnchorElement.prototype.click = function () { downloaded = this.href }
  window.Guoba = { apiUrl: route => `/guoba/api/web-page/api/backup-plugin${route}`, token: () => 'fixture-token' }
  window.fetch = async (url, options = {}) => {
    const request = new URL(url, window.location.href)
    const route = request.pathname.slice(request.pathname.lastIndexOf('/backup-plugin/') + '/backup-plugin/'.length)
    events.push({ route, method: options.method || 'GET', body: options.body && JSON.parse(options.body) })
    let result
    if (route === 'config') result = { config, defaultExcludes: ['node_modules'] }
    else if (route === 'status') result = { active: null, last: null, observedAt: new Date().toISOString() }
    else if (route === 'snapshots') result = { items: [{ id, time: '2026-09-24', hostname: 'fixture', files: 1, bytes: 4 }], total: 1, offset: 0, nextOffset: null, hostname: 'fixture', tag: 'jiuli-backup' }
    else if (route === 'files') {
      const directory = request.searchParams.get('path')
      result = { items: directory === '/' ? [{ path: '/中文 [a]', name: '中文 [a]', type: 'dir', downloadable: true }]
        : [{ path: '/中文 [a]/<img>.bin', name: '<img>.bin', type: 'file', size: 4, downloadable: true }], total: 1, offset: 0, nextOffset: null, path: directory }
    } else if (route === 'downloads' && options.method === 'POST') {
      downloads = [{ id: taskId, snapshotId: id, path: JSON.parse(options.body).path, name: '_img_.bin', status: 'ready', bytes: 4, expiresAt: Date.now() + 1800000 }]
      result = { download: downloads[0] }
    } else if (route === 'downloads') result = { downloads }
    else if (route === `downloads/${taskId}` && options.method === 'DELETE') { downloads = []; result = {} }
    else if (route === `downloads/${taskId}`) result = { download: downloads[0] }
    else assert.fail(`Unexpected request ${route}`)
    return { ok: true, status: 200, json: async () => ({ ok: true, ...result }) }
  }
  window.eval(script)
  await until(() => !document.getElementById('configFields').disabled)
  document.querySelector('[data-tab="backups"]').click()
  await until(() => document.querySelector('#snapshotRows button') && !document.querySelector('#snapshotRows button').disabled)
  assert.equal(document.querySelector('h1').textContent, '备份文件')
  assert.equal(document.getElementById('configForm').hidden, true)
  document.querySelector('#snapshotRows button').click()
  await until(() => document.querySelector('#fileRows .file-name') && !document.querySelector('#fileRows .file-name').disabled)
  document.querySelector('#fileRows .file-name').click()
  await until(() => document.getElementById('fileRows').textContent.includes('<img>.bin') && !document.querySelector('#fileRows button').disabled)
  assert.equal(document.querySelector('#fileRows img'), null)
  assert.ok(document.getElementById('breadcrumbs').textContent.includes('中文 [a]'))
  document.querySelector('#fileRows button').click()
  await until(() => document.getElementById('downloadTasks').textContent.includes('下载到本机'))
  assert.equal(events.find(event => event.method === 'POST').body.path, '/中文 [a]/<img>.bin')
  assert.equal(events.filter(event => event.route === 'config' && event.method !== 'GET').length, 0)
  document.querySelector('#downloadTasks button').click()
  await until(() => downloaded)
  const link = new URL(downloaded)
  assert.equal(link.origin, window.location.origin)
  assert.ok(link.pathname.endsWith(`/downloads/${taskId}/file`))
  assert.equal(link.searchParams.get('token'), 'fixture-token')
  assert.ok(!events.some(event => event.route.endsWith('/file')), 'download must use native attachment, not fetch/blob')
  const input = document.querySelector('[name="oss.bucket"]')
  input.value = 'unsaved-bucket'
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  assert.equal(document.getElementById('libraryUnsaved').hidden, false)
  assert.equal(document.getElementById('refreshSnapshots').disabled, true)
  assert.equal(document.getElementById('downloadSnapshot').disabled, true)
})

test('webpage polls existing task progress across tabs, shows indeterminate phases and retains stale state on errors', { skip: !enabled }, async t => {
  const { JSDOM } = createRequire(import.meta.url)(process.env.TEST_JSDOM_PATH)
  const html = await fs.readFile(`${PLUGIN_DIR}/webadapter/page.html`, 'utf8')
  const script = await fs.readFile(`${PLUGIN_DIR}/webadapter/client.js`, 'utf8')
  const dom = new JSDOM(html, { url: 'https://panel.example/guoba/api/web-page/asset/backup-plugin/page.html', runScripts: 'outside-only', pretendToBeVisual: true })
  t.after(() => dom.window.close())
  const { window } = dom
  const { document } = window
  const element = id => document.getElementById(id)
  const scheduled = new Map()
  let timerId = 0
  const setTimer = window.setTimeout.bind(window)
  const clearTimer = window.clearTimeout.bind(window)
  window.setTimeout = (callback, delay) => {
    if ([2000, 5000, 15000].includes(delay)) { const id = --timerId; scheduled.set(id, { callback, delay }); return id }
    return setTimer(callback, delay)
  }
  window.clearTimeout = id => { if (id < 0) scheduled.delete(id); else clearTimer(id) }
  const poll = () => {
    const [id, timer] = [...scheduled][0]
    scheduled.delete(id)
    timer.callback()
    return timer.delay
  }
  let data = { observedAt: '2026-09-24T00:01:30Z', active: { id: 'existing-task', name: '备份', phase: '读取并备份文件',
    startedAt: '2026-09-24T00:00:00Z', elapsedSeconds: 90, cancelled: false,
    progress: { percent: 0.25, filesDone: 25, totalFiles: 100, bytesDone: 1024, totalBytes: 4096, secondsRemaining: 270 } }, last: null }
  let fail = false
  const requests = []
  window.fetch = async (url, options) => {
    requests.push({ url, options })
    if (url.endsWith('/status')) {
      if (fail) throw new Error('网络暂不可用')
      return { ok: true, json: async () => structuredClone({ ok: true, ...data }) }
    }
    // 即使配置读取失败，任务监视也应独立运行。
    return { ok: false, status: 400, json: async () => ({ ok: false, error: '配置无效' }) }
  }
  window.eval(script)
  await until(() => element('taskPercent').textContent === '25.0%' && scheduled.size > 0)
  assert.match(element('taskName').textContent, /备份/)
  assert.equal(element('taskFiles').textContent, '25 / 100')
  assert.equal(element('taskBytes').textContent, '1.0 KiB / 4.0 KiB')
  assert.equal(element('taskElapsed').textContent, '1 分 30 秒')
  assert.equal(element('taskRemaining').textContent, '约 4 分 30 秒')
  document.querySelector('[data-tab="oss"]').click()
  assert.equal(element('taskMonitor').hidden, false)
  data.active.progress.percent = 0.75
  assert.equal(poll(), 2000)
  await until(() => element('taskPercent').textContent === '75.0%' && scheduled.size > 0)
  fail = true
  poll()
  await until(() => !element('taskStatusError').hidden && scheduled.size > 0)
  assert.equal(element('taskMonitor').dataset.state, 'stale')
  assert.equal(element('taskPercent').textContent, '75.0%')
  assert.match(element('taskStatusError').textContent, /保留上次读取结果/)
  fail = false
  data.active = { ...data.active, name: '仓库检查', phase: '检查仓库', progress: null }
  assert.equal(poll(), 5000)
  await until(() => element('taskPercent').textContent === '执行中' && scheduled.size > 0)
  assert.equal(element('taskProgress').hasAttribute('value'), false)
  assert.equal(element('taskStatusError').hidden, true)
  data.active.cancelled = true
  poll()
  await until(() => element('taskName').textContent.includes('正在取消') && scheduled.size > 0)
  data = { ...data, active: null, last: { name: '备份', status: 'partial', finishedAt: '2026-09-24T00:10:00Z', snapshotId: id, error: '<img src=x> 部分文件未读取' } }
  poll()
  await until(() => !element('lastTask').hidden && scheduled.size > 0)
  assert.equal(element('taskDetails').hidden, true)
  assert.match(element('lastTaskSummary').textContent, /不完整/)
  assert.equal(element('lastTask').querySelector('img'), null)
  assert.ok(requests.every(item => !item.options.method || item.options.method === 'GET'))
  window.dispatchEvent(new window.Event('pagehide'))
  assert.equal(scheduled.size, 0)
})
