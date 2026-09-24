import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { normalizeConfig, connection, PLUGIN_DIR } from '../lib/config.js'
import { BackupService } from '../lib/service.js'
import { runRestic } from '../lib/runner.js'

const binary = process.env.TEST_RESTIC_PATH
test('real restic: exclusions, block dedup, logical full snapshots, delete history, verified restore', { skip: !binary, timeout: 120_000 }, async t => {
  const sandbox = path.join(PLUGIN_DIR, '.runtime')
  await fs.mkdir(sandbox, { recursive: true })
  const directory = await fs.mkdtemp(path.join(sandbox, 'integration-[中文 空格]-'))
  t.after(async () => {
    // 只删除本测试创建且经绝对路径校验的隔离目录。
    assert.ok(path.resolve(directory).startsWith(path.resolve(sandbox) + path.sep))
    await fs.rm(directory, { recursive: true, force: true })
  })
  const source = path.join(directory, 'source')
  const pluginDir = path.join(source, 'plugins', 'backup-plugin')
  const config = normalizeConfig({
    resticPath: path.resolve(binary), backend: 'local', localRepository: path.join(directory, 'repo'),
    password: 'integration-password-only', hostname: 'integration', snapshotTag: 'integration',
  }, { pluginDir, frameworkDir: source })
  const write = async (name, contents = name) => {
    const target = path.join(source, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, contents)
  }
  const excluded = [
    'node_modules/hidden.txt', 'plugins/a/node_modules/hidden.txt', 'logs/hidden.txt', 'temp/hidden.txt',
    'data/upload_tmp/hidden.txt', 'data/memes/hidden.txt', 'plugins/backup-plugin/.runtime/cache/hidden.txt',
  ]
  for (const name of excluded) await write(name)
  await write('app.js', 'original-app')
  await write('data/keep.txt', 'keep-data')
  await write('data/old.txt', 'historical-file')
  await write('config/bot.json', '{"bot":"example"}')
  const content = randomBytes(16 * 1024 * 1024)
  await write('data/large.bin', content)
  const service = new BackupService({ pluginDir, configLoader: async () => config, environment: {} })
  const conn = await connection(config, {})
  await service.init()
  assert.deepEqual((await service.snapshots()).snapshots, [])
  const first = await service.backup()
  assert.equal(first.partial, false)
  assert.equal(first.summary.total_files_processed, 5)
  const second = await service.backup()
  assert.notEqual(first.snapshotId, second.snapshotId)
  assert.equal(second.summary.data_blobs, 0, 'unchanged content must not add data blocks')
  assert.ok(second.summary.data_added < 8192, 'unchanged snapshot only adds small metadata, if any')
  // 修改一个大文件的极少内容；大多数块应被复用。
  content[8 * 1024 * 1024] ^= 0xff
  await write('data/large.bin', content)
  await write('app.js', 'changed-app')
  const removed = path.resolve(source, 'data/old.txt')
  assert.ok(removed.startsWith(path.resolve(source) + path.sep))
  await fs.unlink(removed)
  const third = await service.backup()
  // 块边界由仓库随机多项式决定，允许一个最大块加元数据，避免随机测试误报。
  assert.ok(third.summary.data_added < content.length * 0.75, `changed backup added ${third.summary.data_added} bytes`)
  const list = (await service.snapshots()).snapshots
  assert.equal(list.length, 3)
  assert.equal(list[0].id, third.snapshotId)
  // ls 检查最新快照仍包含全部未排除文件，而不是仅包含差异。
  const listing = await runRestic(config, conn, ['ls', '--json', third.snapshotId], {})
  const files = listing.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(item => item.type === 'file').map(item => item.path)
  assert.equal(files.length, 4)
  for (const name of ['app.js', 'data/keep.txt', 'config/bot.json', 'data/large.bin']) {
    assert.ok(files.some(filename => filename.endsWith('/' + name)), `missing ${name}`)
  }
  for (const name of excluded) assert.ok(!files.some(filename => filename.endsWith('/' + name)), `included ${name}`)
  const restored = await service.restore('latest')
  const allFiles = async folder => {
    const entries = await fs.readdir(folder, { withFileTypes: true })
    const items = await Promise.all(entries.map(entry => entry.isDirectory() ? allFiles(path.join(folder, entry.name)) : [path.join(folder, entry.name)]))
    return items.flat()
  }
  const restoredFiles = await allFiles(restored.target)
  assert.equal(restoredFiles.length, 4)
  assert.equal(await fs.readFile(restoredFiles.find(filename => filename.endsWith('app.js')), 'utf8'), 'changed-app')
  const largeRestored = await fs.readFile(restoredFiles.find(filename => filename.endsWith('large.bin')))
  const digest = buffer => createHash('sha256').update(buffer).digest('hex')
  assert.equal(digest(largeRestored), digest(content))
  const oldRestored = await service.restore(first.snapshotId)
  const oldFiles = await allFiles(oldRestored.target)
  assert.equal(await fs.readFile(oldFiles.find(filename => filename.endsWith('old.txt')), 'utf8'), 'historical-file')
  await service.check()
  await runRestic(config, conn, ['check', '--read-data'], {})
  t.diagnostic(`first=${first.summary.data_added}B unchanged=${second.summary.data_added}B changed=${third.summary.data_added}B; 3 snapshots, restores verified`)
})
