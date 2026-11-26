/**
 * dsh-shared-tree 浏览器侧的契约自验。
 *
 * 只验证「不依赖浏览器就能确证」的部分：模块 id、导出形态、槽位注册、
 * locale 注册、只读性（源码里没有写操作）、以及不 import Harness 客户端包。
 * 渲染结果本身无法在此环境验证，报告里会如实说明。
 *
 * 运行：node test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const CLIENT_PATH = join(here, '..', 'lib', 'client.js')
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

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

/** 极简 React 桩：只需要工厂解构出来的那些 hook 名字存在。 */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
}

/**
 * 载入 client.js 并取回它声明的模块。
 * @returns {{ id: string, module: any }} 声明 id 与工厂返回值。
 */
function loadClientModule() {
  let declaration
  globalThis.window = {
    __ModuleLoader__: {
      load: (value) => { declaration = value },
    },
  }
  // client.js 通过 window.__ModuleLoader__.load 注册，不 export。
  // 用动态求值把它当作普通脚本来跑（与浏览器装载方式一致）。
  const factory = new Function('window', SOURCE)
  factory(globalThis.window)
  if (declaration === undefined) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  const module = declaration.factory((request) => {
    if (request === 'react') return reactStub
    throw new Error(`意外 require('${request}')`)
  })
  return { id: declaration.id, module }
}

/**
 * 造一个记录注册的假客户端 ctx。
 * 关键：cordis 的客户端 Context 在**未 inject** 的服务上取值会抛
 * `cannot get property "x" without inject`，不是返回 undefined。
 * 这里如实模拟这个行为，才能压住那条真实发生的 bug。
 * @param {{ withRightTabs?: boolean }} [options] 是否提供 sidebarRightTabs。
 * @returns {any} 假 ctx。
 */
function fakeClientContext(options = {}) {
  const slots = { injected: [], registered: [] }
  const services = new Map()
  const localeCalls = []
  services.set('locale', {
    register: (ns, locale, dict) => { localeCalls.push([ns, locale, Object.keys(dict).length]); return () => {} },
    bind: () => (key) => `T:${key}`,
  })
  if (options.withRightTabs !== false) {
    services.set('sidebarRightTabs', {
      registered: [],
      register(descriptor) { this.registered.push(descriptor); return () => {} },
    })
  }
  const injected = options.withLocale === false ? [] : ['slots', 'locale']
  const effects = []

  /** 声明过的服务才可读，否则按 cordis 的行为抛错。 */
  const read = (key) => {
    if (!services.has(key)) throw new Error(`cannot get property "${key}" without inject`)
    return services.get(key)
  }

  const ctx = {
    slots: {
      inject: (key, factory) => {
        slots.injected.push(key)
        const value = factory()
        if (value !== null && typeof value === 'object' && typeof value.next === 'function') {
          let step = value.next()
          while (step.done !== true) step = value.next()
        }
      },
      register: (options_, Component) => { slots.registered.push({ options: options_, Component }) },
    },
    effect: (callback, label) => { effects.push(label); return callback() },
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : [deps]
      if (!names.every((key) => services.has(key))) return undefined
      const face = { slots: ctx.slots, effect: ctx.effect }
      for (const key of names) face[key] = services.get(key)
      return callback(face)
    },
    slotsLog: slots,
    effects,
    services,
    localeCalls,
    get sidebarRightTabs() { return read('sidebarRightTabs') },
    get locale() { return read('locale') },
  }
  ctx.declaredInject = injected
  return ctx
}

console.log('dsh-shared-tree 客户端契约自验')
console.log('')

await test('模块 id 必须等于包名（否则 duplicate factory → web boot 失败）', () => {
  const { id } = loadClientModule()
  assert.equal(id, PKG.name)
})

await test('工厂返回 { inject, apply }，inject 声明 slots 与 locale', () => {
  const { module } = loadClientModule()
  assert.equal(typeof module.apply, 'function')
  assert.ok(Array.isArray(module.inject))
  assert.ok(module.inject.includes('slots'))
  // cordis 客户端上下文在未 inject 的服务上取值会抛错，所以 locale 必须声明。
  assert.ok(module.inject.includes('locale'))
  // sidebarRightTabs 必须**不**在 inject 里：放进会让缺少该服务的 profile 整体不激活。
  assert.ok(!module.inject.includes('sidebarRightTabs'), 'sidebarRightTabs 不能进 inject')
})

