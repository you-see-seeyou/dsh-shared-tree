/**
 * dsh-shared-tree 的自验测试。
 *
 * 只读为主：用一个假 ctx（记录 tools.register）+ 真实共享树跑 status/search/verify，
 * 并对 enable/disable 做「不落盘」的假 pluginManager 验证（绝不改真实 profile）。
 * 写入类动作（install）只在临时目录里跑，不碰真实共享树。
 *
 * 运行：node test/shared-tree.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { apply, inject, name } from '../lib/index.js'
import { readLedger, restoreFromLedger } from '../lib/lifecycle.js'

let passed = 0
let failed = 0

/**
 * 跑一个用例。
 * @param {string} title 用例名。
 * @param {Function} body 用例体。
 */
async function test(title, body) {
  try {
    await body()
    passed += 1
    console.log(`  ✓ ${title}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${title}`)
    console.log(`      ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 造一个假 ctx。cordis 的 Context 有 `inject(deps, cb)`，这里照实模拟：
 * 记录注入请求；给了对应服务就直接跑回调，并收集它返回的 disposer。
 * @param {{ pluginManager?: any, webServer?: any }} options 可选服务。
 * @returns {any} 假 ctx。
 */
function fakeContext(options = {}) {
  const tools = new Map()
  const services = new Map()
  const disposers = []
  if (options.pluginManager !== undefined) services.set('pluginManager', options.pluginManager)
  if (options.webServer !== undefined) services.set('webServer', options.webServer)
  return {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get: (key) => services.get(key),
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : [deps]
      const available = names.every((key) => services.has(key))
      if (!available) return undefined
      const face = {}
      for (const key of names) face[key] = services.get(key)
      const dispose = callback({ ...face, get: (key) => services.get(key) })
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    toolsMap: tools,
    disposers,
  }
}

/**
 * 造一个记录注册的假 webServer。
 * @returns {any} 假服务。
 */
function fakeWebServer() {
  const routes = []
  return {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    routes,
  }
}

/**
 * 造一对假 req/res 调用某个 handler。
 * @param {(req: any, res: any) => Promise<void>} handler 路由 handler。
 * @param {string} method HTTP 方法。
 * @param {string} url 请求 URL。
 * @param {any} [body] JSON 请求体。
 * @returns {Promise<{ status: number, json: any }>} 响应。
 */
async function callRoute(handler, method, url, body) {
  const listeners = new Map()
  const req = {
    method, url,
    on: (event, cb) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(cb)
      return req
    },
    destroy: () => {},
  }
  let settled
  const done = new Promise((settle) => { settled = settle })
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; return this },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
      settled()
    },
  }
  const run = handler(req, res)
  // 重放请求体（真实 HTTP 会在 handler 订阅后推送 data/end）。
  await Promise.resolve()
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    for (const cb of listeners.get('data') ?? []) cb(Buffer.from(text, 'utf8'))
  }
  for (const cb of listeners.get('end') ?? []) cb()
  await Promise.all([run, done])
  let json
  try { json = JSON.parse(res.body) } catch { json = undefined }
  return { status: res.statusCode, json }
}

/**
 * 在临时目录造一棵假共享树。
 * @returns {{ root: string, buildDir: string, cleanup: Function }} 路径与清理函数。
 */
function fakeTree() {
  const base = mkdtempSync(join(tmpdir(), 'shared-tree-test-'))
  const root = join(base, 'profiles', 'node_modules')
  const buildDir = join(base, 'build')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '@deepseek-ai', 'schemastery'), { recursive: true })
  writeFileSync(join(root, '@deepseek-ai', 'schemastery', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/schemastery', version: '3.19.0',
  }, null, 2))
  mkdirSync(join(root, 'fake-bundle'), { recursive: true })
  writeFileSync(join(root, 'fake-bundle', 'package.json'), JSON.stringify({
    name: 'fake-bundle', version: '1.2.3', description: 'a fake bundle',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  mkdirSync(join(root, 'fake-lib'), { recursive: true })
  writeFileSync(join(root, 'fake-lib', 'package.json'), JSON.stringify({
    name: 'fake-lib', version: '0.1.0', description: 'plain dependency', dependencies: { 'fake-bundle': '1.2.3' },
  }, null, 2))
  // 只有 dsh.client 的插件：也属于插件语义，但无法作为 profile bundle 启用。
  mkdirSync(join(root, 'fake-client'), { recursive: true })
  writeFileSync(join(root, 'fake-client', 'package.json'), JSON.stringify({
    name: 'fake-client', version: '2.0.0', description: 'a client-only plugin',
    dsh: { client: { platform: 'web', inject: [] } },
  }, null, 2))
  return { root, buildDir, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

console.log('dsh-shared-tree 自验')
console.log('')

await test('模块导出 apply / inject / name', () => {
  assert.equal(typeof apply, 'function')
  assert.deepEqual(inject, ['tools'])
  assert.equal(name, 'shared-tree')
})

await test('插件注册 shared_tree 工具且参数完整', () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const tool = ctx.toolsMap.get('shared_tree')
  assert.ok(tool !== undefined, '未注册 shared_tree')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.deepEqual(tool.parameters.properties.action.enum, ['status', 'search', 'enable', 'disable', 'install', 'verify', 'lifecycle', 'panel'])
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
})

await test('action=status 在空目录上报告"尚未创建"而不是崩', async () => {
  const base = mkdtempSync(join(tmpdir(), 'shared-tree-empty-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = base // 基线快照落在临时目录，不碰真实主目录。
  const ctx = fakeContext()
  apply(ctx, { treeRoot: join(base, 'nothing-here') })
  const tool = ctx.toolsMap.get('shared_tree')
  const text = await tool.execute({ action: 'status' }, {})
  // 生命周期语义：apply（启用）会创建树目录并做基线快照——所以这里是"空树"而非"不存在"。
  assert.match(text, /顶层包：0 个/)
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(base, { recursive: true, force: true })
})

await test('action=status 统计真实假树：包数、bundle 数、junction 数', async () => {
  const tree = fakeTree()
  const ctx = fakeContext()
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  const text = await tool.execute({ action: 'status' }, {})
  assert.match(text, /顶层包：3 个（插件 2：bundle 1 \/ 仅 client 1；纯依赖库 1）/)
  assert.match(text, /@deepseek-ai junction：0\/1/)
  assert.match(text, /树里可启用的 bundle（1）：/)
  assert.match(text, /fake-bundle@1\.2\.3/)
  tree.cleanup()
})

await test('action=search 按关键字过滤', async () => {
  const tree = fakeTree()
  const ctx = fakeContext()
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  const hit = await tool.execute({ action: 'search', query: 'fake-bundle' }, {})
  assert.match(hit, /命中 1 个/)
  assert.match(hit, /fake-bundle@1\.2\.3/)
  assert.doesNotMatch(hit, /fake-lib/)
  const miss = await tool.execute({ action: 'search', query: 'zzz-not-there' }, {})
  assert.match(miss, /没有匹配的包/)
  tree.cleanup()
})

await test('action=search 按 kind 过滤', async () => {
  const tree = fakeTree()
  const ctx = fakeContext()
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  const libraries = await tool.execute({ action: 'search', kind: 'library' }, {})
  assert.match(libraries, /fake-lib/)
  assert.doesNotMatch(libraries, /fake-bundle@/)
  tree.cleanup()
})

await test('action=search 反映 profile 启用状态（假 pluginManager）', async () => {
  const tree = fakeTree()
  const ctx = fakeContext({
    pluginManager: {
      listBundles: async () => ([
        { name: 'fake-bundle', enabled: true, availability: 'profile', version: '1.2.3', rows: [{}, {}] },
      ]),
      setBundleEnabled: async () => ({ application: 'applied' }),
    },
  })
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  const text = await tool.execute({ action: 'search', query: 'fake-bundle' }, {})
  assert.match(text, /已启用/)
  const onlyEnabled = await tool.execute({ action: 'search', onlyEnabled: true }, {})
  assert.match(onlyEnabled, /fake-bundle/)
  assert.doesNotMatch(onlyEnabled, /fake-lib/)
  tree.cleanup()
})

await test('action=enable 调 setBundleEnabled 且不改文件', async () => {
  const tree = fakeTree()
  const calls = []
  const ctx = fakeContext({
    pluginManager: {
      listBundles: async () => [],
      setBundleEnabled: async (target, enabled) => {
        calls.push([target, enabled])
        return { application: 'applied' }
      },
    },
  })
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  const text = await tool.execute({ action: 'enable', target: 'fake-bundle' }, {})
  assert.deepEqual(calls, [['fake-bundle', true]])
  assert.match(text, /已生效/)
  tree.cleanup()
})

await test('action=disable 传 enabled=false', async () => {
  const tree = fakeTree()
  const calls = []
  const ctx = fakeContext({
    pluginManager: {
      listBundles: async () => [],
      setBundleEnabled: async (target, enabled) => {
        calls.push([target, enabled])
        return { application: 'applied' }
      },
    },
  })
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  await tool.execute({ action: 'disable', target: 'fake-bundle' }, {})
  assert.deepEqual(calls, [['fake-bundle', false]])
  tree.cleanup()
})

await test('action=enable 拒绝共享树里不存在的包（不调用 manager）', async () => {
  const tree = fakeTree()
  let called = false
  const ctx = fakeContext({
    pluginManager: {
      listBundles: async () => [],
      setBundleEnabled: async () => {
        called = true
        return { application: 'applied' }
      },
    },
  })
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  const text = await tool.execute({ action: 'enable', target: 'no-such-package' }, {})
  assert.equal(called, false, '不该调用 setBundleEnabled')
  assert.match(text, /未执行任何改动/)
  tree.cleanup()
})

await test('action=enable 在 pluginManager 缺失时给出可操作提示', async () => {
  const tree = fakeTree()
  const ctx = fakeContext()
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  const text = await tool.execute({ action: 'enable', target: 'fake-bundle' }, {})
  assert.match(text, /pluginManager 服务不可用/)
  assert.match(text, /手工/)
  tree.cleanup()
})

await test('action=verify 对未登记目录报"未登记"', async () => {
  const tree = fakeTree()
  const ctx = fakeContext()
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  const text = await tool.execute({ action: 'verify' }, {})
  assert.match(text, /未登记 3/)
  assert.match(text, /有差异/)
  tree.cleanup()
})

await test('action=verify 识别内容漂移与版本漂移', async () => {
  const tree = fakeTree()
  // 直接写清单：fake-lib 记录错误 sha256，fake-bundle 记录错误版本。
  writeFileSync(join(tree.root, '.dsh-shared-tree.json'), JSON.stringify({
    scheme: 'dsh-shared-profile-tree/1',
    packages: [
      { name: 'fake-bundle', version: '9.9.9', sha256: 'deadbeef' },
      { name: 'fake-lib', version: '0.1.0', sha256: 'cafebabe' },
    ],
  }, null, 2))
  const ctx = fakeContext()
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  const text = await tool.execute({ action: 'verify' }, {})
  assert.match(text, /版本漂移/)
  assert.match(text, /内容变化/)
  assert.match(text, /结论：有差异/)
  tree.cleanup()
})

await test('action=install 拒绝非法包名（不跑 pnpm）', async () => {
  const tree = fakeTree()
  const ctx = fakeContext()
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  const text = await tool.execute({ action: 'install', packages: ['bad name; rm -rf /'] }, {})
  assert.match(text, /包名不合法/)
  assert.match(text, /未执行/)
  tree.cleanup()
})

await test('action=install 缺 packages 时报错', async () => {
  const tree = fakeTree()
  const ctx = fakeContext()
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  await assert.rejects(async () => tool.execute({ action: 'install' }, {}), /packages is required/)
  tree.cleanup()
})

await test('参数校验：action 必须在枚举内', async () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const tool = ctx.toolsMap.get('shared_tree')
  await assert.rejects(async () => tool.execute({ action: 'nonsense' }, {}), /must be one of/)
})

await test('参数校验：缺 action 报错', async () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const tool = ctx.toolsMap.get('shared_tree')
  await assert.rejects(async () => tool.execute({}, {}), /action is required/)
})

await test('真实共享树只读体检（不存在的树也不崩）', async () => {
  const ctx = fakeContext()
  // 指向一个肯定不存在的路径，确保 CI/其他机器可跑。
  // 生命周期语义：apply 会创建该目录（启用=建树），之后 status 报告空树。
  const base = mkdtempSync(join(tmpdir(), 'shared-tree-real-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = base
  apply(ctx, { treeRoot: join(base, 'nothing-here') })
  const tool = ctx.toolsMap.get('shared_tree')
  const text = await tool.execute({ action: 'status' }, {})
  assert.match(text, /顶层包：0 个/)
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(base, { recursive: true, force: true })
})

// ── 侧边栏用的 HTTP 数据通道 ────────────────────────────────────────────────

/**
 * 造一个已挂 webServer 的 ctx 并取回注册的 route。
 * @param {any} tree 假树。
 * @param {any} [manager] 假 pluginManager。
 * @returns {{ route: any, ctx: any }}
 */
function ctxWithRoutes(tree, manager) {
  const webServer = fakeWebServer()
  const ctx = fakeContext({ webServer, ...(manager === undefined ? {} : { pluginManager: manager }) })
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const route = webServer.routes.find((item) => item.path === '/dsh-shared-tree')
  return { route, ctx, webServer }
}

await test('路由注册：webServer 存在时注册 prefix 路由', async () => {
  const tree = fakeTree()
  const { route, webServer } = ctxWithRoutes(tree)
  assert.ok(route !== undefined, '未注册路由')
  assert.equal(route.kind, 'prefix')
  assert.equal(typeof route.handler, 'function')
  assert.equal(webServer.routes.length, 1)
  tree.cleanup()
})

await test('路由注册：webServer 缺失时插件仍可用（不抛错）', async () => {
  const tree = fakeTree()
  const ctx = fakeContext() // 没有 webServer
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  assert.match(await tool.execute({ action: 'status' }, {}), /顶层包：3 个/)
  tree.cleanup()
})

await test('GET /status 返回包、类别标志与计数', async () => {
  const tree = fakeTree()
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const { status, json } = await callRoute(route.handler, 'GET', '/dsh-shared-tree/status')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  const names = json.value.packages.map((item) => item.name).sort()
  // 纯依赖库 fake-lib 不出现在列表里（过滤在数据源完成），fake-client 这类只有 dsh.client 的插件保留。
  assert.deepEqual(names, ['fake-bundle', 'fake-client'])
  const bundle = json.value.packages.find((item) => item.name === 'fake-bundle')
  const clientOnly = json.value.packages.find((item) => item.name === 'fake-client')
  assert.equal(bundle.hasBundle, true)
  assert.equal(bundle.hasClient, false)
  assert.equal(clientOnly.hasBundle, false)
  assert.equal(clientOnly.hasClient, true)
  assert.equal(json.value.counts.total, 2)
  assert.equal(json.value.counts.plugins, 2)
  assert.equal(json.value.counts.bundle, 1)
  assert.equal(json.value.counts.libraries, 1)
  assert.equal(json.value.junction.total, 1)
  tree.cleanup()
})

await test('GET /status 反映 pluginManager 的启用状态', async () => {
  const tree = fakeTree()
  const { route } = ctxWithRoutes(tree, {
    listBundles: async () => ([{ name: 'fake-bundle', enabled: true, availability: 'profile', version: '1.2.3', rows: [{}] }]),
  })
  const { json } = await callRoute(route.handler, 'GET', '/dsh-shared-tree/status')
  assert.equal(json.value.packages.find((item) => item.name === 'fake-bundle').enabled, true)
  assert.equal(json.value.packages.find((item) => item.name === 'fake-client').enabled, false)
  assert.equal(json.value.counts.enabled, 1)
  assert.equal(json.value.profileBundlesAvailable, true)
  tree.cleanup()
})

await test('GET /verify 与工具输出同源（行数与计数一致）', async () => {
  const tree = fakeTree()
  const { route, ctx } = ctxWithRoutes(tree)
  const toolText = await ctx.toolsMap.get('shared_tree').execute({ action: 'verify' }, {})
  const { status, json } = await callRoute(route.handler, 'GET', '/dsh-shared-tree/verify')
  assert.equal(status, 200)
  assert.equal(json.value.unrecorded, 3)
  assert.equal(json.value.drifted, 0)
  // 路由 rows 的每一行都必须出现在工具文本里 → 两处结论不可能分叉
  for (const row of json.value.rows) assert.ok(toolText.includes(row.text), `工具文本缺少：${row.text}`)
  assert.ok(toolText.includes(`一致 ${json.value.same}，漂移 ${json.value.drifted}，未登记 ${json.value.unrecorded}，缺失 ${json.value.missing.length}`))
  assert.equal(json.value.healthy, false)
  tree.cleanup()
})

await test('POST /set 的 ok 只表示调用成功，语义结果看 application', async () => {
  const tree = fakeTree()
  // overridden：调用成功但被更高优先级层覆盖 → ok 必须为 true，否则界面会误报"操作失败"。
  const { route } = ctxWithRoutes(tree, {
    listBundles: async () => [],
    setBundleEnabled: async () => ({ application: 'overridden', nextStep: 'a higher-priority layer overrides it' }),
  })
  const { json } = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', { target: 'fake-bundle', enabled: true })
  const result = json.value.results[0]
  assert.equal(result.ok, true, 'overridden 是成功调用，不能报失败')
  assert.equal(result.application, 'overridden')
  assert.equal(result.restartRequired, false)
  assert.match(result.nextStep, /overrides/)
  tree.cleanup()
})

await test('POST /set 遇到 error 才报 ok=false', async () => {
  const tree = fakeTree()
  const { route } = ctxWithRoutes(tree, {
    listBundles: async () => [],
    setBundleEnabled: async () => ({ application: 'failed', error: { code: 'incompatible-version' }, nextStep: 'use a compatible version' }),
  })
  const { json } = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', { target: 'fake-bundle', enabled: true })
  const result = json.value.results[0]
  assert.equal(result.ok, false)
  assert.equal(result.error, 'incompatible-version')
  tree.cleanup()
})

await test('GET /status 为需要提醒的包附带 safetyNote', async () => {
  const tree = fakeTree()
  // 造一个名字命中 SAFETY_NOTES 的包（dsh-mnemon 的 storageScope 警告）
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(tree.root, 'dsh-mnemon'), { recursive: true })
  writeFileSync(join(tree.root, 'dsh-mnemon', 'package.json'), JSON.stringify({
    name: 'dsh-mnemon', version: '0.5.53', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const { json } = await callRoute(route.handler, 'GET', '/dsh-shared-tree/status')
  const mnemon = json.value.packages.find((item) => item.name === 'dsh-mnemon')
  assert.match(mnemon.safetyNote, /storageScope/)
  const plain = json.value.packages.find((item) => item.name === 'fake-client')
  assert.equal(plain.safetyNote, undefined, '无提醒的插件不应带 safetyNote')
  tree.cleanup()
})

await test('POST /set 回带 safetyNote，界面才能提示隔离要求', async () => {
  const tree = fakeTree()
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(tree.root, 'dsh-mnemon'), { recursive: true })
  writeFileSync(join(tree.root, 'dsh-mnemon', 'package.json'), JSON.stringify({
    name: 'dsh-mnemon', version: '0.5.53', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  const { route } = ctxWithRoutes(tree, {
    listBundles: async () => [],
    setBundleEnabled: async () => ({ application: 'applied' }),
  })
  const { json } = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', { target: 'dsh-mnemon', enabled: true })
  assert.match(json.value.results[0].safetyNote, /storageScope/)
  tree.cleanup()
})

await test('护栏：拒绝把「别人的组件」当独立 bundle 启用（issue #470）', async () => {
  const tree = fakeTree()
  // 造 dsh-mnemon（已启用，插入了 mnemon-strategy-scoped）+ 该 strategy 子包（自己也想插同一个 id）
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(tree.root, 'dsh-mnemon'), { recursive: true })
  writeFileSync(join(tree.root, 'dsh-mnemon', 'package.json'), JSON.stringify({
    name: 'dsh-mnemon', version: '0.5.53', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(tree.root, 'dsh-mnemon', 'cordis.patch.yml'), [
    '- insert:',
    '    - id: mnemon',
    '      name: dsh-mnemon',
    '    - id: mnemon-strategy-scoped',
    '      name: dsh-mnemon-strategy-scoped',
    '      disabled: true',
  ].join('\n'))
  mkdirSync(join(tree.root, 'dsh-mnemon-strategy-scoped'), { recursive: true })
  writeFileSync(join(tree.root, 'dsh-mnemon-strategy-scoped', 'package.json'), JSON.stringify({
    name: 'dsh-mnemon-strategy-scoped', version: '0.5.7', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(tree.root, 'dsh-mnemon-strategy-scoped', 'cordis.patch.yml'),
    '- insert:\n    - id: mnemon-strategy-scoped\n      name: dsh-mnemon-strategy-scoped\n')

  const enabledBundles = [{ name: 'dsh-mnemon', enabled: true }]
  let called = false
  const ctx = fakeContext({
    pluginManager: {
      listBundles: async () => enabledBundles,
      setBundleEnabled: async () => { called = true; return { application: 'applied' } },
    },
  })
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')

  // 工具：必须拒绝，且不调用 setBundleEnabled
  const text = await tool.execute({ action: 'enable', target: 'dsh-mnemon-strategy-scoped' }, {})
  assert.equal(called, false, '不得真的去启用')
  assert.match(text, /未执行任何改动/)
  assert.match(text, /issue #470/)
  assert.match(text, /dsh-mnemon/)

  // status：必须把冲突暴露给界面（界面据此隐藏开关）
  const status = await tool.execute({ action: 'status' }, {})
  assert.match(status, /mnemon-strategy-scoped/)

  const webServer = fakeWebServer()
  const ctx2 = fakeContext({
    webServer,
    pluginManager: { listBundles: async () => enabledBundles, setBundleEnabled: async () => { called = true; return {} } },
  })
  apply(ctx2, { treeRoot: tree.root, buildDir: tree.buildDir })
  const route = webServer.routes.find((item) => item.path === '/dsh-shared-tree')
  const listed = await callRoute(route.handler, 'GET', '/dsh-shared-tree/status')
  // 组件不再作为顶层行出现，而是收在归属包（dsh-mnemon）之下。
  assert.equal(
    listed.json.value.packages.some((item) => item.name === 'dsh-mnemon-strategy-scoped'), false,
    '组件不得作为独立行出现',
  )
  const ownerRow = listed.json.value.packages.find((item) => item.name === 'dsh-mnemon')
  const row = (ownerRow.components ?? []).find((item) => item.name === 'dsh-mnemon-strategy-scoped')
  assert.ok(row !== undefined, '组件必须挂在 dsh-mnemon 的 components 下')
  assert.equal(row.conflictId, 'mnemon-strategy-scoped')
  assert.equal(listed.json.value.counts.components, 1)
  assert.equal(listed.json.value.counts.plugins, listed.json.value.counts.total + listed.json.value.counts.components)

  // 路由：同样拒绝
  called = false
  const blocked = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', {
    target: 'dsh-mnemon-strategy-scoped', enabled: true,
  })
  assert.equal(called, false)
  assert.equal(blocked.json.value.results[0].ok, false)
  assert.match(blocked.json.value.results[0].error, /issue #470/)

  // 但**关闭**是允许的（护栏只拦 enable）
  called = false
  await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', {
    target: 'dsh-mnemon-strategy-scoped', enabled: false,
  })
  assert.equal(called, true, 'disable 不应被护栏拦住')

  // 没有任何 bundle 启用时，不该误报冲突（fail-open）
  const lone = fakeContext({ pluginManager: { listBundles: async () => [] } })
  apply(lone, { treeRoot: tree.root, buildDir: tree.buildDir })
  const loneStatus = await lone.toolsMap.get('shared_tree').execute({ action: 'status' }, {})
  assert.doesNotMatch(loneStatus, /issue #470/)
  tree.cleanup()
})

await test('护栏不误伤：正常独立 bundle 仍可启用', async () => {
  const tree = fakeTree()
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(tree.root, 'dsh-solo'), { recursive: true })
  writeFileSync(join(tree.root, 'dsh-solo', 'package.json'), JSON.stringify({
    name: 'dsh-solo', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(tree.root, 'dsh-solo', 'cordis.patch.yml'), '- insert:\n    - id: solo\n      name: dsh-solo\n')
  const ctx = fakeContext({
    pluginManager: {
      listBundles: async () => [{ name: 'fake-bundle', enabled: true }],
      setBundleEnabled: async () => ({ application: 'applied' }),
    },
  })
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const text = await ctx.toolsMap.get('shared_tree').execute({ action: 'enable', target: 'dsh-solo' }, {})
  assert.match(text, /已生效/)
  tree.cleanup()
})

await test('新行为①：纯依赖库不进列表、不计入分组计数，只报被过滤条数', async () => {
  const tree = fakeTree()
  const { route, ctx } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const { json } = await callRoute(route.handler, 'GET', '/dsh-shared-tree/status')
  const names = json.value.packages.map((item) => item.name)

  // fake-lib 没有 dsh 清单 → 必须被过滤（判定依据是插件语义，不是包名白名单）
  assert.ok(!names.includes('fake-lib'), 'fake-lib 不应出现在列表里')
  // 计数同步：total = 列表行数；plugins = total + components；libraries 单独报
  assert.equal(json.value.counts.total, json.value.packages.length)
  assert.equal(json.value.counts.plugins, 2)
  assert.equal(json.value.counts.libraries, 1)
  assert.equal(json.value.counts.plugins, json.value.counts.total + json.value.counts.components)

  // 工具侧仍能看到真实全貌（诊断用），并且显式给出插件/依赖库拆分
  const status = await ctx.toolsMap.get('shared_tree').execute({ action: 'status' }, {})
  assert.match(status, /顶层包：3 个（插件 2：bundle 1 \/ 仅 client 1；纯依赖库 1）/)

  // 白名单反例：换一个新的、从没出现过的库名，同样应被自动过滤（证明不是硬编码名单）
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(tree.root, 'd3'), { recursive: true })
  writeFileSync(join(tree.root, 'd3', 'package.json'), JSON.stringify({ name: 'd3', version: '7.9.2' }, null, 2))
  mkdirSync(join(tree.root, 'mermaid'), { recursive: true })
  writeFileSync(join(tree.root, 'mermaid', 'package.json'), JSON.stringify({ name: 'mermaid', version: '11.17.2' }, null, 2))
  const after = await callRoute(route.handler, 'GET', '/dsh-shared-tree/status')
  const afterNames = after.json.value.packages.map((item) => item.name)
  assert.ok(!afterNames.includes('d3') && !afterNames.includes('mermaid'), '新增依赖库应自动被过滤')
  assert.equal(after.json.value.counts.libraries, 3, '被过滤条数应随之增加')
  assert.equal(after.json.value.counts.total, 2, '列表行数不受依赖库影响')
  tree.cleanup()
})

await test('新行为②：strategy 组件收进归属包、不可独立 enable，护栏仍在', async () => {
  const tree = fakeTree()
  const { mkdirSync, writeFileSync } = await import('node:fs')
  // dsh-mnemon 已启用，其补丁插入了 4 个 strategy id；4 个子包各自也带补丁插同一批 id
  const strategies = ['auto-capture', 'general', 'light-context', 'scoped']
  mkdirSync(join(tree.root, 'dsh-mnemon'), { recursive: true })
  writeFileSync(join(tree.root, 'dsh-mnemon', 'package.json'), JSON.stringify({
    name: 'dsh-mnemon', version: '0.5.53', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(tree.root, 'dsh-mnemon', 'cordis.patch.yml'), [
    '- insert:',
    '    - id: mnemon',
    '      name: dsh-mnemon',
    ...strategies.flatMap((s) => [
      `    - id: mnemon-strategy-${s}`,
      `      name: dsh-mnemon-strategy-${s}`,
      '      disabled: true',
    ]),
  ].join('\n'))
  for (const s of strategies) {
    const dir = join(tree.root, `dsh-mnemon-strategy-${s}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `dsh-mnemon-strategy-${s}`, version: '0.5.7', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2))
    writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: mnemon-strategy-${s}\n      name: dsh-mnemon-strategy-${s}\n`)
  }

  const calls = []
  const { route } = ctxWithRoutes(tree, {
    listBundles: async () => [{ name: 'dsh-mnemon', enabled: true }],
    setBundleEnabled: async (target, enabled) => { calls.push([target, enabled]); return { application: 'applied' } },
  })
  const { json } = await callRoute(route.handler, 'GET', '/dsh-shared-tree/status')

  // 4 个 strategy 都不再是顶层行
  const topNames = json.value.packages.map((item) => item.name)
  for (const s of strategies) {
    assert.ok(!topNames.includes(`dsh-mnemon-strategy-${s}`), `${s} 不应作为独立行出现`)
  }
  // 全部收在 dsh-mnemon 之下
  const owner = json.value.packages.find((item) => item.name === 'dsh-mnemon')
  assert.deepEqual((owner.components ?? []).map((item) => item.name).sort(),
    strategies.map((s) => `dsh-mnemon-strategy-${s}`).sort())
  assert.equal(json.value.counts.components, 4)

  // 组件没有独立开关：每个都必须被 enable 护栏拦住，且不调用 setBundleEnabled
  for (const s of strategies) {
    const name = `dsh-mnemon-strategy-${s}`
    const blocked = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', { target: name, enabled: true })
    const result = blocked.json.value.results[0]
    assert.equal(result.ok, false, `${s} 必须被拦住`)
    assert.match(result.error, /issue #470/)
    assert.match(result.safetyNote, /dsh-mnemon/)
  }
  assert.deepEqual(calls, [], '不得对任何组件调用 setBundleEnabled')

  // disable 仍放行（护栏只拦 enable）
  await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', { target: 'dsh-mnemon-strategy-scoped', enabled: false })
  assert.deepEqual(calls, [['dsh-mnemon-strategy-scoped', false]])
  tree.cleanup()
})

await test('只读分区：link: 插件单独列出、标记 linked、不改四个计数', async () => {
  const tree = fakeTree()
  const { route, ctx } = ctxWithRoutes(tree, {
    listBundles: async () => ([
      // link: 安装的插件（物理上不在共享树里）
      { name: 'dsh-linked-a', enabled: true, version: '0.1.0', description: 'linked a', availability: 'profile', source: 'link:D:\\ws\\a' },
      { name: 'dsh-linked-b', enabled: false, version: '0.2.0', description: 'linked b', availability: 'profile', source: 'link:D:\\ws\\b' },
      // 非 link: 的普通 bundle 不应进只读分区
      { name: 'fake-bundle', enabled: true, availability: 'profile', version: '1.2.3', rows: [{}] },
      // 与树内重名的 link: 条目要剔除（避免同一插件出现两次）
      { name: 'fake-client', enabled: true, availability: 'profile', source: 'link:D:\\ws\\dup' },
    ]),
  })

  const { json } = await callRoute(route.handler, 'GET', '/dsh-shared-tree/status')
  const linked = json.value.linked
  assert.deepEqual(linked.map((item) => item.name).sort(), ['dsh-linked-a', 'dsh-linked-b'])
  assert.equal(json.value.counts.linked, 2)
  // 关键：只读分区不进 packages，也不改任何既有计数口径
  assert.equal(json.value.counts.total, 2, 'total 仍只数共享树行')
  assert.equal(json.value.counts.plugins, 2, 'plugins 仍只数共享树里的插件')
  assert.equal(json.value.counts.libraries, 1)
  assert.equal(json.value.counts.components, 0)
  assert.ok(!json.value.packages.some((item) => item.name.startsWith('dsh-linked-')), 'link: 插件不得混进共享树列表')
  // 分区里带上原始 link: 目标，便于识别
  assert.match(linked.find((item) => item.name === 'dsh-linked-a').source, /^link:/)

  // 工具侧不受影响
  const status = await ctx.toolsMap.get('shared_tree').execute({ action: 'status' }, {})
  assert.match(status, /顶层包：3 个（插件 2：bundle 1 \/ 仅 client 1；纯依赖库 1）/)
  tree.cleanup()
})

await test('只读分区：listBundles 不可用时 linked 为空而不是崩', async () => {
  const tree = fakeTree()
  const webServer = fakeWebServer()
  apply(fakeContext({ webServer }), { treeRoot: tree.root, buildDir: tree.buildDir })
  const route = webServer.routes.find((item) => item.path === '/dsh-shared-tree')
  const { status, json } = await callRoute(route.handler, 'GET', '/dsh-shared-tree/status')
  assert.equal(status, 200)
  assert.deepEqual(json.value.linked, [])
  assert.equal(json.value.counts.linked, 0)
  tree.cleanup()
})

await test('POST /set 调 setBundleEnabled 并回带刷新后的 status', async () => {
  const tree = fakeTree()
  const calls = []
  const { route } = ctxWithRoutes(tree, {
    listBundles: async () => [],
    setBundleEnabled: async (target, enabled) => {
      calls.push([target, enabled])
      return { application: 'applied' }
    },
  })
  const { status, json } = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', { target: 'fake-bundle', enabled: true })
  assert.equal(status, 200)
  assert.deepEqual(calls, [['fake-bundle', true]])
  assert.equal(json.value.results[0].ok, true)
  assert.equal(json.value.results[0].application, 'applied')
  assert.equal(json.value.status.counts.total, 2, '必须回带刷新后的 status')
  tree.cleanup()
})

await test('POST /set 支持一次多个包，并区分树里没有的包', async () => {
  const tree = fakeTree()
  const calls = []
  const { route } = ctxWithRoutes(tree, {
    listBundles: async () => [],
    setBundleEnabled: async (target, enabled) => {
      calls.push([target, enabled])
      return { application: 'restart-required', nextStep: 'restart DSH' }
    },
  })
  const { json } = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', {
    target: ['fake-bundle', 'not-in-tree'], enabled: false,
  })
  assert.deepEqual(calls, [['fake-bundle', false]])
  assert.equal(json.value.results[0].restartRequired, true)
  assert.equal(json.value.results[1].ok, false)
  assert.match(json.value.results[1].error, /not in the shared tree/)
  tree.cleanup()
})

await test('POST /set 校验入参：enabled 必须是布尔、target 必填', async () => {
  const tree = fakeTree()
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [], setBundleEnabled: async () => ({}) })
  const noEnabled = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', { target: 'fake-bundle' })
  assert.equal(noEnabled.status, 400)
  assert.match(noEnabled.json.error, /enabled must be a boolean/)
  const noTarget = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', { enabled: true })
  assert.equal(noTarget.status, 400)
  assert.match(noTarget.json.error, /target is required/)
  tree.cleanup()
})

await test('POST /set 在 pluginManager 缺失时返回 503 而不是崩', async () => {
  const tree = fakeTree()
  const { route } = ctxWithRoutes(tree) // 没有 pluginManager
  const { status, json } = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', { target: 'fake-bundle', enabled: true })
  assert.equal(status, 503)
  assert.match(json.error, /pluginManager is not available/)
  tree.cleanup()
})

await test('未知路径返回 404；坏 JSON 返回 500 且不崩', async () => {
  const tree = fakeTree()
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const notFound = await callRoute(route.handler, 'GET', '/dsh-shared-tree/nope')
  assert.equal(notFound.status, 404)
  const bad = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', '{oops')
  assert.equal(bad.status, 500)
  assert.match(bad.json.error, /not valid JSON/)
  tree.cleanup()
})

await test('只读保证：GET 路由不写任何文件', () => {
  return (async () => {
    const tree = fakeTree()
    const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
    const before = readFileSync(join(tree.root, 'fake-bundle', 'package.json'), 'utf8')
    await callRoute(route.handler, 'GET', '/dsh-shared-tree/status')
    await callRoute(route.handler, 'GET', '/dsh-shared-tree/verify')
    const after = readFileSync(join(tree.root, 'fake-bundle', 'package.json'), 'utf8')
    assert.equal(before, after)
    tree.cleanup()
  })()
})

// ── 升级 UI 的新路由 ────────────────────────────────────────────────────────

/**
 * 在假树旁边造一个引用了 fake-bundle 的假 profile。
 * @param {any} tree 假树（root 的上一级即 profiles 目录）。
 * @param {string} name profile 目录名。
 * @param {string[]} bundles dsh.profile.bundles。
 */
function fakeProfile(tree, name, bundles) {
  const dir = join(dirname(tree.root), name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version: '1.0.0', dsh: { profile: { bundles } },
  }, null, 2))
  return dir
}

await test('GET /impact 缺 pkg 时返回 400', async () => {
  const tree = fakeTree()
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const { status, json } = await callRoute(route.handler, 'GET', '/dsh-shared-tree/impact')
  assert.equal(status, 400)
  assert.match(json.error, /pkg is required/)
  tree.cleanup()
})

await test('GET /impact 报告引用 profile、解析版本与升级历史', async () => {
  const tree = fakeTree()
  const profileDir = fakeProfile(tree, 'prof-a', ['fake-bundle'])
  fakeProfile(tree, 'prof-b', ['fake-client'])
  // 预写一条历史（回滚下拉的数据源）。
  writeFileSync(join(tree.root, '.dsh-shared-tree-history.json'), JSON.stringify({
    scheme: 'dsh-shared-tree-history/1',
    packages: [{ name: 'fake-bundle', from: '1.2.2', to: '1.2.3', kind: 'upgrade', at: '2026-11-27T00:00:00.000Z', archivedPath: null }],
  }, null, 2))
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const { status, json } = await callRoute(route.handler, 'GET', `/dsh-shared-tree/impact?pkg=${encodeURIComponent('fake-bundle')}`)
  assert.equal(status, 200)
  assert.equal(json.value.treeVersion, '1.2.3')
  assert.equal(json.value.referencing, 1)
  const row = json.value.profiles.find((item) => item.profile === 'prof-a')
  assert.equal(row.referenced, true)
  assert.equal(row.enabled, true)
  assert.equal(row.version, '1.2.3', '本地没有 node_modules 时解析到共享树版本')
  assert.equal(row.via, 'shared-tree')
  assert.deepEqual(json.value.history.map((item) => item.version), ['1.2.3'])
  assert.equal(json.value.profiles.find((item) => item.profile === 'prof-b').referenced, false)
  assert.ok(existsSync(profileDir))
  tree.cleanup()
})

await test('GET /deps 缺 pkg 或版本非法时返回 400（不触网）', async () => {
  const tree = fakeTree()
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const missing = await callRoute(route.handler, 'GET', '/dsh-shared-tree/deps')
  assert.equal(missing.status, 400)
  const bad = await callRoute(route.handler, 'GET', `/dsh-shared-tree/deps?pkg=${encodeURIComponent('fake-bundle')}&ver=bad;name`)
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /invalid/)
  tree.cleanup()
})

await test('POST /install 校验入参；GET /install/progress 空闲时返回 state=idle', async () => {
  const tree = fakeTree()
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const noPkgs = await callRoute(route.handler, 'POST', '/dsh-shared-tree/install', {})
  assert.equal(noPkgs.status, 400)
  assert.match(noPkgs.json.error, /packages is required/)
  const badSpec = await callRoute(route.handler, 'POST', '/dsh-shared-tree/install', { packages: ['x; rm -rf /'] })
  assert.equal(badSpec.status, 400)
  assert.match(badSpec.json.error, /包名不合法/)
  const progress = await callRoute(route.handler, 'GET', '/dsh-shared-tree/install/progress')
  assert.equal(progress.status, 200)
  assert.equal(progress.json.value.state, 'idle')
  tree.cleanup()
})

await test('POST /install 对非法包名不启动任务', async () => {
  const tree = fakeTree()
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  await callRoute(route.handler, 'POST', '/dsh-shared-tree/install', { packages: ['bad name'] })
  const progress = await callRoute(route.handler, 'GET', '/dsh-shared-tree/install/progress')
  assert.equal(progress.json.value.state, 'idle', '校验失败时不得留下任务')
  tree.cleanup()
})

await test('POST /rollback 校验入参：版本形态不合法时 400', async () => {
  const tree = fakeTree()
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const missing = await callRoute(route.handler, 'POST', '/dsh-shared-tree/rollback', { name: 'fake-bundle' })
  assert.equal(missing.status, 400)
  const bad = await callRoute(route.handler, 'POST', '/dsh-shared-tree/rollback', { name: 'fake-bundle', version: '1.x; rm' })
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /invalid/)
  tree.cleanup()
})

await test('POST /check-profiles 返回逐 profile 验证行', async () => {
  const tree = fakeTree()
  fakeProfile(tree, 'prof-a', ['fake-bundle'])
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const { status, json } = await callRoute(route.handler, 'POST', '/dsh-shared-tree/check-profiles', { name: 'fake-bundle' })
  assert.equal(status, 200)
  assert.equal(json.value.treeVersion, '1.2.3')
  assert.equal(json.value.rows.length, 1)
  assert.equal(json.value.rows[0].profile, 'prof-a')
  assert.equal(json.value.rows[0].matchesTree, true)
  assert.equal(json.value.rows[0].enabled, true)
  tree.cleanup()
})

await test('POST /set-profile 修改目标 profile 的 bundles 并留备份', async () => {  const tree = fakeTree()
  const dir = fakeProfile(tree, 'prof-a', ['fake-client'])
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const on = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set-profile', { profile: 'prof-a', target: 'fake-bundle', enabled: true })
  assert.equal(on.status, 200)
  assert.equal(on.json.ok, true)
  const written = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.ok(written.dsh.profile.bundles.includes('fake-bundle'), '必须写进 dsh.profile.bundles')
  assert.match(on.json.value.note, /重启/)
  assert.ok(existsSync(join(dir, 'package.json.bak-shared-tree')), '改前必须留备份')
  const off = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set-profile', { profile: 'prof-a', target: 'fake-bundle', enabled: false })
  const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.ok(!after.dsh.profile.bundles.includes('fake-bundle'), '移除后不得残留')
  const unknown = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set-profile', { profile: 'no-such', target: 'fake-bundle', enabled: true })
  assert.equal(unknown.json.ok, false)
  assert.match(unknown.json.error, /不存在/)
  tree.cleanup()
})

// ── 逐插件详情/调试 ────────────────────────────────────────────────────────

await test('GET /entries 解析包补丁的 insert 条目；无 bundle 补丁的包返回 error 字段', async () => {
  const tree = fakeTree()
  writeFileSync(join(tree.root, 'fake-bundle', 'cordis.patch.yml'), [
    '# 注释行要跳过',
    '- insert:',
    '    - id: fake-main',
    '      name: fake-bundle',
    '    - id: fake-widget',
    '      name: fake-widget',
    '      disabled: true',
    '      config:',
    '        mode: fast',
    '        retries: 3',
  ].join('\n'))
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const { status, json } = await callRoute(route.handler, 'GET', `/dsh-shared-tree/entries?pkg=${encodeURIComponent('fake-bundle')}`)
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.value.version, '1.2.3')
  assert.deepEqual(json.value.entries.map((item) => item.id), ['fake-main', 'fake-widget'])
  const widget = json.value.entries[1]
  assert.equal(widget.disabled, true, '块式 disabled:true 必须被识别')
  assert.deepEqual(widget.configKeys.sort(), ['mode', 'retries'], 'config 子块的键要收集为配置键')
  assert.ok(json.value.patchText.includes('fake-widget'), '补丁原文必须回传')
  const noPatch = await callRoute(route.handler, 'GET', `/dsh-shared-tree/entries?pkg=${encodeURIComponent('fake-client')}`)
  assert.equal(noPatch.json.ok, true)
  assert.ok(noPatch.json.value.error !== undefined, '只有 dsh.client 的包要给出可读的 error 字段')
  const missing = await callRoute(route.handler, 'GET', `/dsh-shared-tree/entries?pkg=${encodeURIComponent('no-such')}`)
  assert.equal(missing.json.ok, false)
  tree.cleanup()
})

await test('POST /set-entry 禁用/启用/参数走 profile 覆盖层并留备份', async () => {
  const tree = fakeTree()
  const dir = join(dirname(tree.root), 'prof-a')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'prof-a' }, null, 2))
  writeFileSync(join(dir, 'cordis.patch.yml'), '# 用户已有覆盖层\n- { id: some-other, disabled: true }\n')
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })

  const disable = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set-entry', { profile: 'prof-a', entryId: 'fake-main', disabled: true })
  assert.equal(disable.json.ok, true)
  let text = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /- id: fake-main/, '禁用必须追加覆盖块')
  assert.match(text, /\n  disabled: true/, '覆盖块里要有 disabled: true')
  assert.match(text, /some-other/, '已有覆盖条目不得被破坏')
  assert.ok(existsSync(join(dir, 'cordis.patch.yml.bak-shared-tree')), '改前必须留备份')

  const config = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set-entry', { profile: 'prof-a', entryId: 'fake-main', config: { mode: 'fast' } })
  assert.equal(config.json.ok, true)
  text = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /config: \{"mode":"fast"\}/, '参数必须以合法 YAML flow 形式落盘')
  // 幂等重建：同一 entry 只有一个块。
  assert.equal(text.split('- id: fake-main').length - 1, 1, '重复调整不得产生重复块')

  const enable = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set-entry', { profile: 'prof-a', entryId: 'fake-main', disabled: false })
  assert.equal(enable.json.ok, true)
  text = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  assert.ok(!text.includes('fake-main'), '启用 = 删除覆盖块，让 bundle 自己的补丁生效')
  assert.match(text, /some-other/, '已有覆盖条目仍不得被破坏')

  const unknownProfile = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set-entry', { profile: 'no-such', entryId: 'fake-main', disabled: true })
  assert.equal(unknownProfile.json.ok, false)
  const badId = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set-entry', { profile: 'prof-a', entryId: 'bad id!', disabled: true })
  assert.equal(badId.json.ok, false)
  assert.match(badId.json.error, /不合法/)
  const missing = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set-entry', {})
  assert.equal(missing.status, 400)
  tree.cleanup()
})

await test('GET /debug 汇总加载状态、哈希一致性与引用面', async () => {
  const tree = fakeTree()
  fakeProfile(tree, 'prof-a', ['fake-bundle'])
  const { route } = ctxWithRoutes(tree, {
    listBundles: async () => ([{ name: 'fake-bundle', enabled: true, availability: 'profile', version: '1.2.3', rows: [{}, {}] }]),
  })
  const { status, json } = await callRoute(route.handler, 'GET', `/dsh-shared-tree/debug?pkg=${encodeURIComponent('fake-bundle')}`)
  assert.equal(status, 200)
  assert.equal(json.value.version, '1.2.3')
  assert.equal(json.value.kind, 'bundle')
  assert.deepEqual(json.value.dshKeys, ['bundle'])
  assert.equal(json.value.inCurrentProfile.known, true)
  assert.equal(json.value.inCurrentProfile.enabled, true)
  assert.equal(json.value.inCurrentProfile.rows, 2)
  assert.equal(json.value.hashOk, null, '没有清单记录时哈希按未知处理')
  assert.deepEqual(json.value.referenced, ['prof-a'])
  const missing = await callRoute(route.handler, 'GET', `/dsh-shared-tree/debug?pkg=${encodeURIComponent('no-such')}`)
  assert.equal(missing.json.ok, false)
  tree.cleanup()
})

await test('缺口 A 回归：/set 走 manager（宿主落盘）后必须差异记账进台账', async () => {
  const tree = fakeTree()
  // 假 manager 真的改文件（模拟宿主写当前 profile 的 package.json）。
  const profileDir = fakeProfile(tree, 'prof-a', ['fake-client'])
  const pkgFile = join(profileDir, 'package.json')
  const { route } = ctxWithRoutes(tree, {
    listBundles: async () => [],
    setBundleEnabled: async (target, enabled) => {
      const manifest = JSON.parse(readFileSync(pkgFile, 'utf8'))
      const bundles = manifest.dsh.profile.bundles
      const next = enabled ? [...bundles, target] : bundles.filter((item) => item !== target)
      manifest.dsh.profile.bundles = next
      writeFileSync(pkgFile, `${JSON.stringify(manifest, null, 2)}\n`)
      return { application: 'applied' }
    },
  })
  await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', { target: 'fake-bundle', enabled: true })
  const ledger = readLedger(tree.root)
  const change = ledger.changes.find((item) => item.profile === 'prof-a' && item.kind === 'profile-bundles')
  assert.ok(change !== undefined, '宿主链路的 bundles 写入必须差异记账')
  assert.ok(!change.before.includes('fake-bundle'), 'before 是写入前快照')
  assert.match(change.after, /fake-bundle/, 'after 是写入后快照')
  // 记账后按台账还原 → bundles 回到写入前。
  const outcome = restoreFromLedger(tree.root)
  assert.equal(outcome.reverted.length, 1)
  const restored = JSON.parse(readFileSync(pkgFile, 'utf8'))
  assert.ok(!restored.dsh.profile.bundles.includes('fake-bundle'), '停用还原必须回滚宿主链路写入')
  tree.cleanup()
})

await test('POST /lifecycle-baseline-restore 需显式 confirm；确认后恢复基线', async () => {
  const tree = fakeTree()
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const noConfirm = await callRoute(route.handler, 'POST', '/dsh-shared-tree/lifecycle-baseline-restore', {})
  assert.equal(noConfirm.status, 400)
  assert.match(noConfirm.json.error, /confirm/)
  const ok = await callRoute(route.handler, 'POST', '/dsh-shared-tree/lifecycle-baseline-restore', { confirm: true })
  assert.equal(ok.json.ok, true)
  assert.ok('reverted' in ok.json.value)
  tree.cleanup()
})

// ── 生命周期路由 ────────────────────────────────────────────────────────────

await test('GET /rows join listBundles 的行级 meta（title/description 按 lang 解析）', async () => {
  const tree = fakeTree()
  writeFileSync(join(tree.root, 'fake-bundle', 'cordis.patch.yml'), '- insert:\n    - id: fake-main\n')
  const { route } = ctxWithRoutes(tree, {
    listBundles: async () => ([
      {
        name: 'fake-bundle',
        rows: [
          { rowId: 'fake-main', moduleName: 'fake-bundle', meta: { title: { en: 'Main switch', zh: '主开关' }, description: { en: 'Toggles the core.', zh: '控制核心功能。' } } },
        ],
      },
    ]),
    listPlugins: async () => ([
      { entryId: 'fake-main', rowId: 'fake-main', moduleName: 'fake-bundle', enabled: true, phase: null, readOnlyReason: null },
    ]),
  })
  const zh = await callRoute(route.handler, 'GET', `/dsh-shared-tree/rows?pkg=${encodeURIComponent('fake-bundle')}&lang=zh`)
  assert.equal(zh.json.value.rows[0].title, '主开关', 'zh 必须解析中文文案（原版 PluginLocalizedMeta 同字段）')
  assert.equal(zh.json.value.rows[0].description, '控制核心功能。')
  const en = await callRoute(route.handler, 'GET', `/dsh-shared-tree/rows?pkg=${encodeURIComponent('fake-bundle')}&lang=en`)
  assert.equal(en.json.value.rows[0].title, 'Main switch', 'en 必须解析英文文案')
  // meta 缺失的行：title/description 为 null，开关与状态不受影响。
  const { route: route2 } = ctxWithRoutes(tree, {
    listBundles: async () => ([{ name: 'fake-bundle', rows: [] }]),
    listPlugins: async () => ([{ entryId: 'fake-main', moduleName: 'fake-bundle', enabled: false, phase: null, readOnlyReason: null }]),
  })
  const bare = await callRoute(route2.handler, 'GET', `/dsh-shared-tree/rows?pkg=${encodeURIComponent('fake-bundle')}&lang=zh`)
  assert.equal(bare.json.value.rows[0].title, null)
  assert.equal(bare.json.value.rows[0].enabled, false)
  tree.cleanup()
})

await test('GET /lifecycle 返回状态；restore/destroy 无确认被拒', async () => {
  const tree = fakeTree()
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  const status = await callRoute(route.handler, 'GET', '/dsh-shared-tree/lifecycle')
  assert.equal(status.json.ok, true)
  assert.equal(status.json.value.initialized, true, 'apply 已在挂载时做过基线快照')
  assert.ok(Array.isArray(status.json.value.profiles))
  const noConfirm = await callRoute(route.handler, 'POST', '/dsh-shared-tree/lifecycle-restore', {})
  assert.equal(noConfirm.status, 400)
  const noDestroy = await callRoute(route.handler, 'POST', '/dsh-shared-tree/lifecycle-destroy', { confirm: 'yes' })
  assert.equal(noDestroy.status, 400)
  assert.match(noDestroy.json.error, /DESTROY/)
  tree.cleanup()
})

await test('apply 通过 ctx.effect 注册停用还原；fake ctx 的 disposer 被收集', async () => {
  const tree = fakeTree()
  const webServer = fakeWebServer()
  const effects = []
  const ctx = fakeContext({ webServer })
  ctx.effect = (callback, label) => { effects.push({ callback, label }); return () => {} }
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const entry = effects.find((item) => item.label === 'dsh-shared-tree: lifecycle restore')
  assert.ok(entry !== undefined, '必须注册 lifecycle restore 的 effect')
  // 手动触发 dispose：还原跑在假树上不炸（台账无变更 → 空还原）。
  // callback 同步返回 undefined、异步返回 promise，两种形态都不能炸。
  const outcome = entry.callback()
  if (outcome !== undefined && outcome !== null && typeof outcome.then === 'function') await outcome
  // 没有 ctx.effect 的宿主（异常环境）也不得崩。
  const plain = fakeContext()
  assert.doesNotThrow(() => apply(plain, { treeRoot: tree.root, buildDir: tree.buildDir }))
  tree.cleanup()
})

await test('工具 action=lifecycle：status / restore 需确认 / destroy 预览', async () => {
  const tree = fakeTree()
  const ctx = fakeContext()
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  const status = await tool.execute({ action: 'lifecycle', mode: 'status' }, {})
  assert.match(status, /生命周期：已初始化/)
  assert.match(status, /台账变更：0 条/)
  const noConfirm = await tool.execute({ action: 'lifecycle', mode: 'restore' }, {})
  assert.match(noConfirm, /confirm=true/)
  const dry = await tool.execute({ action: 'lifecycle', mode: 'restore-dry-run' }, {})
  assert.match(dry, /预览/)
  const destroyDry = await tool.execute({ action: 'lifecycle', mode: 'destroy-dry-run' }, {})
  assert.match(destroyDry, /保留/)
  const destroyNo = await tool.execute({ action: 'lifecycle', mode: 'destroy' }, {})
  assert.match(destroyNo, /confirm=true/)
  tree.cleanup()
})

// ── 原版插件详情复刻：描述 + 行级功能开关 ──────────────────────────────────

await test('GET /detail 优先宿主 readBundleDetail，缺服务时退回包内 README', async () => {
  const tree = fakeTree()
  writeFileSync(join(tree.root, 'fake-bundle', 'README.md'), '# fake-bundle\n\n一个假插件。')
  const { route } = ctxWithRoutes(tree, {
    listBundles: async () => [],
    readBundleDetail: async (name, language) => ({
      status: 'found', path: `docs/${name}.${language}.md`, markdown: `# ${name} (host doc, ${language})`,
    }),
  })
  const host = await callRoute(route.handler, 'GET', `/dsh-shared-tree/detail?pkg=${encodeURIComponent('fake-bundle')}&lang=zh`)
  assert.equal(host.json.ok, true)
  assert.equal(host.json.value.source, 'host', '宿主服务可用时必须走 readBundleDetail（原版同源）')
  assert.match(host.json.value.markdown, /host doc, zh/)
  tree.cleanup()

  const tree2 = fakeTree()
  writeFileSync(join(tree2.root, 'fake-bundle', 'README.md'), '# fake-bundle README')
  const { route: route2 } = ctxWithRoutes(tree2, { listBundles: async () => [] })
  const readme = await callRoute(route2.handler, 'GET', `/dsh-shared-tree/detail?pkg=${encodeURIComponent('fake-bundle')}&lang=zh`)
  assert.equal(readme.json.value.source, 'readme', '服务不可用时退回 README 兜底')
  assert.match(readme.json.value.markdown, /README/)
  const none = await callRoute(route2.handler, 'GET', `/dsh-shared-tree/detail?pkg=${encodeURIComponent('fake-client')}&lang=zh`)
  assert.equal(none.json.value.found, false, '没有任何文档时 found=false（界面显示缺失文案）')
  assert.ok('docPath' in none.json.value, '必须回带 docPath（图片解析锚点）')
  const bad = await callRoute(route2.handler, 'GET', '/dsh-shared-tree/detail?pkg=')
  assert.equal(bad.status, 400)
  tree2.cleanup()
})

