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

await test('写请求白名单：/set、/install、/rollback、/check-profiles、/set-profile', () => {
  const calls = [...SOURCE.matchAll(/postJson\(\s*('([^']+)'|`([^`]+)`)/g)].map((m) => m[2] ?? m[3])
  assert.ok(calls.length > 0, '客户端必须显式声明写请求路径')
  const allowed = new Set(['/set', '/install', '/rollback', '/check-profiles', '/set-profile', '/set-entry', '/set-row', '/lifecycle-baseline-restore', '/panel'])
  for (const path of calls) {
    assert.ok(allowed.has(path), `不允许的写请求：${path}`)
  }
  // 升级必须走确认弹窗 + 总是覆盖（replace:true），且逐 profile 验证在升级任务完成后触发。
  assert.ok(SOURCE.includes('replace: true'), 'install 请求必须显式 replace:true（覆盖升级）')
  assert.ok(SOURCE.includes('/check-profiles'), '升级完成后必须调 /check-profiles 出验证结果卡')
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
  const header = SOURCE.slice(
    SOURCE.indexOf("h('span', { style: styles.meta }"),
    SOURCE.indexOf("h('button'", SOURCE.indexOf("h('span', { style: styles.meta }")),
  )
  assert.ok(/counts\.total/.test(header) && /counts\.enabled/.test(header), '顶部计数口径不变')
  assert.ok(!/counts\.linked/.test(header), '顶部计数不得把 linked 算进来')
  assert.ok(/counts\.linked/.test(SOURCE) || /linked\.length/.test(SOURCE), '分区标题用 linked 自身条数')
})

await test('升级流程契约：确认弹窗、精确版本锁定、四阶段进度、依赖不满足置灰', () => {
  // 确认弹窗：固定精确版本 + 影响面列表 + 开始/取消。
  assert.ok(SOURCE.includes('ConfirmModal'), '必须有确认弹窗组件')
  assert.ok(SOURCE.includes('affectedProfiles'), '弹窗必须展示"影响 N 个 profile"')
  assert.ok(SOURCE.includes("useState(true)"), '精确版本锁定默认开启')
  // 任务进度：prepare/build/merge/verify 四阶段 + 结束后逐 profile 验证结果卡。
  assert.ok(SOURCE.includes("['prepare', 'build', 'merge', 'verify']"), '四阶段顺序必须固定')
  assert.ok(SOURCE.includes('JobCard'), '必须有任务进度卡组件')
  assert.ok(SOURCE.includes('/install/progress'), '进度必须轮询任务接口')
  // 依赖区：deps.ok === false 时升级按钮禁用。
  assert.ok(SOURCE.includes('upgradeBlocked'), '必须依赖检查结果决定升级按钮是否置灰')
  // 详情页三区 + 行内按钮。
  assert.ok(SOURCE.includes('DetailPanel'), '必须有详情页组件')
  assert.ok(SOURCE.includes('/set-profile'), '灰度开关必须走跨 profile 接口')
  assert.ok(SOURCE.includes('/rollback'), '回滚下拉必须走 /rollback')
})

await test('黑屏回归：DetailPanel 不得引用未定义的 load（渲染期 ReferenceError → 槽位整块空白）', () => {
  const body = SOURCE.slice(SOURCE.indexOf('function DetailPanel'), SOURCE.indexOf('function ConfirmModal'))
  assert.ok(!/\[name,\s*load\s*,/.test(body), 'DetailPanel 的 useCallback 依赖里不得出现未定义的 load')
  assert.ok(/\[name,\s*loadDetail,\s*t\]/.test(body), '必须引用自己定义的 loadDetail')
  // 每个取数失败都要有错误态兜底（不许白屏/黑屏）。
  assert.ok(body.includes('entriesError'), '功能项加载失败要有错误态')
  assert.ok(body.includes('debugError'), '调试信息加载失败要有错误态')
  // TDZ 回归（2026-11-27 实测：toggleRow 的依赖数组引用了滞后声明的 loadDetail →
  // 渲染期求值触发 "Cannot access 'loadDetail' before initialization" → 整面板黑屏）。
  // 规则：DetailPanel 段内每个 useCallback 依赖数组的成员，必须在其之前已声明（props 解构或 const）。
  const props = ['name', 'treeVersion', 'onBack', 'onUpgrade', 'onJobStarted', 't', 'fill']
  const declarations = [
    ...[...body.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=/g)].map((match) => ({ name: match[1], at: match.index })),
    // useState 的数组解构：const [a, setA] = useState(...)
    ...[...body.matchAll(/const\s*\[([^\]]+)\]\s*=/g)].flatMap((match) =>
      match[1].split(',').map((item) => item.trim()).filter((item) => /^[A-Za-z_$][\w$]*$/.test(item))
        .map((name) => ({ name, at: match.index }))),
  ]
  for (const match of body.matchAll(/\},\s*\[([^\]]+)\]\)/g)) {
    for (const dep of match[1].split(',').map((item) => item.trim()).filter((item) => item.length > 0)) {
      const found = declarations.find((item) => item.name === dep)
      assert.ok(
        props.includes(dep) || (found !== undefined && found.at < match.index),
        `依赖数组里的「${dep}」必须在其之前声明（TDZ 会黑屏），位置 ${match.index}`,
      )
    }
  }
  // toggleRow 必须在 loadDetail 声明之后（上一次黑屏的直接原因）。
  const loadAt = body.indexOf('const loadDetail = useCallback')
  const toggleAt = body.indexOf('const toggleRow = useCallback')
  assert.ok(loadAt >= 0 && toggleAt > loadAt, 'loadDetail 必须先于 toggleRow 声明')
})