await test('不 import 任何 Harness 客户端包（避免版本漂移与槽位崩空）', () => {
  const requires = [...SOURCE.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2])
  for (const request of requires) {
    assert.equal(request, 'react', `client.js 只应 require('react')，实际还有 ${request}`)
  }
})

await test('apply 注册三处入口：main(key) / sidebar.panellist(id) / 右栏 tab', () => {
  const { module } = loadClientModule()
  const ctx = fakeClientContext()
  module.apply(ctx)
  const names = ctx.slotsLog.registered.map((item) => item.options.name)
  assert.ok(names.includes('main'), '缺 main 面板')
  assert.ok(names.includes('sidebar.panellist'), '缺侧边栏图标')
  assert.ok(names.includes('sidebar.right.pane.tab'), '缺右栏 tab')
  // main 的 key 与 sidebar.panellist 的 id 必须相同，否则点图标打不开面板
  const main = ctx.slotsLog.registered.find((item) => item.options.name === 'main')
  const icon = ctx.slotsLog.registered.find((item) => item.options.name === 'sidebar.panellist')
  assert.equal(main.options.key, icon.options.id, 'main.key 必须等于 sidebar.panellist.id')
  assert.equal(typeof icon.options.label, 'function')
  assert.equal(typeof icon.Component, 'function')
  assert.equal(typeof main.Component, 'function')
})

await test('侧边栏图标有排位（order）且在合理区间', () => {
  const { module } = loadClientModule()
  const ctx = fakeClientContext()
  module.apply(ctx)
  const icon = ctx.slotsLog.registered.find((item) => item.options.name === 'sidebar.panellist')
  assert.equal(typeof icon.options.order, 'number')
  assert.ok(icon.options.order >= 0 && icon.options.order <= 100)
})

await test('右栏 tab 声明 kind/title/guide 且被注册', () => {
  const { module } = loadClientModule()
  const ctx = fakeClientContext()
  module.apply(ctx)
  assert.equal(ctx.sidebarRightTabs.registered.length, 1)
  const descriptor = ctx.sidebarRightTabs.registered[0]
  assert.equal(descriptor.kind, descriptor.id)
  assert.equal(typeof descriptor.title, 'function')
  assert.ok(Array.isArray(descriptor.guide) && descriptor.guide.length > 0)
  assert.match(descriptor.guide[0].description(), /\S/)
})

await test('locale 字典按 en/zh 两种语言注册到同一命名空间', () => {
  const { module } = loadClientModule()
  const ctx = fakeClientContext()
  module.apply(ctx)
  const locales = ctx.localeCalls.map((call) => call[1]).sort()
  assert.deepEqual(locales, ['en', 'zh'])
  const namespaces = new Set(ctx.localeCalls.map((call) => call[0]))
  assert.equal(namespaces.size, 1, '两个语言必须同属一个命名空间')
  for (const call of ctx.localeCalls) assert.ok(call[2] > 20, `字典 key 太少：${call[2]}`)
  const [first, second] = ctx.localeCalls
  assert.equal(first[2], second[2], 'en/zh 字典 key 数量必须一致')
})

await test('回归：未 inject 的服务被访问时必须走 try/catch，不得冒泡', () => {
  // 这条对应真实运行时出现过的两条 renderer 错误：
  //   [dsh-shared-tree] 文案注册失败 … cannot get property "locale" without inject
  //   [dsh-shared-tree] 右栏 tab 注册失败 … cannot get property "sidebarRightTabs" without inject
  const { module } = loadClientModule()
  const ctx = fakeClientContext({ withLocale: false, withRightTabs: false })
  const errors = []
  const originalError = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  try {
    // locale 已声明在 inject 里 → 正常运行时不缺；这里模拟"真缺"的极端情况。
    module.apply(ctx)
  } finally {
    console.error = originalError
  }
  // 关键断言：apply 不能抛出；前两处入口仍要注册成功。
  const names = ctx.slotsLog.registered.map((item) => item.options.name)
  assert.ok(names.includes('main'), 'main 仍应注册')
  assert.ok(names.includes('sidebar.panellist'), '侧边栏图标仍应注册')
  assert.ok(!names.includes('sidebar.right.pane.tab'), '缺 sidebarRightTabs 时不应注册右栏 tab')
})

await test('sidebarRightTabs 存在时右栏 tab 通过 ctx.inject 注册', () => {
  const { module } = loadClientModule()
  const ctx = fakeClientContext()
  module.apply(ctx)
  assert.equal(ctx.services.get('sidebarRightTabs').registered.length, 1)
})