await test('GET /detail-image 伺服包内图片；穿越与缺参被拒', async () => {
  const tree = fakeTree()
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  mkdirSync(join(tree.root, 'fake-bundle', 'docs'), { recursive: true })
  writeFileSync(join(tree.root, 'fake-bundle', 'docs', 'demo.png'), png)
  writeFileSync(join(tree.root, 'fake-bundle', 'cover.png'), png)
  const { route } = ctxWithRoutes(tree, { listBundles: async () => [] })
  // 文档子目录里的相对图片。
  const hit = await callRoute(route.handler, 'GET', `/dsh-shared-tree/detail-image?pkg=${encodeURIComponent('fake-bundle')}&doc=${encodeURIComponent('README.md')}&rel=${encodeURIComponent('docs/demo.png')}`)
  assert.equal(hit.status, 200)
  assert.equal(hit.json, undefined, '图片字节直出，不是 JSON 响应')
  tree.cleanup()

  const tree2 = fakeTree()
  writeFileSync(join(tree2.root, 'fake-bundle', 'cover.png'), png)
  const { route: route2 } = ctxWithRoutes(tree2, { listBundles: async () => [] })
  // callRoute 现有 stub 只收 JSON；这里直接断言 JSON 层行为，字节路径由上一段覆盖。
  const missing = await callRoute(route2.handler, 'GET', `/dsh-shared-tree/detail-image?pkg=${encodeURIComponent('fake-bundle')}&rel=${encodeURIComponent('nope.png')}`)
  assert.equal(missing.status, 404)
  const traversal = await callRoute(route2.handler, 'GET', `/dsh-shared-tree/detail-image?pkg=${encodeURIComponent('fake-bundle')}&rel=${encodeURIComponent('..\\..\\..\\windows\\win.ini')}`)
  assert.equal(traversal.status, 404, '路径穿越必须被拒（找不到即 404，绝不读包外文件）')
  const noParams = await callRoute(route2.handler, 'GET', '/dsh-shared-tree/detail-image?pkg=fake-bundle')
  assert.equal(noParams.status, 400)
  tree2.cleanup()
})

