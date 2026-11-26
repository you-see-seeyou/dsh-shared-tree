/**
 * dsh-shared-tree —— 跨 profile 共享插件树管理。
 *
 * 共享树 = `<DSH_HOME>/profiles/node_modules`。它是 profiles/<name>/ 的祖先目录，
 * Node 的模块解析会自然经过它，所以放在这里的包可被所有 profile "按名引用"，
 * 不必各自安装。本插件只做三件事：
 *
 *   1. install —— 把 npm 包装进共享树（临时目录 hoisted 构建 + 只合并顶层包目录）
 *   2. search  —— 列出/搜索共享树里有哪些包、哪些是可加载的 bundle
 *   3. enable/disable —— 决定当前 profile 启用共享树里的哪些 bundle
 *
 * 设计约束（均为实测得来，勿改）：
 *   - 绝不写 `profiles/node_modules/@deepseek-ai`：那是 dsh 安装目录的 10 个 junction，
 *     在 profiles/ 层跑 pnpm 会把它们剪掉。
 *   - 绝不从 profile 解析 `@deepseek-ai/*`：npm 镜像版会遮蔽 CLI 内置 build，
 *     导致整个 base 层工具调度失效。因此本包零 `@deepseek-ai` 依赖，全部用 Node 内置实现。
 *   - mnemon 这类"组合包"必须连同其依赖闭包一起复制，否则加载时 MODULE_NOT_FOUND。
 *
 * @module dsh-shared-tree
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

/** 插件在 loader 中的条目 id。 */
const name = 'shared-tree'
/** 需要的宿主服务：工具注册表。pluginManager 用懒取，缺失时降级报告。 */
const inject = ['tools']

/** dsh 安装自带的 scope，共享树里禁止改写。 */
const PROTECTED_SCOPE = '@deepseek-ai'
/** 共享树清单文件名。 */
const MANIFEST_FILE = '.dsh-shared-tree.json'
/** 清单 scheme，用于识别自己写的文件。 */
const MANIFEST_SCHEME = 'dsh-shared-profile-tree/1'
/** 单次哈希计算的体积上限，防止误扫超大目录卡住 Host。 */
const HASH_BUDGET_BYTES = 64 * 1024 * 1024

/** 已知需要额外提示的包（基于实测，不是猜测）。 */
const SAFETY_NOTES = {
  'dsh-mnemon': 'dsh-mnemon 默认 storageScope=global，会落到 ~/.mnemon 与该机器上其他 profile 共用记忆库。启用前请先在该 profile 的 cordis.patch.yml 写 `- id: mnemon` + `storageScope: custom` + 独立 dataDir。',
}
/** 允许被本工具安装的包名形态（防止把 shell 元字符塞进 pnpm 参数）。 */
const SAFE_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*+-]+)?$/i
/** Sidebar/面板 与 Host 之间的 HTTP 路由前缀（与 dsh-taskboard 同法，不走被 fence 的 /api）。 */
const ROUTE_PREFIX = '/dsh-shared-tree'
/** 单次请求体上限：本机 OOM 防护，不是信任边界。 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * DSH 用户主目录下的路径。与 dsh 自身语义一致：DSH_HOME 优先，否则 ~/.dsh。
 * @param {...string} segments 相对 home 的路径片段。
 * @returns {string} 绝对路径。
 */
function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  return join(resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh')), ...segments)
}

/**
 * 共享树根目录。
 * @returns {string} 绝对路径。
 */
function treeRootOf() {
  return dshHomePath('profiles', 'node_modules')
}

/**
 * 读取目录下的 package.json。
 * @param {string} dir 包目录。
 * @returns {any} 解析后的内容，读不到时为 undefined。
 */
function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 判断目录项是否为真实目录（排除 symlink / junction）。
 * @param {string} full 绝对路径。
 * @returns {{ real: boolean, link: boolean }} 是否为真实目录、是否为链接。
 */
function dirKind(full) {
  try {
    const stat = lstatSync(full)
    const link = stat.isSymbolicLink()
    return { real: stat.isDirectory() && !link, link }
  } catch {
    return { real: false, link: false }
  }
}

/**
 * 把一条目录项归类。
 * @param {any} manifest 该包的 package.json。
 * @returns {'bundle'|'client'|'library'} bundle 可作 profile bundle 加载；client 仅浏览器侧；library 纯依赖。
 */
function kindOf(manifest) {
  if (manifest?.dsh?.bundle !== undefined && manifest.dsh.bundle !== null) return 'bundle'
  if (manifest?.dsh?.client !== undefined && manifest.dsh.client !== null) return 'client'
  return 'library'
}

/**
 * 一个包是否具备插件语义。
 *
 * 判据是它自带 `dsh.*` 清单（`dsh.bundle` / `dsh.client` / 以后可能新增的其它 dsh 键），
 * **不是包名白名单** —— 所以以后 pnpm 再提升进来任何纯依赖库都会自动被过滤，不需要维护名单。
 * 实测本机共享树：194 个顶层包里 20 个有 dsh 清单、174 个没有，且没有"有 dsh 但既非 bundle 也非 client"的灰色地带。
 * @param {any} manifest 包的 package.json。
 * @returns {boolean} 是否具备插件语义。
 */
function hasPluginManifest(manifest) {
  const dsh = manifest?.dsh
  return dsh !== undefined && dsh !== null && typeof dsh === 'object' && Object.keys(dsh).length > 0
}

/**
 * 扫描共享树里的全部顶层包。
 * @param {string} root 共享树根。
 * @returns {Array<object>} 每个顶层包的描述。
 */