await test('en/zh 字典 key 完全对齐', () => {
  // 直接从源码里取两个字典对象并比较 key 集合（不经过 locale 服务）。
  const enBlock = SOURCE.slice(SOURCE.indexOf('en: {'), SOURCE.indexOf('zh: {'))
  const zhBlock = SOURCE.slice(SOURCE.indexOf('zh: {'), SOURCE.indexOf('},\n    }'))
  const keysOf = (block) => [...block.matchAll(/^\s{8}([a-zA-Z]+):/gm)].map((m) => m[1]).sort()
  const enKeys = keysOf(enBlock)
  const zhKeys = keysOf(zhBlock)
  assert.ok(enKeys.length > 20, `en key 太少：${enKeys.length}`)
  assert.deepEqual(enKeys, zhKeys, 'en/zh key 必须一一对应')
})

await test('slots 注册抛错时不连累其他入口', () => {
  const { module } = loadClientModule()
  const ctx = fakeClientContext()
  const originalInject = ctx.slots.inject
  let first = true
  ctx.slots.inject = (key, factory) => {
    if (first) { first = false; throw new Error('boom') }
    return originalInject(key, factory)
  }
  module.apply(ctx)
  const names = ctx.slotsLog.registered.map((item) => item.options.name)
  assert.ok(names.includes('sidebar.panellist'), '第一处失败后第二处仍应注册')
})

