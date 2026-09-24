import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createBackupPlugin } from './lib/plugin.js'

// 框架是可选 peer；插件位于 JiuLi/plugins 时也可通过宿主自身 exports 解析。
// 独立网页入口不加载本文件，也不需要安装或构建 JiuLi。
let frameworkUrl
try { frameworkUrl = pathToFileURL(createRequire(import.meta.url).resolve('jiuli')).href }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
  frameworkUrl = pathToFileURL(createRequire(new URL('../../package.json', import.meta.url)).resolve('jiuli')).href
}
const { JiuLiPlugin } = await import(frameworkUrl)

export default createBackupPlugin(JiuLiPlugin)