function scanTree(root) {
  const found = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  /** 收一个包。 */
  const collect = (full, name, scope) => {
    const manifest = readManifest(full)
    const { real, link } = dirKind(full)
    if (manifest === undefined && !real) return
    found.push({
      name: manifest?.name ?? name,
      entry: name,
      scope: scope ?? null,
      version: manifest?.version ?? null,
      description: typeof manifest?.description === 'string' ? manifest.description : '',
      kind: kindOf(manifest),
      plugin: hasPluginManifest(manifest),
      hasBundle: manifest?.dsh?.bundle !== undefined && manifest.dsh.bundle !== null,
      hasClient: manifest?.dsh?.client !== undefined && manifest.dsh.client !== null,
      real,
      link,
      dependencies: Object.keys(manifest?.dependencies ?? {}).length,
    })
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === PROTECTED_SCOPE) continue
    const full = join(root, entry.name)
    if (entry.name.startsWith('@')) {
      let kids
      try {
        kids = readdirSync(full, { withFileTypes: true })
      } catch {
        continue
      }
      for (const kid of kids) {
        if (kid.name.startsWith('.')) continue
        collect(join(full, kid.name), `${entry.name}/${kid.name}`, entry.name)
      }
      continue
    }
    collect(full, entry.name)
  }
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 校验 @deepseek-ai 下的 junction 是否完好。
 * @param {string} root 共享树根。
 * @returns {{ total: number, junctions: number, names: string[] }} 统计与名字。
 */
function junctionFacts(root) {
  const dir = join(root, PROTECTED_SCOPE)
  if (!existsSync(dir)) return { total: 0, junctions: 0, names: [] }
  const names = []
  let junctions = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    names.push(entry.name)
    if (entry.isSymbolicLink()) junctions += 1
    else {
      try {
        if (lstatSync(join(dir, entry.name)).isSymbolicLink()) junctions += 1
      } catch {
        // 读不到就按非 junction 计，交给调用方用数量差异发现。
      }
    }
  }
  return { total: names.length, junctions, names: names.sort() }
}

/**
 * 计算一个包目录的树哈希：逐文件 sha256 后按相对路径排序再哈希一次。
 * @param {string} dir 包目录。
 * @returns {{ hash: string, files: number, bytes: number, truncated: boolean }} 结果。
 */
function treeHash(dir) {
  const rows = []
  let bytes = 0
  let truncated = false
  /** 递归走文件。 */
  const walk = (current) => {
    if (truncated) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      try {
        const size = statSync(full).size
        bytes += size
        if (bytes > HASH_BUDGET_BYTES) {
          truncated = true
          return
        }
        const digest = createHash('sha256').update(readFileSync(full)).digest('hex')
        rows.push(`${full.slice(dir.length).split(sep).join('/')}  ${digest}`)
      } catch {
        // 单个文件读不到不致命，跳过。
      }
    }
  }
  walk(dir)
  rows.sort()
  return {
    hash: createHash('sha256').update(rows.join('\n')).digest('hex'),
    files: rows.length,
    bytes,
    truncated,
  }
}

/**
 * 读共享树清单。
 * @param {string} root 共享树根。
 * @returns {any} 清单对象；不存在时返回空壳。
 */
function readTreeManifest(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8'))
    if (raw !== null && typeof raw === 'object') return raw
  } catch {
    // 缺失或损坏都按空清单处理，稍后整体重写。
  }
  return { scheme: MANIFEST_SCHEME, packages: [] }
}

/**
 * 把一次安装结果并入清单。
 * @param {string} root 共享树根。
 * @param {Array<object>} packages 本次新增/更新的包。
 * @param {string} buildDir 构建目录。
 * @returns {number} 清单中的包总数。
 */
function mergeTreeManifest(root, packages, buildDir) {
  const manifest = readTreeManifest(root)
  const byName = new Map()
  for (const item of Array.isArray(manifest.packages) ? manifest.packages : []) {
    if (typeof item?.name === 'string') byName.set(item.name, item)
  }
  for (const item of packages) byName.set(item.name, { ...item, buildDir })
  manifest.scheme = MANIFEST_SCHEME
  manifest.updated = new Date().toISOString()
  manifest.packages = [...byName.values()].sort((left, right) => String(left.name).localeCompare(String(right.name)))
  writeFileSync(join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest.packages.length
}

/**
 * 计算依赖闭包。共享树只复制顶层包目录，所以被依赖的顶层包必须一起进树。
 * @param {string} buildDir 构建出的 node_modules。
 * @param {string[]} roots 直接请求的包名。
 * @returns {{ closure: string[], skippedProtected: string[], missing: string[] }} 闭包与诊断。
 */
function dependencyClosure(buildDir, roots) {
  const closure = new Set()
  const skippedProtected = new Set()
  const missing = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const current = queue.shift()
    if (closure.has(current)) continue
    const manifest = readManifest(join(buildDir, current))
    if (manifest === undefined) {
      if (!existsSync(join(buildDir, current))) missing.add(current)
      continue
    }
    closure.add(current)
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      // @deepseek-ai/* 由 profiles/node_modules 下的 junction 提供，绝不复制进树。
      if (dependency === PROTECTED_SCOPE || dependency.startsWith(`${PROTECTED_SCOPE}/`)) {
        skippedProtected.add(dependency)
        continue
      }
      if (!closure.has(dependency)) queue.push(dependency)
    }
  }
  return { closure: [...closure], skippedProtected: [...skippedProtected], missing: [...missing] }
}

/**
 * 在给定目录跑 pnpm。
 * @param {string[]} args pnpm 参数。
 * @param {string} cwd 工作目录。
 * @param {number} timeoutMs 超时。
 * @param {string|undefined} registry 首选 registry。
 * @returns {Promise<{ code: number, output: string }>} 退出码与合并输出。
 */
