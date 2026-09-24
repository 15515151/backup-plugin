import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'
import { createDiagnostics } from '../lib/diagnostics.js'

const config = normalizeConfig({
  oss: { bucket: 'backup-bucket', prefix: 'jiuli/bot', accessKeyId: 'example-id', accessKeySecret: 'example-secret' },
})
const now = () => new Date('2026-09-24T01:02:03Z')
const emptyBucket = () => new Response('<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><KeyCount>0</KeyCount></ListBucketResult>')

test('restic diagnostic needs no repository and does not inherit repository credentials or echo output', async () => {
  const diagnostics = createDiagnostics({
    environment: { PATH: 'bin', RESTIC_PASSWORD_COMMAND: 'bad-command', RESTIC_PASSWORD: 'private', AWS_SECRET_ACCESS_KEY: 'private', AWS_SESSION_TOKEN: 'private' },
    restic: async (candidate, conn, args, job, options) => {
      assert.equal(candidate.timeoutMinutes, 10 / 60)
      assert.deepEqual(conn.args, [])
      assert.deepEqual(conn.env, { PATH: 'bin' })
      assert.deepEqual(args, ['version'])
      assert.equal(options.maxBytes, 16384)
      assert.equal(job.cancelled, undefined)
      return { stdout: 'restic 0.19.1 compiled with go1.25.0 on windows/amd64\nprivate-output' }
    },
  })
  const result = await diagnostics.test('restic', config)
  assert.equal(result.version, '0.19.1')
  assert.match(result.message, /可用/)
  assert.ok(result.elapsedMs >= 0)
  assert.ok(!JSON.stringify(result).includes('private'))
})

test('restic errors are actionable and unexpected output is never exposed', async () => {
  for (const [code, expected] of [['ENOENT', /找不到/], ['EACCES', /执行权限/], ['ENOEXEC', /linux_amd64/], ['TIMEOUT', /10 秒/], ['OUTPUT_LIMIT', /超过限制/], [1, /执行失败/]]) {
    const diagnostics = createDiagnostics({ environment: {}, restic: async () => { throw Object.assign(new Error('private-output'), { code }) } })
    await assert.rejects(diagnostics.test('restic', config), error => expected.test(error.message) && !error.message.includes('private'))
  }
  const diagnostics = createDiagnostics({ restic: async () => ({ stdout: 'some-other-program private-output' }) })
  await assert.rejects(diagnostics.test('restic', config), /未返回有效的 restic 版本/)
})

test('real restic version works before OSS credentials or password are configured', { skip: !process.env.TEST_RESTIC_PATH }, async () => {
  const candidate = normalizeConfig({ resticPath: process.env.TEST_RESTIC_PATH })
  const result = await createDiagnostics().test('restic', candidate)
  assert.match(result.version, /^\d+\.\d+\.\d+/)
})

test('OSS test signs a bounded read-only list request and accepts an uninitialized empty bucket', async () => {
  const diagnostics = createDiagnostics({ environment: {}, now, fetchImpl: async (url, options) => {
    assert.equal(url.href, 'https://backup-bucket.oss-cn-hangzhou.aliyuncs.com/?list-type=2&max-keys=1&prefix=jiuli%2Fbot%2F')
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'manual')
    assert.equal(options.body, undefined)
    // 固定请求向量，签名另用 Python hashlib / hmac 独立计算。
    assert.equal(options.headers.authorization, 'AWS4-HMAC-SHA256 Credential=example-id/20260924/oss-cn-hangzhou/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=7e0092d13aee78b37146bdf01cf18ab9fb3cdf255b3e5bd13d4bd8414c2d4d52')
    assert.equal(options.headers['x-amz-date'], '20260924T010203Z')
    return emptyBucket()
  } })
  const result = await diagnostics.test('oss', config)
  assert.match(result.message, /连接正常/)
  assert.match(result.message, /尚未验证对象读写、删除权限或仓库密码/)
  assert.ok(!JSON.stringify(result).includes('example-secret'))
})

