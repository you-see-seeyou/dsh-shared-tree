import { apply } from '../lib/index.js'
const tools = new Map()
const webServer = { routes: [], register(r) { this.routes.push(r); return () => {} } }
// 示例 profile 的 bundle 清单（中性占位，不含真实插件组合）。
const bundles = [
  { name: 'example-bundle-a', enabled: true }, { name: 'example-bundle-b', enabled: true },
  { name: 'example-bundle-c', enabled: true }, { name: 'example-bundle-d', enabled: false },
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
const v = JSON.parse(res.body).value
console.log('=== 计数 ===')
console.log(JSON.stringify(v.counts))
console.log('=== 包列表 ===')
for (const item of v.packages) console.log('  ' + item.name + '  kind=' + item.kind + '  enabled=' + item.enabled)