function runPnpm(args, cwd, timeoutMs, registry) {
  return new Promise((settle) => {
    const env = { ...process.env, NODE_USE_ENV_PROXY: '0', CI: '1' }
    // 进程环境可能带坏代理（内网 HTTP 代理），实测会让 pnpm 全部 ECONNRESET。
    delete env.HTTP_PROXY
    delete env.HTTPS_PROXY
    delete env.http_proxy
    delete env.https_proxy
    const argv = [...args]
    if (registry !== undefined && registry.length > 0) argv.push('--registry', registry)
    let child
    try {
      child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', argv, {
        cwd, env, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      settle({ code: -1, output: `无法启动 pnpm：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    let output = ''
    const absorb = (chunk) => {
      output += String(chunk)
      if (output.length > 40000) output = output.slice(-40000)
    }
    child.stdout?.on('data', absorb)
    child.stderr?.on('data', absorb)
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 进程可能已退出。
      }
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      settle({ code: -1, output: `${output}\n无法启动 pnpm：${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      settle({ code: code ?? -1, output })
    })
  })
}

/**
 * 把构建目录里的包合并进共享树。
 * @param {string} buildRoot 构建出的 node_modules。
 * @param {string} root 共享树根。
 * @param {string[]} packages 要复制的包名。
 * @param {boolean} replace 已存在时是否覆盖。
 * @returns {{ copied: string[], skipped: string[], replaced: string[] }} 结果。
 */
function mergeIntoTree(buildRoot, root, packages, replace) {
  const copied = []
  const skipped = []
  const replaced = []
  mkdirSync(root, { recursive: true })
  for (const packageName of packages) {
    if (packageName === PROTECTED_SCOPE || packageName.startsWith(`${PROTECTED_SCOPE}/`)) {
      skipped.push(`${packageName}（受保护的安装目录 scope）`)
      continue
    }
    if (!SAFE_SPEC.test(packageName)) {
      skipped.push(`${packageName}（包名不合法）`)
      continue
    }
    const from = join(buildRoot, packageName)
    const to = join(root, packageName)
    if (!existsSync(from)) {
      skipped.push(`${packageName}（构建目录里没有）`)
      continue
    }
    const exists = existsSync(to)
    if (exists && !replace) {
      skipped.push(`${packageName}（已存在，未覆盖）`)
      continue
    }
    if (exists) {
      rmSync(to, { recursive: true, force: true })
      replaced.push(packageName)
    }
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true, force: true, dereference: false })
    copied.push(packageName)
  }
  return { copied, skipped, replaced }
}

/**
 * 查询当前 profile 的 bundle 清单（来自 pluginManager）。
 * @param {any} ctx cordis 上下文。
 * @returns {Promise<any[]|undefined>} 清单；服务不可用时 undefined。
 */
async function profileBundles(ctx) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined || typeof manager.listBundles !== 'function') return undefined
  try {
    return await manager.listBundles()
  } catch {
    return undefined
  }
}

/**
 * 把共享树里的包与当前 profile 的启用状态对齐。
 * @param {any[]} treePackages 共享树里的包。
 * @param {any[]|undefined} bundles 当前 profile 的 bundle 清单。
 * @returns {any[]} 附带 enabled / availability 的视图。
 */
function withProfileState(treePackages, bundles) {
  const index = new Map()
  for (const bundle of bundles ?? []) index.set(bundle.name, bundle)
  return treePackages.map((item) => {
    const row = index.get(item.name)
    return {
      ...item,
      enabled: row?.enabled === true,
      availability: row?.availability ?? null,
      profileVersion: row?.version ?? null,
      rows: Array.isArray(row?.rows) ? row.rows.length : 0,
    }
  })
}

/**
 * 过滤搜索结果。
 * @param {any[]} items 候选。
 * @param {{ query?: string, kind?: string, onlyEnabled?: boolean }} options 条件。
 * @returns {any[]} 命中项。
 */
function filterItems(items, options) {
  const needle = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
  const kind = typeof options.kind === 'string' ? options.kind : undefined
  return items.filter((item) => {
    if (kind !== undefined && kind !== 'all' && item.kind !== kind) return false
    if (options.onlyEnabled === true && item.enabled !== true) return false
    if (needle.length === 0) return true
    const haystack = `${item.name} ${item.version ?? ''} ${item.description ?? ''}`.toLowerCase()
    return haystack.includes(needle)
  })
}

/**
 * 渲染一行包信息。
 * @param {any} item 包。
 * @returns {string} 单行描述。
 */
function formatItem(item) {
  const flags = [item.kind]
  if (item.enabled === true) flags.push('已启用')
  if (item.real === false) flags.push('非真实目录')
  if (item.link === true) flags.push('链接')
  const version = item.version === null ? '?' : String(item.version)
  const description = typeof item.description === 'string' && item.description.length > 0
    ? ` — ${item.description.slice(0, 110)}`
    : ''
  return `- ${item.name}@${version} [${flags.join('·')}]${description}`
}

/**
 * 极简的 tool 定义：把 author-facing 参数规格编译成 JSON Schema 并做前置校验。
 * 与 dsh-tools 的 defineTool 结构兼容（不引入 @deepseek-ai 依赖，避免遮蔽 CLI 内置 build）。
 * @param {{ name: string, description: string, parameters: Record<string, any>, output: any, execute: Function }} options 定义。
 * @returns {any} 工具对象。
 */
