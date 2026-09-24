import { createPanelConfig } from './lib/panel-config.js'

export function supportGuoba() {
  return createGuobaSupport(createPanelConfig())
}

export function createGuobaSupport(store) {
  return {
    pluginInfo: {
      name: 'backup-plugin', title: 'restic 备份',
      description: 'JiuLi 块级增量去重备份，支持阿里云 OSS 与本地仓库',
      isV3: true, isV2: false, showInMenu: 'auto', icon: 'mdi:backup-restore', iconColor: '#23756c',
    },
    configInfo: {
      schemas: [
        { label: '备份仓库', component: 'SOFT_GROUP_BEGIN' },
        { field: 'resticPath', label: 'restic 路径', component: 'Input', required: true, bottomHelpMessage: 'Linux 示例：/usr/local/bin/restic；填 restic 则从 PATH 查找。' },
        { field: 'backend', label: '存储位置', component: 'Select', componentProps: { options: [{ label: '阿里云 OSS', value: 'oss' }, { label: '本地仓库', value: 'local' }] } },
        { field: 'password', label: '仓库密码', component: 'InputPassword', bottomHelpMessage: '星号占位表示已保存，保持不变即保留；清空则删除配置中的密码。仓库密码与 OSS 密钥不同，请在仓库外保存。' },
        { field: 'passwordFile', label: '密码文件', component: 'Input', bottomHelpMessage: '可选，优先于上面的密码。RESTIC_PASSWORD_FILE / RESTIC_PASSWORD 环境变量优先于配置。' },
        { field: 'localRepository', label: '本地仓库目录', component: 'Input', bottomHelpMessage: '仅本地后端使用，必须在机器人目录之外。' },
        { label: '阿里云 OSS', component: 'SOFT_GROUP_BEGIN' },
        { field: 'oss.endpoint', label: '地域 Endpoint', component: 'Input', bottomHelpMessage: '例如 https://oss-cn-hangzhou.aliyuncs.com，不含 Bucket 名。' },
        { field: 'oss.region', label: 'OSS 地域', component: 'Input', componentProps: { placeholder: 'oss-cn-hangzhou' } },
        { field: 'oss.bucket', label: 'Bucket 名称', component: 'Input' },
        { field: 'oss.prefix', label: '仓库前缀', component: 'Input', componentProps: { placeholder: 'jiuli' } },
        ...[
          ['oss.accessKeyId', 'AccessKey ID'], ['oss.accessKeySecret', 'AccessKey Secret'], ['oss.sessionToken', '临时凭据 Token'],
        ].map(([field, label]) => ({ field, label, component: 'InputPassword', bottomHelpMessage: '星号占位表示已保存；未修改则保留，清空则删除。对应的 AWS 环境变量优先。' })),
        { label: '定时与快照', component: 'SOFT_GROUP_BEGIN' },
        { field: 'schedule.enabled', label: '开启定时备份', component: 'Switch', bottomHelpMessage: '面板保存后自动更新定时任务。' },
        { field: 'schedule.cron', label: '备份时间', component: 'Input', bottomHelpMessage: '0 0 4 * * * 表示每天 04:00，使用服务器时区；支持 5 或 6 段数字 cron。' },
        { field: 'snapshotTag', label: '快照标签', component: 'Input', bottomHelpMessage: '同一仓库中的不同机器人使用不同标签。' },
        { field: 'hostname', label: '备份主机名', component: 'Input', bottomHelpMessage: '留空使用当前机器名；迁移恢复时填原机器名。' },
        { label: '排除与传输', component: 'SOFT_GROUP_BEGIN' },
        { field: 'extraExcludes', label: '额外排除路径', component: 'GTags', bottomHelpMessage: '默认始终排除 node_modules、logs、temp、data/upload_tmp、data/memes 和插件运行目录；这里添加其他排除规则，不支持 ! 反选。' },
        { field: 'timeoutMinutes', label: '任务超时（分钟）', component: 'InputNumber', componentProps: { min: 1, max: 10080, step: 1 } },
        ...[['limitUploadKiB', '上传限速'], ['limitDownloadKiB', '下载限速']].map(([field, label]) => ({
          field, label, component: 'InputNumber', componentProps: { min: 0, max: 2147483647, step: 1, addonAfter: 'KiB/s' }, bottomHelpMessage: '0 表示不限速。',
        })),
      ],
      async getConfigData() { return (await store.get()).config },
      async setConfigData(data, { Result }) {
        try { const result = await store.save(data); return Result.ok({}, result.message) }
        catch (error) { return Result.error(error.message) }
      },
    },
  }
}
