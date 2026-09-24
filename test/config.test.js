import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { normalizeConfig, connection, redact, loadConfig, isWithin, literalPattern, DEFAULT_EXCLUDES } from '../lib/config.js'

const options = { pluginDir: path.resolve('plugins/backup-plugin'), frameworkDir: path.resolve('.') }
const oss = { bucket: 'test-bucket', accessKeyId: 'test-access-id', accessKeySecret: 'test-access-secret' }

test('OSS uses restic native S3 backend, virtual-host addressing and OSS region', async () => {
  const config = normalizeConfig({ password: 'repo-password', oss }, options)
  const conn = await connection(config, {})
  assert.ok(conn.args.includes('s3:https://oss-cn-hangzhou.aliyuncs.com/test-bucket/jiuli'))
  assert.ok(conn.args.includes('s3.bucket-lookup=dns'))
  assert.ok(conn.args.includes('s3.region=oss-cn-hangzhou'))
  assert.equal(conn.env.AWS_ACCESS_KEY_ID, oss.accessKeyId)
  assert.equal(conn.env.AWS_SECRET_ACCESS_KEY, oss.accessKeySecret)
  assert.equal(conn.env.RESTIC_PASSWORD, 'repo-password')
  assert.ok(!conn.args.join(' ').includes('repo-password'))
  assert.ok(!conn.args.join(' ').includes(oss.accessKeySecret))
})

test('environment credentials override config, restic command/repository injection is removed', async () => {
  const config = normalizeConfig({ password: 'config-password', oss }, options)
  const conn = await connection(config, {
    PATH: '/tools', RESTIC_PASSWORD: 'env-password', RESTIC_REPOSITORY: 'wrong',
    RESTIC_PASSWORD_COMMAND: 'do-not-run', RESTIC_REPOSITORY_FILE: 'wrong',
    AWS_ACCESS_KEY_ID: 'env-id', AWS_SECRET_ACCESS_KEY: 'env-secret', AWS_SESSION_TOKEN: 'token',
  })
  assert.equal(conn.env.RESTIC_PASSWORD, 'env-password')
  assert.equal(conn.env.AWS_ACCESS_KEY_ID, 'env-id')
  assert.equal(conn.env.AWS_SESSION_TOKEN, 'token')
  assert.equal(conn.env.RESTIC_PASSWORD_COMMAND, undefined)
  assert.equal(conn.env.RESTIC_REPOSITORY, undefined)
  assert.equal(conn.env.RESTIC_REPOSITORY_FILE, undefined)
  assert.equal(conn.env.PATH, '/tools')
})

test('default excludes always present, extra excludes cannot reinclude them', () => {
  const config = normalizeConfig({ extraExcludes: ['.git'] }, options)
  for (const name of DEFAULT_EXCLUDES) assert.ok(config.excludes.includes(name))
  assert.ok(config.excludes.includes(literalPattern(config.runtimeDir)))
  assert.ok(config.excludes.includes('.git'))
  assert.throws(() => normalizeConfig({ extraExcludes: ['!node_modules'] }, options), /反选/)
})

test('reject malformed config and unsafe OSS endpoints', async () => {
  for (const input of [null, [], { oss: [] }, { schedule: 'cron' }, { timeoutMinutes: -1 }, { extraExcludes: 'logs' }, { snapshotTag: 'a,b' }, { schedule: { enabled: 'false' } }]) {
    assert.throws(() => normalizeConfig(input, options))
  }
  for (const endpoint of ['http://oss-cn-hangzhou.aliyuncs.com', 'https://id:secret@example.com', 'https://example.com/bucket']) {
    await assert.rejects(connection(normalizeConfig({ password: 'password', oss: { ...oss, endpoint } }, options), {}), /Endpoint/)
  }
  await assert.rejects(connection(normalizeConfig({ oss }, options), {}), /仓库密码/)
  await assert.rejects(connection(normalizeConfig({ password: 'password', oss: { ...oss, bucket: '' } }, options), {}), /bucket/)
  for (const cron of ['n o t a cron', '0 90 4 * * *', '*/0 * * * *', '0 4 * 13 *']) {
    assert.throws(() => normalizeConfig({ schedule: { cron } }, options), /cron/)
  }
})

test('local repository cannot overlap the source', async () => {
  for (const repository of [options.frameworkDir, path.join(options.frameworkDir, 'repo'), path.dirname(options.frameworkDir)]) {
    const config = normalizeConfig({ backend: 'local', password: 'password', localRepository: repository }, options)
    await assert.rejects(connection(config, {}), /机器人目录/)
  }
  assert.equal(isWithin('/foo/bar', '/foo/barley'), false)
})

test('password file works, JSON errors do not expose source credentials', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiuli-config-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(path.join(directory, 'password'), 'file-secret\r\n')
  const config = normalizeConfig({ oss, passwordFile: 'password' }, { ...options, pluginDir: directory })
  assert.equal((await connection(config, {})).env.RESTIC_PASSWORD, 'file-secret')
  await fs.writeFile(path.join(directory, 'config.json'), '{"password":"super-secret",broken}')
  await assert.rejects(loadConfig({ pluginDir: directory }), error => !error.message.includes('super-secret') && /JSON/.test(error.message))
  assert.equal(redact('super-secret / access-secret', ['super-secret', 'access-secret']), '[已隐藏] / [已隐藏]')
})
