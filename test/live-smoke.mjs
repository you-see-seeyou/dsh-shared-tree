import { apply } from '../lib/index.js'
const tools = new Map()
const ctx = { tools: { register: (t) => tools.set(t.name, t) }, get: () => undefined }
apply(ctx, {})   // 用默认 root = DSH_HOME/profiles/node_modules
const tool = tools.get('shared_tree')
const out = await tool.execute({ action: 'status' }, {})
console.log('===== status =====')
console.log(out)
console.log('')
console.log('===== search kind=bundle limit=6 =====')
console.log(await tool.execute({ action: 'search', kind: 'bundle', limit: 6 }, {}))

