export function bytes(value = 0) {
  if (!Number.isFinite(value) || value < 0) return '未知'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ }
  return `${value.toFixed(index ? 2 : 0)} ${units[index]}`
}

export function date(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function backupResult(result) {
  const summary = result.summary
  return [
    result.partial ? '备份不完整：已生成快照，但部分文件未能读取，请处理后重试。' : '备份完成',
    `快照：${result.snapshotId}`,
    `扫描：${summary.total_files_processed ?? 0} 个文件 / ${bytes(summary.total_bytes_processed)}`,
    `新增存储：${bytes(summary.data_added_packed ?? summary.data_added)}`,
    `耗时：${Number(summary.total_duration ?? 0).toFixed(1)} 秒`,
    '此快照可独立恢复完整文件树；仓库只新增未去重的数据块。',
    result.warning,
  ].filter(Boolean).join('\n')
}

export function statusMessage({ config, readiness, last, active }) {
  const labels = { success: '成功', partial: '不完整', error: '失败', cancelled: '已取消' }
  return [
    'restic 备份状态',
    `配置：${readiness}（未在此处连接仓库）`,
    `后端：${config.backend === 'oss' ? '阿里云 OSS / S3' : '本地仓库'}`,
    `源目录：${config.frameworkDir}`,
    `快照范围：${config.hostname} / ${config.snapshotTag}`,
    `定时：${config.schedule.enabled ? config.schedule.cron : '关闭'}`,
    `当前：${active ? `${active.name}${active.cancelled ? '（正在取消）' : ''}，开始于 ${date(active.startedAt)}` : '空闲'}`,
    active?.progress ? `进度：${((active.progress.percent ?? 0) * 100).toFixed(1)}% / ${bytes(active.progress.bytesDone)}` : '',
    last ? `最近任务：${last.name} / ${labels[last.status] ?? last.status} / ${date(last.finishedAt)}` : '最近任务：无',
    last?.snapshotId ? `最近任务快照：${last.snapshotId}` : '',
    last?.error ? `错误：${last.error}` : '',
    `排除：${config.excludes.join('、')}`,
  ].filter(Boolean).join('\n')
}
