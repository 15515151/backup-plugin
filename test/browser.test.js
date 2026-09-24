import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { inflateRawSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { normalizeConfig, PLUGIN_DIR } from '../lib/config.js'
import { BackupService } from '../lib/service.js'
import { BackupBrowser, snapshotPath } from '../lib/browser.js'

const id = 'a'.repeat(64)
const snapshot = { id, time: '2026-09-24T00:00:00Z', hostname: 'fixture', tags: ['jiuli-backup'], summary: { total_bytes_processed: 4, total_files_processed: 1 } }
const nodes = [
  { type: 'dir', path: '/中文 [a]', mtime: snapshot.time },
  { type: 'file', path: '/中文 [a]/文件.bin', size: 4, mtime: snapshot.time },
  { type: 'symlink', path: '/link', linktarget: '/outside/private.txt' },
]

async function fixture(t, runner, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiuli-browser-'))
  const pluginDir = path.join(directory, 'source/plugins/backup-plugin')
  const config = normalizeConfig({ backend: 'local', localRepository: path.join(directory, 'repo'), password: 'test-password' }, {
    pluginDir, frameworkDir: path.join(directory, 'source'),
  })
  await fs.mkdir(pluginDir, { recursive: true })
  const service = new BackupService({ pluginDir, configLoader: async () => config, runner, environment: {} })
  const browser = new BackupBrowser({ service, ...options })
  t.after(async () => {
    for (const entry of browser.registry.entries.values()) {
      browser.cancel(entry.id)
      await entry.promise
      await browser.remove(entry.id, true)
    }
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { browser, service, config, directory }
}

async function runner(config, conn, args) {
  if (args[0] === 'snapshots') return { stdout: JSON.stringify([snapshot]) }
  if (args[0] === 'ls') return { stdout: [{ message_type: 'snapshot' }, ...nodes].map(node => JSON.stringify(node)).join('\n') }
  if (args[0] === 'dump') {
    await fs.writeFile(args[args.indexOf('--target') + 1], Buffer.from([0, 255, 10, 13]))
    return { code: 0 }
  }
  assert.fail(`Unexpected command ${args[0]}`)
}

test('snapshot and directory browsing is scoped, paginated and never returns raw snapshot metadata', async t => {
  const { browser } = await fixture(t, async (config, conn, args) => {
    if (args[0] === 'snapshots') {
      assert.ok(args.includes('--host'))
      assert.ok(args.includes('--tag'))
      return { stdout: JSON.stringify(Array.from({ length: 31 }, (_, index) => ({ ...snapshot, id: index.toString(16).padStart(64, '0'), excludes: ['private'], username: 'private' }))) }
    }
    assert.deepEqual(args, ['ls', '--json', '--', '0'.repeat(64), '/'])
    return runner(config, conn, args)
  })
  const first = await browser.snapshots()
  assert.equal(first.items.length, 30)
  assert.equal(first.total, 31)
  assert.equal(first.nextOffset, 30)
  assert.equal((await browser.snapshots(30)).items.length, 1)
  assert.ok(!JSON.stringify(first).includes('private'))
  const files = await browser.files('0'.repeat(64))
  assert.deepEqual(files.items.map(item => item.path), ['/中文 [a]', '/link'])
  assert.equal(files.items[1].downloadable, false)
  assert.throws(() => browser.files('--help'), /快照/)
  assert.throws(() => browser.snapshots(-1), /分页/)
})

test('invalid paths and snapshot IDs are rejected before exporting or accessing host files', async t => {
  const { browser } = await fixture(t, runner)
  for (const value of ['../file', '/a/../file', '/a/./file', '//file', '/a/', '/a\0b', '/a\nb', {}, undefined]) {
    assert.throws(() => snapshotPath(value), /路径无效/)
  }
  assert.equal(snapshotPath('/中文 [a]/文件.bin'), '/中文 [a]/文件.bin')
  await assert.rejects(browser.files('b'.repeat(64)), /未找到/)
  const task = browser.start(id, '/link')
  await browser.get(task.id).promise
  assert.equal((await browser.status(task.id)).status, 'error')
  assert.match((await browser.status(task.id)).error, /符号链接/)
  assert.throws(() => browser.get('../config.json'), /ID 无效/)
  assert.throws(() => browser.get(randomUUID()), /已过期/)
})

test('prepared downloads preserve binary bytes, are private, survive reload, and cannot be deleted during a transfer', async t => {
  const { browser, service } = await fixture(t, runner)
  const task = browser.start(id, '/中文 [a]/文件.bin')
  assert.equal(task.status, 'preparing')
  assert.throws(() => browser.start(id), /已有/)
  await assert.rejects(browser.acquire(task.id), /尚未/)
  await browser.get(task.id).promise
  const reloaded = new BackupBrowser({ service })
  const ready = await reloaded.status(task.id)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.name, '文件.bin')
  assert.equal(ready.bytes, 4)
  assert.ok(!JSON.stringify(ready).includes('.runtime'))
  const lease = await reloaded.acquire(task.id)
  assert.deepEqual(await fs.readFile(lease.target), Buffer.from([0, 255, 10, 13]))
  await assert.rejects(browser.remove(task.id), /正在下载/)
  lease.release()
  lease.release()
  assert.equal(browser.get(task.id).readers, 0)
  await browser.remove(task.id)
  await assert.rejects(fs.access(lease.target))
})

test('failed and cancelled exports remove partial bytes, redact errors and release the backup lock', async t => {
  let entered
  const exporting = new Promise(resolve => { entered = resolve })
  const { browser, service } = await fixture(t, async (config, conn, args, job) => {
    if (args[0] !== 'dump') return runner(config, conn, args)
    const partial = args[args.indexOf('--target') + 1]
    await fs.writeFile(partial, 'partial')
    entered()
    await new Promise((_resolve, reject) => { job.stop = () => reject(new Error('cancelled test-password')) })
  })
  const task = browser.start(id, '/中文 [a]')
  await exporting
  assert.ok((await browser.status(task.id)).bytes > 0)
  await assert.rejects(service.backup(), /已有任务/)
  browser.cancel(task.id)
  await browser.get(task.id).promise
  const entry = browser.get(task.id)
  assert.equal(entry.status, 'cancelled')
  assert.equal(service.state.active, null)
  await assert.rejects(fs.access(entry.directory))
  assert.ok(!JSON.stringify(await browser.status(task.id)).includes('test-password'))
})

test('export failure never exposes a partial download and cache cleanup respects active readers', async t => {
  const { browser } = await fixture(t, async (config, conn, args) => {
    if (args[0] === 'dump') {
      await fs.writeFile(args[args.indexOf('--target') + 1], 'partial-data')
      throw new Error('failed test-password')
    }
    return runner(config, conn, args)
  })
  const task = browser.start(id)
  await browser.get(task.id).promise
  const entry = browser.get(task.id)
  assert.equal(entry.status, 'error')
  assert.ok(!entry.error.includes('test-password'))
  await assert.rejects(browser.acquire(task.id), /尚未/)
  await assert.rejects(fs.access(entry.directory))
  entry.expiresAt = Date.now() - 1
  await browser.cleanup()
  assert.equal(browser.registry.entries.size, 0)
})

test('completed cache expires without deleting files held by a download stream', async t => {
  const { browser } = await fixture(t, runner)
  const task = browser.start(id)
  await browser.get(task.id).promise
  const entry = browser.get(task.id)
  const lease = await browser.acquire(task.id)
  entry.expiresAt = Date.now() - 1
  await browser.cleanup()
  await fs.access(lease.target)
  assert.deepEqual(await browser.listDownloads(), [])
  lease.release()
  await browser.cleanup()
  await assert.rejects(fs.access(lease.target))
  assert.equal(browser.registry.entries.size, 0)
})

test('a progress response racing export completion cannot overwrite final file size', async t => {
  let exporting
  const started = new Promise(resolve => { exporting = resolve })
  let finishExport
  const { browser } = await fixture(t, async (config, conn, args) => {
    if (args[0] !== 'dump') return runner(config, conn, args)
    const target = args[args.indexOf('--target') + 1]
    await fs.writeFile(target, '12')
    exporting()
    await new Promise(resolve => { finishExport = resolve })
    await fs.writeFile(target, Buffer.from([0, 255, 10, 13]))
  })
  const task = browser.start(id, '/中文 [a]/文件.bin')
  await started
  const stat = fs.stat.bind(fs)
  let releasePoll
  let polled
  const polling = new Promise(resolve => { polled = resolve })
  let intercepted = false
  t.mock.method(fs, 'stat', async (...args) => {
    const result = await stat(...args)
    if (!intercepted && args[0].endsWith('payload.part')) {
      intercepted = true
      polled()
      await new Promise(resolve => { releasePoll = resolve })
    }
    return result
  })
  const response = browser.status(task.id)
  await polling
  finishExport()
  await browser.get(task.id).promise
  releasePoll()
  assert.equal((await response).bytes, 4)
  const lease = await browser.acquire(task.id)
  assert.equal(lease.size, 4)
  lease.release()
})

test('starting cache deletion prevents new download leases', async t => {
  const { browser } = await fixture(t, runner)
  const task = browser.start(id)
  await browser.get(task.id).promise
  const remove = browser.removeDirectory.bind(browser)
  let release
  browser.removeDirectory = async directory => { await new Promise(resolve => { release = resolve }); await remove(directory) }
  const deleting = browser.remove(task.id)
  await assert.rejects(browser.acquire(task.id), /已清理/)
  release()
  await deleting
})

function readZip(buffer) {
  // 独立读取 ZIP 中央目录和压缩内容，验证导出确实可解压且内容正确。
  const footer = buffer.length - 22
  assert.equal(buffer.readUInt32LE(footer), 0x06054b50)
  const count = buffer.readUInt16LE(footer + 10)
  let cursor = buffer.readUInt32LE(footer + 16)
  const entries = new Map()
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressed = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extra = buffer.readUInt16LE(cursor + 30)
    const comment = buffer.readUInt16LE(cursor + 32)
    const offset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28)
    const data = buffer.subarray(start, start + compressed)
    assert.ok([0, 8].includes(method))
    entries.set(name, method === 8 ? inflateRawSync(data) : data)
    cursor += 46 + nameLength + extra + comment
  }
  return entries
}

