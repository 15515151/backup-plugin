import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeConfig } from '../lib/config.js'
import { BackupService } from '../lib/service.js'

const id = 'a'.repeat(64)
async function fixture(t, runner) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiuli-service-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const pluginDir = path.join(directory, 'source/plugins/backup-plugin')
  const config = normalizeConfig({ backend: 'local', localRepository: path.join(directory, 'repo'), password: 'test-password' }, {
    pluginDir, frameworkDir: path.join(directory, 'source'),
  })
  const options = { pluginDir, configLoader: async () => config, runner, environment: {} }
  return { service: new BackupService(options), options, config }
}

test('backup preserves full snapshots and reports restic partial exit code 3', async t => {
  const { service } = await fixture(t, async (config, conn, args) => {
    assert.equal(args[0], 'backup')
    assert.deepEqual(args.slice(-2), ['--', '.'])
    assert.equal(args.includes('--skip-if-unchanged'), false)
    for (const exclude of ['node_modules', 'logs', 'temp', 'data/upload_tmp', 'data/memes']) assert.ok(args.includes(exclude))
    return { code: 3, summary: { snapshot_id: id }, stderr: 'unreadable file' }
  })
  const result = await service.backup()
  assert.equal(result.partial, true)
  assert.equal(result.snapshotId, id)
  assert.equal(service.state.last.status, 'partial')
  assert.equal(service.state.active, null)
})

test('concurrent and reloaded service instances share task lock; failures release it', async t => {
  let release
  const waiting = new Promise(resolve => { release = resolve })
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const { service, options } = await fixture(t, async () => {
    entered()
    await waiting
    throw new Error('failed with test-password')
  })
  const pending = service.backup()
  await started
  const reloaded = new BackupService(options)
  await assert.rejects(reloaded.backup(), /已有任务/)
  release()
  await assert.rejects(pending, error => !error.message.includes('test-password') && error.message.includes('[已隐藏]'))
  assert.equal(service.state.active, null)
  assert.equal(reloaded.state.last.status, 'error')
})

test('missing backup summary is not treated as success', async t => {
  const { service } = await fixture(t, async () => ({ code: 0, summary: null }))
  await assert.rejects(service.backup(), /快照 ID/)
  assert.equal(service.state.last.status, 'error')
})

test('restore selects scoped latest snapshot and creates unique non-overwriting targets', async t => {
  const targets = []
  const old = 'b'.repeat(64)
  const { service, config } = await fixture(t, async (cfg, conn, args) => {
    if (args[0] === 'snapshots') {
      assert.ok(args.includes('--host'))
      assert.ok(args.includes('--tag'))
      return { stdout: JSON.stringify([{ id: old, time: '2025-01-01' }, { id, time: '2026-01-01' }]) }
    }
    assert.equal(args[0], 'restore')
    assert.equal(args[1], id)
    assert.ok(args.includes('--verify'))
    targets.push(args[args.indexOf('--target') + 1])
    return { code: 0 }
  })
  await service.restore('latest')
  await service.restore(id.slice(0, 8))
  assert.notEqual(targets[0], targets[1])
  assert.ok(targets.every(target => target.startsWith(path.join(config.runtimeDir, 'restores'))))
  await assert.rejects(service.restore('--delete'), /恢复格式/)
  await assert.rejects(service.restore('../source'), /恢复格式/)
  await assert.rejects(service.restore('c'.repeat(8)), /未找到/)
})

test('ambiguous snapshot prefix never starts restore', async t => {
  const { service } = await fixture(t, async (config, conn, args) => {
    assert.equal(args[0], 'snapshots')
    return { stdout: JSON.stringify([{ id, time: '2026-01-01' }, { id: 'a'.repeat(63) + 'b', time: '2026-01-02' }]) }
  })
  await assert.rejects(service.restore('aaaaaaaa'), /不唯一/)
})

test('cancel requests process termination without clearing the lock early', async t => {
  let stopCalled = false
  let finish
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const { service } = await fixture(t, async (config, conn, args, job) => {
    job.stop = () => { stopCalled = true }
    entered()
    await new Promise(resolve => { finish = resolve })
    throw new Error('任务已取消')
  })
  assert.equal(service.cancel(), false)
  const pending = service.check()
  await started
  assert.equal(service.cancel(), true)
  assert.equal(stopCalled, true)
  assert.ok(service.state.active)
  finish()
  await assert.rejects(pending, /取消/)
  assert.equal(service.state.active, null)
  assert.equal(service.state.last.status, 'cancelled')
})

test('web status sees an existing shared task without loading config, taking the lock or exposing process objects', async t => {
  let release
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let runs = 0
  const { service, options } = await fixture(t, async (_config, _conn, _args, job) => {
    runs++
    job.phase = '读取并备份文件'
    job.progress = { percent: 0.4, filesDone: 4, totalFiles: 10, bytesDone: 400, totalBytes: 1000, secondsRemaining: 12, private: 'test-password' }
    job.child = { circular: job, secret: 'test-password' }
    entered()
    await new Promise(resolve => { release = resolve })
    return { code: 3, summary: { snapshot_id: id }, stderr: 'some files unreadable' }
  })
  const pending = service.backup()
  await started
  const reloaded = new BackupService({ ...options, configLoader: () => assert.fail('status must not load changed or invalid config') })
  const status = await reloaded.taskStatus()
  assert.equal(status.active.id, service.state.active.id)
  assert.equal(status.active.name, '备份')
  assert.equal(status.active.phase, '读取并备份文件')
  assert.equal(status.active.progress.percent, 0.4)
  assert.equal(status.active.progress.secondsRemaining, 12)
  assert.ok(status.active.elapsedSeconds >= 0)
  assert.ok(!JSON.stringify(status).includes('test-password'))
  assert.equal(status.config, undefined)
  assert.equal(status.active.child, undefined)
  assert.equal(runs, 1)
  service.cancel()
  assert.equal((await reloaded.taskStatus()).active.cancelled, true)
  release()
  await pending
  const completed = await reloaded.taskStatus()
  assert.equal(completed.active, null)
  assert.equal(completed.last.status, 'partial')
  assert.equal(completed.last.snapshotId, id)
})

test('web status reads safe last-result metadata without requiring repository credentials', async t => {
  const { service, config } = await fixture(t, () => assert.fail('no child process should be created'))
  await fs.mkdir(config.runtimeDir, { recursive: true })
  await fs.writeFile(path.join(config.runtimeDir, 'last-result.json'), JSON.stringify({
    name: '备份', status: 'error', startedAt: '2026-09-24T00:00:00Z', finishedAt: '2026-09-24T00:01:00Z',
    error: '凭据无效', config: { password: 'private-secret' }, target: '/private/path',
  }))
  service.configLoader = () => assert.fail('status does not depend on configured credentials')
  const result = await service.taskStatus()
  assert.equal(result.active, null)
  assert.equal(result.last.error, '凭据无效')
  assert.ok(!JSON.stringify(result).includes('private'))
  service.state.active = { name: '仓库检查', startedAt: 'invalid', progress: { percent: NaN, filesDone: -5, totalFiles: Infinity } }
  const checking = await service.taskStatus()
  assert.equal(checking.active.elapsedSeconds, null)
  assert.equal(checking.active.progress.percent, null)
  assert.equal(checking.active.progress.filesDone, null)
  assert.equal(checking.active.progress.totalFiles, null)
  service.state.active = null
})
