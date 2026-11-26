import { apply } from '../lib/index.js'
const tools = new Map()
const webServer = { routes: [], register(r) { this.routes.push(r); return () => {} } }
// 真实 desktop 的 19 条 bundles 里，7 条是 link:（含 dsh-shared-tree 自己）
const bundles = [
  { name: 'dsh-mnemon', enabled: true }, { name: 'dsh-taskboard', enabled: true },
  { name: 'dsh-super-kanban', enabled: true }, { name: 'dsh-context', enabled: true },
  { name: 'dsh-hermes-memory', enabled: true }, { name: 'dsh-plugin-guard', enabled: true },
  { name: 'dsh-prompt-rewriter', enabled: true }, { name: 'dsh-better-sidebar', enabled: true },
  { name: 'dsh-agent-model-hub', enabled: true, version: '0.2.0', availability: 'profile', source: 'link:D:\\ws\\agent-model-hub' },
  { name: 'dsh-llm-empty-text-guard', enabled: true, version: '0.1.0', availability: 'profile', source: 'link:D:\\ws\\dsh-llm-empty-text-guard' },
  { name: 'dsh-llm-failover-probe', enabled: true, version: '0.1.0', availability: 'profile', source: 'link:D:\\ws\\dsh-llm-failover-probe' },
  { name: 'dsh-qwen-token-plan-cn-responses', enabled: true, version: '0.1.9', availability: 'profile', source: 'link:D:\\ws\\dsh-qwen-token-plan-cn-responses' },
  { name: 'dsh-rotation-signal', enabled: false, version: '0.1.0', availability: 'profile', source: 'link:D:\\ws\\dsh-rotation-signal' },
  { name: 'dsh-shared-tree', enabled: true, version: '0.1.0', availability: 'profile', source: 'link:D:\\ws\\dsh-shared-tree' },
  { name: 'dsh-steer-busy', enabled: true, version: '0.1.0', availability: 'profile', source: 'link:D:\\ws\\dsh-steer-busy' },
]
const ctx = {
  tools: { register: (t) => tools.set(t.name, t) },
  get: (k) => k === 'pluginManager' ? { listBundles: async () => bundles, setBundleEnabled: async () => ({ application: 'applied' }) } : (k === 'webServer' ? webServer : undefined),
  inject: (deps, cb) => (deps.includes('webServer') ? cb({ webServer, get: () => undefined }) : undefined),
}
apply(ctx, {})
const route = webServer.routes.find((r) => r.path === '/dsh-shared-tree')
const res = { statusCode: 0, body: '', writeHead(s) { this.statusCode = s; return this }, end(c) { if (c) this.body += String(c); this.done?.() } }
const req = { method: 'GET', url: '/dsh-shared-tree/status', on() {}, destroy() {} }
const p = route.handler(req, res)
await new Promise((r) => { res.done = r; setTimeout(r, 50) })
await p
const v = JSON.parse(res.body).value
console.log('=== 共享树列表计数（应与上轮完全一致，未受影响）===')
console.log(JSON.stringify(v.counts))
console.log('  total=' + v.counts.total + ' plugins=' + v.counts.plugins + ' components=' + v.counts.components + ' libraries=' + v.counts.libraries)
console.log('')
console.log('=== 只读分区 linked（' + v.linked.length + ' 条）===')
for (const l of v.linked) console.log('  ' + (l.enabled ? '[已启用]' : '[未启用]') + ' ' + l.name + '@' + l.version + '  ' + l.source)
console.log('')
console.log('含 dsh-shared-tree 自己:', v.linked.some((l) => l.name === 'dsh-shared-tree'))
console.log('link: 插件混进共享树列表吗:', v.packages.some((p) => p.name.startsWith('dsh-llm') || p.name === 'dsh-shared-tree') ? '是（不对）' : '否 ✓')