function defineTool(options) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(options.parameters)) {
    const { required: isRequired, ...value } = spec
    properties[key] = compileValue(value)
    if (isRequired === true) required.push(key)
  }
  const parameters = { type: 'object', properties }
  if (required.length > 0) parameters.required = required
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: {},
      render: (args, value) => options.output.render(args, value),
    },
    async execute(args, exec) {
      const violations = []
      for (const key of required) if (!(key in args)) violations.push(`${key} is required`)
      for (const [key, schema] of Object.entries(properties)) {
        if (!(key in args)) continue
        const value = args[key]
        if (schema.type === 'string' && typeof value !== 'string') violations.push(`${key} must be a string`)
        if (schema.type === 'boolean' && typeof value !== 'boolean') violations.push(`${key} must be a boolean`)
        if (schema.type === 'number' && typeof value !== 'number') violations.push(`${key} must be a number`)
        if (schema.type === 'array' && !Array.isArray(value)) violations.push(`${key} must be an array`)
        if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
          violations.push(`${key} must be one of ${schema.enum.join(', ')}`)
        }
      }
      if (violations.length > 0) throw new Error(`Error: invalid arguments: ${violations.join('; ')}`)
      return options.execute(args, exec)
    },
  }
}

/**
 * 把一个值规格编译成 JSON Schema 子集。
 * @param {any} spec 规格。
 * @returns {any} schema 节点。
 */
function compileValue(spec) {
  const node = {}
  if (typeof spec.description === 'string' && spec.description.length > 0) node.description = spec.description
  if (spec.type === undefined) return node
  if (spec.type === 'array') {
    node.type = 'array'
    if (spec.items !== undefined) node.items = compileValue(spec.items)
    return node
  }
  node.type = spec.type
  if (spec.enum !== undefined) node.enum = [...spec.enum]
  return node
}

/**
 * 计算 verify 的结构化结果。**工具与 HTTP 路由共用这一份**，两处结论因此不可能分叉。
 * @param {string} root 共享树根。
 * @returns {{ rows: Array<{tone: string, text: string}>, same: number, drifted: number, unrecorded: number, missing: string[], junction: any, healthy: boolean }} 结果。
 */
function computeVerify(root) {
  const manifest = readTreeManifest(root)
  const recorded = new Map()
  for (const item of Array.isArray(manifest.packages) ? manifest.packages : []) {
    if (typeof item?.name === 'string') recorded.set(item.name, item)
  }
  const onDisk = scanTree(root)
  const rows = []
  let same = 0
  let drifted = 0
  let unrecorded = 0
  for (const item of onDisk) {
    const record = recorded.get(item.name)
    if (record === undefined) {
      unrecorded += 1
      rows.push({ tone: 'unknown', text: `  ? ${item.name}@${item.version ?? '?'} 未登记（清单里没有）` })
      continue
    }
    if (record.version !== undefined && record.version !== item.version) {
      drifted += 1
      rows.push({ tone: 'drift', text: `  ✗ ${item.name} 版本漂移：清单 ${record.version} → 磁盘 ${item.version ?? '?'}` })
      continue
    }
    if (typeof record.sha256 !== 'string') {
      same += 1
      continue
    }
    const hashed = treeHash(join(root, item.name))
    if (hashed.truncated) {
      rows.push({ tone: 'partial', text: `  ~ ${item.name} 体积超过哈希预算，只比了版本` })
      same += 1
      continue
    }
    if (hashed.hash === record.sha256) same += 1
    else {
      drifted += 1
      rows.push({ tone: 'drift', text: `  ✗ ${item.name} 内容变化：${String(record.sha256).slice(0, 12)} → ${hashed.hash.slice(0, 12)}` })
    }
  }
  const missing = [...recorded.keys()].filter((item) => !onDisk.some((entry) => entry.name === item))
  for (const item of missing) rows.push({ tone: 'missing', text: `  - ${item} 清单有、磁盘没有` })
  const junction = junctionFacts(root)
  return {
    rows,
    same,
    drifted,
    unrecorded,
    missing,
    junction,
    healthy: drifted === 0 && missing.length === 0 && junction.junctions === junction.total,
  }
}

/**
 * 读一个包自带 bundle 补丁里插入的 entry id。
 *
 * 用途：有些包**不是独立可启用的 bundle**，而是另一个包（如 dsh-mnemon）已经插入过的组件。
 * 把这种包装成 profile bundle 启用，会让同一个 entry id 被两层插入 —— 正是 dsh-mnemon 补丁
 * 开头的警告：duplicates entry IDs and prevents Settings from saving (issue #470)。
 *
 * 解析用行级正则，读不到就返回空集合（fail-open：宁可漏拦，也不误拦合法启用）。
 * @param {string} packageDir 包目录。
 * @returns {Set<string>} 该包插入的 entry id 集合。
 */
