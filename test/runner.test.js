import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { runRestic } from '../lib/runner.js'

const config = { resticPath: 'restic', frameworkDir: process.cwd(), timeoutMinutes: 1 }
const conn = { args: [], env: process.env, secrets: ['test-secret'] }
const processFor = script => (file, args, options) => {
  assert.equal(options.shell, false)
  assert.equal(options.stdio[0], 'ignore')
  return spawn(process.execPath, ['-e', script], options)
}

test('streaming backup JSON handles fragmented UTF-8, progress, summary, partial errors', async () => {
  const job = {}
  const result = await runRestic(config, conn, ['backup'], job, {
    json: true,
    spawnProcess: processFor(`
      process.stdout.write('{"message_type":"status","percent_done":0.5}\\n');
      process.stdout.write('{"message_type":"sum');
      process.stdout.write('mary","snapshot_id":"abc"}\\n');
      process.stderr.write('file 例子 failed test-secret');
      process.exitCode = 3;
    `),
  })
  assert.equal(result.code, 3)
  assert.equal(result.summary.snapshot_id, 'abc')
  assert.equal(job.progress.percent, 0.5)
  assert.match(result.stderr, /例子/)
  assert.ok(!result.stderr.includes('test-secret'))
  assert.equal(job.child, null)
})

test('non-zero exit is rejected and secrets are redacted', async () => {
  await assert.rejects(runRestic(config, conn, ['check'], {}, {
    spawnProcess: processFor("process.stderr.write('test-secret failed'); process.exitCode=3"),
  }), error => error.code === 3 && !error.message.includes('test-secret'))
})

test('output limit and timeout actually terminate child processes', async () => {
  await assert.rejects(runRestic(config, conn, ['snapshots'], {}, {
    maxBytes: 100,
    spawnProcess: processFor("process.stdout.write('x'.repeat(1000));setInterval(()=>{},1000)"),
  }), error => error.code === 'OUTPUT_LIMIT')
  await assert.rejects(runRestic({ ...config, timeoutMinutes: 0.002 }, conn, ['check'], {}, {
    spawnProcess: processFor('setInterval(()=>{},1000)'),
  }), error => error.code === 'TIMEOUT')
})

test('cancel terminates child and pre-cancelled jobs never spawn', async () => {
  await assert.rejects(runRestic(config, conn, ['check'], { cancelled: true }, {
    spawnProcess: () => assert.fail('must not spawn'),
  }), error => error.code === 'CANCELLED')
  const job = {}
  const promise = runRestic(config, conn, ['check'], job, { spawnProcess: processFor('setInterval(()=>{},1000)') })
  job.cancelled = true
  job.stop()
  await assert.rejects(promise, error => error.code === 'CANCELLED')
  assert.equal(job.child, null)
})

test('missing executable is actionable and releases process handle', async () => {
  const job = {}
  await assert.rejects(runRestic({ ...config, resticPath: 'nonexistent-restic-jiuli-abc123' }, conn, ['init'], job), /找不到 restic/)
  assert.equal(job.child, null)
})
