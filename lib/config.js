import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FRAMEWORK_DIR = path.resolve(PLUGIN_DIR, '../..')
export const DEFAULT_EXCLUDES = Object.freeze([
  'node_modules', 'logs', 'temp', 'data/upload_tmp', 'data/memes',
])

const object = value => value && typeof value === 'object' && !Array.isArray(value)
const string = (value, name) => {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error(`${name} 必须是单行字符串`)
  return value.trim()
}
const integer = (value, name, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}～${max} 的整数`)
  return value
}

export function isWithin(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

// 将 glob 元字符转义，目录名带 []、?、* 时仍排除精确路径。
export function literalPattern(value) {
  return value.replaceAll('\\', '/').replace(/[?*\[]/g, char => `[${char}]`)
}

function validateCron(cron) {
  const fields = cron.split(/\s+/)
  if (fields.length !== 5 && fields.length !== 6) throw new Error('schedule.cron 需要 5 或 6 段 cron 表达式')
  const bounds = fields.length === 6 ? [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] : [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  const valid = fields.every((field, index) => field.split(',').every(part => {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
    if (!match) return false
    const [min, max] = bounds[index]
    if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > max - min + 1)) return false
    if (match[1] === '*') return true
    const range = match[1].split('-').map(Number)
    return range.every(number => number >= min && number <= max) && (range.length === 1 || range[0] <= range[1])
  }))
  if (!valid) throw new Error('schedule.cron 无效：支持数字、*、范围、逗号与 / 步长，请检查各字段取值')
}

export async function ensureConfig(pluginDir = PLUGIN_DIR) {
  const target = path.join(pluginDir, 'config.json')
  try {
    await fs.copyFile(path.join(pluginDir, 'config.example.json'), target, 1)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  return target
}

export async function readConfig(pluginDir = PLUGIN_DIR) {
  const filename = path.join(pluginDir, 'config.json')
  let input
  try {
    input = JSON.parse(await fs.readFile(filename, 'utf8'))
  } catch (error) {
    // JSON.parse 的原始错误可能包含密码所在行，不能直接转发给日志或聊天。
    if (error.code === 'ENOENT') throw new Error('缺少 config.json，请复制插件的 config.example.json 后填写')
    throw new Error('config.json 无法读取或 JSON 格式错误，请检查配置文件')
  }
  return input
}

export async function loadConfig({ pluginDir = PLUGIN_DIR, frameworkDir = FRAMEWORK_DIR } = {}) {
  return normalizeConfig(await readConfig(pluginDir), { pluginDir, frameworkDir })
}

export function normalizeConfig(input, { pluginDir = PLUGIN_DIR, frameworkDir = FRAMEWORK_DIR } = {}) {
  if (!object(input)) throw new Error('config.json 顶层必须是对象')
  if (input.oss !== undefined && !object(input.oss)) throw new Error('oss 必须是对象')
  if (input.schedule !== undefined && !object(input.schedule)) throw new Error('schedule 必须是对象')
  const oss = input.oss ?? {}
  const schedule = input.schedule ?? {}
  const backend = input.backend ?? 'oss'
  if (!['oss', 'local'].includes(backend)) throw new Error('backend 仅支持 oss 或 local')
  if (schedule.enabled !== undefined && typeof schedule.enabled !== 'boolean') throw new Error('schedule.enabled 必须为布尔值')
  const cron = string(schedule.cron ?? '0 0 4 * * *', 'schedule.cron')
  validateCron(cron)
  const extraExcludes = input.extraExcludes ?? []
  if (!Array.isArray(extraExcludes) || extraExcludes.some(item => typeof item !== 'string' || !item.trim() || /[\0\r\n]/.test(item) || item.trim().startsWith('!'))) {
    throw new Error('extraExcludes 必须是非空排除规则数组，不能使用 ! 反选默认排除项')
  }
  const snapshotTag = string(input.snapshotTag ?? 'jiuli-backup', 'snapshotTag')
  if (!/^[\w.-]{1,80}$/.test(snapshotTag)) throw new Error('snapshotTag 仅支持 1～80 位字母、数字、下划线、点和连字符')
  const root = path.resolve(frameworkDir)
  const plugin = path.resolve(pluginDir)
  const runtimeDir = path.join(plugin, '.runtime')
  const excludes = [...DEFAULT_EXCLUDES, ...extraExcludes.map(item => item.trim())]
  if (isWithin(root, runtimeDir)) excludes.push(literalPattern(runtimeDir))
  let resticPath = string(input.resticPath ?? 'restic', 'resticPath')
  if (!resticPath) throw new Error('resticPath 不能为空')
  if (/[\\/]/.test(resticPath)) resticPath = path.resolve(plugin, resticPath)
  if (/\.(bat|cmd|ps1)$/i.test(resticPath)) throw new Error('resticPath 必须指向 restic 可执行文件，不能是 shell 脚本')
  const passwordFile = string(input.passwordFile ?? '', 'passwordFile')
  if (input.password !== undefined && (typeof input.password !== 'string' || /[\0\r\n]/.test(input.password))) throw new Error('password 必须是单行字符串')
  const localRepository = string(input.localRepository ?? '', 'localRepository')
  return {
    pluginDir: plugin, frameworkDir: root, runtimeDir, excludes, resticPath, backend,
    password: typeof input.password === 'string' ? input.password : '',
    passwordFile: passwordFile ? path.resolve(plugin, passwordFile) : '',
    oss: {
      endpoint: string(oss.endpoint ?? 'https://oss-cn-hangzhou.aliyuncs.com', 'oss.endpoint'),
      region: string(oss.region ?? 'oss-cn-hangzhou', 'oss.region'),
      bucket: string(oss.bucket ?? '', 'oss.bucket'),
      prefix: string(oss.prefix ?? 'jiuli', 'oss.prefix').replace(/^\/+|\/+$/g, ''),
      accessKeyId: string(oss.accessKeyId ?? '', 'oss.accessKeyId'),
      accessKeySecret: string(oss.accessKeySecret ?? '', 'oss.accessKeySecret'),
      sessionToken: string(oss.sessionToken ?? '', 'oss.sessionToken'),
    },
    localRepository: localRepository ? path.resolve(plugin, localRepository) : '',
    hostname: string(input.hostname ?? '', 'hostname') || os.hostname(), snapshotTag,
    schedule: { enabled: schedule.enabled ?? false, cron },
    timeoutMinutes: integer(input.timeoutMinutes ?? 120, 'timeoutMinutes', 1, 10080),
    limitUploadKiB: integer(input.limitUploadKiB ?? 0, 'limitUploadKiB', 0, 2147483647),
    limitDownloadKiB: integer(input.limitDownloadKiB ?? 0, 'limitDownloadKiB', 0, 2147483647),
  }
}

export function ossRepository(oss, { allowEmptyBucket = false } = {}) {
  let endpoint
  try { endpoint = new URL(oss.endpoint) } catch { throw new Error('oss.endpoint 必须是完整的 HTTPS 地域 Endpoint') }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('oss.endpoint 必须是 HTTPS 地域 Endpoint，不包含 Bucket、路径或查询参数')
  }
  if (!(allowEmptyBucket && !oss.bucket) && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(oss.bucket)) throw new Error('请填写合法的 oss.bucket（3～63 位）')
  if (!/^oss-[a-z0-9-]+$/.test(oss.region)) throw new Error('oss.region 示例：oss-cn-hangzhou')
  if (!/^[\w./-]*$/.test(oss.prefix) || oss.prefix.split('/').some(part => part === '.' || part === '..')) throw new Error('oss.prefix 仅支持字母、数字、下划线、点、连字符和目录分隔符')
  return `s3:${endpoint.origin}/${oss.bucket}${oss.prefix ? `/${oss.prefix}` : ''}`
}

export async function validateLocalRepository(config) {
  if (!config.localRepository) throw new Error('local 后端需要填写 localRepository')
  const canonical = async target => {
    try { return await fs.realpath(target) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(target)
      if (parent === target) return target
      return path.join(await canonical(parent), path.basename(target))
    }
  }
  const realRoot = await canonical(config.frameworkDir)
  const realRepository = await canonical(config.localRepository)
  if (isWithin(realRoot, realRepository) || isWithin(realRepository, realRoot)) throw new Error('localRepository 必须放在机器人目录之外，且不能是机器人目录的上级')
}

export async function connection(config, environment = process.env) {
  const env = { ...environment }
  // 显式配置本次操作，防止宿主进程已有的 restic 环境变量覆盖目标或执行密码命令。
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('RESTIC_') || ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'].includes(key.toUpperCase())) delete env[key]
  }
  let password = environment.RESTIC_PASSWORD || config.password
  const passwordFile = environment.RESTIC_PASSWORD_FILE || (!environment.RESTIC_PASSWORD && config.passwordFile)
  if (passwordFile) {
    try { password = (await fs.readFile(path.resolve(config.pluginDir, passwordFile), 'utf8')).replace(/[\r\n]+$/, '') }
    catch { throw new Error('无法读取 restic 密码文件，请检查 passwordFile / RESTIC_PASSWORD_FILE') }
  }
  if (!password || /[\0\r\n]/.test(password)) throw new Error('请设置仓库密码：RESTIC_PASSWORD、passwordFile 或 config.json 的 password')
  env.RESTIC_PASSWORD = password
  const secrets = [password]
  const args = ['--cache-dir', path.join(config.runtimeDir, 'cache'), '--retry-lock', '0s']
  let repository
  if (config.backend === 'oss') {
    const { oss } = config
    repository = ossRepository(oss)
    const accessKeyId = environment.AWS_ACCESS_KEY_ID || oss.accessKeyId
    const accessKeySecret = environment.AWS_SECRET_ACCESS_KEY || oss.accessKeySecret
    const sessionToken = environment.AWS_SESSION_TOKEN || oss.sessionToken
    if (!accessKeyId || !accessKeySecret) throw new Error('请配置 OSS AccessKey，或设置 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY')
    env.AWS_ACCESS_KEY_ID = accessKeyId
    env.AWS_SECRET_ACCESS_KEY = accessKeySecret
    if (sessionToken) env.AWS_SESSION_TOKEN = sessionToken
    secrets.push(accessKeyId, accessKeySecret, sessionToken)
    args.push('-o', 's3.bucket-lookup=dns', '-o', `s3.region=${oss.region}`)
  } else {
    await validateLocalRepository(config)
    repository = config.localRepository
  }
  args.push('--repo', repository)
  if (config.limitUploadKiB) args.push('--limit-upload', String(config.limitUploadKiB))
  if (config.limitDownloadKiB) args.push('--limit-download', String(config.limitDownloadKiB))
  return { args, env, secrets: secrets.filter(Boolean) }
}

export function redact(message, secrets = []) {
  let result = String(message)
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) result = result.split(secret).join('[已隐藏]')
  }
  return result.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@').slice(-2000)
}
