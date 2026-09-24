import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes, scrypt as deriveKey, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(deriveKey)
const COOKIE = 'backup_session'
const SESSION_MS = 8 * 60 * 60 * 1000
const WINDOW_MS = 15 * 60 * 1000
const digest = value => createHash('sha256').update(value).digest('hex')
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** 凭据与会话仅属于独立服务；Guoba 注册入口不加载此模块。 */
export async function createWebAuth({ pluginDir, password, secure = false, now = Date.now, sessionMs = SESSION_MS }) {
  const filename = path.join(pluginDir, '.runtime', 'web-auth.json')
  let credential
  let initialPassword
  if (password !== undefined && (typeof password !== 'string' || password.length < 12 || password.length > 256 || /[\0\r\n]/.test(password))) {
    throw new Error('BACKUP_WEB_PASSWORD 必须为 12～256 位单行密码')
  }
  if (password === undefined) {
    try {
      credential = JSON.parse(await fs.readFile(filename, 'utf8'))
      if (credential.version !== 1 || !/^[a-f0-9]{32}$/.test(credential.salt) || !/^[a-f0-9]{128}$/.test(credential.hash)) throw new Error('invalid')
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('独立网页登录凭据无法读取；设置 BACKUP_WEB_PASSWORD 后重启可重置')
      initialPassword = randomBytes(18).toString('base64url')
      password = initialPassword
    }
  }
  if (password !== undefined) {
    const salt = randomBytes(16).toString('hex')
    credential = { version: 1, salt, hash: (await scrypt(password, salt, 64)).toString('hex') }
    await fs.mkdir(path.dirname(filename), { recursive: true })
    const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(credential) + '\n', { flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, filename)
    } finally { await fs.unlink(temporary).catch(() => {}) }
  }
  const sessions = new Map()
  const attempts = new Map()
  const globalAttempts = { count: 0, until: 0 }
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure, path: '/' }
  function prune() {
    for (const [key, value] of sessions) if (value.expiresAt <= now()) sessions.delete(key)
    for (const [key, value] of attempts) if (value.until <= now()) attempts.delete(key)
  }
  function token(req) {
    return /(?:^|;\s*)backup_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1]
  }
  function session(req) {
    prune()
    const value = token(req)
    return value ? sessions.get(digest(value)) : undefined
  }
  const unauthorized = res => res.status(401).json({ ok: false, error: '请登录独立备份面板' })
  return {
    initialPassword,
    session,
    async login(req, res) {
      prune()
      const key = req.socket.remoteAddress || 'unknown'
      const attempt = attempts.get(key) || { count: 0, until: now() + WINDOW_MS }
      if (globalAttempts.until <= now()) Object.assign(globalAttempts, { count: 0, until: now() + WINDOW_MS })
      if (attempt.count >= 10 || globalAttempts.count >= 100) {
        res.set('Retry-After', String(Math.max(1, Math.ceil(((attempt.count >= 10 ? attempt.until : globalAttempts.until) - now()) / 1000))))
        return res.status(429).json({ ok: false, error: '登录尝试过多，请稍后重试' })
      }
      attempt.count++
      globalAttempts.count++
      attempts.set(key, attempt)
      const candidate = req.body?.password
      if (typeof candidate !== 'string' || candidate.length > 256 || !equal((await scrypt(candidate, credential.salt, 64)).toString('hex'), credential.hash)) {
        return res.status(401).json({ ok: false, error: '登录密码错误' })
      }
      attempts.delete(key)
      const old = token(req)
      if (old) sessions.delete(digest(old))
      while (sessions.size >= 32) sessions.delete(sessions.keys().next().value)
      const value = randomBytes(32).toString('base64url')
      const entry = { csrf: randomBytes(32).toString('base64url'), expiresAt: now() + sessionMs }
      sessions.set(digest(value), entry)
      res.cookie(COOKIE, value, { ...cookieOptions, maxAge: sessionMs })
      res.json({ ok: true, ...entry })
    },
    requireSession(req, res, next) {
      const current = session(req)
      if (!current) return unauthorized(res)
      if (!['GET', 'HEAD'].includes(req.method) && !equal(req.get('X-Backup-CSRF'), current.csrf)) {
        return res.status(403).json({ ok: false, error: '登录校验已失效，请刷新页面后重试' })
      }
      next()
    },
    logout(req, res) {
      const value = token(req)
      if (value) sessions.delete(digest(value))
      res.clearCookie(COOKIE, cookieOptions)
      res.json({ ok: true })
    },
    close() { sessions.clear(); attempts.clear() },
  }
}