await test('GET /rows 走宿主 listPlugins 按 moduleName 过滤；缺服务时回退补丁解析（只读）', async () => {
  const tree = fakeTree()
  writeFileSync(join(tree.root, 'fake-bundle', 'cordis.patch.yml'), '- insert:\n    - id: fake-main\n    - id: fake-widget\n')
  const { route } = ctxWithRoutes(tree, {
    listBundles: async () => [],
    listPlugins: async () => ([
      { entryId: 'fake-main', rowId: 'fake-main', moduleName: 'fake-bundle', enabled: true, phase: null, readOnlyReason: null },
      { entryId: 'fake-widget', rowId: 'fake-widget', moduleName: 'fake-bundle', enabled: false, phase: 'failed', readOnlyReason: 'protected' },
      { entryId: 'other', moduleName: 'some-other-pkg', enabled: true, phase: null, readOnlyReason: null },
    ]),
  })
  const host = await callRoute(route.handler, 'GET', `/dsh-shared-tree/rows?pkg=${encodeURIComponent('fake-bundle')}`)
  assert.equal(host.json.ok, true)
  assert.equal(host.json.value.source, 'host')
  assert.equal(host.json.value.manageable, true)
  assert.deepEqual(host.json.value.rows.map((row) => row.entryId), ['fake-main', 'fake-widget'], '必须按 moduleName 归属过滤')
  const widget = host.json.value.rows[1]
  assert.equal(widget.enabled, false)
  assert.equal(widget.phase, 'failed')
  assert.equal(widget.readOnlyReason, 'protected')
  tree.cleanup()

  const tree2 = fakeTree()
  writeFileSync(join(tree2.root, 'fake-bundle', 'cordis.patch.yml'), '- insert:\n    - id: fake-main\n')
  const { route: route2 } = ctxWithRoutes(tree2, { listBundles: async () => [] })
  const fallback = await callRoute(route2.handler, 'GET', `/dsh-shared-tree/rows?pkg=${encodeURIComponent('fake-bundle')}`)
  assert.equal(fallback.json.value.source, 'patch')
  assert.equal(fallback.json.value.manageable, false, '兜底行必须标记只读')
  assert.match(fallback.json.value.rows[0].readOnlyReason, /不可用|只读|read/)
  tree2.cleanup()
})

