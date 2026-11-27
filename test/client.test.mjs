/**
 * dsh-shared-tree 浏览器侧的契约自验。
 *
 * 只验证「不依赖浏览器就能确证」的部分：模块 id、导出形态、槽位注册、
 * locale 注册、只读性（源码里没有写操作）、以及不 import Harness 客户端包。
 * 渲染结果本身无法在此环境验证，报告里会如实说明。
 *
 * 2026-11-27 精简后：客户端只剩「只读目录 + 刷新 + 跳官方配置页」。
 * 功能按钮与自建详情页已整体删除，这里同时钉住「不得复活」的契约。
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

await test('写请求白名单：/panel（登记面板可见）+ 升级通道 /install、/check-profiles', () => {
  const calls = [...SOURCE.matchAll(/postJson\(\s*('([^']+)'|`([^`]+)`)/g)].map((m) => m[2] ?? m[3])
  assert.ok(calls.length > 0, '客户端必须显式声明写请求路径')
  const allowed = new Set(['/panel', '/install', '/check-profiles'])
  for (const path of calls) {
    assert.ok(allowed.has(path), `不允许的写请求：${path}`)
  }
  // 升级通道必须真的被使用（2026-11-27 恢复的长期保留功能）。
  assert.ok(calls.includes('/install'), '升级必须走 POST /install')
  assert.ok(calls.includes('/check-profiles'), '升级完成后必须调 /check-profiles 出验证结果卡')
  // 已删除的功能按钮对应的路由一个都不得再出现（升级相关的 /install、/check-profiles、/impact、/deps 除外）。
  for (const gone of ['/set', '/rollback', '/set-profile', '/set-entry', '/set-row', '/lifecycle-baseline-restore', '/entries', '/debug', '/detail', '/rows']) {
    assert.ok(!SOURCE.includes(gone), `已删除的路由不得再出现：${gone}`)
  }
})

await test('精简契约：自建详情页与无关功能按钮不得复活（升级能力除外）', () => {
  // 组件级死代码检查：这些组件/函数整体删除，任何引用都算复活。
  // ConfirmModal / JobCard / checkKindLabel 属升级能力，2026-11-27 恢复，不在禁止之列。
  for (const gone of ['DetailPanel', 'SmallSwitch', 'renderMarkdown', 'toneOf']) {
    assert.ok(!SOURCE.includes(gone), `已删除的组件/函数不得再出现：${gone}`)
  }
  // 按钮文案（中英字典 key）不得残留（升级相关 key 已恢复，不在禁止之列）。
  // 只扫字典区：job 对象的 detail 字段是升级进度卡的合法数据，不是文案 key。
  const dictSource = SOURCE.slice(SOURCE.indexOf('en: {'), SOURCE.indexOf('},\n    }'))
  for (const gone of [
    'enable', 'disable', 'rollback', 'detail', 'back', 'panelPin', 'panelPinned',
    'openConfig', 'rowsShow', 'rowsHide', 'lifeBaseline', 'verify', 'working', 'pendingTag',
    'tabDoc', 'tabUpgrade', 'tabVersion', 'tabProfiles', 'docSection', 'rowsSection',
    'featuresTitle', 'debugTitle', 'impactTitle', 'depsTitle', 'versionTitle',
  ]) {
    assert.ok(!new RegExp(`\\b${gone}:`).test(dictSource), `已删除的文案 key 不得残留：${gone}`)
  }
  // 按钮形态：刷新 + 检查更新 + 行内升级 + 弹窗取消/开始 + 进度卡关闭，共 6 处；
  // 不得出现启用/停用、详情、功能展开等已删按钮。
  const buttons = [...SOURCE.matchAll(/h\('button'/g)]
  assert.equal(buttons.length, 6, `面板应有 6 个按钮（刷新/检查更新/行内升级/取消/开始/进度卡关闭），实际 ${buttons.length} 个`)
  assert.ok(SOURCE.includes("t('refresh')"), '必须有刷新按钮')
  assert.ok(SOURCE.includes("t('checkUpdates')"), '必须有检查更新按钮')
  assert.ok(SOURCE.includes("t('upgrade')"), '必须有行内升级按钮')
})

await test('升级能力契约：可升级判据、确认弹窗、进度轮询、完成后刷新（与 38555d5 删除前同源）', () => {
  // 可升级判据：/deps?ver=latest 的 available===true 且 version !== 树内版本。
  assert.ok(SOURCE.includes('/deps?pkg='), '可升级判据必须走 /deps（registry 最新版本 + 依赖检查）')
  assert.ok(SOURCE.includes('&ver=latest'), '必须问 latest 版本')
  assert.ok(/deps\.available !== true/.test(SOURCE), 'registry 不可达时不得显示升级按钮')
  assert.ok(/deps\.version === item\.version/.test(SOURCE), '版本相同判为已是最新')
  // 确认弹窗：精确版本锁定 + 影响面 + 依赖检查不通过置灰。
  assert.ok(SOURCE.includes('ConfirmModal'), '必须有确认弹窗组件')
  assert.ok(SOURCE.includes('affectedProfiles'), '弹窗必须展示"影响 N 个 profile"')
  assert.ok(SOURCE.includes('upgradeBlocked'), '依赖检查 ok===false 时开始按钮必须置灰')
  assert.ok(SOURCE.includes("useState(true)"), '精确版本锁定默认开启')
  // 执行通道：POST /install 总是覆盖（replace:true），四阶段进度轮询。
  assert.ok(SOURCE.includes('replace: true'), 'install 请求必须显式 replace:true（覆盖升级）')
  assert.ok(SOURCE.includes("['prepare', 'build', 'merge', 'verify']"), '四阶段顺序必须固定')
  assert.ok(SOURCE.includes('JobCard'), '必须有任务进度卡组件')
  assert.ok(SOURCE.includes('/install/progress'), '进度必须轮询任务接口')
  // 完成后：逐 profile 验证 + 列表刷新 + 清掉旧的可升级缓存。
  assert.ok(SOURCE.includes("postJson('/check-profiles'"), '升级完成后必须出逐 profile 验证结果')
  assert.ok(/setUpdates\(\{\}\)/.test(SOURCE), '升级完成后必须清掉旧的可升级缓存')
  // 行内升级按钮必须 stopPropagation，避免误触发行点击跳转。
  assert.ok(/event\.stopPropagation\(\); void openConfirm/.test(SOURCE), '升级按钮必须 stopPropagation')
  // 检查更新必须并发 + 增量上屏（单次 /deps 实测 3-7s，串行 20 个包要 90s+，用户会以为按钮坏了）。
  const checkBody = SOURCE.slice(SOURCE.indexOf('const checkUpdates = useCallback'), SOURCE.indexOf('}, [data])', SOURCE.indexOf('const checkUpdates = useCallback')))
  assert.ok(/Promise\.all/.test(checkBody), '检查更新必须并发（不能逐个串行 await）')
  assert.ok(/CONCURRENCY/.test(checkBody), '必须有并发上限（registry 不宜打爆）')
  assert.ok(/setCheckProgress/.test(checkBody), '必须回报进度，避免长时间只有一个"检查中"')
  assert.ok(/setUpdates\(\{ \.\.\.next \}\)/.test(checkBody), '必须增量上屏（探到一个显示一个）')
  assert.ok(SOURCE.includes('checkingProgress'), '按钮/提示要有 {done}/{total} 进度文案')
})

await test('样式只用主题 token 或透明值，没有硬编码配色（图标除外）', () => {
  // 只扫真正承载样式的那两段：styles 对象 + <style> 模板。
  // 扫全文会把注释和文案里的 issue #470 之类编号误判成颜色。
  const stylesStart = SOURCE.indexOf('const styles = {')
  const stylesEnd = SOURCE.indexOf('function SharedTreePanel')
  const templateStart = SOURCE.indexOf("h('style', null, `")
  const templateEnd = SOURCE.indexOf('`),', templateStart)
  assert.ok(stylesStart > 0 && stylesEnd > stylesStart, '找不到 styles 对象')
  assert.ok(templateStart > 0 && templateEnd > templateStart, '找不到 <style> 模板')
  const css = SOURCE.slice(stylesStart, stylesEnd) + SOURCE.slice(templateStart, templateEnd)

  const hexColors = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
  // 允许作为 token 缺省值的少量兜底色（#3b6ef5 / #fff，升级 UI 恢复后与删除前一致），其余不允许。
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

await test('竞态保护：load 必须 bump epoch（旧 Refresh 不得覆盖新状态）', () => {
  const loadBody = SOURCE.slice(SOURCE.indexOf('const load = useCallback'), SOURCE.indexOf('useEffect(() => { void load() }'))
  assert.match(loadBody, /\+\+epoch\.current/)
  assert.match(loadBody, /request !== epoch\.current/, 'load 必须校验 epoch 后再写入')
})

await test('读不到启用状态时按"未知"处理，而不是全显示未启用', () => {
  assert.ok(/stateKnown/.test(SOURCE), '需要 stateKnown 判断')
  assert.ok(/profileBundlesAvailable !== false/.test(SOURCE), '必须读 profileBundlesAvailable')
  assert.ok(/unknownTag/.test(SOURCE), '需要 unknownTag 文案')
})

await test('提醒与可访问性：aria-live、焦点环、描述限行', () => {
  assert.ok(/aria-live/.test(SOURCE), '通知区需要 aria-live')
  assert.ok(/focus-visible/.test(SOURCE), '需要 focus-visible 焦点环')
  assert.ok(/-btn:disabled/.test(SOURCE), '需要 disabled 样式')
  assert.ok(/-webkit-line-clamp/.test(SOURCE), '描述要限行数，避免挤压窄栏')
})

await test('alive 必须在挂载时重置（否则双挂载后一直卡在读取中）', () => {
  const effect = SOURCE.slice(SOURCE.indexOf('useEffect(() => {'), SOURCE.indexOf('const load = useCallback'))
  assert.match(effect, /alive\.current = true/, '挂载时必须把 alive 置回 true')
  assert.match(effect, /alive\.current = false/, '卸载时必须置 false')
})

await test('类别筛选不再有 library 选项，改用过滤说明', () => {
  // 纯依赖库在数据源就被过滤，列表里不会出现；因此类别下拉不该再提供"纯运行时库"。
  const selectBlock = SOURCE.slice(SOURCE.indexOf("value: 'all'"), SOURCE.indexOf("value: 'stateAll'"))
  assert.ok(!/value: 'library'/.test(selectBlock), '类别下拉不应再有 library 选项')
  assert.ok(!/t\('kindLibrary'\)/.test(SOURCE), '不应再渲染"纯运行时库"类别 badge')
  // 但要给出"过滤掉多少条"的可见说明
  assert.ok(/filteredNote/.test(SOURCE), '需要被过滤条数的说明文案')
  assert.ok(/counts\.libraries/.test(SOURCE), '说明必须读 counts.libraries')
  assert.ok(/componentsNote/.test(SOURCE), '需要归组组件条数的说明文案')
})

await test('组件渲染为归属行下的子行，且没有任何按钮', () => {
  // 子行来自 item.components（数据源已把组件从顶层摘掉）
  assert.ok(/item\.components/.test(SOURCE), '必须渲染 item.components')
  assert.ok(/styles\.childRow/.test(SOURCE), '需要子行样式')
  assert.ok(/fill\('componentOf'/.test(SOURCE), '子行要标注归属')
  assert.ok(/fill\('componentHint'/.test(SOURCE), '子行要说明为何不能独立启用')
  // 关键：子行里不能有任何按钮或写请求。
  const childStart = SOURCE.indexOf('components.map((child)')
  const childBlock = SOURCE.slice(childStart, SOURCE.indexOf('}))', childStart))
  assert.ok(!/h\('button'/.test(childBlock), '子行不得渲染按钮')
  assert.ok(!/postJson/.test(childBlock), '子行不得发写请求')
})

await test('搜索命中子项时仍能看到归属行', () => {
  // 组件不参与类别/状态过滤，但关键字命中子项应让归属行可见，否则搜 "scoped" 会找不到。
  const block = SOURCE.slice(SOURCE.indexOf('const visible = useMemo'), SOURCE.indexOf('const junction = data'))
  assert.match(block, /components\.some\(\(child\) => matchesText\(child\)\)/, '关键字需匹配子项')
})

await test('只读分区：渲染 linked 列表且区块内没有任何按钮', () => {
  // 分区数据来自 Host 的 data.linked（源自 listBundles().source 的 link: 条目）
  assert.ok(/data\?\.linked/.test(SOURCE), '必须读 data.linked')
  assert.ok(/linkedSection/.test(SOURCE), '需要 linkedSection 渲染函数')
  assert.ok(/t\('linkedNote'\)/.test(SOURCE), '分区要有只读说明')
  assert.ok(/t\('linkedTarget'\)/.test(SOURCE), '要显示 link: 目标路径')
  // 关键：只读 —— 分区内不得出现任何按钮或写请求。
  const start = SOURCE.indexOf('const linkedSection = ()')
  const end = SOURCE.indexOf('return h(\'div\', { style: styles.root }', start)
  assert.ok(start > 0 && end > start, '定位不到 linkedSection 函数体')
  const block = SOURCE.slice(start, end)
  assert.ok(!/h\('button'/.test(block), '只读分区不得渲染按钮')
  assert.ok(!/postJson/.test(block), '只读分区不得发写请求')
})

await test('只读分区不参与四个计数，只影响自己的条数', () => {
  // 顶部计数仍用 counts.total / counts.enabled；linked 只用于分区标题与说明
  const header = SOURCE.slice(
    SOURCE.indexOf("h('span', { style: styles.meta }"),
    SOURCE.indexOf("h('button'", SOURCE.indexOf("h('span', { style: styles.meta }")),
  )
  assert.ok(/counts\.total/.test(header) && /counts\.enabled/.test(header), '顶部计数口径不变')
  assert.ok(!/counts\.linked/.test(header), '顶部计数不得把 linked 算进来')
  assert.ok(/counts\.linked/.test(SOURCE) || /linked\.length/.test(SOURCE), '分区标题用 linked 自身条数')
})

await test('生命周期状态条契约：只读展示，状态必须在 SharedTreePanel 作用域内声明', () => {
  // 2026-11-27 实测：lifecycle 的 useState 被误插进别的组件 → 渲染期 ReferenceError → 整面板黑屏。
  const panelStart = SOURCE.indexOf('function SharedTreePanel')
  const panelBody = SOURCE.slice(panelStart)
  const stateAt = panelBody.indexOf('const [lifecycle, setLifecycle] = useState(null)')
  assert.ok(stateAt > 0, 'lifecycle 状态必须声明在 SharedTreePanel 内')
  const renderAt = panelBody.indexOf('lifecycle !== null')
  assert.ok(renderAt > stateAt, '渲染必须在状态声明之后')
  // 状态条数据来自 /lifecycle。
  assert.ok(SOURCE.includes("getJson('/lifecycle')"), '总览页必须拉取 /lifecycle')
  assert.ok(SOURCE.includes('data-lifecycle'), '状态条必须带 data 标记')
  // 精简后：只读展示，不得再有基线还原按钮。
  assert.ok(!/baselineArm/.test(SOURCE), '基线还原按钮已删除，不得残留状态')
  assert.ok(!/lifecycle-baseline-restore/.test(SOURCE), '基线还原路由不得再出现')
})

await test('面板可见性契约：跳转前先问面板自己的数据源，列不出就先登记', () => {
  // 面板的数据源是宿主 pluginManager.listBundles()，不是共享树目录；不能在客户端猜。
  assert.ok(SOURCE.includes('remote?.pluginManager'), '必须问宿主的 pluginManager，不能猜')
  assert.ok(SOURCE.includes('listBundles()'), '可见性必须来自 listBundles（面板同源数据）')
  assert.ok(SOURCE.includes('ensurePanelVisible'), '跳转前必须有 ensurePanelVisible')
  assert.ok(SOURCE.includes("postJson('/panel'"), '登记必须走 /panel 路由')
  assert.ok(/async function openOfficialConfig/.test(SOURCE), '跳转必须异步（先登记再跳）')
  assert.ok(SOURCE.includes("get?.('pluginNavigation')"), '必须懒取宿主 pluginNavigation 服务')
  assert.ok(SOURCE.includes('nav.openBundle('), '跳转必须走 pluginNavigation.openBundle')
})

await test('行点击契约：独立 bundle 跳转；组件与 client-only 只提示、不跳转', () => {
  // 独立 bundle：先 ensurePanelVisible（在 openOfficialConfig 内）再跳官方配置页。
  assert.ok(SOURCE.includes('openOfficialConfig(item.name)'), '行点击必须先尝试跳官方配置页')
  assert.ok(/rowMain,\s*cursor:\s*'pointer'/.test(SOURCE), 'rowMain 必须 pointer + 可点')
  // 组件（entry id 归属别的插件）绝不能走官方跳转：它不该作为独立 bundle 出现。
  assert.ok(/item\.hasBundle === true && item\.standaloneConflict === undefined/.test(SOURCE), '只有独立 bundle 才跳转')
  // 自建详情页已删除：跳转失败 / 组件 / client-only 一律只给提示，不得回退到详情页。
  assert.ok(!/setDetailName/.test(SOURCE), '详情页状态已删除，不得残留')
  assert.ok(SOURCE.includes('componentRowHint'), '组件点击要有专门提示')
  assert.ok(SOURCE.includes('clientRowHint'), 'client-only 点击要有专门提示')
  assert.ok(SOURCE.includes('jumpFailed'), '跳转失败要有提示文案')
  // 失败提示必须真的接到 openOfficialConfig 的返回值上。
  assert.ok(/openOfficialConfig\(item\.name\)\.then\(\(opened\) =>/.test(SOURCE), '必须处理跳转结果')
  assert.ok(/if \(!opened\) setNotice/.test(SOURCE), '跳转失败必须给 notice')
})

console.log('')
console.log(`${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