test('real restic browser: list, binary file, Unicode folder ZIP, empty folder ZIP and entire snapshot ZIP', {
  skip: !process.env.TEST_RESTIC_PATH, timeout: 120000,
}, async t => {
  const sandbox = path.join(PLUGIN_DIR, '.runtime')
  const directory = await fs.mkdtemp(path.join(sandbox, 'download-integration-'))
  const source = path.join(directory, 'source')
  const pluginDir = path.join(source, 'plugins/backup-plugin')
  await fs.mkdir(path.join(source, '中文 [a]/空目录'), { recursive: true })
  await fs.mkdir(path.join(source, 'node_modules'), { recursive: true })
  const contents = Buffer.from([0, 1, 128, 255, 10, 13])
  await fs.writeFile(path.join(source, '中文 [a]/文件.bin'), contents)
  await fs.writeFile(path.join(source, 'node_modules/excluded.txt'), 'excluded')
  await fs.writeFile(path.join(source, 'root.txt'), 'root-data')
  const config = normalizeConfig({ backend: 'local', localRepository: path.join(directory, 'repo'),
    resticPath: process.env.TEST_RESTIC_PATH, password: 'integration-password-only', hostname: 'fixture' }, { pluginDir, frameworkDir: source })
  const service = new BackupService({ pluginDir, configLoader: async () => config, environment: {} })
  const browser = new BackupBrowser({ service })
  t.after(async () => {
    for (const entry of browser.registry.entries.values()) { clearTimeout(entry.timer); await entry.promise }
    browser.registry.entries.clear()
    assert.ok(path.resolve(directory).startsWith(path.resolve(sandbox) + path.sep))
    await fs.rm(directory, { recursive: true, force: true })
  })
  await service.init()
  const { snapshotId } = await service.backup()
  const snapshots = await browser.snapshots()
  assert.equal(snapshots.items[0].id, snapshotId)
  const root = await browser.files(snapshotId)
  assert.ok(root.items.some(item => item.path === '/中文 [a]' && item.type === 'dir'))
  assert.ok(!root.items.some(item => item.path === '/node_modules'))
  const folder = await browser.files(snapshotId, '/中文 [a]')
  assert.equal(folder.items.length, 2)
  for (const selected of ['/中文 [a]/文件.bin', '/中文 [a]', '/中文 [a]/空目录', '/']) {
    const task = browser.start(snapshotId, selected)
    await browser.get(task.id).promise
    const result = await browser.status(task.id)
    assert.equal(result.status, 'ready', result.error)
    const lease = await browser.acquire(task.id)
    const data = await fs.readFile(lease.target)
    if (selected.endsWith('.bin')) assert.deepEqual(data, contents)
    else {
      assert.ok(result.name.endsWith('.zip'))
      const entries = readZip(data)
      if (selected !== '/中文 [a]/空目录') assert.deepEqual([...entries].find(([name]) => name.endsWith('文件.bin'))?.[1], contents)
      if (selected === '/') assert.equal(entries.get('root.txt')?.toString(), 'root-data')
      assert.ok(![...entries.keys()].some(name => name.includes('node_modules') || name.includes('downloads')))
    }
    lease.release()
    await browser.remove(task.id)
  }
})