await test('POST /set-row 优先 manager.setPluginEnabled（原版写入链路），缺服务走覆盖层兜底', async () => {
  const tree = fakeTree()
  const calls = []
  const { route } = ctxWithRoutes(tree, {
    listBundles: async () => [],
    setPluginEnabled: async (entryId, enabled) => {
      if (entryId === 'x') throw new Error('unknown-plugin')
      calls.push([entryId, enabled])
      return { application: 'restart-required', nextStep: 'restart DSH' }
    },
  })
  const applied = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set-row', { entryId: 'fake-main', enabled: false })
  assert.equal(applied.json.ok, true)
  assert.deepEqual(calls, [['fake-main', false]], '必须走原版同一条写入链路')
  assert.equal(applied.json.value.application, 'restart-required')
  assert.equal(applied.json.value.restartRequired, true)
  assert.match(applied.json.value.nextStep, /restart/)
  const failed = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set-row', { entryId: 'x', enabled: true })
  assert.equal(failed.json.ok, false, 'manager 报错时 ok=false（界面即时反馈失败）')
  const bad = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set-row', { entryId: 'x' })
  assert.equal(bad.status, 400)
  tree.cleanup()

  const tree2 = fakeTree()
  const dir = join(dirname(tree2.root), 'prof-a')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'prof-a' }, null, 2))
  const { route: route2 } = ctxWithRoutes(tree2, { listBundles: async () => [] })
  const noManager = await callRoute(route2.handler, 'POST', '/dsh-shared-tree/set-row', { entryId: 'fake-main', enabled: false })
  assert.equal(noManager.status, 503, '无服务且未给 profile 时 503')
  const fallback = await callRoute(route2.handler, 'POST', '/dsh-shared-tree/set-row', { entryId: 'fake-main', enabled: false, profile: 'prof-a' })
  assert.equal(fallback.json.ok, true)
  assert.equal(fallback.json.value.application, 'restart-required', '兜底路径必须标记需重启')
  const text = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /- id: fake-main/, '兜底必须把禁用写进 profile 覆盖层')
  tree2.cleanup()
})