function bundleEntryIds(packageDir) {
  const ids = new Set()
  const manifest = readManifest(packageDir)
  const declared = manifest?.dsh?.bundle
  if (declared === undefined || declared === null) return ids
  const relatives = []
  if (typeof declared === 'string') relatives.push(declared)
  else if (typeof declared.patch === 'string') relatives.push(declared.patch)
  for (const relative of relatives) {
    let text
    try {
      text = readFileSync(resolve(packageDir, relative), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue
      const match = /^\s*-\s+id:\s*([A-Za-z0-9@/._-]+)\s*$/.exec(line)
      if (match !== null) ids.add(match[1])
    }
  }
  return ids
}

/**
 * 当前 profile 已启用的 bundle 各自插入了哪些 entry id。
 * @param {string} root 共享树根。
 * @param {any[]|undefined} bundles pluginManager 的 bundle 清单。
 * @returns {Map<string, string>} entry id → 提供它的 bundle 包名。
 */
function enabledEntryIdIndex(root, bundles) {
  const index = new Map()
  for (const bundle of bundles ?? []) {
    if (bundle?.enabled !== true || typeof bundle.name !== 'string') continue
    const dir = join(root, bundle.name)
    if (!existsSync(dir)) continue
    for (const id of bundleEntryIds(dir)) {
      if (!index.has(id)) index.set(id, bundle.name)
    }
  }
  return index
}

/**
 * 判断一个包能否作为独立 profile bundle 启用。
 * 若它插入的 entry id 已由**另一个**已启用的 bundle 提供，则不能。
 * @param {string} name 包名。
 * @param {string} root 共享树根。
 * @param {Map<string, string>} enabledIndex 已启用 bundle 的 id 索引。
 * @returns {{conflictId: string, owner: string}|undefined} 冲突信息。
 */
function standaloneConflictOf(name, root, enabledIndex) {
  const dir = join(root, name)
  if (!existsSync(dir)) return undefined
  for (const id of bundleEntryIds(dir)) {
    const owner = enabledIndex.get(id)
    if (owner !== undefined && owner !== name) return { conflictId: id, owner }
  }
  return undefined
}

/**
 * 组装侧边栏要的树状态。
 *
 * 只输出**具备插件语义**的包：pnpm hoisted 提升进来的纯依赖库（d3 / mermaid / codemirror …）
 * 没有 dsh 清单、没有 enable 语义，不进列表也不计数，只报一个被过滤的条数。
 * 其中 entry id 已被别的**已启用** bundle 提供的那几个包（dsh-mnemon 的 strategy 组件）
 * 收进 `components`，挂在归属包之下，不再作为独立行出现。
 *
 * @param {string} root 共享树根。
 * @param {any[]|undefined} bundles 当前 profile 的 bundle 清单。
 * @returns {object} 状态快照。
 */
function buildStatusData(root, bundles) {
  const enabledIndex = enabledEntryIdIndex(root, bundles)
  const all = withProfileState(scanTree(root), bundles)
  const plugins = all.filter((item) => item.plugin === true)
  const libraries = all.length - plugins.length

  const annotated = plugins.map((item) => {
    const next = { ...item }
    if (SAFETY_NOTES[item.name] !== undefined) next.safetyNote = SAFETY_NOTES[item.name]
    if (item.hasBundle === true && item.enabled !== true) {
      const conflict = standaloneConflictOf(item.name, root, enabledIndex)
      if (conflict !== undefined) {
        next.standaloneConflict = conflict
        next.safetyNote = `这不是独立可启用的插件：它的 entry id「${conflict.conflictId}」已由已启用的 ${conflict.owner} 提供。` +
          '再作为 profile bundle 启用会让同一个 id 被两层插入，导致设置无法保存（issue #470）。它的开关在它所属插件的设置页里。'
      }
    }
    return next
  })

  const pluginNames = new Set(annotated.map((item) => item.name))
  const componentsByOwner = new Map()
  const topLevel = []
  for (const item of annotated) {
    const owner = item.standaloneConflict === undefined ? undefined : item.standaloneConflict.owner
    if (owner !== undefined && owner !== item.name && pluginNames.has(owner)) {
      const list = componentsByOwner.get(owner) ?? []
      list.push({
        name: item.name,
        version: item.version,
        kind: item.kind,
        description: item.description,
        conflictId: item.standaloneConflict.conflictId,
      })
      componentsByOwner.set(owner, list)
      continue
    }
    topLevel.push(item)
  }
  const packages = topLevel.map((item) => {
    const components = componentsByOwner.get(item.name)
    return components === undefined ? item : { ...item, components }
  })

  const junction = junctionFacts(root)
  const manifest = readTreeManifest(root)
  const each = packages

  // 只读旁路分区：**不**并入 packages，也**不**进上面四个计数。
  // 来源是 pluginManager.listBundles() 里 source 以 `link:` 开头的条目 —— 这些包物理上不在共享树里
  // （profile 本地 symlink 会遮蔽树内副本），所以不能算作共享树成员，只做只读标记。
  // 与 packages 重名的条目剔除，避免同一插件出现两次。
  const treeNames = new Set(packages.map((item) => item.name))
  const linked = (bundles ?? [])
    .filter((bundle) => typeof bundle?.source === 'string' && bundle.source.startsWith('link:'))
    .filter((bundle) => typeof bundle.name === 'string' && !treeNames.has(bundle.name))
    .map((bundle) => ({
      name: bundle.name,
      version: bundle.version ?? null,
      description: typeof bundle.description === 'string' ? bundle.description : '',
      enabled: bundle.enabled === true,
      availability: bundle.availability ?? null,
      source: bundle.source,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

  return {
    root,
    exists: existsSync(root),
    packages,
    counts: {
      // total 是**列表里实际的行数**（组件已收进归属包），与界面顶部显示的数字同步。
      total: each.length,
      plugins: plugins.length,
      components: plugins.length - each.length,
      bundle: each.filter((item) => item.hasBundle === true).length,
      clientOnly: each.filter((item) => item.hasBundle !== true && item.hasClient === true).length,
      enabled: each.filter((item) => item.enabled === true).length,
      libraries,
      // 只读分区的条数，单独一个键，不影响上面任何口径。
      linked: linked.length,
    },
    linked,
    junction: { total: junction.total, junctions: junction.junctions, healthy: junction.total > 0 && junction.junctions === junction.total },
    manifest: { entries: Array.isArray(manifest.packages) ? manifest.packages.length : 0, updated: manifest.updated ?? null },
    profileBundlesAvailable: bundles !== undefined,
  }
}

/**
 * 写一个 JSON 响应。
 * @param {any} res node ServerResponse。
 * @param {number} status HTTP 状态码。
 * @param {any} payload 可序列化内容。
 */
function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * 读一个有上限的 JSON 请求体。
 * @param {any} req node IncomingMessage。
 * @returns {Promise<any>} 解析结果；空体返回 {}。
 */
function readJsonBody(req) {
  return new Promise((settle, fail) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', fail)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        settle({})
        return
      }
      try {
        settle(JSON.parse(text))
      } catch {
        fail(new Error('request body is not valid JSON'))
      }
    })
  })
}

