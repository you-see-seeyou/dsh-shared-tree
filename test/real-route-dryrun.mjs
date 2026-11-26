import { apply } from '../lib/index.js'
const tools = new Map()
const webServer = { routes: [], register(r) { this.routes.push(r); return () => {} } }
const bundles = [
  { name: 'dsh-mnemon', enabled: true }, { name: 'dsh-taskboard', enabled: true },
  { name: 'dsh-super-kanban', enabled: true }, { name: 'dsh-context', enabled: true },
  { name: 'dsh-hermes-memory', enabled: true }, { name: 'dsh-plugin-guard', enabled: true },
  { name: 'dsh-prompt-rewriter', enabled: true }, { name: 'dsh-better-sidebar', enabled: true },
]
const ctx = {
  tools: { register: (t) => tools.set(t.name, t) },
  get: (k) => k === 'pluginManager' ? { listBundles: async () => bundles, setBundleEnabled: async () => ({ application: 'applied' }) } : (k === 'webServer' ? webServer : undefined),
  inject: (deps, cb) => (deps.every((d) => d === 'webServer') ? cb({ webServer, get: () => undefined }) : undefined),
}
apply(ctx, {})
const route = webServer.routes.find((r) => r.path === '/dsh-shared-tree')
const res = { statusCode: 0, body: '', writeHead(s) { this.statusCode = s; return this }, end(c) { if (c) this.body += String(c); this.done?.() } }
const req = { method: 'GET', url: '/dsh-shared-tree/status', on() {}, destroy() {} }
const p = route.handler(req, res)
await new Promise((r) => { res.done = r; setTimeout(r, 50) })
await p
const j = JSON.parse(res.body)
const v = j.value
console.log('=== 侧边栏数据源（真实共享树 + 假 pluginManager）===')
console.log('列表行数 counts.total      :', v.counts.total)
console.log('插件总数 counts.plugins     :', v.counts.plugins)
console.log('归组组件 counts.components  :', v.counts.components)
console.log('bundle / 仅 client          :', v.counts.bundle, '/', v.counts.clientOnly)
console.log('已启用 counts.enabled       :', v.counts.enabled)
console.log('被过滤的纯依赖库 libraries  :', v.counts.libraries, '  (= 194 - 20)')
console.log('')
console.log('顶层行（%d 个）:', v.packages.length)
for (const pkg of v.packages) {
  const kids = pkg.components ?? []
  console.log(`  ${pkg.name}${pkg.enabled ? ' [已启用]' : ''}${kids.length ? ` → ${kids.length} 组件` : ''}`)
}
console.log('')
const owner = v.packages.find((p) => p.name === 'dsh-mnemon')
console.log('dsh-mnemon 下的组件:', (owner.components ?? []).map((c) => c.name).join(', '))
const leaked = v.packages.filter((p) => /^(d3|mermaid|codemirror|@lezer|cytoscape)/.test(p.name))
console.log('顶层行里是否残留 d3/mermaid/codemirror/@lezer/cytoscape:', leaked.length ? leaked.map(p=>p.name).join(',') : '无 ✓')