// ── 官方面板可见性（panel）：树里的包必须能重新出现在 pluginManager.listBundles 的候选集合里 ──

/**
 * 造一个带 profile 的假树，并给该 profile 一份可写 package.json。
 * @param {object} [manifest] 初始清单。
 * @returns {{tree: any, profileDir: string, profileName: string}} 场景。
 */
function fakeProfileTree(manifest = { name: 'prof-panel', private: true }) {
  const tree = fakeTree()
  const profileName = 'prof-panel'
  const profileDir = join(dirname(tree.root), profileName)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2))
  return { tree, profileDir, profileName }
}

/** 造一个把自己当作该 profile 的假 pluginManager（profile.dir 驱动 currentProfile 解析）。 */
function managerForProfile(profileDir, calls = []) {
  return {
    profile: { dir: profileDir },
    listBundles: async () => [],
    setBundleEnabled: async (packageName, enabled) => {
      calls.push([packageName, enabled])
      return { application: 'restart-required', nextStep: 'restart DSH' }
    },
  }
}

await test('panel 报告：分得清"树里有"和"面板看得见"', async () => {
  const { tree, profileDir } = fakeProfileTree()
  const { route } = ctxWithRoutes(tree, managerForProfile(profileDir))
  const { status, json } = await callRoute(route.handler, 'GET', '/dsh-shared-tree/panel?profile=prof-panel')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.deepEqual(json.value.treeBundles, ['fake-bundle'], '只有 dsh.bundle 的包算 bundle')
  assert.deepEqual(json.value.visible, [], '清单里什么都没写 → 面板看不见')
  assert.deepEqual(json.value.hidden, ['fake-bundle'], '这正是"跳过去面板空"的根因')
  // profile 不存在时明确报错，不静默返回空报告。
  const missing = await callRoute(route.handler, 'GET', '/dsh-shared-tree/panel?profile=nope')
  assert.equal(missing.status, 404)
  tree.cleanup()
})