await test('详情/调试契约：功能项开关、profile 覆盖层、整行可点', () => {
  assert.ok(SOURCE.includes('/entries?pkg='), '功能项必须走 /entries')
  assert.ok(SOURCE.includes('/set-entry'), '功能项开关必须走 /set-entry（写 profile 覆盖层）')
  assert.ok(SOURCE.includes('/debug?pkg='), '调试区必须走 /debug')
  assert.ok(SOURCE.includes('targetProfile'), 'entry 调整必须显式选择目标 profile')
  assert.ok(SOURCE.includes('wholeRowHint'), '整行可点要有提示文案')
  // 整行可点：rowMain 的 onClick 直接进详情；行内按钮必须 stopPropagation 防误触。
  assert.ok(/rowMain,\s*cursor:\s*'pointer'/.test(SOURCE), 'rowMain 必须 pointer + 可点')
  assert.ok((SOURCE.match(/event\.stopPropagation\(\)/g) ?? []).length >= 3, '行内按钮都要 stopPropagation')
  // 已启用的插件：点行跳官方 Plugins 页该插件自己的配置面板（宿主 pluginNavigation.openBundle）。
  assert.ok(SOURCE.includes("get?.('pluginNavigation')"), '必须懒取宿主 pluginNavigation 服务')
  assert.ok(SOURCE.includes('nav.openBundle('), '跳转必须走 pluginNavigation.openBundle')
  assert.ok(SOURCE.includes('openOfficialConfig(item.name)'), '行点击必须先尝试跳官方配置页')
  assert.ok(SOURCE.includes('openOfficialConfig(name)'), '详情页必须有配置页按钮')
})

await test('面板可见性契约：跳转前先问面板自己的数据源，列不出就先登记', () => {
  // 面板的数据源是宿主 pluginManager.listBundles()，不是共享树目录；不能在客户端猜。
  assert.ok(SOURCE.includes('remote?.pluginManager'), '必须问宿主的 pluginManager，不能猜')
  assert.ok(SOURCE.includes('listBundles()'), '可见性必须来自 listBundles（面板同源数据）')
  assert.ok(SOURCE.includes('ensurePanelVisible'), '跳转前必须有 ensurePanelVisible')
  assert.ok(SOURCE.includes("postJson('/panel'"), '登记必须走 /panel 路由')
  assert.ok(/async function openOfficialConfig/.test(SOURCE), '跳转必须异步（先登记再跳）')
  assert.ok(SOURCE.includes('panelPin'), '详情页要有手动"加入插件面板"按钮')
  // 组件（entry id 归属别的插件）绝不能走官方跳转：它不该作为独立 bundle 出现。
  assert.ok(/item\.hasBundle === true && item\.standaloneConflict === undefined/.test(SOURCE), '组件必须回退自建详情')
})

