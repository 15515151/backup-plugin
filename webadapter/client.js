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
  const params = new URLSearchParams(location.search)
  const assetIndex = location.pathname.indexOf('/web-page/')
  const rawBase = params.get('__webBase') || (assetIndex >= 0 ? location.pathname.slice(0, assetIndex) : '')
  const base = new URL(rawBase || '/', location.origin)
  const apiUrl = window.Guoba?.apiUrl ? window.Guoba.apiUrl('/backup-plugin/config')
    : `${base.pathname.replace(/\/+$/, '')}/api/backup-plugin/config`

  function showNotice(message, error = false) {
    notice.textContent = message
    notice.classList.toggle('error', error)
    notice.hidden = false
  }

  function selectTab(tab) {
    const selected = ['repository', 'oss', 'schedule'].includes(tab) ? tab : 'repository'
    document.querySelectorAll('[data-tab]').forEach(button => {
      const active = button.dataset.tab === selected
      button.classList.toggle('active', active)
      if (active) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    })
    document.querySelectorAll('.config-page').forEach(page => { page.hidden = page.id !== `page-${selected}` })
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
    saveButton.disabled = busy || !dirty
    refreshButton.disabled = busy
    fieldset.disabled = busy || !loaded
    form.elements.namedItem('schedule.cron').disabled = !form.elements.namedItem('schedule.enabled').checked
    document.getElementById('localField').hidden = form.elements.namedItem('backend').value !== 'local'
    const destination = document.getElementById('destination')
    destination.firstChild.textContent = form.elements.namedItem('backend').value === 'local' ? '本地仓库' : '阿里云 OSS'
    saveState.textContent = busy ? '正在处理…' : !loaded ? '配置未读取，请点击重新读取' : dirty ? '有未保存的修改' : '配置已同步'
    saveButton.textContent = busy ? '请稍候…' : '保存配置'
  }

  function fill(data) {
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
  }

  async function request(options = {}) {
    if (base.origin !== location.origin) throw new Error('面板接口必须与当前页面同源')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
      const response = await fetch(apiUrl, { ...options, signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.ok) throw new Error(data.error || data.message || `请求失败（${response.status}），请检查面板登录状态`)
      return data
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请重新读取配置确认是否保存成功')
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

  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => selectTab(button.dataset.tab)))
  document.querySelector('.brand').addEventListener('click', () => selectTab('repository'))
  document.querySelectorAll('[data-secret]').forEach(input => input.addEventListener('focus', () => { if (input.value === '********') input.select() }))
  document.querySelectorAll('[data-reveal]').forEach(button => button.addEventListener('click', () => {
    const input = form.elements.namedItem(button.dataset.reveal)
    input.type = input.type === 'password' ? 'text' : 'password'
    button.textContent = input.type === 'password' ? '显示' : '隐藏'
  }))
  form.addEventListener('input', update)
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
  reload()
})()