/**
 * 构造共享树的 HTTP handler。**只读 + 启用开关**：不做 install（装包要走工具或 CLI）。
 * @param {{ rootOf: () => string, getBundles: () => Promise<any[]|undefined>, getManager: () => any }} deps 依赖。
 * @returns {(req: any, res: any) => Promise<void>} handler。
 */
function createRouteHandler(deps) {
  return async (req, res) => {
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid URL' })
      return
    }
    const method = req.method ?? 'GET'
    try {
      if (method === 'GET' && pathname === `${ROUTE_PREFIX}/status`) {
        sendJson(res, 200, { ok: true, value: buildStatusData(deps.rootOf(), await deps.getBundles()) })
        return
      }
      if (method === 'GET' && pathname === `${ROUTE_PREFIX}/verify`) {
        const root = deps.rootOf()
        const result = computeVerify(root)
        sendJson(res, 200, {
          ok: true,
          value: {
            root,
            rows: result.rows,
            same: result.same,
            drifted: result.drifted,
            unrecorded: result.unrecorded,
            missing: result.missing,
            junction: { total: result.junction.total, junctions: result.junction.junctions },
            healthy: result.healthy,
          },
        })
        return
      }
      if (method === 'POST' && pathname === `${ROUTE_PREFIX}/set`) {
        const body = await readJsonBody(req)
        const enabled = body?.enabled
        if (typeof enabled !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'enabled must be a boolean' })
          return
        }
        const requested = Array.isArray(body?.target) ? body.target : [body?.target]
        const names = requested.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0)
        if (names.length === 0) {
          sendJson(res, 400, { ok: false, error: 'target is required' })
          return
        }
        const manager = deps.getManager()
        if (manager === undefined || typeof manager.setBundleEnabled !== 'function') {
          sendJson(res, 503, { ok: false, error: 'pluginManager is not available in this profile' })
          return
        }
        const root = deps.rootOf()
        const inTree = new Set(scanTree(root).map((item) => item.name))
        const enabledIndex = enabled ? enabledEntryIdIndex(root, await deps.getBundles()) : new Map()
        const results = []
        for (const name of names) {
          if (!inTree.has(name)) {
            results.push({ name, ok: false, error: 'not in the shared tree' })
            continue
          }
          if (enabled) {
            const conflict = standaloneConflictOf(name, root, enabledIndex)
            if (conflict !== undefined) {
              results.push({
                name, ok: false, application: null,
                error: `entry id「${conflict.conflictId}」already provided by ${conflict.owner}; enabling would duplicate entry IDs and break Settings (issue #470)`,
                safetyNote: `它的开关在 ${conflict.owner} 自己的设置页里，不要作为 profile bundle 启用。`,
              })
              continue
            }
          }
          try {
            const outcome = await manager.setBundleEnabled(name, enabled)
            const application = outcome?.application ?? null
            const failed = outcome?.error !== undefined && outcome?.error !== null
            results.push({
              name,
              // ok = 调用本身成功（没有 error）。语义上的结果看 application：
              // applied 已生效 / restart-required 待重启 / overridden 被更高优先级层覆盖 /
              // cancelled 已取消并还原。界面按 application 给不同措辞，不能一律报"失败"。
              ok: !failed,
              application,
              nextStep: outcome?.nextStep ?? null,
              error: failed ? (outcome.error.code ?? 'failed') : null,
              restartRequired: application === 'restart-required',
              safetyNote: SAFETY_NOTES[name] ?? null,
            })
          } catch (error) {
            results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }
        sendJson(res, 200, { ok: true, value: { enabled, results, status: buildStatusData(root, await deps.getBundles()) } })
        return
      }
      sendJson(res, 404, { ok: false, error: `no route for ${method} ${pathname}` })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * 挂载插件。
 * @param {any} ctx cordis 上下文。
 * @param {any} config 行配置。
 */
