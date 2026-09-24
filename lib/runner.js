import { spawn } from 'node:child_process'
import { redact } from './config.js'

const phases = { init: '初始化仓库', backup: '读取并备份文件', snapshots: '读取快照列表', ls: '读取文件列表', restore: '恢复并校验文件', check: '检查仓库', dump: '准备下载文件' }
const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : null

function progressEvent(event) {
  const summary = event.message_type === 'summary'
  const totalFiles = nonnegative(event.total_files ?? event.total_files_processed)
  const totalBytes = nonnegative(event.total_bytes ?? event.total_bytes_processed)
  const filesDone = nonnegative(event.files_done ?? event.files_restored ?? (summary ? totalFiles : null))
  const bytesDone = nonnegative(event.bytes_done ?? event.bytes_restored ?? (summary ? totalBytes : null))
  let percent = nonnegative(event.percent_done)
  if (percent === null && bytesDone !== null && totalBytes > 0) percent = bytesDone / totalBytes
  if (percent === null && filesDone !== null && totalFiles > 0) percent = filesDone / totalFiles
  if ([totalFiles, totalBytes, filesDone, bytesDone, percent].every(value => value === null)) return null
  return { percent: percent === null ? null : Math.min(1, percent), filesDone, totalFiles, bytesDone, totalBytes, secondsRemaining: nonnegative(event.seconds_remaining) }
}

export class ResticError extends Error {
  constructor(message, code) { super(message); this.name = 'ResticError'; this.code = code }
}

/** 每个任务只有一个直接子进程；参数数组调用，不经 shell，不向 stdin 请求密码。 */
export function runRestic(config, conn, command, job, { json = false, maxBytes = 8 * 1024 * 1024, spawnProcess = spawn } = {}) {
  if (job.cancelled) return Promise.reject(new ResticError('任务已取消', 'CANCELLED'))
  job.phase = phases[command[0]] || '执行中'
  job.progress = null
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let summary = null
    let pending = ''
    let timedOut = false
    let overflow = false
    let bytes = 0
    let child
    try {
      child = spawnProcess(config.resticPath, [...conn.args, ...command], {
        cwd: config.frameworkDir, env: conn.env, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) { reject(new ResticError(redact(error.message, conn.secrets), 'SPAWN')); return }
    job.child = child
    const terminate = () => child.kill('SIGTERM')
    const timer = setTimeout(() => { timedOut = true; stop() }, config.timeoutMinutes * 60_000)
    timer.unref?.()
    // SIGTERM 在 Windows 直接终止进程；Unix 上给 restic 清理锁的机会后再兜底。
    let killTimer
    const stop = () => {
      terminate()
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000)
      killTimer.unref?.()
    }
    job.stop = stop
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const readLine = line => {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line)
        if (event.message_type === 'summary') summary = event
        if (event.message_type === 'status' || event.message_type === 'summary') job.progress = progressEvent(event) ?? job.progress
        if (event.message_type === 'error') stderr = (stderr + '\n' + redact(line, conn.secrets)).slice(-16000)
      } catch { stderr = (stderr + '\n' + redact(line, conn.secrets)).slice(-16000) }
    }
    child.stdout.on('data', chunk => {
      if (json) {
        pending += chunk
        let end
        while ((end = pending.indexOf('\n')) !== -1) {
          readLine(pending.slice(0, end))
          pending = pending.slice(end + 1)
        }
        if (pending.length > maxBytes) { overflow = true; stop() }
      } else {
        bytes += Buffer.byteLength(chunk)
        if (bytes > maxBytes) { overflow = true; stop(); return }
        stdout += chunk
      }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000) })
    const cleanup = () => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (job.child === child) { job.child = null; job.stop = null }
    }
    child.once('error', error => {
      cleanup()
      reject(new ResticError(error.code === 'ENOENT'
        ? '找不到 restic，请安装 restic 并配置 resticPath 或 PATH'
        : redact(`无法启动 restic：${error.message}`, conn.secrets), error.code))
    })
    child.once('close', (code, signal) => {
      cleanup()
      if (json) readLine(pending)
      if (job.cancelled) { reject(new ResticError('任务已取消；如仓库留下锁，请确认无任务运行后在终端检查', 'CANCELLED')); return }
      if (timedOut) { reject(new ResticError('restic 执行超时，请检查网络或增大 timeoutMinutes', 'TIMEOUT')); return }
      if (overflow) { reject(new ResticError('restic 输出超过限制，操作已停止', 'OUTPUT_LIMIT')); return }
      const result = { code, stdout, summary, stderr: redact(stderr, conn.secrets) }
      if (code !== 0 && !(command[0] === 'backup' && code === 3)) {
        reject(new ResticError(`restic 失败（${code ?? signal}）：${redact(stderr || stdout || '进程异常退出', conn.secrets)}`, code))
        return
      }
      resolve(result)
    })
  })
}
