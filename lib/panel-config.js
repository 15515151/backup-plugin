import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PLUGIN_DIR, FRAMEWORK_DIR, DEFAULT_EXCLUDES, ensureConfig, readConfig, normalizeConfig, ossRepository, validateLocalRepository } from './config.js'
import { notifyConfigChanged } from './config-events.js'

export const SECRET_MASK = '********'
export const SECRET_FIELDS = ['password', 'oss.accessKeyId', 'oss.accessKeySecret', 'oss.sessionToken']
export const CONFIG_FIELDS = [
  'resticPath', 'backend', 'password', 'passwordFile', 'localRepository', 'snapshotTag', 'hostname',
  'oss.endpoint', 'oss.region', 'oss.bucket', 'oss.prefix', 'oss.accessKeyId', 'oss.accessKeySecret', 'oss.sessionToken',
  'extraExcludes', 'schedule.enabled', 'schedule.cron', 'timeoutMinutes', 'limitUploadKiB', 'limitDownloadKiB',
]
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const isObject = value => value && typeof value === 'object' && !Array.isArray(value)
const queues = globalThis[Symbol.for('jiuli.backup-plugin.config-writes')] ??= new Map()

export function getField(config, field) {
  const [key, sub] = field.split('.')
  return sub ? config[key]?.[sub] : config[key]
}

function setField(config, field, value) {
  const [key, sub] = field.split('.')
  if (sub) config[key] = { ...config[key], [sub]: value }
  else config[key] = value
}

/** 仅接收白名单字段，同时兼容锅巴点路径和 WebUI 嵌套对象。 */
export function mergePanelConfig(current, data) {
  if (!isObject(data)) throw new Error('配置必须是对象')
  const next = structuredClone(current)
  for (const field of CONFIG_FIELDS) {
    const [key, sub] = field.split('.')
    const present = has(data, field) || (sub && isObject(data[key]) && has(data[key], sub))
    if (!present) continue
    const value = has(data, field) ? data[field] : data[key][sub]
    if (SECRET_FIELDS.includes(field) && value === SECRET_MASK) continue
    setField(next, field, value)
  }
  return next
}

export function panelData(config) {
  const data = {}
  for (const field of CONFIG_FIELDS) {
    const value = getField(config, field)
    setField(data, field, SECRET_FIELDS.includes(field) && value ? SECRET_MASK : structuredClone(value))
  }
  return data
}

export function createPanelConfig({ pluginDir = PLUGIN_DIR, frameworkDir = FRAMEWORK_DIR, notify = notifyConfigChanged } = {}) {
  const key = path.resolve(pluginDir)
  async function read() {
    await ensureConfig(pluginDir)
    const defaults = JSON.parse(await fs.readFile(path.join(pluginDir, 'config.example.json'), 'utf8'))
    const current = await readConfig(pluginDir)
    normalizeConfig(current, { pluginDir, frameworkDir })
    return { ...defaults, ...current, oss: { ...defaults.oss, ...current.oss }, schedule: { ...defaults.schedule, ...current.schedule } }
  }

  return {
    async get() { return { config: panelData(await read()), defaultExcludes: [...DEFAULT_EXCLUDES] } },
    save(data) {
      const previous = queues.get(key) ?? Promise.resolve()
      const operation = previous.catch(() => {}).then(async () => {
        const next = mergePanelConfig(await read(), data)
        const normalized = normalizeConfig(next, { pluginDir, frameworkDir })
        if (normalized.backend === 'oss') ossRepository(normalized.oss, { allowEmptyBucket: true })
        else if (normalized.localRepository) await validateLocalRepository(normalized)
        await fs.mkdir(normalized.runtimeDir, { recursive: true })
        const temporary = path.join(normalized.runtimeDir, `config-${randomUUID()}.tmp`)
        try {
          await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
          await fs.rename(temporary, path.join(pluginDir, 'config.json'))
        } catch {
          await fs.unlink(temporary).catch(() => {})
          throw new Error('无法保存 config.json，请检查插件目录的写入权限')
        }
        const result = await notify(pluginDir).catch(() => ({ applied: false, failed: true }))
        const message = result.failed
          ? '配置已保存，定时任务更新失败，请查看机器人日志并重载插件'
          : result.applied ? '配置已保存，定时任务已更新；正在运行的任务使用原配置'
            : '配置已保存，启动或重载备份插件后应用定时设置'
        return { config: panelData(next), defaultExcludes: [...DEFAULT_EXCLUDES], message }
      })
      queues.set(key, operation)
      operation.finally(() => { if (queues.get(key) === operation) queues.delete(key) }).catch(() => {})
      return operation
    },
  }
}