await test('原版详情复刻契约：描述文档 + 行级功能开关（原版布局与写入链路）', () => {
  // 描述区：BundleDetailSection 复刻 —— /detail 拉文档 + 极简 Markdown 渲染 + 重试/缺失态。
  assert.ok(SOURCE.includes('/detail?pkg='), '描述必须走 /detail（宿主 readBundleDetail 同源）')
  assert.ok(SOURCE.includes('renderMarkdown'), '必须自带 Markdown 渲染（原版 DetailDocument 的降级复刻）')
  assert.ok(SOURCE.includes('docRetry'), '描述加载失败必须有重试')
  assert.ok(SOURCE.includes('docMissing'), '无文档时要有缺失文案而不是空白')
  // 功能开关区：RowsSection 复刻 —— 状态点 + 行 id + 状态 + 拨动开关，写入走原版链路。
  assert.ok(SOURCE.includes('/rows?pkg='), '功能行必须走 /rows（宿主 listPlugins 同源）')
  assert.ok(SOURCE.includes('/set-row'), '行开关必须走 /set-row（宿主优先 manager.setPluginEnabled 原版链路）')
  assert.ok(SOURCE.includes("role: 'switch'"), '开关必须是 role=switch 的拨动控件（原版 Switch 形态）')
  assert.ok(SOURCE.includes('rowsFilter'), '行多时要有过滤输入框（原版 partsFilter 行为）')
  assert.ok(SOURCE.includes('readOnlyReason'), '只读行要禁用并给原因（原版 RowSwitch locked 行为）')
  assert.ok(SOURCE.includes('docSection(),'), '描述区必须在详情页渲染')
  assert.ok(/rowsSection\(\)/.test(SOURCE), '功能开关区必须在详情页渲染')
})

await test('原版描述区 1:1 复刻契约：三态结构、原版 token、图片渲染', () => {
  // 三态：骨架 / 滚动文档 / 失败重试（DetailDocument.module.css 逐项对齐）。
  assert.ok(SOURCE.includes('docSkeleton'), 'loading 必须是骨架条三态之一')
  assert.ok(SOURCE.includes('dst-skeleton'), '骨架动画 keyframes 必须存在（原版同款）')
  assert.ok(SOURCE.includes("maxHeight: 'min(560px, 60vh)'"), '文档滚动区高度上限必须与原版一致')
  assert.ok(SOURCE.includes("borderTop: '0.5px solid var(--dsw-alias-border-l1"), '文档区上下 0.5px 边框线（原版 border-block）')
  assert.ok(SOURCE.includes("scrollbarGutter: 'stable'"), '滚动条 gutter 稳定（原版）')
  assert.ok(SOURCE.includes('data-detail-document'), '保留原版 data 标记')
  // token：字体/链接/行内代码/错误色全走原版 alias token。
  assert.ok(SOURCE.includes('--dsw-font-markdown-h1'), '标题必须用原版 markdown 字体 token')
  assert.ok(SOURCE.includes("--dsw-alias-markdown-inline-code"), '行内代码背景必须用原版 token')
  assert.ok(SOURCE.includes('--dsw-alias-link'), '链接色必须用原版 token')
  assert.ok(SOURCE.includes("--dsw-alias-bg-skeleton"), '骨架条背景必须用原版 token')
  // 图片：![alt](src) 相对路径走 /detail-image，http(s) 直渲染。
  assert.ok(SOURCE.includes('/detail-image?pkg='), '相对图片必须经宿主 detail-image 路由伺服')
  assert.ok(SOURCE.includes('data:'), 'data: URI 图片直渲染')
  assert.ok(SOURCE.includes('renderMarkdown(doc.markdown'), '描述区必须经渲染器输出')
})