test('OSS uses environment credentials and signed STS token; internal endpoint and root prefix work', async () => {
  const candidate = normalizeConfig({ oss: { ...config.oss, endpoint: 'https://oss-cn-hangzhou-internal.aliyuncs.com', prefix: '' } })
  const diagnostics = createDiagnostics({
    environment: { AWS_ACCESS_KEY_ID: 'env-id', AWS_SECRET_ACCESS_KEY: 'env-secret', AWS_SESSION_TOKEN: 'env-token' }, now,
    fetchImpl: async (url, options) => {
      assert.equal(url.host, 'backup-bucket.oss-cn-hangzhou-internal.aliyuncs.com')
      assert.equal(url.searchParams.get('prefix'), '')
      assert.match(options.headers.authorization, /Credential=env-id\//)
      assert.match(options.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/)
      assert.equal(options.headers['x-amz-security-token'], 'env-token')
      assert.ok(!JSON.stringify(options.headers).includes('example-'))
      return new Response('<ListBucketResult><Contents><Key>private-filename</Key></Contents></ListBucketResult>')
    },
  })
  const result = await diagnostics.test('oss', candidate)
  assert.ok(!JSON.stringify(result).includes('private-filename'))
  assert.ok(!JSON.stringify(result).includes('env-token'))
})

test('invalid OSS fields and missing credentials fail before any network request', async () => {
  const diagnostics = createDiagnostics({ environment: {}, fetchImpl: () => assert.fail('must not access network') })
  for (const oss of [
    { bucket: '' }, { region: 'invalid' }, { prefix: '../escape' }, { endpoint: 'http://oss-cn-hangzhou.aliyuncs.com' },
    { endpoint: 'https://example.com' }, { endpoint: 'https://oss-cn-hangzhou.aliyuncs.com.attacker.invalid' },
    { accessKeyId: '' }, { accessKeySecret: '' },
  ]) await assert.rejects(diagnostics.test('oss', normalizeConfig({ oss: { ...config.oss, ...oss } })))
})

test('OSS failures distinguish credentials, permissions, bucket, clock, token and region without echoing XML', async () => {
  for (const [status, code, expected] of [
    [403, 'AccessDenied', /oss:ListObjects/], [403, 'InvalidAccessKeyId', /ID 无效/],
    [403, 'SignatureDoesNotMatch', /Secret/], [404, 'NoSuchBucket', /不存在/],
    [403, 'RequestTimeTooSkewed', /时间/], [403, 'SecurityTokenExpired', /已过期/],
    [403, 'InvalidSecurityToken', /Token 无效/], [400, 'AuthorizationHeaderMalformed', /地域/],
    [301, 'PermanentRedirect', /地域/], [503, 'ServiceUnavailable', /重试/],
  ]) {
    let calls = 0
    const diagnostics = createDiagnostics({ environment: {}, fetchImpl: async () => {
      calls++
      return new Response(`<Error><Code>${code}</Code><Message>private-secret</Message><RequestId>private-request-id</RequestId></Error>`, {
        status, headers: { Location: 'https://attacker.invalid/' },
      })
    } })
    await assert.rejects(diagnostics.test('oss', config), error => expected.test(error.message) && !error.message.includes('private'))
    assert.equal(calls, 1)
  }
})

test('OSS unexpected responses, excessive bodies, DNS and TLS failures stay bounded and private', async () => {
  for (const [fetchImpl, expected] of [
    [async () => new Response('<html>private-secret</html>'), /非预期内容/],
    [async () => new Response('x'.repeat(32769)), /超过测试限制/],
    [async () => { throw Object.assign(new Error('private-secret'), { cause: { code: 'ENOTFOUND' } }) }, /DNS/],
    [async () => { throw Object.assign(new Error('private-secret'), { cause: { code: 'CERT_HAS_EXPIRED' } }) }, /证书/],
    [async () => { throw new Error('private-secret') }, /网络/],
  ]) await assert.rejects(createDiagnostics({ environment: {}, fetchImpl }).test('oss', config), error => expected.test(error.message) && !error.message.includes('private'))
})

test('OSS timeout covers waiting for response headers and streaming response body', async () => {
  const blocked = signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  for (const fetchImpl of [
    (_url, { signal }) => blocked(signal),
    async (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
    } })),
  ]) await assert.rejects(createDiagnostics({ environment: {}, fetchImpl, timeoutMs: 30 }).test('oss', config), /测试超时/)
})

test('concurrent diagnostics are rejected across service instances and the lock clears after failures', async () => {
  let finish
  const first = createDiagnostics({ environment: {}, fetchImpl: () => new Promise(resolve => { finish = resolve }) })
  const second = createDiagnostics({ environment: {}, fetchImpl: async () => emptyBucket() })
  const pending = first.test('oss', config)
  await assert.rejects(second.test('oss', config), error => error.code === 'BUSY')
  finish(new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }))
  await assert.rejects(pending, /访问被拒绝/)
  assert.match((await second.test('oss', config)).message, /连接正常/)
})
