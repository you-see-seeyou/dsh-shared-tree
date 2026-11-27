/**
 * 冒烟脚本：用默认 root（<DSH_HOME>/profiles/node_modules）跑一次 status 与 search。
 *
 * 注意：它读的是**运行时的真实共享树**，输出会包含本机已装的插件名。仅本地手工运行查看用，
 * 不是 `npm test` 的一部分，也不要把它的输出粘进仓库。
 */
import { apply } from '../lib/index.js'
const tools = new Map()
const ctx = { tools: { register: (t) => tools.set(t.name, t) }, get: () => undefined }
apply(ctx, {})
const tool = tools.get('shared_tree')
const out = await tool.execute({ action: 'status' }, {})
console.log('===== status =====')
console.log(out)
console.log('')
console.log('===== search kind=bundle limit=6 =====')
console.log(await tool.execute({ action: 'search', kind: 'bundle', limit: 6 }, {}))