await test('tab 式信息架构契约：四区块按钮切换、保挂载不重挂', () => {
  assert.ok(SOURCE.includes("useState('doc')"), 'tab 状态必须存在且默认描述页')
  assert.ok(SOURCE.includes("role: 'tablist'") && SOURCE.includes("role: 'tabpanel'"), 'tab/tabpanel 语义齐全')
  assert.ok(SOURCE.includes('tabDoc') && SOURCE.includes('tabUpgrade') && SOURCE.includes('tabVersion') && SOURCE.includes('tabProfiles'), '四个 tab 文案齐全')
  assert.ok(SOURCE.includes("paneStyle('doc')") && SOURCE.includes("paneStyle('upgrade')") && SOURCE.includes("paneStyle('version')") && SOURCE.includes("paneStyle('profiles')"), '四个区块都由 paneStyle 包裹')
  // 保挂载：非激活 tab 用 display:none，不用条件渲染卸载（状态不丢、不重新请求）。
  assert.ok(SOURCE.includes(": { display: 'none' }"), '非激活 tab 必须 display:none 保挂载')
  assert.ok(!/tab === 'doc'\s*\?\s*docSection\(\)/.test(SOURCE), '不得条件渲染区块（会重挂丢状态）')
})

await test('生命周期状态条契约：状态必须在 SharedTreePanel 作用域内声明（黑屏回归）', () => {
  // 2026-11-27 实测：lifecycle 的 useState 被误插进 DetailPanel，而渲染条在 SharedTreePanel
  // → 渲染期 ReferenceError: lifecycle is not defined → 整面板黑屏 retire。
  const panelStart = SOURCE.indexOf('function SharedTreePanel')
  const panelBody = SOURCE.slice(panelStart)
  const stateAt = panelBody.indexOf('const [lifecycle, setLifecycle] = useState(null)')
  assert.ok(stateAt > 0, 'lifecycle 状态必须声明在 SharedTreePanel 内')
  const renderAt = panelBody.indexOf('lifecycle !== null')
  assert.ok(renderAt > stateAt, '渲染必须在状态声明之后')
  const detailBody = SOURCE.slice(SOURCE.indexOf('function DetailPanel'), SOURCE.indexOf('function ConfirmModal'))
  assert.equal(detailBody.indexOf('const [lifecycle'), -1, 'DetailPanel 不得声明 lifecycle 状态（作用域错位=黑屏根源）')
  // 状态条数据来自 /lifecycle。
  assert.ok(SOURCE.includes("getJson('/lifecycle')"), '总览页必须拉取 /lifecycle')
  assert.ok(SOURCE.includes('data-lifecycle'), '状态条必须带 data 标记')
})

await test('总览信息密度契约：条目展开功能开关 + 用途描述（侧边栏面板同款）', () => {
  // 展开/收起按钮与行内块。
  assert.ok(SOURCE.includes('rowsShow') && SOURCE.includes('rowsHide'), '必须有展开/收起按钮文案')
  assert.ok(SOURCE.includes('data-overview-rows'), '总览展开块必须带 data 标记')
  assert.ok(SOURCE.includes('rowsCache'), '展开数据必须有缓存（不重复请求）')
  assert.ok(SOURCE.includes('overviewRowsBlock'), '总览行内功能块必须存在')
  // 数据源：/rows 复用 + lang 参数（原版 PluginLocalizedMeta 同字段）。
  assert.ok(SOURCE.includes("getJson(`/rows?pkg="), '总览功能行必须走 /rows（与详情页同一数据源）')
  assert.ok(SOURCE.includes('&lang='), '行级 title/description 必须按语言解析')
  // 行渲染：开关 + 用途描述 + 状态点。
  assert.ok((SOURCE.match(/row\.description !== null && row\.description !== undefined/g) ?? []).length >= 2, '总览与详情都要渲染用途描述')
  assert.ok(SOURCE.includes("row.title ?? row.entryId"), '行标题优先用原版 meta.title')
  // 写入链路：总览行内开关必须走 /set-row（manager 原生链路 + 差异记账）。
  assert.ok(SOURCE.includes("postJson('/set-row', { entryId, enabled })"), '总览行内开关必须走 /set-row')
})

console.log('')
console.log(`${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
