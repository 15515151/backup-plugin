(() => {
  'use strict'
  const form = document.getElementById('configForm')
  if (form.dataset.initialized) return
  form.dataset.initialized = 'true'
  const fieldset = document.getElementById('configFields')
  const saveButton = document.getElementById('saveBtn')
  const refreshButton = document.getElementById('refreshBtn')
  const saveState = document.getElementById('saveState')
  const notice = document.getElementById('notice')
  const fields = [...form.querySelectorAll('[name]')]
  let saved = ''
  let loaded = false
  let busy = false
  const library = { loaded: false, busy: false, snapshot: null, directory: '/', snapshots: null, files: null, downloads: [] }
  let downloadTimer
  const monitor = { active: null, polling: false, stopped: false, timer: null }
  const standalone = document.documentElement.dataset.mode === 'standalone'
  let authenticated = !standalone
  let csrf = ''
  let taskBusy = false
  let statusKnown = false
  const params = new URLSearchParams(location.search)
  const assetIndex = location.pathname.indexOf('/web-page/')
  const rawBase = standalone ? '' : params.get('__webBase') || (assetIndex >= 0 ? location.pathname.slice(0, assetIndex) : '')
  const base = new URL(rawBase || '/', location.origin)
  const apiUrl = route => standalone ? `/api/backup-plugin/${route}` : window.Guoba?.apiUrl ? window.Guoba.apiUrl(`/backup-plugin/${route}`)
    : assetIndex >= 0 ? `${base.pathname.replace(/\/+$/, '')}/web-page/api/backup-plugin/backup-plugin/${route}`
    : `${base.pathname.replace(/\/+$/, '')}/api/backup-plugin/${route}`

  function guobaToken() {
    let token = window.Guoba?.token?.() || ''
    if (!token) {
      try { token = localStorage.getItem('guoba-access-token') || '' } catch { /* storage 可能被禁用 */ }
      token ||= params.get('token') || ''
    }
    return token
  }

  function showLogin(message = '') {
    authenticated = false
    csrf = ''
    loaded = false
    statusKnown = false
    saved = ''
    form.reset()
    monitor.stopped = true
    clearTimeout(monitor.timer)
    clearTimeout(downloadTimer)
    document.documentElement.dataset.authenticated = 'false'
    document.getElementById('loginPanel').hidden = false
    document.getElementById('loginError').hidden = !message
    document.getElementById('loginError').textContent = message
    document.getElementById('loginPassword').value = ''
    document.getElementById('loginPassword').focus()
  }

  async function authRequest(route, options = {}) {
    const response = await fetch(`/api/auth/${route}`, { ...options, cache: 'no-store', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Backup-CSRF': csrf, ...options.headers }, signal: AbortSignal.timeout(20000) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.ok) throw new Error(data.error || '无法连接备份面板，请稍后重试')
    return data
  }

  async function enterPanel() {
    const session = await authRequest('session')
    csrf = session.csrf
    authenticated = true
    monitor.stopped = false
    document.documentElement.dataset.authenticated = 'true'
    document.getElementById('loginPanel').hidden = true
    document.getElementById('loginPassword').value = ''
    document.getElementById('logoutBtn').hidden = false
    document.getElementById('sourceDirectory').hidden = false
    document.getElementById('sourceDirectory').textContent = `备份源目录：${session.sourceDir}`
    selectTab('repository')
    await Promise.all([reload(), refreshTaskStatus()])
  }

  document.getElementById('loginForm').addEventListener('submit', async event => {
    event.preventDefault()
    const button = document.getElementById('loginButton')
    if (button.disabled) return
    button.disabled = true
    button.textContent = '正在登录…'
    try {
      await authRequest('login', { method: 'POST', body: JSON.stringify({ password: document.getElementById('loginPassword').value }) })
      await enterPanel()
    } catch (error) { showLogin(error.message) }
    finally { button.disabled = false; button.textContent = '登录备份面板' }
  })
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await authRequest('logout', { method: 'POST', body: '{}' }); showLogin() }
    catch (error) { showNotice(error.message, true) }
  })

  function clearTests(kind) {
    document.querySelectorAll('[data-test-result]').forEach(result => {
      if (kind && result.dataset.testResult !== kind) return
      result.hidden = true
      result.textContent = ''
      result.removeAttribute('data-state')
    })
  }

  function showNotice(message, error = false) {
    notice.textContent = message
    notice.classList.toggle('error', error)
    notice.hidden = false
  }

  function selectTab(tab) {
    const selected = ['repository', 'oss', 'schedule', 'backups'].includes(tab) ? tab : 'repository'
    document.querySelectorAll('[data-tab]').forEach(button => {
      const active = button.dataset.tab === selected
      button.classList.toggle('active', active)
      if (active) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    })
    document.querySelectorAll('.config-page').forEach(page => { page.hidden = page.id !== `page-${selected}` })
    const browsing = selected === 'backups'
    form.hidden = browsing
    refreshButton.hidden = browsing
    document.querySelector('.backup-flow').hidden = browsing
    document.querySelector('.header h1').textContent = browsing ? '备份文件' : '备份设置'
    document.querySelector('.header .eyebrow').textContent = browsing ? 'RESTIC / 文件' : 'RESTIC / 配置'
    document.querySelector('.subtitle').textContent = browsing ? '浏览历史快照，把需要的文件下载到本机。' : '为机器人文件设置存储位置与备份计划。'
    if (browsing) {
      if (loaded && !library.loaded) refreshSnapshots()
      refreshDownloads()
    }
  }

  function collect() {
    const data = {}
    for (const field of fields) {
      const value = field.type === 'checkbox' ? field.checked : field.type === 'number' ? (field.value === '' ? null : Number(field.value))
        : field.name === 'extraExcludes' ? field.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : field.value
      const [key, sub] = field.name.split('.')
      if (sub) { data[key] ??= {}; data[key][sub] = value }
      else data[key] = value
    }
    return data
  }

  function update() {
    const dirty = loaded && JSON.stringify(collect()) !== saved
    saveButton.disabled = busy || library.busy || !dirty
    refreshButton.disabled = busy || library.busy
    fieldset.disabled = busy || library.busy || !loaded
    form.elements.namedItem('schedule.cron').disabled = !form.elements.namedItem('schedule.enabled').checked
    document.getElementById('localField').hidden = form.elements.namedItem('backend').value !== 'local'
    const destination = document.getElementById('destination')
    destination.firstChild.textContent = form.elements.namedItem('backend').value === 'local' ? '本地仓库' : '阿里云 OSS'
    saveState.textContent = busy ? '正在处理…' : !loaded ? '配置未读取，请点击重新读取' : dirty ? '有未保存的修改' : '配置已同步'
    saveButton.textContent = busy ? '请稍候…' : '保存配置'
    updateLibrary()
    updateTaskActions()
  }

  function fill(data) {
    clearTests()
    for (const field of fields) {
      const [key, sub] = field.name.split('.')
      const value = sub ? data.config[key]?.[sub] : data.config[key]
      if (field.type === 'checkbox') field.checked = value === true
      else field.value = field.name === 'extraExcludes' ? (value ?? []).join('\n') : value ?? ''
      if (field.hasAttribute('data-secret')) field.type = 'password'
    }
    document.querySelectorAll('[data-reveal]').forEach(button => { button.textContent = '显示' })
    const exclusions = document.getElementById('defaultExcludes')
    exclusions.replaceChildren(...data.defaultExcludes.map(pattern => {
      const item = document.createElement('li')
      item.textContent = pattern
      return item
    }))
    loaded = true
    saved = JSON.stringify(collect())
    library.loaded = false
    library.snapshot = null
    library.snapshots = null
    library.files = null
    document.getElementById('snapshotTable').hidden = true
    document.getElementById('snapshotPagination').hidden = true
    document.getElementById('fileBrowser').hidden = true
    document.getElementById('snapshotEmpty').hidden = false
    document.getElementById('snapshotEmpty').textContent = '点击刷新列表，读取已保存配置中的备份。'
  }

  async function request(options = {}, route = 'config', timeout = 20000) {
    if (!authenticated) throw new Error('请先登录备份面板')
    if (base.origin !== location.origin || new URL(apiUrl(route), location.origin).origin !== location.origin) throw new Error('面板接口必须与当前页面同源')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const headers = { ...options.headers }
      if (standalone) headers['X-Backup-CSRF'] = csrf
      else { const token = guobaToken(); if (token) headers['guoba-access-token'] = token }
      const response = await fetch(apiUrl(route), { ...options, headers, signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
      const data = await response.json().catch(() => ({}))
      if (standalone && response.status === 401) showLogin('登录已过期，请重新输入面板密码')
      if (!response.ok || !data.ok) throw new Error(data.error || data.message || `请求失败（${response.status}），请检查面板登录状态`)
      return data
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(route === 'config' ? '请求超时，请重新读取配置确认是否保存成功' : '请求超时，请稍后刷新重试')
      throw error
    } finally { clearTimeout(timer) }
  }

  async function reload() {
    if (busy) return
    if (loaded && saved !== JSON.stringify(collect()) && !window.confirm('重新读取会放弃尚未保存的修改，是否继续？')) return
    busy = true
    update()
    try { fill(await request()); notice.hidden = true }
    catch (error) { showNotice(error.message, true) }
    finally { busy = false; update() }
  }

  const el = id => document.getElementById(id)
  function node(tag, text, className) {
    const element = document.createElement(tag)
    if (text !== undefined) element.textContent = text
    if (className) element.className = className
    return element
  }
  function action(label, callback, className = 'table-button', repository = true) {
    const button = node('button', label, className)
    button.type = 'button'
    if (repository) button.dataset.libraryAction = ''
    button.addEventListener('click', callback)
    return button
  }
  function size(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—'
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let index = 0
    while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index++ }
    return `${index ? bytes.toFixed(1) : bytes} ${units[index]}`
  }
  function date(value) {
    const parsed = new Date(value)
    return value && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : '—'
  }
  function duration(value) {
    if (!Number.isFinite(value) || value < 0) return '—'
    const seconds = Math.floor(value)
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分` : '', `${seconds % 60} 秒`].filter(Boolean).join(' ')
  }
  function renderTaskStatus(data) {
    statusKnown = true
    monitor.active = data.active
    const { active, last } = data
    el('taskMonitor').dataset.state = active ? 'running' : 'idle'
    el('taskStatusError').hidden = true
    el('taskName').textContent = active ? `${active.name}${active.cancelled ? ' · 正在取消' : ' · 执行中'}` : '当前空闲，新的任务启动后会自动显示。'
    el('taskDetails').hidden = !active
    if (active) {
      const progress = active.progress
      const percent = progress?.percent
      el('taskPhase').textContent = active.cancelled ? '正在等待任务停止…' : active.phase
      if (Number.isFinite(percent)) {
        el('taskProgress').value = percent
        el('taskPercent').textContent = `${(percent * 100).toFixed(1)}%`
      } else {
        el('taskProgress').removeAttribute('value')
        el('taskPercent').textContent = '执行中'
      }
      const count = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—'
      el('taskFiles').textContent = `${count(progress?.filesDone)} / ${count(progress?.totalFiles)}`
      el('taskBytes').textContent = `${size(progress?.bytesDone)} / ${size(progress?.totalBytes)}`
      el('taskElapsed').textContent = duration(active.elapsedSeconds)
      el('taskRemaining').textContent = progress?.secondsRemaining === null || progress?.secondsRemaining === undefined ? '待估算' : `约 ${duration(progress.secondsRemaining)}`
    }
    el('taskUpdated').textContent = `${active ? `开始于 ${date(active.startedAt)} · ` : ''}更新于 ${date(data.observedAt)} · ${active ? '每 2 秒刷新' : '每 5 秒刷新'}`
    el('lastTask').hidden = !last
    if (last) {
      const labels = { success: '成功', partial: '不完整', error: '失败', cancelled: '已取消' }
      el('lastTask').dataset.state = last.status
      el('lastTaskSummary').textContent = `${last.name} · ${labels[last.status] || last.status} · ${date(last.finishedAt)}`
      const detail = [last.snapshotId ? `快照：${last.snapshotId}` : '', last.target ? `恢复目录：${last.target}` : '', last.error].filter(Boolean).join('\n')
      el('lastTaskDetail').textContent = detail
      el('lastTaskDetail').hidden = !detail
    }
    updateTaskActions()
  }
  function updateTaskActions() {
    const dirty = loaded && JSON.stringify(collect()) !== saved
    document.querySelectorAll('[data-task]').forEach(button => {
      button.disabled = !authenticated || !loaded || !statusKnown || dirty || busy || taskBusy || library.busy || Boolean(monitor.active)
    })
    el('cancelTask').disabled = !authenticated || !statusKnown || taskBusy || !monitor.active || monitor.active.cancelled
  }
  document.querySelectorAll('[data-task]').forEach(button => button.addEventListener('click', async () => {
    const action = button.dataset.task
    let selector
    if (action === 'restore') {
      selector = window.prompt('输入 latest 或快照 ID，将恢复到服务器上的独立目录：', 'latest')?.trim()
      if (!selector) return
    }
    if (action === 'init' && !window.confirm('使用已保存配置创建加密仓库？已有仓库不会被覆盖。请先保存好仓库密码。')) return
    if (action === 'restore' && !window.confirm(`恢复 ${selector} 到新的恢复目录，不覆盖源文件。是否继续？`)) return
    taskBusy = true
    updateTaskActions()
    try {
      await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, selector }) }, 'tasks')
      library.loaded = false
      showNotice('任务已启动，可在当前任务区域查看进度和结果。')
      await refreshTaskStatus()
    } catch (error) { showNotice(error.message, true) }
    finally { taskBusy = false; updateTaskActions() }
  }))
  el('cancelTask').addEventListener('click', async () => {
    if (!monitor.active) return
    taskBusy = true
    updateTaskActions()
    try {
      await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: monitor.active.id }) }, 'tasks/cancel')
      await refreshTaskStatus()
    } catch (error) { showNotice(error.message, true) }
    finally { taskBusy = false; updateTaskActions() }
  })
  async function refreshTaskStatus() {
    if (monitor.polling || monitor.stopped || !authenticated) return
    monitor.polling = true
    clearTimeout(monitor.timer)
    el('refreshTask').disabled = true
    let failed = false
    try {
      const data = await request({}, 'status', 10000)
      if (!monitor.stopped) renderTaskStatus(data)
    } catch (error) {
      failed = true
      statusKnown = false
      updateTaskActions()
      if (!monitor.stopped) {
        el('taskMonitor').dataset.state = 'stale'
        el('taskStatusError').hidden = false
        el('taskStatusError').textContent = `状态刷新失败：${error.message}。保留上次读取结果，稍后自动重试。`
      }
    } finally {
      monitor.polling = false
      el('refreshTask').disabled = false
      if (!monitor.stopped) monitor.timer = setTimeout(refreshTaskStatus, document.hidden ? 15000 : failed ? 5000 : monitor.active ? 2000 : 5000)
    }
  }
  el('refreshTask').addEventListener('click', refreshTaskStatus)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTaskStatus() })
  window.addEventListener('pagehide', () => { monitor.stopped = true; clearTimeout(monitor.timer) })
  window.addEventListener('pageshow', () => { if (authenticated && monitor.stopped) { monitor.stopped = false; refreshTaskStatus() } })
  function libraryNotice(message, error = false) {
    el('browserNotice').textContent = message
    el('browserNotice').classList.toggle('error', error)
    el('browserNotice').hidden = !message
  }
  function updateLibrary() {
    const dirty = loaded && JSON.stringify(collect()) !== saved
    const blocked = !loaded || dirty || busy || library.busy
    el('libraryUnsaved').hidden = !dirty
    document.querySelectorAll('[data-library-action]').forEach(button => { button.disabled = blocked })
    if (library.snapshots) {
      el('snapshotsPrev').disabled = blocked || library.snapshots.offset === 0
      el('snapshotsNext').disabled = blocked || library.snapshots.nextOffset === null
    }
    if (library.files) {
      el('filesPrev').disabled = blocked || library.files.offset === 0
      el('filesNext').disabled = blocked || library.files.nextOffset === null
    }
    el('page-backups').setAttribute('aria-busy', String(library.busy))
  }
  async function libraryAction(callback) {
    if (library.busy || busy || !loaded) return
    if (JSON.stringify(collect()) !== saved) { libraryNotice('请先保存配置，再浏览或准备下载。', true); return }
    library.busy = true
    libraryNotice('正在读取仓库，请稍候…')
    update()
    try { await callback(); libraryNotice('') }
    catch (error) { libraryNotice(error.message, true) }
    finally { library.busy = false; update() }
  }
  function pagination(prefix, data, limit) {
    el(`${prefix}Pagination`).hidden = data.total <= limit
    el(`${prefix}Count`).textContent = `第 ${Math.floor(data.offset / limit) + 1} 页 · 共 ${data.total} 项`
  }
  function renderSnapshots(data) {
    library.snapshots = data
    library.loaded = true
    el('snapshotScope').textContent = `${data.hostname} · ${data.tag}`
    el('snapshotEmpty').hidden = data.items.length > 0
    el('snapshotEmpty').textContent = '没有快照。请检查主机名与标签是否匹配，或先初始化仓库并创建备份。'
    el('snapshotTable').hidden = !data.items.length
    el('snapshotRows').replaceChildren(...data.items.map(item => {
      const row = node('tr')
      row.dataset.snapshot = item.id
      row.classList.toggle('selected', library.snapshot?.id === item.id)
      const time = node('td', date(item.time))
      const id = node('small', item.id.slice(0, 8))
      id.title = item.id
      time.append(id)
      const operation = node('td')
      operation.append(action('浏览文件', () => browse(item, '/')))
      row.append(time, node('td', item.hostname), node('td', item.files ?? '—'), node('td', size(item.bytes)), operation)
      return row
    }))
    pagination('snapshot', data, 30)
  }
  function refreshSnapshots(offset = 0) {
    return libraryAction(async () => renderSnapshots(await request({}, `snapshots?offset=${offset}`, 150000)))
  }
  function renderFiles(data) {
    library.directory = data.path
    library.files = data
    el('fileBrowser').hidden = false
    el('selectedSnapshot').textContent = `${date(library.snapshot.time)} · ${library.snapshot.id.slice(0, 8)}`
    document.querySelectorAll('[data-snapshot]').forEach(row => row.classList.toggle('selected', row.dataset.snapshot === library.snapshot.id))
    el('fileEmpty').hidden = data.items.length > 0
    el('fileTable').hidden = !data.items.length
    const crumbs = [action('快照根目录', () => browse(library.snapshot, '/'), '')]
    let current = ''
    for (const segment of data.path.split('/').filter(Boolean)) {
      current += `/${segment}`
      const target = current
      crumbs.push(node('span', '/'), action(segment, () => browse(library.snapshot, target), ''))
    }
    crumbs[crumbs.length - 1].setAttribute('aria-current', 'location')
    el('breadcrumbs').replaceChildren(...crumbs)
    el('downloadFolder').hidden = data.path === '/'
    el('fileRows').replaceChildren(...data.items.map(item => {
      const row = node('tr')
      const name = node('td')
      name.append(node('span', item.type === 'dir' ? '目录' : item.type === 'file' ? '文件' : '链接/特殊', 'file-kind'))
      name.append(item.type === 'dir' ? action(item.name, () => browse(library.snapshot, item.path), 'file-name') : node('span', item.name))
      const operation = node('td')
      if (item.downloadable) operation.append(action(item.type === 'dir' ? '下载 ZIP' : '下载', () => prepareDownload(item.path)))
      else operation.append(node('span', '随上级目录打包', 'muted'))
      row.append(name, node('td', item.type === 'file' ? size(item.size) : '—'), node('td', date(item.mtime), 'file-time'), operation)
      return row
    }))
    pagination('file', data, 100)
  }
  function browse(snapshot, directory, offset = 0) {
    return libraryAction(async () => {
      const query = new URLSearchParams({ snapshot: snapshot.id, path: directory, offset })
      const data = await request({}, `files?${query}`, 150000)
      library.snapshot = snapshot
      renderFiles(data)
    })
  }
  function prepareDownload(selectedPath) {
    return libraryAction(async () => {
      const { download } = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshotId: library.snapshot.id, path: selectedPath }) }, 'downloads')
      library.downloads.push(download)
      renderDownloads()
      await refreshDownloads()
      el('downloadTasks').scrollIntoView({ behavior: 'auto', block: 'nearest' })
    })
  }
  async function downloadFile(item) {
    try {
      // 先确认任务仍有效，再交给浏览器原生下载；沿用锅巴支持的 query token 鉴权。
      const { download } = await request({}, `downloads/${item.id}`)
      if (download.status !== 'ready') throw new Error('下载尚未准备完成，请刷新任务')
      const url = new URL(apiUrl(`downloads/${item.id}/file`), location.origin)
      if (url.origin !== location.origin) throw new Error('下载地址必须与面板同源')
      if (!standalone) {
        const token = guobaToken()
        if (!token) throw new Error('登录状态已失效，请重新登录锅巴后下载')
        url.searchParams.set('token', token)
      }
      const link = node('a')
      link.href = url.href
      link.download = item.name
      link.referrerPolicy = 'no-referrer'
      document.body.append(link)
      link.click()
      link.remove()
      libraryNotice('已交给浏览器下载，可在浏览器下载列表查看进度。')
    } catch (error) { libraryNotice(error.message, true) }
  }
  async function changeDownload(item, cancel) {
    try {
      await request({ method: cancel ? 'POST' : 'DELETE', ...(cancel ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) }, `downloads/${item.id}${cancel ? '/cancel' : ''}`)
      await refreshDownloads()
    } catch (error) { libraryNotice(error.message, true) }
  }
  function renderDownloads() {
    if (!library.downloads.length) {
      el('downloadTasks').replaceChildren(node('p', '暂无下载任务。先选择快照或文件。', 'empty-state'))
      return
    }
    el('downloadTasks').replaceChildren(...library.downloads.map(item => {
      const row = node('div', undefined, 'download-task')
      row.dataset.state = item.status
      const info = node('div', undefined, 'download-info')
      info.append(node('strong', item.name), node('p', `${item.snapshotId.slice(0, 8)} · ${item.path}`))
      const message = item.status === 'preparing' ? `正在准备 · 已生成 ${size(item.bytes)}`
        : item.status === 'ready' ? `已就绪 · ${size(item.bytes)} · 保留至 ${date(item.expiresAt)}`
          : item.status === 'cancelled' ? '已取消准备，临时文件已清理。' : `准备失败 · ${item.error}`
      info.append(node('p', message))
      const actions = node('div', undefined, 'download-actions')
      if (item.status === 'preparing') {
        const progress = node('progress')
        progress.setAttribute('aria-label', '正在准备下载')
        info.append(progress)
        actions.append(action('取消', () => changeDownload(item, true), 'table-button', false))
      } else {
        if (item.status === 'ready') actions.append(action('下载到本机', () => downloadFile(item), 'table-button', false))
        actions.append(action('清理', () => changeDownload(item, false), 'table-button', false))
      }
      row.append(info, actions)
      return row
    }))
  }
  let pollingDownloads = false
  let queuedDownloadRefresh = false
  async function refreshDownloads() {
    if (!authenticated) return
    if (pollingDownloads) { queuedDownloadRefresh = true; return }
    pollingDownloads = true
    clearTimeout(downloadTimer)
    try {
      const response = await request({}, 'downloads')
      library.downloads = response.downloads
      renderDownloads()
    } catch (error) { libraryNotice(`读取下载任务失败：${error.message}`, true) }
    finally {
      pollingDownloads = false
      if (authenticated && queuedDownloadRefresh) { queuedDownloadRefresh = false; downloadTimer = setTimeout(refreshDownloads, 0) }
      else if (authenticated && library.downloads.some(item => item.status === 'preparing')) downloadTimer = setTimeout(refreshDownloads, document.hidden ? 5000 : 1500)
    }
  }
  el('refreshSnapshots').addEventListener('click', () => refreshSnapshots())
  el('snapshotsPrev').addEventListener('click', () => refreshSnapshots(Math.max(0, library.snapshots.offset - 30)))
  el('snapshotsNext').addEventListener('click', () => refreshSnapshots(library.snapshots.nextOffset))
  el('filesPrev').addEventListener('click', () => browse(library.snapshot, library.directory, Math.max(0, library.files.offset - 100)))
  el('filesNext').addEventListener('click', () => browse(library.snapshot, library.directory, library.files.nextOffset))
  el('downloadSnapshot').addEventListener('click', () => prepareDownload('/'))
  el('downloadFolder').addEventListener('click', () => prepareDownload(library.directory))
  el('refreshDownloads').addEventListener('click', refreshDownloads)

  document.querySelectorAll('[data-test]').forEach(button => button.addEventListener('click', async () => {
    if (!loaded || busy) return
    const kind = button.dataset.test
    const result = document.querySelector(`[data-test-result="${kind}"]`)
    const label = button.textContent
    const current = collect()
    // 检测只提交本组字段，未填完的密码、cron 等不会阻止连接测试。
    const data = kind === 'restic' ? { resticPath: current.resticPath } : { oss: current.oss }
    busy = true
    update()
    button.textContent = '正在测试…'
    result.hidden = false
    result.dataset.state = 'pending'
    result.setAttribute('aria-busy', 'true')
    result.textContent = kind === 'restic' ? '正在检查服务器上的 restic…' : '正在连接 OSS，验证凭据与列举权限…'
    try {
      const response = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }, `test/${kind}`)
      result.dataset.state = 'success'
      result.textContent = `测试通过 · ${response.result.message}（耗时 ${(response.result.elapsedMs / 1000).toFixed(2)} 秒）`
    } catch (error) {
      result.dataset.state = 'error'
      result.textContent = `测试失败 · ${error.message}`
    } finally {
      result.setAttribute('aria-busy', 'false')
      button.textContent = label
      busy = false
      update()
    }
  }))

  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => selectTab(button.dataset.tab)))
  document.querySelector('.brand').addEventListener('click', () => selectTab('repository'))
  document.querySelectorAll('[data-secret]').forEach(input => input.addEventListener('focus', () => { if (input.value === '********') input.select() }))
  document.querySelectorAll('[data-reveal]').forEach(button => button.addEventListener('click', () => {
    const input = form.elements.namedItem(button.dataset.reveal)
    input.type = input.type === 'password' ? 'text' : 'password'
    button.textContent = input.type === 'password' ? '显示' : '隐藏'
  }))
  form.addEventListener('input', event => {
    if (event.target.name === 'resticPath') clearTests('restic')
    if (event.target.name?.startsWith('oss.')) clearTests('oss')
    update()
  })
  form.addEventListener('change', update)
  // 隐藏分组中的必填项出错时先切换到对应分组，浏览器才能聚焦输入框。
  form.addEventListener('invalid', event => {
    const page = event.target.closest('.config-page')
    if (page) selectTab(page.id.replace('page-', ''))
  }, true)
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (!loaded || busy) return
    const data = collect()
    busy = true
    update()
    try {
      const result = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      fill(result)
      showNotice(result.message || '配置已保存')
    } catch (error) { showNotice(error.message, true) }
    finally { busy = false; update() }
  })
  refreshButton.addEventListener('click', reload)
  window.addEventListener('beforeunload', event => {
    if (loaded && saved !== JSON.stringify(collect())) { event.preventDefault(); event.returnValue = '' }
  })
  function applyTheme(isDark) { document.documentElement.dataset.theme = isDark ? 'dark' : 'light' }
  try {
    const theme = JSON.parse(localStorage.getItem('__guoba_theme__') || 'null')
    applyTheme(theme ? Boolean(theme.isDark) : window.matchMedia('(prefers-color-scheme: dark)').matches)
  } catch { applyTheme(false) }
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === window.parent && event.data?.type === 'guoba:theme-changed') applyTheme(event.data.isDark)
  })
  selectTab('repository')
  if (standalone) {
    showLogin()
    document.getElementById('loginButton').disabled = true
    enterPanel().catch(() => showLogin()).finally(() => { document.getElementById('loginButton').disabled = false })
  } else {
    reload()
    refreshTaskStatus()
  }
})()
