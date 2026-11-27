import { apply } from '../lib/index.js'
const tools = new Map()
const webServer = { routes: [], register(r) { this.routes.push(r); return () => {} } }
// 示例 profile 的 bundle 清单：含若干共享树包 + 若干以 link: 安装的本地插件。
// 数据一律用中性占位（example-* / D:\ws\...），不含任何真实 profile 的插件组合与版本。
const bundles = [
  { name: 'example-bundle-a', enabled: true }, { name: 'example-bundle-b', enabled: true },
  { name: 'example-bundle-c', enabled: true }, { name: 'example-bundle-d', enabled: false },
  { name: 'example-linked-a', enabled: true, version: '0.1.0', availability: 'profile', source: 'link:D:\\ws\\example-linked-a' },
  { name: 'example-linked-b', enabled: false, version: '0.2.0', availability: 'profile', source: 'link:D:\\ws\\example-linked-b' },
  { name: 'example-linked-self', enabled: true, version: '0.1.0', availability: 'profile', source: 'link:D:\\ws\\example-linked-self' },
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
console.log('=== 共享树列表计数 ===')
console.log(JSON.stringify(v.counts))
console.log('  total=' + v.counts.total + ' plugins=' + v.counts.plugins + ' components=' + v.counts.components + ' libraries=' + v.counts.libraries)
console.log('')
console.log('=== 只读分区 linked（' + v.linked.length + ' 条）===')
for (const l of v.linked) console.log('  ' + (l.enabled ? '[已启用]' : '[未启用]') + ' ' + l.name + '@' + l.version + '  ' + l.source)
console.log('')
console.log('含本插件自己:', v.linked.some((l) => l.name === 'example-linked-self'))
console.log('link: 插件混进共享树列表吗:', v.packages.some((p) => p.name.startsWith('example-linked')) ? '是（不对）' : '否 ✓')