function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const configuredRoot = typeof settings.treeRoot === 'string' && settings.treeRoot.length > 0 ? resolve(settings.treeRoot) : undefined
  const buildDir = typeof settings.buildDir === 'string' && settings.buildDir.length > 0
    ? resolve(settings.buildDir)
    : dshHomePath('cache', 'shared-tree-build')
  const registry = typeof settings.registry === 'string' && settings.registry.length > 0 ? settings.registry : undefined
  const timeoutMs = typeof settings.timeoutMs === 'number' && settings.timeoutMs > 0 ? settings.timeoutMs : 300_000

  /** 当前共享树根。 */
  const rootOf = () => configuredRoot ?? treeRootOf()

  ctx.tools.register(defineTool({
    name: 'shared_tree',
    description: '管理跨 profile 共享插件树（<DSH_HOME>/profiles/node_modules）。status 查看树的包与 junction 健康；search 搜索树里的包；enable/disable 决定当前 profile 是否启用树里的某个 bundle；install 把 npm 包装进共享树（临时目录 hoisted 构建，只合并顶层包目录，绝不动 @deepseek-ai 的 junction）；verify 复核每个包的树哈希。共享树被所有 profile 复用，改动会影响其他 profile，所以先 search 再决定。',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'search', 'enable', 'disable', 'install', 'verify'], description: '操作类型。' },
      query: { type: 'string', description: 'search：按包名/描述关键字过滤（不区分大小写）。' },
      kind: { type: 'string', enum: ['all', 'bundle', 'client', 'library'], description: 'search：按类型过滤。bundle 可作 profile bundle 加载，client 仅浏览器侧，library 是依赖库。' },
      onlyEnabled: { type: 'boolean', description: 'search：只看当前 profile 已启用的包。' },
      target: { type: 'string', description: 'enable/disable：目标包名，或用逗号分隔多个包名。' },
      packages: { type: 'array', items: { type: 'string' }, description: 'install：要装进共享树的包名或 name@version 列表。' },
      replace: { type: 'boolean', description: 'install：目标包已存在时是否覆盖（默认 false，只跳过）。' },
      limit: { type: 'number', description: 'search：最多返回多少条（默认 40）。' },
    },
    output: {
      schema: {},
      render: (args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const root = rootOf()
      const bundles = await profileBundles(ctx)
      const manager = ctx.get('pluginManager')

      if (args.action === 'status') {
        const packages = scanTree(root)
        const junction = junctionFacts(root)
        const manifest = readTreeManifest(root)
        const view = withProfileState(packages, bundles)
        const bundlesInTree = view.filter((item) => item.kind === 'bundle')
        const pluginCount = view.filter((item) => item.plugin === true).length
        const clientOnlyCount = view.filter((item) => item.hasBundle !== true && item.hasClient === true).length
        const lines = [
          `共享树：${root}`,
          `存在：${existsSync(root) ? '是' : '否（尚未创建）'}`,
          `顶层包：${packages.length} 个（插件 ${pluginCount}：bundle ${bundlesInTree.length} / 仅 client ${clientOnlyCount}；纯依赖库 ${packages.length - pluginCount}）`,
          `@deepseek-ai junction：${junction.junctions}/${junction.total}${junction.junctions === junction.total && junction.total > 0 ? '（完好）' : '（异常，请检查）'}`,
          `清单：${Array.isArray(manifest.packages) ? manifest.packages.length : 0} 条${manifest.updated === undefined ? '' : `，更新于 ${manifest.updated}`}`,
          `当前 profile 的 bundle 清单：${bundles === undefined ? '不可用（pluginManager 服务未挂载）' : `${bundles.length} 条`}`,
        ]
        const enabledHere = view.filter((item) => item.enabled === true)
        if (enabledHere.length > 0) {
          lines.push('', `本 profile 已启用的共享包（${enabledHere.length}）：`)
          for (const item of enabledHere) lines.push(formatItem(item))
        }
        if (bundlesInTree.length > 0) {
          // 把"已由别的已启用 bundle 提供 entry id"的组件标出来，避免在 CLI 里被当成可独立启用的插件。
          const enabledIndex = enabledEntryIdIndex(root, bundles)
          lines.push('', `树里可启用的 bundle（${bundlesInTree.length}）：`)
          for (const item of bundlesInTree) {
            const conflict = standaloneConflictOf(item.name, root, enabledIndex)
            lines.push(conflict === undefined
              ? formatItem(item)
              : `${formatItem(item)} · 组件（归属 ${conflict.owner}，勿单独启用，否则重复 entry id → issue #470）`)
          }
        }
        return lines.join('\n')
      }

      if (args.action === 'search') {
        const packages = withProfileState(scanTree(root), bundles)
        const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 40
        const hits = filterItems(packages, args)
        if (hits.length === 0) return `共享树里没有匹配的包（共 ${packages.length} 个）。可用 shared_tree status 查看全部。`
        const lines = [`命中 ${hits.length} 个${hits.length > limit ? `，显示前 ${limit} 个` : ''}：`]
        for (const item of hits.slice(0, limit)) lines.push(formatItem(item))
        const notInProfile = hits.filter((item) => item.kind === 'bundle' && item.enabled !== true)
        if (notInProfile.length > 0) {
          lines.push('', `其中未在本 profile 启用的 bundle（${notInProfile.length}）：${notInProfile.map((item) => item.name).join('、')}`)
          lines.push('用 shared_tree action=enable target=<包名> 启用。')
        }
        return lines.join('\n')
      }

      if (args.action === 'enable' || args.action === 'disable') {
        const wanted = String(args.target ?? '').split(',').map((item) => item.trim()).filter((item) => item.length > 0)
        if (wanted.length === 0) throw new Error('target is required: pass a package name, or several separated by commas')
        if (manager === undefined || typeof manager.setBundleEnabled !== 'function') {
          return `pluginManager 服务不可用，无法修改 profile 的 bundle 选择。请手工在该 profile 的 package.json 里编辑 dsh.profile.bundles。`
        }
        const enable = args.action === 'enable'
        const inTree = new Set(scanTree(root).map((item) => item.name))
        const problems = []
        if (enable) {
          // 拦住"把别人的组件当独立 bundle 启用"——会重复插入 entry id（issue #470）。
          const enabledIndex = enabledEntryIdIndex(root, bundles)
          for (const packageName of wanted) {
            const conflict = standaloneConflictOf(packageName, root, enabledIndex)
            if (conflict !== undefined) {
              problems.push(`${packageName}：它的 entry id「${conflict.conflictId}」已由已启用的 ${conflict.owner} 提供，` +
                '再启用会让同一个 id 被两层插入并导致设置无法保存（issue #470）。请改用该插件自己的设置页切换。')
            }
          }
        }
        for (const packageName of wanted) {
          if (!inTree.has(packageName)) problems.push(`${packageName}：共享树里没有这个包（先 install，或检查包名）`)
        }
        if (problems.length > 0) return ['未执行任何改动：', ...problems.map((item) => `- ${item}`)].join('\n')
        const results = []
        for (const packageName of wanted) {
          try {
            const outcome = await manager.setBundleEnabled(packageName, enable)
            const lines = [`- ${packageName}：${describeApplication(outcome.application)}`]
            if (outcome.nextStep !== undefined) lines.push(`  ${outcome.nextStep}`)
            if (outcome.error !== undefined && outcome.error.code !== undefined) lines.push(`  错误：${outcome.error.code}`)
            if (enable && SAFETY_NOTES[packageName] !== undefined) lines.push(`  ⚠ ${SAFETY_NOTES[packageName]}`)
            results.push(lines.join('\n'))
          } catch (error) {
            results.push(`- ${packageName}：失败（${error instanceof Error ? error.message : String(error)}）`)
          }
        }
        return [`共享树 ${root}`, `动作：${enable ? '启用' : '禁用'}`, ...results].join('\n')
      }

      if (args.action === 'install') {
        const specs = Array.isArray(args.packages) ? args.packages.map((item) => String(item).trim()) : []
        if (specs.length === 0) throw new Error('packages is required for install')
        const invalid = specs.filter((item) => !SAFE_SPEC.test(item))
        if (invalid.length > 0) return `包名不合法，未执行：${invalid.join(', ')}。只接受 npm 包名或 name@version。`
        const replace = args.replace === true
        mkdirSync(buildDir, { recursive: true })
        const dependencies = {}
        for (const spec of specs) {
          const at = spec.lastIndexOf('@')
          if (at > 0) dependencies[spec.slice(0, at)] = spec.slice(at + 1)
          else dependencies[spec] = 'latest'
        }
        writeFileSync(join(buildDir, 'package.json'), `${JSON.stringify({
          name: 'dsh-shared-tree-build', private: true, version: '0.0.0', dependencies,
        }, null, 2)}\n`, 'utf8')
        writeFileSync(join(buildDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')
        const installed = await runPnpm(['install', '--no-frozen-lockfile'], buildDir, timeoutMs, registry)
        if (installed.code !== 0) {
          return [`pnpm install 失败（exit ${installed.code}），共享树未改动。`, '', installed.output.slice(-2500)].join('\n')
        }
        const buildRoot = join(buildDir, 'node_modules')
        const roots = Object.keys(dependencies)
        const closure = dependencyClosure(buildRoot, roots)
        if (closure.closure.length === 0) {
          return ['构建产物里找不到请求的包，共享树未改动。', '', installed.output.slice(-1500)].join('\n')
        }
        const merged = mergeIntoTree(buildRoot, root, closure.closure, replace)
        const registered = merged.copied.concat(merged.replaced).map((packageName) => {
          const manifest = readManifest(join(root, packageName))
          const hashed = treeHash(join(root, packageName))
          return {
            name: manifest?.name ?? packageName,
            version: manifest?.version ?? null,
            kind: kindOf(manifest),
            sha256: hashed.hash,
            files: hashed.files,
            bytes: hashed.bytes,
            truncated: hashed.truncated,
          }
        })
        const total = mergeTreeManifest(root, registered, buildDir)
        const junction = junctionFacts(root)
        const lines = [
          `共享树：${root}`,
          `请求：${specs.join('、')}`,
          `依赖闭包：${closure.closure.length} 个（${closure.closure.join('、')}）`,
        ]
        if (closure.skippedProtected.length > 0) {
          lines.push(`由 @deepseek-ai junction 提供、未复制：${closure.skippedProtected.join('、')}`)
        }
        if (closure.missing.length > 0) lines.push(`构建产物里缺失：${closure.missing.join('、')}`)
        lines.push(`写入：${merged.copied.length} 个${merged.replaced.length > 0 ? `，覆盖：${merged.replaced.join('、')}` : ''}`)
        for (const item of registered) {
          lines.push(`  + ${item.name}@${item.version ?? '?'} [${item.kind}] ${item.files} 文件 ${item.bytes} B sha256=${String(item.sha256).slice(0, 16)}`)
        }
        if (merged.skipped.length > 0) lines.push(`跳过：${merged.skipped.join('；')}`)
        lines.push(`@deepseek-ai junction：${junction.junctions}/${junction.total}${junction.junctions === junction.total ? '（完好）' : '（异常）'}`)
        lines.push(`清单已更新：${total} 条`)
        const bundlesInstalled = registered.filter((item) => item.kind === 'bundle')
        if (bundlesInstalled.length > 0) {
          lines.push('', `下一步：用 shared_tree action=enable target=${bundlesInstalled[0].name} 让本 profile 启用。`)
        }
        return lines.join('\n')
      }

      if (args.action === 'verify') {
        const result = computeVerify(root)
        const lines = [`校验共享树：${root}`, ...result.rows.map((row) => row.text)]
        lines.push('', `一致 ${result.same}，漂移 ${result.drifted}，未登记 ${result.unrecorded}，缺失 ${result.missing.length}`)
        lines.push(`@deepseek-ai junction：${result.junction.junctions}/${result.junction.total}${result.junction.junctions === result.junction.total && result.junction.total > 0 ? '（完好）' : '（异常）'}`)
        if (result.drifted === 0 && result.missing.length === 0 && result.junction.junctions === result.junction.total) lines.push('结论：共享树完好。')
        else lines.push('结论：有差异，见上。升级包后请重跑 install 以刷新清单。')
        return lines.join('\n')
      }

      throw new Error(`unknown action: ${args.action}`)
    },
  }), 'dsh-shared-tree: tool')

  // 侧边栏 / 面板 用的 HTTP 路由。webServer 是可选的：没有它（例如非 Web 形态的宿主）
  // 只跳过界面数据通道，shared_tree 工具照常工作。
  ctx.inject(['webServer'], (webCtx) => {
    const handler = createRouteHandler({
      rootOf,
      getBundles: () => profileBundles(ctx),
      getManager: () => ctx.get('pluginManager'),
    })
    return webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
  })
}

/**
 * 把 ChangeResult.application 翻成人话。
 * @param {string|undefined} application 应用结果。
 * @returns {string} 描述。
 */
function describeApplication(application) {
  switch (application) {
    case 'applied': return '已生效'
    case 'cancelled': return '已取消，文件已还原'
    case 'overridden': return '已保存，但被更高优先级层（如 agent preset）覆盖，当前不生效'
    case 'restart-required': return '已保存，需重启 DSH 才生效'
    case 'failed': return '失败'
    default: return `未知结果（${String(application)}）`
  }
}

export { apply, inject, name }