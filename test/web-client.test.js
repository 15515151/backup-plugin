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