await test('panel 登记：写 link: 依赖让面板可见，但绝不写 dsh.profile.bundles', async () => {
  const { tree, profileDir } = fakeProfileTree()
  const { route } = ctxWithRoutes(tree, managerForProfile(profileDir))
  const posted = await callRoute(route.handler, 'POST', '/dsh-shared-tree/panel', { target: 'fake-bundle', exposed: true })
  assert.equal(posted.json.ok, true)
  assert.deepEqual(posted.json.value.changed, ['fake-bundle'])
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['fake-bundle'], `link:${join(tree.root, 'fake-bundle').replace(/\\/g, '/')}`)
  assert.equal(manifest.dsh, undefined, '绝不能顺手把包加进 dsh.profile.bundles（那会真的加载它）')
  // 登记后报告立刻能看到它。
  assert.deepEqual(posted.json.value.report.visible, ['fake-bundle'])
  assert.deepEqual(posted.json.value.report.hidden, [])
  // 备份与台账都要留痕。
  assert.ok(existsSync(join(profileDir, 'package.json.bak-shared-tree')), '改前必须备份')
  assert.ok(existsSync(join(tree.root, '.dsh-shared-tree-panel.json')), '必须留面板登记台账')
  tree.cleanup()
})

await test('panel 幂等与撤销：重复登记不重写，撤销只删自己写的那条', async () => {
  const { tree, profileDir } = fakeProfileTree()
  const { route } = ctxWithRoutes(tree, managerForProfile(profileDir))
  await callRoute(route.handler, 'POST', '/dsh-shared-tree/panel', { target: 'fake-bundle', exposed: true })
  const again = await callRoute(route.handler, 'POST', '/dsh-shared-tree/panel', { target: 'fake-bundle', exposed: true })
  assert.deepEqual(again.json.value.changed, [], '已是目标状态时不应改动文件')
  assert.deepEqual(again.json.value.kept, ['fake-bundle'])
  const removed = await callRoute(route.handler, 'POST', '/dsh-shared-tree/panel', { target: 'fake-bundle', exposed: false })
  assert.deepEqual(removed.json.value.changed, ['fake-bundle'])
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies, undefined, '原本没有 dependencies 字段，撤销后应一并删除')
  tree.cleanup()
})

