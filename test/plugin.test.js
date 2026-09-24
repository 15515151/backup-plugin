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

test('scheduled task uses a callable bound function, disabling schedule prevents execution', async () => {
  let enabled = true
  let calls = 0
  const Plugin = createBackupPlugin(BasePlugin, {
    service: { state: {}, backup: async () => { calls++; return { snapshotId: summary.snapshot_id, summary } } },
    ensure: async () => {}, load: async () => ({ schedule: { enabled, cron: '0 0 4 * * *' } }), log: () => {},
  })
  const plugin = new Plugin()
  await plugin.onLoad()
  assert.equal(plugin.task.length, 1)
  await plugin.task[0].fnc()
  enabled = false
  await plugin.task[0].fnc()
  assert.equal(calls, 1)
})

test('bad configuration keeps commands loaded without a schedule', async () => {
  const logs = []
  const Plugin = createBackupPlugin(BasePlugin, {
    ensure: async () => {}, load: async () => { throw new Error('bad config') }, log: (level, text) => logs.push(text),
  })
  const plugin = new Plugin()
  await plugin.onLoad()
  assert.equal(plugin.task.length, 0)
  assert.equal(plugin.rule.length, 1)
  assert.match(logs[0], /bad config/)
})
