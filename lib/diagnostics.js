import { createHash, createHmac } from 'node:crypto'
import { ossCredentials, ossRepository } from './config.js'
import { runRestic } from './runner.js'

const active = globalThis[Symbol.for('jiuli.backup-plugin.diagnostics')] ??= new Set()
const sha256 = value => createHash('sha256').update(value).digest('hex')
const hmac = (key, value) => createHmac('sha256', key).update(value).digest()
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

class DiagnosticError extends Error {}

async function testRestic(config, { environment, restic, timeoutMs }) {
  const env = { ...environment }
  for (const key of Object.keys(env)) {
    if (/^(RESTIC_|AWS_)/i.test(key)) delete env[key]
  }
  let result
  try {
    result = await restic({ ...config, timeoutMinutes: timeoutMs / 60000 }, { args: [], env, secrets: [] }, ['version'], {}, { maxBytes: 16384 })
  } catch (error) {
    const messages = {
      ENOENT: '找不到 restic，请安装 restic 并检查可执行文件路径或机器人进程的 PATH',
      EACCES: 'restic 没有执行权限；Linux 上请检查文件权限并执行 chmod +x',
      ENOEXEC: 'restic 文件格式或架构不匹配；Linux x86_64 请使用 linux_amd64 版本',
      TIMEOUT: `restic 测试超时（${timeoutMs / 1000} 秒），请检查可执行文件`,
      OUTPUT_LIMIT: '程序输出超过限制，请确认该路径指向 restic 可执行文件',
    }
    // 不向网页转发任意可执行文件的原始输出。
    throw new DiagnosticError(messages[error.code] || 'restic 执行失败，请检查文件路径、执行权限和系统架构')
  }
  const version = /^restic (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/m.exec(result.stdout)?.[1]
  if (!version) throw new DiagnosticError('程序未返回有效的 restic 版本，请检查可执行文件路径')
  return { version, message: `restic ${version} 可用，已成功执行版本检查。` }
}

// 与 restic S3 后端一致：虚拟主机寻址、AWS Signature V4、服务名 s3。
function listRequest(oss, credentials, date) {
  const url = new URL(oss.endpoint)
  url.hostname = `${oss.bucket}.${url.hostname}`
  const query = [['list-type', '2'], ['max-keys', '1'], ['prefix', oss.prefix ? `${oss.prefix}/` : '']]
    .map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&')
  url.search = query
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = timestamp.slice(0, 8)
  const headers = { host: url.host, 'x-amz-content-sha256': sha256(''), 'x-amz-date': timestamp }
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken.trim()
  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')
  const canonicalHeaders = names.map(name => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('')
  const canonical = ['GET', '/', query, canonicalHeaders, signedHeaders, headers['x-amz-content-sha256']].join('\n')
  const scope = `${day}/${oss.region}/s3/aws4_request`
  const toSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.accessKeySecret}`, day), oss.region), 's3'), 'aws4_request')
  const signature = hmac(signingKey, toSign).toString('hex')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { url, headers }
}

async function readResponse(response, controller) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 32768) {
        controller.abort()
        await reader.cancel().catch(() => {})
        throw new DiagnosticError('OSS 返回内容超过测试限制，请检查 Endpoint 是否正确')
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { reader.releaseLock() }
}

function ossFailure(status, body) {
  const code = /<Code>\s*([A-Za-z0-9]{1,80})\s*<\/Code>/.exec(body)?.[1]
  const messages = {
    AccessDenied: '访问被拒绝，请检查 AccessKey 的 oss:ListObjects 权限和 Bucket 策略',
    InvalidAccessKeyId: 'AccessKey ID 无效或已停用',
    SignatureDoesNotMatch: '签名不匹配，请检查 AccessKey Secret、地域和服务器时间',
    NoSuchBucket: 'Bucket 不存在，请检查 Bucket 名称及所在地域',
    RequestTimeTooSkewed: '服务器时间偏差过大，请同步服务器时间后重试',
    InvalidSecurityToken: 'STS Token 无效，请检查临时凭据',
    SecurityTokenExpired: 'STS Token 已过期，请更新临时凭据',
    ExpiredToken: 'STS Token 已过期，请更新临时凭据',
    AuthorizationHeaderMalformed: '签名地域配置不正确，请检查 OSS 地域与 Endpoint',
    InvalidArgument: '请求参数不正确，请检查 OSS 地域、Endpoint 和前缀',
    PermanentRedirect: 'Endpoint 与 Bucket 地域不匹配，请使用 Bucket 所在地域的 Endpoint',
  }
  const message = messages[code] || (status === 403 ? messages.AccessDenied : status === 404 ? messages.NoSuchBucket
    : status >= 300 && status < 400 ? messages.PermanentRedirect : '请检查 OSS Endpoint、凭据和网络后重试')
  // OSS 的 Message / RequestId / 对象内容均不回传，防止泄露凭据或目录信息。
  return new DiagnosticError(`OSS 连接测试失败（HTTP ${status}）：${message}`)
}

async function testOss(config, { environment, fetchImpl, timeoutMs, now }) {
  const { oss } = config
  ossRepository(oss)
  const endpoint = new URL(oss.endpoint)
  if (!/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(endpoint.hostname) || endpoint.port) {
    throw new DiagnosticError('OSS 测试需要阿里云 HTTPS 地域 Endpoint，例如 https://oss-cn-hangzhou.aliyuncs.com（支持内网 Endpoint）')
  }
  const credentials = ossCredentials(oss, environment)
  const { url, headers } = listRequest(oss, credentials, now())
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // 手动处理重定向，绝不将签名或 STS Token 转发到其他地址。
    const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal })
    const body = await readResponse(response, controller)
    if (!response.ok) throw ossFailure(response.status, body)
    if (!/<ListBucketResult(?:\s[^>]*)?>/.test(body) || !body.includes('</ListBucketResult>')) {
      throw new DiagnosticError('OSS 返回了非预期内容，请检查地域 Endpoint')
    }
    return { message: 'OSS 连接正常，凭据有效，已验证指定前缀的列举权限。尚未验证对象读写、删除权限或仓库密码。' }
  } catch (error) {
    if (error instanceof DiagnosticError) throw error
    if (controller.signal.aborted) throw new DiagnosticError(`OSS 连接测试超时（${timeoutMs / 1000} 秒），请检查服务器网络和内网 Endpoint 的可达性`)
    const code = error.cause?.code || error.code
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) throw new DiagnosticError('无法解析 OSS 域名，请检查 Endpoint 和服务器 DNS')
    if (/CERT|TLS|SSL/.test(code || '')) throw new DiagnosticError('OSS TLS 证书校验失败，请检查服务器时间和证书环境')
    throw new DiagnosticError('无法连接 OSS，请检查 Endpoint、服务器网络及代理设置')
  } finally { clearTimeout(timer) }
}

export function createDiagnostics({ environment = process.env, restic = runRestic, fetchImpl = fetch, timeoutMs = 10000, now = () => new Date() } = {}) {
  const options = { environment, restic, fetchImpl, timeoutMs, now }
  return {
    async test(kind, config) {
      if (!['restic', 'oss'].includes(kind)) throw new DiagnosticError('不支持的测试类型')
      if (active.has(config.pluginDir)) {
        const error = new DiagnosticError('已有连接测试正在运行，请稍后重试')
        error.code = 'BUSY'
        throw error
      }
      active.add(config.pluginDir)
      const start = Date.now()
      try {
        const result = await (kind === 'restic' ? testRestic(config, options) : testOss(config, options))
        return { ...result, elapsedMs: Date.now() - start }
      } finally { active.delete(config.pluginDir) }
    },
  }
}
