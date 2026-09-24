import test from 'node:test'
import assert from 'node:assert/strict'
import { createBackupPlugin } from '../lib/plugin.js'

class BasePlugin { constructor(options) { Object.assign(this, options) } }
const summary = { snapshot_id: 'a'.repeat(64), total_files_processed: 2, data_added: 1 }

test('all commands require master, with handler defense as well as framework rule', async () => {
  let invoked = false
  const Plugin = createBackupPlugin(BasePlugin, { service: { state: {}, backup: () => { invoked = true } } })
  const plugin = new Plugin()
  assert.ok(plugin.rule.every(rule => rule.permission === 'master'))
  assert.equal(await plugin.handle({ msg: '#备份', isMaster: false, reply: () => assert.fail('unauthorized reply') }), false)
  assert.equal(invoked, false)
})

test('async command replies remain bound to the original event', async () => {
  let resolveBackup
  const pending = new Promise(resolve => { resolveBackup = resolve })
  const Plugin = createBackupPlugin(BasePlugin, { service: { state: {}, backup: () => pending } })
  const plugin = new Plugin()
  const first = []
  const second = []
  const e1 = { msg: '#备份', isMaster: true, reply: async text => first.push(text) }
  const e2 = { msg: '#备份帮助', isMaster: true, reply: async text => second.push(text) }
  plugin.e = e1
  const work = plugin.handle(e1)
  plugin.e = e2
  await plugin.handle(e2)
  resolveBackup({ snapshotId: summary.snapshot_id, summary, partial: false })
  await work
  assert.equal(first.length, 2)
  assert.match(first[1], /备份完成/)
  assert.equal(second.length, 1)
  assert.match(second[0], /仅机器人主人/)
})

test('scheduled task uses a callable bound function, disabling schedule prevents execution', async t => {
  let enabled = true
  let calls = 0
  let callback
  const Plugin = createBackupPlugin(BasePlugin, {
    service: { state: {}, backup: async () => { calls++; return { snapshotId: summary.snapshot_id, summary } } },
    ensure: async () => {}, load: async () => ({ schedule: { enabled, cron: '0 0 4 * * *' } }), log: () => {},
    createJob: async (_cron, fn) => { callback = fn; return { cancel() {} } },
  })
  const plugin = new Plugin()
  t.after(() => plugin.onUnload())
  await plugin.onLoad()
  assert.ok(plugin.scheduledJob)
  await callback()
  enabled = false
  await callback()
  assert.equal(calls, 1)
})

test('bad configuration keeps commands loaded without a schedule', async t => {
  const logs = []
  const Plugin = createBackupPlugin(BasePlugin, {
    ensure: async () => {}, load: async () => { throw new Error('bad config') }, log: (level, text) => logs.push(text),
  })
  const plugin = new Plugin()
  t.after(() => plugin.onUnload())
  await plugin.onLoad()
  assert.equal(plugin.task.length, 0)
  assert.equal(plugin.rule.length, 1)
  assert.match(logs[0], /bad config/)
})

test('panel saves apply schedule changes and unload removes job and subscription', async () => {
  let notify
  let removed = false
  let config = { schedule: { enabled: false, cron: '0 0 4 * * *' } }
  const jobs = []
  const Plugin = createBackupPlugin(BasePlugin, {
    ensure: async () => {}, load: async () => config, log: () => {},
    subscribe: callback => { notify = callback; return () => { removed = true } },
    createJob: async cron => {
      const job = { cron, cancelled: false, cancel() { this.cancelled = true } }
      jobs.push(job)
      return job
    },
  })
  const plugin = new Plugin()
  await plugin.onLoad()
  assert.equal(jobs.length, 0)
  config.schedule.enabled = true
  await notify()
  config.schedule.cron = '0 0 5 * * *'
  await notify()
  assert.equal(jobs[0].cancelled, true)
  assert.equal(jobs[1].cron, '0 0 5 * * *')
  config.schedule.enabled = false
  await notify()
  assert.equal(jobs[1].cancelled, true)
  config.schedule.enabled = true
  await notify()
  plugin.onUnload()
  assert.equal(jobs[2].cancelled, true)
  assert.equal(removed, true)
})

test('a delayed schedule creation cannot survive plugin unload', async () => {
  let finish
  let started
  const creating = new Promise(resolve => { started = resolve })
  let cancelled = false
  const Plugin = createBackupPlugin(BasePlugin, {
    ensure: async () => {}, load: async () => ({ schedule: { enabled: true, cron: '0 0 4 * * *' } }),
    subscribe: () => () => {}, log: () => {},
    createJob: async () => { started(); return new Promise(resolve => { finish = resolve }) },
  })
  const plugin = new Plugin()
  const loading = plugin.onLoad()
  await creating
  plugin.onUnload()
  finish({ cancel() { cancelled = true } })
  await loading
  assert.equal(cancelled, true)
  assert.equal(plugin.scheduledJob, null)
})
