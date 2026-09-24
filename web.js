#!/usr/bin/env node
import { startWebServer } from './lib/web-server.js'

try {
  const runtime = await startWebServer({
    host: process.env.BACKUP_WEB_HOST || '127.0.0.1',
    port: process.env.BACKUP_WEB_PORT === undefined ? 5212 : Number(process.env.BACKUP_WEB_PORT),
    origin: process.env.BACKUP_WEB_ORIGIN,
    password: process.env.BACKUP_WEB_PASSWORD,
    sourceDir: process.env.BACKUP_SOURCE_DIR,
  })
  console.log(`独立备份面板：${runtime.url}\n备份源目录：${runtime.sourceDir}`)
  if (runtime.initialPassword) console.log(`首次登录密码（仅本次显示，请保存）：${runtime.initialPassword}`)
  else console.log('使用已设置的独立网页登录密码；重置请设置 BACKUP_WEB_PASSWORD 后重启。')
  const stop = () => runtime.close().catch(() => { process.exitCode = 1 })
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  console.error(`独立网页启动失败：${error.code === 'EADDRINUSE' ? '端口已占用，请修改 BACKUP_WEB_PORT' : error.message}`)
  process.exitCode = 1
}
