import path from 'node:path'
import { PLUGIN_DIR } from './config.js'

// 面板、插件入口和热重载后的模块图共享监听器。
const listeners = globalThis[Symbol.for('jiuli.backup-plugin.config-listeners')] ??= new Map()

export function subscribeConfig(listener, pluginDir = PLUGIN_DIR) {
  const key = path.resolve(pluginDir)
  if (!listeners.has(key)) listeners.set(key, new Set())
  listeners.get(key).add(listener)
  return () => {
    const callbacks = listeners.get(key)
    callbacks?.delete(listener)
    if (!callbacks?.size) listeners.delete(key)
  }
}

export async function notifyConfigChanged(pluginDir = PLUGIN_DIR) {
  const callbacks = [...(listeners.get(path.resolve(pluginDir)) ?? [])]
  const results = await Promise.allSettled(callbacks.map(callback => callback()))
  return { applied: callbacks.length > 0, failed: results.some(result => result.status === 'rejected') }
}