await test('只读：客户端只发 GET 与一个 POST /set，且没有 install 路径', () => {
  const calls = [...SOURCE.matchAll(/(getJson|postJson)\(\s*'([^']+)'/g)].map((m) => [m[1], m[2]])
  assert.ok(calls.length > 0)
  for (const [fn, path] of calls) {
    assert.ok(path.startsWith('/'), `路径必须以 / 开头：${path}`)
    if (fn === 'postJson') assert.equal(path, '/set', '唯一的写请求只能是 /set')
  }
  assert.ok(!/\/install/.test(SOURCE), '客户端不应触发 install（装包只走工具/CLI）')
})

await test('样式只用主题 token 或透明值，没有硬编码配色（图标除外）', () => {
  // 只扫真正承载样式的那两段：styles 对象 + <style> 模板。
  // 扫全文会把注释和文案里的 issue #470 之类编号误判成颜色。
  const stylesStart = SOURCE.indexOf('const styles = {')
  const stylesEnd = SOURCE.indexOf('function toneOf')
  const templateStart = SOURCE.indexOf("h('style', null, `")
  const templateEnd = SOURCE.indexOf('`),', templateStart)
  assert.ok(stylesStart > 0 && stylesEnd > stylesStart, '找不到 styles 对象')
  assert.ok(templateStart > 0 && templateEnd > templateStart, '找不到 <style> 模板')
  const css = SOURCE.slice(stylesStart, stylesEnd) + SOURCE.slice(templateStart, templateEnd)

  const hexColors = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
  // 允许作为 token 缺省值的少量兜底色（#3b6ef5 / #fff），其余不允许。
  const allowed = new Set(['#3b6ef5', '#fff'])
  const offending = hexColors.filter((value) => !allowed.has(value))
  assert.deepEqual(offending, [], `样式区出现硬编码颜色：${offending.join(', ')}`)
  assert.ok(!/rgba?\(\s*\d/.test(css.replace(/rgba\(127,\s*127,\s*127/g, '')), '不应出现硬编码 rgb 颜色')
  // 兜底：样式区必须真的引用了主题 token，否则上面的检查会变成空转
  assert.ok((css.match(/--dsw-alias-/g) ?? []).length > 10, '样式区应大量引用 --dsw-alias-* token')
})

await test('不写 DOM：没有 document./appendChild/querySelector 用法', () => {
  assert.ok(!/document\.(body|querySelector|getElementById|createElement)/.test(SOURCE))
  assert.ok(!/\.appendChild\(/.test(SOURCE))
})

await test('类别过滤与工具同源：一律按 kind 单字段判定', () => {
  // 界面若用 hasBundle/hasClient 各自判定，一个同时具备两者的包会同时出现在
  // "dsh.bundle" 与 "dsh.client" 两个类别里，而 `shared_tree action=search kind=`
  // 用的是单个 kind 字段 —— 两处结论会分叉。这里钉死界面必须用 kind。
  assert.ok(/item\.kind !== kind/.test(SOURCE), '类别过滤必须用 item.kind')
  assert.ok(!/kind === 'bundle' && item\.hasBundle/.test(SOURCE), '不得用 hasBundle 做类别过滤')
  assert.ok(!/kind === 'client' && item\.hasClient/.test(SOURCE), '不得用 hasClient 做类别过滤')
})

await test('并发保护：任何操作进行中都要禁用其他动作按钮', () => {
  // 单一个 busy 串同时给"行开关"和"校验"用；若只按 busy==='__verify__' 判禁用，
  // 校验进行中点某一个开关就会把其他按钮重新启用 → 并发写。
  assert.ok(/const anyBusy = busy !== null/.test(SOURCE), '应有统一的 anyBusy')
  const disabledUses = [...SOURCE.matchAll(/disabled: ([^,\n]+)/g)].map((m) => m[1].trim())
  assert.ok(disabledUses.length >= 3, `按钮都要有 disabled：${disabledUses.length}`)
  for (const expr of disabledUses) {
    assert.ok(/anyBusy|loading|\|\|/.test(expr), `disabled 必须考虑 anyBusy/loading：${expr}`)
  }
})

await test('竞态保护：toggle 也要 bump epoch（旧 Refresh 不得覆盖新状态）', () => {
  const toggleBody = SOURCE.slice(SOURCE.indexOf('const toggle = useCallback'), SOURCE.indexOf('const runVerify'))
  assert.match(toggleBody, /\+\+epoch\.current/, 'toggle 必须 bump epoch')
  assert.match(toggleBody, /request !== epoch\.current/, 'toggle 必须校验 epoch 后再写入')
  const loadBody = SOURCE.slice(SOURCE.indexOf('const load = useCallback'), SOURCE.indexOf('useEffect(() => { void load() }'))
  assert.match(loadBody, /\+\+epoch\.current/)
})

await test('重启待生效时显示专门的标记，不误显示成"未启用"', () => {
  assert.ok(/pendingTag/.test(SOURCE), '需要 pendingTag 文案')
  assert.ok(/result\.restartRequired === true/.test(SOURCE), '必须识别 restartRequired')
  assert.ok(/setPending/.test(SOURCE), '需要 per-row pending 状态')
})

await test('读不到启用状态时按"未知"处理并禁用开关，而不是全显示未启用', () => {
  assert.ok(/stateKnown/.test(SOURCE), '需要 stateKnown 判断')
  assert.ok(/profileBundlesAvailable !== false/.test(SOURCE), '必须读 profileBundlesAvailable')
  assert.ok(/unknownTag/.test(SOURCE), '需要 unknownTag 文案')
  assert.ok(/disabled: anyBusy \|\| !stateKnown/.test(SOURCE), '状态未知时必须禁用开关')
})

await test('application 语义分开措辞：applied / restart-required / overridden / cancelled', () => {
  for (const key of ['applied', 'needRestart', 'overridden', 'cancelled']) {
    assert.ok(new RegExp(`messageKey: '${key}'`).test(SOURCE), `toneOf 缺少 ${key}`)
  }
  assert.ok(/toneOf/.test(SOURCE), '需要 toneOf 把 application 翻成措辞')
})

await test('提醒与可访问性：safetyNote、aria-live、带包名的可访问名称、局部样式', () => {
  assert.ok(/item\.safetyNote/.test(SOURCE), '界面必须展示 safetyNote')
  assert.ok(/aria-live/.test(SOURCE), '通知区需要 aria-live')
  assert.ok(/'aria-label': `\$\{enabledNow/.test(SOURCE) || /aria-label': `/.test(SOURCE), '开关要有带包名的可访问名称')
  assert.ok(/focus-visible/.test(SOURCE), '需要 focus-visible 焦点环')
  assert.ok(/-btn:disabled/.test(SOURCE), '需要 disabled 样式')
  assert.ok(/-webkit-line-clamp/.test(SOURCE), '描述要限行数，避免挤压窄栏')
})

await test('alive 必须在挂载时重置（否则双挂载后一直卡在读取中）', () => {
  const effect = SOURCE.slice(SOURCE.indexOf('useEffect(() => {'), SOURCE.indexOf('const load = useCallback'))
  assert.match(effect, /alive\.current = true/, '挂载时必须把 alive 置回 true')
  assert.match(effect, /alive\.current = false/, '卸载时必须置 false')
})

await test('新行为①（客户端）：类别筛选不再有 library 选项，改用过滤说明', () => {
  // 纯依赖库在数据源就被过滤，列表里不会出现；因此类别下拉不该再提供"纯运行时库"。
  const selectBlock = SOURCE.slice(SOURCE.indexOf("value: 'all'"), SOURCE.indexOf("value: 'stateAll'"))
  assert.ok(!/value: 'library'/.test(selectBlock), '类别下拉不应再有 library 选项')
  assert.ok(!/t\('kindLibrary'\)/.test(SOURCE), '不应再渲染"纯运行时库"类别 badge')
  // 但要给出"过滤掉多少条"的可见说明
  assert.ok(/filteredNote/.test(SOURCE), '需要被过滤条数的说明文案')
  assert.ok(/counts\.libraries/.test(SOURCE), '说明必须读 counts.libraries')
  assert.ok(/componentsNote/.test(SOURCE), '需要归组组件条数的说明文案')
})

await test('新行为②（客户端）：组件渲染为归属行下的子行，且不给开关', () => {
  // 子行来自 item.components（数据源已把组件从顶层摘掉）
  assert.ok(/item\.components/.test(SOURCE), '必须渲染 item.components')
  assert.ok(/styles\.childRow/.test(SOURCE), '需要子行样式')
  assert.ok(/fill\('componentOf'/.test(SOURCE), '子行要标注归属')
  assert.ok(/fill\('componentHint'/.test(SOURCE), '子行要说明为何不能独立启用')
  // 关键：子行里不能有 enable 按钮（toggle 只出现在归属行）
  const childStart = SOURCE.indexOf('components.map((child)')
  const childBlock = SOURCE.slice(childStart, SOURCE.indexOf('}))', childStart))
  assert.ok(!/toggle\(/.test(childBlock), '子行不得绑定 toggle')
  assert.ok(!/styles\.primaryButton/.test(childBlock), '子行不得渲染启用按钮')
})

await test('新行为②（客户端）：搜索命中子项时仍能看到归属行', () => {
  // 组件不参与类别/状态过滤，但关键字命中子项应让归属行可见，否则搜 "scoped" 会找不到。
  const block = SOURCE.slice(SOURCE.indexOf('const visible = useMemo'), SOURCE.indexOf('const junction = data'))
  assert.match(block, /components\.some\(\(child\) => matchesText\(child\)\)/, '关键字需匹配子项')
})

await test('只读分区（客户端）：渲染 linked 列表且区块内没有任何按钮', () => {
  // 分区数据来自 Host 的 data.linked（源自 listBundles().source 的 link: 条目）
  assert.ok(/data\?\.linked/.test(SOURCE), '必须读 data.linked')
  assert.ok(/linkedSection/.test(SOURCE), '需要 linkedSection 渲染函数')
  assert.ok(/t\('linkedNote'\)/.test(SOURCE), '分区要有只读说明')
  assert.ok(/t\('linkedTarget'\)/.test(SOURCE), '要显示 link: 目标路径')
  // 关键：只读 —— 分区内不得出现 toggle 或任何按钮。
  // 切片必须只圈住 linkedSection 这个函数体（它后面紧跟组件自己的 return）。
  const start = SOURCE.indexOf('const linkedSection = ()')
  const end = SOURCE.indexOf('return h(\'div\', { style: styles.root }', start)
  assert.ok(start > 0 && end > start, '定位不到 linkedSection 函数体')
  const block = SOURCE.slice(start, end)
  assert.ok(!/toggle\(/.test(block), '只读分区不得绑定 toggle')
  assert.ok(!/h\('button'/.test(block), '只读分区不得渲染按钮')
  assert.ok(!/setBundleEnabled|postJson/.test(block), '只读分区不得发写请求')
})

await test('只读分区（客户端）：不参与四个计数，只影响自己的条数', () => {
  // 顶部计数仍用 counts.total / counts.enabled；linked 只用于分区标题与说明
  const header = SOURCE.slice(SOURCE.indexOf("h('span', { style: styles.meta }"), SOURCE.indexOf("h('button'"))
  assert.ok(/counts\.total/.test(header) && /counts\.enabled/.test(header), '顶部计数口径不变')
  assert.ok(!/counts\.linked/.test(header), '顶部计数不得把 linked 算进来')
  assert.ok(/counts\.linked/.test(SOURCE) || /linked\.length/.test(SOURCE), '分区标题用 linked 自身条数')
})

console.log('')
console.log(`${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