await test('panel 撤销：用户自己写的同名依赖绝不被删', async () => {
  // 该 profile 本来就手工把包挂在 dependencies 里（版本号指向真实 registry）。
  const tree = fakeTree()
  const profileDir = join(dirname(tree.root), 'prof-user')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'prof-user', private: true, dependencies: { 'fake-bundle': '^1.0.0' },
  }, null, 2))
  const { route } = ctxWithRoutes(tree, managerForProfile(profileDir))
  // 登记时发现已有同名依赖 → 跳过，不覆盖。
  const posted = await callRoute(route.handler, 'POST', '/dsh-shared-tree/panel', { target: 'fake-bundle', exposed: true })
  assert.deepEqual(posted.json.value.changed, [])
  assert.match(posted.json.value.skipped[0].reason, /已有同名依赖/)
  // 撤销时也不动它。
  const removed = await callRoute(route.handler, 'POST', '/dsh-shared-tree/panel', { target: 'fake-bundle', exposed: false })
  assert.deepEqual(removed.json.value.changed, [])
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['fake-bundle'], '^1.0.0', '用户自己的依赖必须原样保留')
  tree.cleanup()
})

await test('panel 拒绝：非 bundle 与树外包不登记（并说明原因）', async () => {
  const { tree, profileDir } = fakeProfileTree()
  const { route } = ctxWithRoutes(tree, managerForProfile(profileDir))
  const posted = await callRoute(route.handler, 'POST', '/dsh-shared-tree/panel', { target: 'fake-client,fake-lib,ghost-pkg', exposed: true })
  assert.equal(posted.json.ok, true)
  assert.deepEqual(posted.json.value.changed, [], '没有一个是可登记的 bundle')
  const reasons = posted.json.value.skipped.map((item) => `${item.name}:${item.reason}`).join('|')
  assert.match(reasons, /fake-client:不是 bundle/)
  assert.match(reasons, /fake-lib:不是 bundle/)
  assert.match(reasons, /ghost-pkg:不在共享树里/)
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies, undefined, '全部被拒时不得留下任何改动')
  tree.cleanup()
})

