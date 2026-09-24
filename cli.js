#!/usr/bin/env node
import { BackupService } from './lib/service.js'
import { backupResult, date, statusMessage } from './lib/format.js'

const service = new BackupService()
const [command, selector, ...extra] = process.argv.slice(2)
const commands = ['status', 'init', 'backup', 'snapshots', 'check', 'restore']
if (!commands.includes(command) || extra.length || (selector && command !== 'restore')) {
  console.error('用法：node cli.js status|init|backup|snapshots|check|restore [latest|快照ID]')
  process.exitCode = 1
} else {
  const cancel = () => service.cancel()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  try {
    if (command === 'status') console.log(statusMessage(await service.status()))
    else if (command === 'backup') {
      const result = await service.backup()
      console.log(backupResult(result))
      if (result.partial) process.exitCode = 2
    } else if (command === 'snapshots') {
      const { snapshots } = await service.snapshots()
      console.log(snapshots.length ? snapshots.map(item => `${item.id}  ${date(item.time)}`).join('\n') : '没有快照')
    } else if (command === 'restore') {
      const result = await service.restore(selector ?? 'latest')
      console.log(`恢复并校验完成：${result.snapshotId}\n目录：${result.target}`)
    } else if (command === 'init') {
      await service.init()
      console.log('仓库初始化完成')
    } else {
      await service.check()
      console.log('仓库结构与索引检查通过')
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}