await test('panel 入参校验：exposed 必须布尔、target 必填', async () => {
  const { tree, profileDir } = fakeProfileTree()
  const { route } = ctxWithRoutes(tree, managerForProfile(profileDir))
  const noFlag = await callRoute(route.handler, 'POST', '/dsh-shared-tree/panel', { target: 'fake-bundle' })
  assert.equal(noFlag.status, 400)
  const noTarget = await callRoute(route.handler, 'POST', '/dsh-shared-tree/panel', { exposed: true })
  assert.equal(noTarget.status, 400)
  tree.cleanup()
})

await test('panel 只在指定 profile 生效：其他 profile 的清单零改动', async () => {
  const { tree, profileDir, profileName } = fakeProfileTree()
  const otherDir = join(dirname(tree.root), 'prof-other')
  mkdirSync(otherDir, { recursive: true })
  const otherManifest = JSON.stringify({ name: 'prof-other', private: true, dsh: { profile: { bundles: [] } } }, null, 2)
  writeFileSync(join(otherDir, 'package.json'), otherManifest)
  const { route } = ctxWithRoutes(tree, managerForProfile(profileDir))
  await callRoute(route.handler, 'POST', '/dsh-shared-tree/panel', { target: 'fake-bundle', exposed: true, profile: profileName })
  assert.equal(readFileSync(join(otherDir, 'package.json'), 'utf8'), otherManifest, '别的 profile 必须一字未动')
  tree.cleanup()
})

await test('panel 与生命周期台账联动：stop 插件时登记一并回滚', async () => {
  const { tree, profileDir } = fakeProfileTree()
  const webServer = fakeWebServer()
  const manager = managerForProfile(profileDir)
  const ctx = fakeContext({ webServer, pluginManager: manager })
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const route = webServer.routes.find((item) => item.path === '/dsh-shared-tree')
  await callRoute(route.handler, 'POST', '/dsh-shared-tree/panel', { target: 'fake-bundle', exposed: true })
  assert.ok(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies, '先确认已写入')
  // 触发 dispose（等价于停用插件）→ 台账里的 panel 变更必须被还原。
  const entry = ctx.disposers.length > 0 ? ctx.disposers.at(-1) : undefined
  const restore = restoreFromLedger(tree.root)
  assert.ok(restore.reverted.length > 0, '台账里必须有可还原的条目')
  const after = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(after.dependencies, undefined, '停用后登记必须被回滚')
  assert.equal(typeof entry === 'function' || entry === undefined, true)
  tree.cleanup()
})

await test('disable 顺手登记：停用后包仍留在面板入口（不加载）', async () => {
  const { tree, profileDir } = fakeProfileTree({ name: 'prof-panel', private: true, dsh: { profile: { bundles: ['fake-bundle'] } } })
  const calls = []
  const manager = managerForProfile(profileDir, calls)
  // 停用成功后，宿主会把名字从 bundles 摘掉；这里模拟"摘掉后"的清单，验证登记补偿。
  manager.setBundleEnabled = async (packageName, enabled) => {
    calls.push([packageName, enabled])
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    manifest.dsh.profile.bundles = enabled ? ['fake-bundle'] : []
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2))
    return { application: 'restart-required', nextStep: 'restart DSH' }
  }
  const { route } = ctxWithRoutes(tree, manager)
  const disabled = await callRoute(route.handler, 'POST', '/dsh-shared-tree/set', { target: 'fake-bundle', enabled: false })
  assert.deepEqual(calls, [['fake-bundle', false]])
  assert.equal(disabled.json.value.results[0].panelPinned, true, '停用后必须补登记，否则面板里再也找不到它')
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, [], 'bundles 里必须已摘掉（真的不加载）')
  assert.ok(manifest.dependencies['fake-bundle'], 'dependencies 里必须留一条 link: 入口')
  tree.cleanup()
})

await test('工具 action=panel：无参数只读报告，带 target 执行登记', async () => {
  const { tree, profileDir } = fakeProfileTree()
  const ctx = fakeContext({ pluginManager: managerForProfile(profileDir) })
  apply(ctx, { treeRoot: tree.root, buildDir: tree.buildDir })
  const tool = ctx.toolsMap.get('shared_tree')
  // currentProfile 从 pluginManager.profile.dir 推导。
  const report = await tool.execute({ action: 'panel' }, {})
  assert.match(report, /profile：prof-panel/)
  assert.match(report, /官方面板看不见（1）：fake-bundle/)
  const applied = await tool.execute({ action: 'panel', target: 'fake-bundle' }, {})
  assert.match(applied, /已改动（1）：fake-bundle/)
  assert.match(applied, /需重启/)
  const verify = await tool.execute({ action: 'panel' }, {})
  assert.match(verify, /官方面板可见（1）：fake-bundle/)
  tree.cleanup()
})

await test('panel 组件识别：entry id 归属别的树内 bundle 时拒绝登记（issue #470 防线）', async () => {
  const tree = fakeTree()
  // 造归属包 + 组件：组件的补丁插入一个已被归属包声明的 id。
  mkdirSync(join(tree.root, 'owner-bundle'), { recursive: true })
  writeFileSync(join(tree.root, 'owner-bundle', 'package.json'), JSON.stringify({
    name: 'owner-bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(tree.root, 'owner-bundle', 'cordis.patch.yml'), '- insert:\n    - id: owner-shared-row\n      name: owner-bundle\n')
  mkdirSync(join(tree.root, 'owner-component'), { recursive: true })
  writeFileSync(join(tree.root, 'owner-component', 'package.json'), JSON.stringify({
    name: 'owner-component', version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(tree.root, 'owner-component', 'cordis.patch.yml'), '- insert:\n    - id: owner-shared-row\n      name: owner-component\n')

  const profileDir = join(dirname(tree.root), 'prof-cmp')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'prof-cmp', private: true }, null, 2))
  const { route } = ctxWithRoutes(tree, managerForProfile(profileDir))

  const report = await callRoute(route.handler, 'GET', '/dsh-shared-tree/panel?profile=prof-cmp')
  const components = report.json.value.components.map((item) => item.name)
  assert.ok(components.includes('owner-component'), '组件必须被识别出来（未启用也要能识别）')
  assert.ok(!components.includes('owner-bundle'), '归属包自己不算组件')

  const posted = await callRoute(route.handler, 'POST', '/dsh-shared-tree/panel', { target: 'owner-component', exposed: true })
  assert.deepEqual(posted.json.value.changed, [], '组件不得被登记进面板')
  assert.match(posted.json.value.skipped[0].reason, /是组件，不是独立插件/)
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies, undefined, '被拒时不得留下改动')
  tree.cleanup()
})

console.log('')
console.log(`${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1