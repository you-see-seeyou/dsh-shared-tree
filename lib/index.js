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
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { captureProfileFiles, destroyTree, ensureTreeDir, lifecycleStatus, recordChange, recordProfileFileChanges, restoreBaseline, restoreFromLedger, snapshotBaseline } from './lifecycle.js'

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
/** 升级历史文件名（与清单同目录）。 */
const HISTORY_FILE = '.dsh-shared-tree-history.json'
/** 覆盖升级前旧版本目录的归档根：<DSH_HOME>/cache/shared-tree-backup。 */
const BACKUP_SUBPATH = ['cache', 'shared-tree-backup']
/** 合法版本号形态（用于 rollback 入参校验）。 */
const SAFE_VERSION = /^[\w.+-]+$/
/** 每个阶段的人类可读名（路由与界面共用同一套顺序）。 */
const INSTALL_STAGES = ['prepare', 'build', 'merge', 'verify']

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
 * 查当前 profile 的 bundle 清单（来自 pluginManager）。
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
 * 当前正在运行的 profile 名（目录名）。
 *
 * 优先 `profileContext`（app-boot 注入的 profile 描述），退回 pluginManager 自己的 profile 字段；
 * 都拿不到返回 undefined —— 调用方据此报"无法确定当前 profile"，绝不去猜别的 profile。
 * @param {any} ctx cordis 上下文。
 * @returns {string|undefined} profile 目录名。
 */
function currentProfileName(ctx) {
  try {
    const direct = ctx.get('profileContext')
    if (typeof direct?.dir === 'string' && direct.dir.length > 0) return basename(direct.dir)
  } catch {
    // 忽略：退回 pluginManager。
  }
  try {
    const manager = ctx.get('pluginManager')
    const dir = manager?.profile?.dir
    if (typeof dir === 'string' && dir.length > 0) return basename(dir)
  } catch {
    // 忽略：拿不到就是 undefined。
  }
  return undefined
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

// ── 升级 UI 支撑：影响面 / 依赖检查 / 历史 / 归档 / 任务化安装 ─────────────────

/**
 * profiles 根目录：默认布局下是共享树根的上一级（<home>/profiles）。
 * @param {string} root 共享树根。
 * @returns {string} profiles 目录绝对路径。
 */
function profilesDirOf(root) {
  return dirname(root)
}

/**
 * 列出所有 profile（profiles/ 下带 package.json 的目录，跳过 node_modules 与隐藏目录）。
 * @param {string} root 共享树根。
 * @returns {Array<{name: string, dir: string, manifest: any}>} profile 列表。
 */
function listProfiles(root) {
  const dir = profilesDirOf(root)
  const found = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    const manifest = readManifest(full)
    if (manifest === undefined) continue
    found.push({ name: entry.name, dir: full, manifest })
  }
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 计算一个包的引用影响面：哪些 profile 在 dsh.profile.bundles 里引用了它、
 * 各自解析到的版本（本地 node_modules 优先，否则走共享树）。
 * @param {string} root 共享树根。
 * @param {string} packageName 包名。
 * @param {string|null} treeVersion 共享树里当前的版本。
 * @returns {{ profiles: Array<object>, treeVersion: string|null }} 影响面。
 */
function profileImpact(root, packageName, treeVersion) {
  const profiles = []
  for (const profile of listProfiles(root)) {
    const declared = profile.manifest?.dsh?.profile?.bundles
    const entries = Array.isArray(declared)
      ? declared.filter((item) => typeof item === 'string')
      : []
    const hit = entries.find((entry) => entry === packageName || entry.startsWith(`${packageName}/`))
    let localVersion = null
    try {
      localVersion = readManifest(join(profile.dir, 'node_modules', packageName))?.version ?? null
    } catch {
      localVersion = null
    }
    profiles.push({
      profile: profile.name,
      bundleEntry: hit ?? null,
      referenced: hit !== undefined,
      enabled: hit !== undefined,
      version: localVersion ?? (hit !== undefined ? treeVersion : null),
      via: localVersion !== null ? 'local' : hit !== undefined ? 'shared-tree' : null,
    })
  }
  return { profiles, treeVersion }
}

/**
 * 读升级历史。
 * @param {string} root 共享树根。
 * @returns {{ scheme: string, packages: Array<object> }} 历史。
 */
function readHistory(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, HISTORY_FILE), 'utf8'))
    if (raw !== null && typeof raw === 'object' && Array.isArray(raw.packages)) return raw
  } catch {
    // 缺失或损坏按空历史处理。
  }
  return { scheme: 'dsh-shared-tree-history/1', packages: [] }
}

/**
 * 追加一条升级历史。
 * @param {string} root 共享树根。
 * @param {{name: string, from: string|null, to: string|null, kind: string, archivedPath: string|null}} entry 条目。
 * @returns {number} 历史条目总数。
 */
function appendHistory(root, entry) {
  const history = readHistory(root)
  history.scheme = 'dsh-shared-tree-history/1'
  history.updated = new Date().toISOString()
  history.packages = [{ ...entry, at: history.updated }, ...(Array.isArray(history.packages) ? history.packages : [])].slice(0, 200)
  writeFileSync(join(root, HISTORY_FILE), `${JSON.stringify(history, null, 2)}\n`, 'utf8')
  return history.packages.length
}

/**
 * 查某个包的历史版本（有 archivedPath 归档的排前面，可作回滚目标）。
 * @param {string} root 共享树根。
 * @param {string} packageName 包名。
 * @returns {Array<{version: string, at: string, kind: string, archivedPath: string|null}>} 版本列表（新→旧）。
 */
function historyOf(root, packageName) {
  const rows = []
  for (const item of readHistory(root).packages) {
    if (item?.name !== packageName) continue
    if (typeof item.to !== 'string' || item.to.length === 0) continue
    rows.push({ version: item.to, at: item.at ?? '', kind: item.kind ?? 'upgrade', archivedPath: typeof item.archivedPath === 'string' ? item.archivedPath : null })
  }
  return rows
}

/**
 * 覆盖前把旧版本目录归档到 <home>/cache/shared-tree-backup/<pkg>@<ver>。
 * @param {string} root 共享树根。
 * @param {string} packageName 包名。
 * @returns {{ path: string, version: string }|null} 归档结果；没有旧版本时 null。
 */
function archiveOldVersion(root, packageName) {
  const from = join(root, packageName)
  if (!existsSync(from)) return null
  const oldManifest = readManifest(from)
  const version = typeof oldManifest?.version === 'string' && oldManifest.version.length > 0 ? oldManifest.version : 'unknown'
  const to = join(dshHomePath(...BACKUP_SUBPATH), `${packageName}@${version}`)
  try {
    mkdirSync(dirname(to), { recursive: true })
    if (existsSync(to)) rmSync(to, { recursive: true, force: true })
    cpSync(from, to, { recursive: true, force: true, dereference: false })
    return { path: to, version }
  } catch {
    return null
  }
}

/**
 * 极简 semver 范围判断：支持 ^x.y.z / ~x.y.z / >=x.y.z / 精确版本 / *。
 * 只用于 engines 检查的展示结论，不是完整 semver 实现（||、x-range 等按不满足处理）。
 * @param {string} version 实际版本。
 * @param {string} range 范围表达式。
 * @returns {boolean|null} 是否满足；表达式不认识时 null。
 */
function satisfiesRange(version, range) {
  const text = String(range).trim()
  if (text === '' || text === '*' || text === 'latest' || text === 'x') return true
  const parse = (value) => {
    const parts = String(value).replace(/^[v=\s]+/, '').split('.')
    const numbers = parts.map((part) => Number.parseInt(part, 10))
    if (numbers.some((part) => !Number.isFinite(part))) return null
    return numbers
  }
  const actual = parse(version)
  if (actual === null || actual.length < 2) return null
  const compare = (left, right) => {
    for (let index = 0; index < 3; index += 1) {
      const a = left[index] ?? 0
      const b = right[index] ?? 0
      if (a !== b) return a - b
    }
    return 0
  }
  const operatorMatch = /^(>=|<=|>|<|\^|~)?\s*(.+)$/.exec(text)
  if (operatorMatch === null) return null
  const operator = operatorMatch[1] ?? ''
  const bound = parse(operatorMatch[2])
  if (bound === null || bound.length < 1) return null
  const order = compare(actual, bound)
  switch (operator) {
    case '>=': return order >= 0
    case '>': return order > 0
    case '<=': return order <= 0
    case '<': return order < 0
    case '^': {
      // ^x.y.z：同主版本（主版本为 0 时同次版本）。
      if (actual[0] !== bound[0]) return false
      if (bound[0] === 0) {
        if ((actual[1] ?? 0) !== (bound[1] ?? 0)) return false
        return compare(actual, bound) >= 0
      }
      return order >= 0
    }
    case '~': {
      if (actual[0] !== bound[0] || (actual[1] ?? 0) !== (bound[1] ?? 0)) return false
      return order >= 0
    }
    default: return actual[0] === bound[0] && (actual[1] ?? 0) === (bound[1] ?? 0)
  }
}

/**
 * 当前 DSH 版本（尽力而为）：环境变量优先，读不到就 null（界面按"未知"展示，不拦截）。
 * @returns {string|null} 版本号。
 */
function currentDshVersion() {
  const fromEnv = process.env.DSH_VERSION
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return null
}

/**
 * 组装一个候选版本的依赖检查（engines.node / engines.dsh / peerDependencies）。
 * 纯本地计算：manifest 由调用方给（来自 registry 元数据）。
 * @param {string} packageName 包名。
 * @param {string} targetVersion 候选版本。
 * @param {any} manifest registry 返回的 manifest（peerDependencies/engines）。
 * @param {string} root 共享树根（peer 是否已在树里）。
 * @returns {{ available: boolean, checks: Array<object>, ok: boolean }} 检查清单。
 */
function buildDependencyChecks(packageName, targetVersion, manifest, root) {
  const checks = []
  const engines = manifest?.engines ?? {}
  if (typeof engines.node === 'string' && engines.node.length > 0) {
    const installed = process.versions?.node ?? null
    const ok = installed !== null ? satisfiesRange(installed, engines.node) : null
    checks.push({ kind: 'node', name: 'node', required: engines.node, installed, ok })
  }
  if (typeof engines.dsh === 'string' && engines.dsh.length > 0) {
    const installed = currentDshVersion()
    const ok = installed !== null ? satisfiesRange(installed, engines.dsh) : null
    checks.push({ kind: 'dsh', name: 'dsh', required: engines.dsh, installed, ok })
  }
  const peers = manifest?.peerDependencies ?? {}
  for (const [peer, range] of Object.entries(peers)) {
    const localManifest = readManifest(join(root, peer))
    const installed = typeof localManifest?.version === 'string' ? localManifest.version : null
    const ok = installed !== null ? satisfiesRange(installed, String(range)) : false
    checks.push({ kind: 'peer', name: peer, required: String(range), installed, ok })
  }
  return { available: true, checks, ok: checks.every((item) => item.ok !== false) }
}

/**
 * 用 pnpm view 查 registry：name 的最新版本，或 name@version 的 manifest。
 * @param {string} spec 查询规格。
 * @param {{ buildDir: string, registry?: string, timeoutMs: number }} settings 安装设置。
 * @returns {Promise<any>} 解析后的 JSON；失败时 undefined。
 */
async function pnpmView(spec, settings) {
  const outcome = await runPnpm(['view', spec, '--json'], settings.buildDir, Math.min(settings.timeoutMs, 60_000), settings.registry)
  if (outcome.code !== 0) return undefined
  const text = outcome.output.trim()
  // pnpm 可能混入非 JSON 前缀行，取最后一行起的完整 JSON。
  const start = text.lastIndexOf('{') >= text.lastIndexOf('[') ? text.lastIndexOf('{') : text.lastIndexOf('[')
  if (start < 0) return undefined
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return undefined
  }
}

/**
 * 任务化的安装流程（UI 的 升级/回滚 共用）：prepare → build → merge → verify。
 * 与工具的 install 分支同源（同一批底层函数），但带阶段回调并总是覆盖、归档、记历史。
 * @param {{ specs: string[], replace: boolean, kind: string, root: string, buildDir: string, registry?: string, timeoutMs: number }} options 参数。
 * @param {(stage: string, detail: string) => void} onStage 阶段回调。
 * @returns {Promise<object>} 结构化结果。
 */
async function performInstall(options, onStage) {
  const { specs, replace, kind, root, buildDir, registry, timeoutMs } = options
  const invalid = specs.filter((item) => !SAFE_SPEC.test(item))
  if (invalid.length > 0) {
    return { ok: false, stage: 'prepare', error: `包名不合法：${invalid.join(', ')}` }
  }
  onStage('prepare', specs.join('、'))
  const dependencies = {}
  for (const spec of specs) {
    const at = spec.lastIndexOf('@')
    if (at > 0) dependencies[spec.slice(0, at)] = spec.slice(at + 1)
    else dependencies[spec] = 'latest'
  }
  mkdirSync(buildDir, { recursive: true })
  writeFileSync(join(buildDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-shared-tree-build', private: true, version: '0.0.0', dependencies,
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(buildDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')

  onStage('build', Object.keys(dependencies).join('、'))
  const installed = await runPnpm(['install', '--no-frozen-lockfile'], buildDir, timeoutMs, registry)
  if (installed.code !== 0) {
    return { ok: false, stage: 'build', error: `pnpm install 失败（exit ${installed.code}）`, output: installed.output.slice(-2500) }
  }
  const buildRoot = join(buildDir, 'node_modules')
  const closure = dependencyClosure(buildRoot, Object.keys(dependencies))
  if (closure.closure.length === 0) {
    return { ok: false, stage: 'build', error: '构建产物里找不到请求的包', output: installed.output.slice(-1500) }
  }

  onStage('merge', `${closure.closure.length} 个包`)
  const archives = {}
  const previousVersions = {}
  if (replace) {
    for (const packageName of closure.closure) {
      if (existsSync(join(root, packageName))) {
        const archived = archiveOldVersion(root, packageName)
        if (archived !== null) {
          archives[packageName] = archived.path
          previousVersions[packageName] = archived.version
        }
      }
    }
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
  if (registered.length > 0) mergeTreeManifest(root, registered, buildDir)
  for (const item of registered) {
    appendHistory(root, {
      name: item.name,
      from: previousVersions[item.name] ?? null,
      to: item.version,
      kind,
      archivedPath: archives[item.name] ?? null,
    })
  }

  onStage('verify', '')
  const verification = computeVerify(root)
  return {
    ok: merged.copied.length > 0,
    stage: 'verify',
    specs,
    closure,
    merged,
    registered,
    verify: { same: verification.same, drifted: verification.drifted, unrecorded: verification.unrecorded, missing: verification.missing, healthy: verification.healthy },
    error: merged.copied.length === 0 ? '没有包被写入共享树' : null,
  }
}

// ── 逐插件详情/调试：entry 清单 + profile 覆盖层开关 ─────────────────────────

/**
 * 解析一个 cordis.patch.yml 文本里的 loader 条目（行级，容错优先）。
 * 支持两种形态：块式 `- id: X` + 缩进子键，行内 `- { id: X, disabled: true }`。
 * 只统计**顶层**条目（`-` 在第 0 列）；嵌套在 insert: 下的条目是「插件提供功能」的声明，
 * 也一并收集（flag declared=true），顶层条目是「用户覆盖」的声明（declared=false）。
 * @param {string} text patch 文件文本。
 * @returns {Array<{id: string, name: string|null, disabled: boolean, configKeys: string[], inline: boolean, topLevel: boolean}>} 条目。
 */
function parsePatchEntries(text) {
  const entries = []
  if (typeof text !== 'string') return entries
  const lines = text.split(/\r?\n/)
  /** 当前块式条目与它 `-` 的列位置、config 子块深度。 */
  let current = null
  let dashCol = -1
  let configDepth = -1
  const strip = (value) => String(value).trim().replace(/^['"]|['"]$/g, '')
  /** 行内 map：抓 id / name / disabled 与其余键名。 */
  const collectInline = (raw, topLevel) => {
    const fields = {}
    for (const match of raw.matchAll(/([\w.-]+)\s*:\s*([^,}]+)/g)) fields[match[1]] = strip(match[2])
    if (fields.id === undefined) return
    entries.push({
      id: fields.id,
      name: fields.name ?? null,
      disabled: fields.disabled === 'true',
      configKeys: Object.keys(fields).filter((key) => !['id', 'name', 'disabled', 'insert'].includes(key)),
      inline: true,
      topLevel,
    })
  }
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim().length === 0) {
      continue
    }
    const inline = /^(\s*)-\s*\{(.+)\}\s*$/.exec(line)
    if (inline !== null) {
      collectInline(inline[2], inline[1].length === 0)
      current = null
      configDepth = -1
      continue
    }
    const item = /^(\s*)-\s+(.+)$/.exec(line)
    if (item !== null) {
      const col = item[1].length
      const kv = /^([\w.-]+)\s*:\s*(.*)$/.exec(item[2])
      if (kv !== null && kv[1] === 'id') {
        current = { id: strip(kv[2]), name: null, disabled: false, configKeys: [], inline: false, topLevel: col === 0 }
        entries.push(current)
        dashCol = col
        configDepth = -1
      } else {
        current = null
        configDepth = -1
      }
      continue
    }
    const key = /^(\s+)([\w.-]+)\s*:\s*(.*)$/.exec(line)
    if (key === null || current === null || current.inline) continue
    const col = key[1].length
    if (col <= dashCol) continue
    if (configDepth >= 0) {
      if (col > configDepth) { current.configKeys.push(key[2]); continue }
      configDepth = -1
    }
    if (key[2] === 'name') current.name = strip(key[3])
    else if (key[2] === 'disabled') current.disabled = key[3].trim() === 'true'
    else if (key[2] === 'config') configDepth = col
    else current.configKeys.push(key[2])
  }
  return entries
}

/**
 * 读共享树里某个包的补丁文本与解析出的功能项（insert 条目 = 该插件提供的功能）。
 * @param {string} root 共享树根。
 * @param {string} packageName 包名。
 * @returns {{ found: boolean, version: string|null, patchText: string, entries: Array<object>, error?: string }} 结果。
 */
function packageEntries(root, packageName) {
  const dir = join(root, packageName)
  const manifest = readManifest(dir)
  const declared = manifest?.dsh?.bundle
  const relatives = []
  if (typeof declared === 'string') relatives.push(declared)
  else if (typeof declared?.patch === 'string') relatives.push(declared.patch)
  let patchText = ''
  let error
  if (relatives.length === 0) {
    error = '该包没有声明 dsh.bundle.patch，没有可列的功能项'
  } else {
    try {
      patchText = readFileSync(resolve(dir, relatives[0]), 'utf8')
    } catch (failure) {
      error = `补丁文件读不到：${failure instanceof Error ? failure.message : String(failure)}`
    }
  }
  const entries = parsePatchEntries(patchText).filter((entry) => entry.topLevel === false)
  return {
    found: existsSync(dir),
    version: manifest?.version ?? null,
    patchText,
    entries,
    ...(error !== undefined ? { error } : {}),
  }
}

/**
 * 把「某 profile 对某 entry 的覆盖」写进该 profile 自己的 cordis.patch.yml。
 * 规则：禁用/改参数 = 重建该 entry 的**顶层覆盖块**（幂等，不依赖旧块形态）；
 * 启用（disabled=false 且无 config）= 删除覆盖块（让 bundle 自己的补丁生效）。
 * 改前备份为 cordis.patch.yml.bak-shared-tree（覆盖式）。
 * @param {string} root 共享树根。
 * @param {string} profileName profile 目录名。
 * @param {string} entryId entry id。
 * @param {{ disabled?: boolean, config?: object }} patch 覆盖内容。
 * @returns {{ ok: boolean, error?: string, backupPath?: string, note?: string }} 结果。
 */
function setProfileEntryOverride(root, profileName, entryId, patch) {
  const profile = listProfiles(root).find((item) => item.name === profileName)
  if (profile === undefined) return { ok: false, error: `profile「${profileName}」不存在` }
  if (!/^[\w@/.:-]+$/.test(entryId)) return { ok: false, error: 'entry id 不合法' }
  const disable = patch?.disabled === true
  const config = patch?.config
  if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config))) {
    return { ok: false, error: 'config 必须是对象' }
  }
  const file = join(profile.dir, 'cordis.patch.yml')
  const backupPath = `${file}.bak-shared-tree`
  const patchExists = existsSync(file)
  let text = ''
  let beforeText = null
  try {
    if (patchExists) {
      text = readFileSync(file, 'utf8')
      beforeText = text
      copyFileSync(file, backupPath)
    }
  } catch (failure) {
    return { ok: false, error: `读/备份失败：${failure instanceof Error ? failure.message : String(failure)}` }
  }
  const lines = text.split(/\r?\n/)
  /** 找到该 entryId 的顶层覆盖块：`- id: X`（第 0 列）或行内 `- { id: X, ... }`。 */
  let startIndex = -1
  let inlineBlock = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*#/.test(line)) continue
    const inline = /^-\s*\{(.+)\}\s*$/.exec(line)
    if (inline !== null && /(^|[\s{])id\s*:\s*['"]?[\w@/.:-]*/.test(inline[1])) {
      const idMatch = /(?:^|[{,\s])id\s*:\s*['"]?([\w@/.:-]+)/.exec(inline[1])
      if (idMatch !== null && idMatch[1] === entryId) {
        startIndex = index
        inlineBlock = true
        break
      }
    }
    const block = /^-\s+id\s*:\s*['"]?([\w@/.:-]+)['"]?\s*$/.exec(line)
    if (block !== null && block[1] === entryId) {
      startIndex = index
      break
    }
  }
  const renderBlock = () => {
    const block = [`- id: ${entryId}`]
    if (disable) block.push('  disabled: true')
    if (config !== undefined) block.push(`  config: ${JSON.stringify(config)}`)
    return block
  }
  let next
  if (startIndex >= 0) {
    // 启用（无任何覆盖）= 整块删除；否则整块重建。
    if (!disable && config === undefined) {
      next = lines.slice(0, startIndex)
      let endIndex = lines.length
      for (let index = startIndex + 1; index < lines.length; index += 1) {
        if (/^-\s/.test(lines[index])) { endIndex = index; break }
      }
      next = next.concat(lines.slice(endIndex))
    } else {
      let endIndex = lines.length
      if (!inlineBlock) {
        for (let index = startIndex + 1; index < lines.length; index += 1) {
          if (/^-\s/.test(lines[index])) { endIndex = index; break }
        }
      } else {
        endIndex = startIndex + 1
      }
      next = lines.slice(0, startIndex).concat(renderBlock(), lines.slice(endIndex))
    }
  } else {
    if (!disable && config === undefined) {
      return { ok: true, backupPath, note: '该 entry 本来就没有覆盖，已处于启用状态' }
    }
    const header = text.trim().length === 0
      ? ['# 由 dsh-shared-tree 追加的覆盖条目（也可手工编辑/删除）']
      : []
    next = lines.concat(header, renderBlock())
  }
  const out = `${next.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`
  try {
    writeFileSync(file, out, 'utf8')
  } catch (failure) {
    return { ok: false, error: `写入失败：${failure instanceof Error ? failure.message : String(failure)}`, backupPath }
  }
  try {
    recordChange(root, { kind: 'patch-file', profile: profileName, file: 'cordis.patch.yml', before: beforeText, after: existsSync(file) ? readFileSync(file, 'utf8') : null })
  } catch {
    // 台账写不进不致命（还原兜底还有 .bak 文件与独立脚本）。
  }
  return { ok: true, backupPath, note: '已写入该 profile 的 cordis.patch.yml 覆盖层，需重启 DSH 生效' }
}

// ── 原版插件详情复刻：描述文档 + 行级功能开关（与 Plugins 页同一套数据与写入链路）──

/**
 * 读一个插件包的描述文档：优先宿主的 readBundleDetail（原版 Plugins 页同源），
 * 服务不可用或读不到时退回包内 README（zh 优先）。
 * @param {any} manager pluginManager 服务（可能为 undefined）。
 * @param {string} root 共享树根。
 * @param {string} packageName 包名。
 * @param {string} language 语言（zh/en）。
 * @returns {Promise<{ markdown: string, path: string|null, source: 'host'|'readme', found: boolean, error?: string }>} 描述文档。
 */
async function bundleDetailDocument(manager, root, packageName, language) {
  if (manager !== undefined && typeof manager.readBundleDetail === 'function') {
    try {
      const detail = await manager.readBundleDetail(packageName, language)
      if (detail !== undefined && detail !== null && typeof detail === 'object') {
        if (detail.status === 'found' && typeof detail.markdown === 'string' && detail.markdown.length > 0) {
          return { markdown: detail.markdown, path: typeof detail.path === 'string' ? detail.path : null, source: 'host', found: true }
        }
        if (detail.status === 'missing') {
          return { markdown: '', path: null, source: 'host', found: false }
        }
      }
    } catch {
      // 服务抛错时落到 README 兜底。
    }
  }
  const dir = join(root, packageName)
  for (const candidate of ['README.zh.md', 'README.zh-CN.md', 'README.md']) {
    const full = join(dir, candidate)
    if (!existsSync(full)) continue
    try {
      return { markdown: readFileSync(full, 'utf8'), path: candidate, source: 'readme', found: true }
    } catch {
      continue
    }
  }
  return { markdown: '', path: null, source: 'readme', found: false, error: '该包没有描述文档' }
}

/**
 * 解析原版 LocalizedText（string | {en, [locale]}）为单一语言文本。
 * @param {any} value 字段值。
 * @param {string} lang 目标语言（zh/en）。
 * @returns {string|null} 解析结果；无值为 null。
 */
function resolveLocalized(value, lang) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value === 'object') {
    const preferred = typeof value[lang] === 'string' && value[lang].length > 0 ? value[lang] : null
    if (preferred !== null) return preferred
    if (typeof value.en === 'string' && value.en.length > 0) return value.en
    const first = Object.values(value).find((item) => typeof item === 'string' && item.length > 0)
    return first ?? null
  }
  return null
}

/**
 * 列一个插件包的功能开关行：优先宿主 listPlugins()（原版同源，含 enabled/phase/readOnlyReason），
 * 按 moduleName 归属过滤；并从 listBundles() 的 BundleRowInfo.meta（PluginLocalizedMeta）join 出
 * 原版面板显示的行级 title/description——**同一数据源，不自造元数据**。
 * 服务不可用时回退为补丁解析结果（只读展示，无 title/description）。
 * @param {any} manager pluginManager 服务（可能为 undefined）。
 * @param {string} root 共享树根。
 * @param {string} packageName 包名。
 * @param {string} lang 展示语言（zh/en）。
 * @returns {Promise<{ rows: Array<object>, manageable: boolean, source: 'host'|'patch' }>} 行清单。
 */
async function bundleRows(manager, root, packageName, lang = 'zh') {
  if (manager !== undefined && typeof manager.listPlugins === 'function') {
    try {
      const plugins = await manager.listPlugins()
      const base = (Array.isArray(plugins) ? plugins : [])
        .filter((item) => item !== null && typeof item === 'object' && (item.moduleName === packageName || item.patchId === packageName))
        .map((item) => ({
          entryId: typeof item.entryId === 'string' ? item.entryId : null,
          rowId: typeof item.rowId === 'string' ? item.rowId : typeof item.id === 'string' ? item.id : null,
          moduleName: typeof item.moduleName === 'string' ? item.moduleName : null,
          enabled: item.enabled === true,
          phase: typeof item.phase === 'string' ? item.phase : null,
          readOnlyReason: typeof item.readOnlyReason === 'string' ? item.readOnlyReason : null,
        }))
      if (base.length > 0) {
        // 行级 title/description 来自 listBundles 的 BundleRowInfo.meta（原版面板同一字段）。
        let rows = base
        try {
          const bundles = typeof manager.listBundles === 'function' ? await manager.listBundles() : []
          const bundle = (Array.isArray(bundles) ? bundles : []).find((item) => item?.name === packageName)
          const metaByModule = new Map()
          for (const row of Array.isArray(bundle?.rows) ? bundle.rows : []) {
            if (typeof row?.moduleName !== 'string') continue
            if (!metaByModule.has(row.moduleName)) {
              metaByModule.set(row.moduleName, {
                title: resolveLocalized(row.meta?.title, lang),
                description: resolveLocalized(row.meta?.description, lang),
              })
            }
          }
          rows = base.map((row) => {
            const meta = metaByModule.get(row.moduleName ?? '') ?? {}
            return { ...row, title: meta.title ?? null, description: meta.description ?? null }
          })
        } catch {
          // meta 拿不到不致命：行仍有开关与状态，只是没有展示文案。
        }
        return { rows, manageable: true, source: 'host' }
      }
    } catch {
      // 服务抛错时落到补丁解析兜底。
    }
  }
  const parsed = packageEntries(root, packageName)
  return {
    rows: parsed.entries.map((entry) => ({
      entryId: entry.id,
      rowId: entry.id,
      moduleName: packageName,
      enabled: entry.disabled !== true,
      phase: null,
      readOnlyReason: 'pluginManager 不可用，开关只读（可改用 shared_tree 工具或重启后重试）',
    })),
    manageable: false,
    source: 'patch',
  }
}

/**
 * 解析描述文档图片的磁盘路径（原版 serveDetailFile 的复刻）。
 * rel 先按文档所在目录解析，再按包目录解析；两者都必须落在包目录内（防穿越）。
 * @param {string} root 共享树根。
 * @param {string} packageName 包名。
 * @param {string} rel 图片引用（相对路径）。
 * @param {string|null} docPath 文档路径（相对包目录或绝对）。
 * @returns {string|null} 存在的图片绝对路径；找不到为 null。
 */
function detailImagePath(root, packageName, rel, docPath) {
  if (typeof rel !== 'string' || rel.length === 0 || /^[\w-]+:\/\//.test(rel)) return null
  const packageDir = resolve(join(root, packageName))
  const docDir = typeof docPath === 'string' && docPath.length > 0 ? dirname(resolve(join(root, packageName), docPath)) : packageDir
  const candidates = [resolve(docDir, rel), resolve(packageDir, rel)]
  let packageReal = null
  try {
    packageReal = realpathSync(packageDir)
  } catch {
    return null
  }
  for (const candidate of candidates) {
    // 字面路径必须落在包目录内（防 ../、绝对路径、doc 参数操纵）。
    if (!candidate.startsWith(packageDir + sep) && candidate !== packageDir) continue
    if (!existsSync(candidate)) continue
    let stat
    try {
      stat = statSync(candidate)
    } catch {
      continue
    }
    // 符号链接/junction 一律拒绝（防指向包外的越界读取——共享树里 junction 是常态）。
    if (stat.isSymbolicLink() || lstatSync(candidate).isSymbolicLink()) continue
    if (!stat.isFile()) continue
    // realpath 之后再比一次前缀：中间目录若也是链接，字面前缀会骗过上面的检查。
    let candidateReal = null
    try {
      candidateReal = realpathSync(candidate)
    } catch {
      continue
    }
    if (candidateReal === packageReal || candidateReal.startsWith(packageReal + sep)) return candidate
  }
  return null
}

/** 图片扩展名 → content-type。 */
const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
}

/**
 * 汇总一个包的调试信息：加载状态、清单一致性、引用面、功能项。 * @param {string} root 共享树根。
 * @param {string} packageName 包名。
 * @param {any[]|undefined} bundles 当前 profile 的 bundle 清单。
 * @returns {object} 调试快照。
 */
function buildDebugInfo(root, packageName, bundles) {
  const manifest = readManifest(join(root, packageName))
  const recorded = readTreeManifest(root).packages.find((item) => item?.name === packageName)
  let hashOk = null
  if (recorded !== undefined && typeof recorded.sha256 === 'string' && existsSync(join(root, packageName))) {
    const hashed = treeHash(join(root, packageName))
    hashOk = hashed.truncated ? null : hashed.hash === recorded.sha256
  }
  const row = (bundles ?? []).find((item) => item?.name === packageName)
  const entries = packageEntries(root, packageName)
  return {
    name: packageName,
    version: manifest?.version ?? null,
    kind: kindOf(manifest),
    dshKeys: manifest?.dsh === undefined || manifest?.dsh === null ? [] : Object.keys(manifest.dsh),
    inCurrentProfile: row === undefined
      ? { known: false }
      : { known: true, enabled: row.enabled === true, availability: row.availability ?? null, rows: Array.isArray(row?.rows) ? row.rows.length : 0, source: typeof row?.source === 'string' ? row.source : null },
    hashOk,
    entriesCount: entries.entries.length,
    entriesError: entries.error ?? null,
    referenced: profileImpact(root, packageName, manifest?.version ?? null).profiles.filter((item) => item.referenced).map((item) => item.profile),
  }
}

/**
 * 升级后逐 profile 验证：引用该包的每个 profile 解析到哪个版本、是否启用。
 * @param {string} root 共享树根。
 * @param {string} packageName 包名。
 * @returns {{ name: string, treeVersion: string|null, rows: Array<object> }} 结果。
 */
function checkProfilesAfterUpgrade(root, packageName) {
  const treeVersion = readManifest(join(root, packageName))?.version ?? null
  const { profiles } = profileImpact(root, packageName, treeVersion)
  return {
    name: packageName,
    treeVersion,
    rows: profiles
      .filter((row) => row.referenced)
      .map((row) => ({
        profile: row.profile,
        version: row.version,
        via: row.via,
        matchesTree: row.version === null ? null : row.version === treeVersion,
        enabled: row.enabled,
      })),
  }
}

/**
 * 把共享树里的一个 bundle 加进 / 移出某个 profile 的 dsh.profile.bundles。
 * 改前把该 profile 的 package.json 备份为 package.json.bak-shared-tree（覆盖式）。
 * @param {string} root 共享树根。
 * @param {string} profileName profile 目录名。
 * @param {string} packageName 包名。
 * @param {boolean} enabled true=加入，false=移除。
 * @returns {{ ok: boolean, error?: string, backupPath?: string, note?: string }} 结果。
 */
function setProfileBundle(root, profileName, packageName, enabled) {
  const profile = listProfiles(root).find((item) => item.name === profileName)
  if (profile === undefined) return { ok: false, error: `profile「${profileName}」不存在` }
  if (!SAFE_SPEC.test(packageName)) return { ok: false, error: '包名不合法' }
  const file = join(profile.dir, 'package.json')
  const backupPath = `${file}.bak-shared-tree`
  let beforeText = null
  try {
    beforeText = existsSync(file) ? readFileSync(file, 'utf8') : null
  } catch {
    beforeText = null
  }
  try {
    copyFileSync(file, backupPath)
  } catch (error) {
    return { ok: false, error: `备份失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const declared = profile.manifest?.dsh?.profile?.bundles
  const entries = Array.isArray(declared) ? declared.filter((item) => typeof item === 'string') : []
  const next = entries.filter((entry) => entry !== packageName && !entry.startsWith(`${packageName}/`))
  if (enabled) next.push(packageName)
  profile.manifest.dsh = profile.manifest.dsh ?? {}
  profile.manifest.dsh.profile = profile.manifest.dsh.profile ?? {}
  profile.manifest.dsh.profile.bundles = next
  try {
    writeFileSync(file, `${JSON.stringify(profile.manifest, null, 2)}\n`, 'utf8')
  } catch (error) {
    return { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}`, backupPath }
  }
  try {
    recordChange(root, { kind: 'profile-bundles', profile: profileName, file: 'package.json', before: beforeText, after: readFileSync(file, 'utf8') })
  } catch {
    // 台账写不进不致命（还原兜底还有 .bak 文件与独立脚本）。
  }
  return { ok: true, backupPath, note: enabled ? '已加入该 profile 的 dsh.profile.bundles，需重启该 profile 生效' : '已移出该 profile 的 dsh.profile.bundles，需重启该 profile 生效' }
}

/** 面板可见性登记台账：记录本插件写进各 profile `dependencies` 的 `link:` 引用（用于精确撤销）。 */
const PANEL_LEDGER_FILE = '.dsh-shared-tree-panel.json'

/**
 * 读面板可见性台账。
 * @param {string} root 共享树根。
 * @returns {{scheme: string, profiles: Record<string, Record<string, {spec: string, at: string, hadDependencies: boolean}>>}} 台账。
 */
function readPanelLedger(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, PANEL_LEDGER_FILE), 'utf8'))
    if (raw !== null && typeof raw === 'object' && typeof raw.profiles === 'object' && raw.profiles !== null) return raw
  } catch {
    // 缺失/损坏按空台账处理，写入时整体重写。
  }
  return { scheme: 'dsh-shared-tree-panel/1', profiles: {} }
}

/**
 * 写面板可见性台账。
 * @param {string} root 共享树根。
 * @param {object} ledger 台账。
 */
function writePanelLedger(root, ledger) {
  ledger.scheme = 'dsh-shared-tree-panel/1'
  ledger.updated = new Date().toISOString()
  writeFileSync(join(root, PANEL_LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
}

/**
 * 一个 profile 的清单里「官方 Plugins 面板能看到的名字」。
 *
 * 宿主 `pluginManager.readBundles()` 的候选集合只来自 profile 清单
 * （`dsh.profile.bundles` ∪ `dependencies`）加安装目录与官方目录，
 * **从不 readdir `profiles/node_modules`**——这就是共享树里的包在面板里"消失"的原因。
 * @param {any} manifest profile 的 package.json。
 * @returns {Set<string>} 名字集合。
 */
function declaredNamesOf(manifest) {
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((item) => typeof item === 'string')
    : []
  return new Set([...bundles, ...Object.keys(manifest?.dependencies ?? {})])
}

/**
 * 面板可见性报告：树里的 bundle 有哪些当前 profile 能看到 / 看不到。
 *
 * 额外标出 `components`：entry id 已被**另一个树内 bundle** 声明的包（如 dsh-mnemon 的 strategy 组件）。
 * 这类包即便登记成 link: 依赖也不该在面板里当成独立插件启用——会重复插入 entry id（issue #470）。
 * @param {string} root 共享树根。
 * @param {string} profileName profile 目录名。
 * @returns {{ok: boolean, error?: string, profile?: string, visible?: string[], hidden?: string[], treeBundles?: string[], components?: Array<{name: string, owner: string, entryId: string}>}} 报告。
 */
function panelReport(root, profileName) {
  const profile = listProfiles(root).find((item) => item.name === profileName)
  if (profile === undefined) return { ok: false, error: `profile「${profileName}」不存在` }
  const declared = declaredNamesOf(profile.manifest)
  const bundles = scanTree(root).filter((item) => item.hasBundle === true)
  // entry id 所有者表：与"是否已启用"无关，纯看树内声明，所以未启用的组件也能识别出来。
  const owners = new Map()
  const idsByName = new Map()
  for (const item of bundles) {
    const ids = bundleEntryIds(join(root, item.name))
    idsByName.set(item.name, ids)
    for (const id of ids) if (!owners.has(id)) owners.set(id, item.name)
  }
  const components = []
  for (const item of bundles) {
    for (const id of idsByName.get(item.name) ?? []) {
      const owner = owners.get(id)
      if (owner !== undefined && owner !== item.name) {
        components.push({ name: item.name, owner, entryId: id })
        break
      }
    }
  }
  const componentNames = new Set(components.map((item) => item.name))
  const treeBundles = bundles.map((item) => item.name)
  return {
    ok: true,
    profile: profileName,
    treeBundles,
    visible: treeBundles.filter((name) => declared.has(name)),
    hidden: treeBundles.filter((name) => !declared.has(name)),
    components,
  }
}

/**
 * 让共享树里的 bundle 重新出现在官方 Plugins 面板里。
 *
 * 做法：把包登记为当前 profile 的 `dependencies[name] = "link:<树内绝对路径>"`。
 * - **只写 dependencies，绝不写 `dsh.profile.bundles`** —— 包不会被加载，移除/隔离语义不变；
 * - 面板 `readBundles()` 因此能看到它（`installed: true / enabled: false`），可打开配置页、可在面板里自行启用；
 * - 只改**指定的那一个 profile**，其他 profile 与共享树目录本身零改动；
 * - 改动前备份 `package.json.bak-shared-tree`，并记进生命周期台账（停用插件时随还原回滚）。
 *
 * @param {string} root 共享树根。
 * @param {string} profileName profile 目录名。
 * @param {string|string[]} packageNames 目标包名（单个或数组）。
 * @param {boolean} exposed true=登记为可见，false=撤销本插件的登记。
 * @returns {{ok: boolean, error?: string, changed?: string[], kept?: string[], skipped?: Array<{name: string, reason: string}>, note?: string}} 结果。
 */
function setPanelVisibility(root, profileName, packageNames, exposed) {
  const profile = listProfiles(root).find((item) => item.name === profileName)
  if (profile === undefined) return { ok: false, error: `profile「${profileName}」不存在` }
  const requested = (Array.isArray(packageNames) ? packageNames : [packageNames])
    .flatMap((item) => String(item ?? '').split(','))
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (requested.length === 0) return { ok: false, error: 'target is required' }

  const file = join(profile.dir, 'package.json')
  let beforeText = null
  try {
    beforeText = existsSync(file) ? readFileSync(file, 'utf8') : null
  } catch {
    beforeText = null
  }
  if (beforeText === null) return { ok: false, error: '读不到该 profile 的 package.json' }

  let manifest
  try {
    manifest = JSON.parse(beforeText)
  } catch (error) {
    return { ok: false, error: `package.json 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }

  const ledger = readPanelLedger(root)
  ledger.profiles[profileName] = ledger.profiles[profileName] ?? {}
  const record = ledger.profiles[profileName]
  const changed = []
  const kept = []
  const skipped = []

  // 组件识别：entry id 已被树内另一个 bundle 声明。这种包登记成可见只会诱发 issue #470
  // （在面板里被当成独立插件启用 → 同一 id 被两层插入 → 设置存不下）。
  const componentOwners = new Map()
  if (exposed) {
    const bundles = scanTree(root).filter((item) => item.hasBundle === true)
    const owners = new Map()
    const idsByName = new Map()
    for (const item of bundles) {
      const ids = bundleEntryIds(join(root, item.name))
      idsByName.set(item.name, ids)
      for (const id of ids) if (!owners.has(id)) owners.set(id, item.name)
    }
    for (const [name, ids] of idsByName) {
      for (const id of ids) {
        const owner = owners.get(id)
        if (owner !== undefined && owner !== name) {
          componentOwners.set(name, { owner, entryId: id })
          break
        }
      }
    }
  }

  for (const name of requested) {
    if (name === PROTECTED_SCOPE || name.startsWith(`${PROTECTED_SCOPE}/`)) {
      skipped.push({ name, reason: '受保护的安装目录 scope，不登记' })
      continue
    }
    if (!SAFE_SPEC.test(name)) {
      skipped.push({ name, reason: '包名不合法' })
      continue
    }
    const dir = join(root, name)
    if (!existsSync(dir)) {
      skipped.push({ name, reason: '不在共享树里' })
      continue
    }
    const manifestOfPackage = readManifest(dir)
    if (manifestOfPackage?.dsh?.bundle === undefined || manifestOfPackage.dsh.bundle === null) {
      skipped.push({ name, reason: '不是 bundle（没有 dsh.bundle），官方面板不会按插件列出' })
      continue
    }
    const conflict = componentOwners.get(name)
    if (conflict !== undefined) {
      skipped.push({
        name,
        reason: `它的 entry id「${conflict.entryId}」已由树内的 ${conflict.owner} 提供（是组件，不是独立插件）；`
          + '登记进面板会诱使别人把它当独立 bundle 启用，导致重复 entry id（issue #470）',
      })
      continue
    }
    const spec = `link:${dir.replace(/\\/g, '/')}`
    const dependencies = manifest.dependencies ?? {}
    const current = typeof dependencies[name] === 'string' ? dependencies[name] : undefined
    if (exposed) {
      if (current === spec) {
        kept.push(name)
        continue
      }
      if (current !== undefined) {
        skipped.push({ name, reason: `该 profile 的 dependencies 里已有同名依赖（${current}），不覆盖` })
        continue
      }
      for (const field of ['devDependencies', 'optionalDependencies']) {
        if (typeof manifest[field]?.[name] === 'string') {
          skipped.push({ name, reason: `该 profile 的 ${field} 里已有同名依赖，不覆盖` })
          continue
        }
      }
      if (skipped.some((item) => item.name === name)) continue
      const hadDependencies = manifest.dependencies !== undefined
      manifest.dependencies = { ...dependencies, [name]: spec }
      record[name] = { spec, at: new Date().toISOString(), hadDependencies }
      // 显式重新登记 → 清掉撤销标记（自动登记恢复对它的覆盖）。
      if (record.revoked?.[name] !== undefined) {
        delete record.revoked[name]
        if (Object.keys(record.revoked).length === 0) delete record.revoked
      }
      changed.push(name)
      continue
    }
    // 撤销：只撤销**本插件登记过的、且当前值仍是它**的依赖，绝不误删用户自己写的。
    const registered = record[name]
    if (registered === undefined) {
      skipped.push({ name, reason: '本插件没有为它登记过（可能不是本插件加的依赖）' })
      continue
    }
    if (current !== registered.spec) {
      skipped.push({ name, reason: `当前 dependencies 值已不是本插件写的那条（${current ?? '已移除'}），不撤销` })
      continue
    }
    delete manifest.dependencies[name]
    if (manifest.dependencies !== undefined && Object.keys(manifest.dependencies).length === 0 && registered.hadDependencies !== true) {
      delete manifest.dependencies
    }
    delete record[name]
    // 记住这次显式撤销：自动登记（启动补扫/启用后登记）不再碰它，直到显式 expose=true。
    record.revoked = record.revoked ?? {}
    record.revoked[name] = new Date().toISOString()
    changed.push(name)
  }

  if (changed.length === 0) {
    return { ok: true, changed, kept, skipped, note: skipped.length > 0 ? '没有可改动的项' : '已是最新状态' }
  }

  try {
    copyFileSync(file, `${file}.bak-shared-tree`)
  } catch (error) {
    return { ok: false, error: `备份失败：${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  } catch (error) {
    return { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    recordChange(root, {
      kind: exposed ? 'panel-dependencies' : 'panel-dependencies-restore',
      profile: profileName,
      file: 'package.json',
      before: beforeText,
      after: readFileSync(file, 'utf8'),
    })
  } catch {
    // 台账写不进不致命（还原兜底还有 .bak 文件与独立脚本）。
  }
  try {
    writePanelLedger(root, ledger)
  } catch {
    // 台账写不进不致命（撤销时退化为"跳过并报告"）。
  }
  return {
    ok: true,
    changed,
    kept,
    skipped,
    note: exposed
      ? '已登记为当前 profile 的 link: 依赖：官方插件面板能看到它，但不会被加载（启用状态仍由 dsh.profile.bundles 决定）'
      : '已撤销登记：该包回到"仅存在于共享树"的状态',
  }
}

/**
 * 自动登记单个包（启用/停用成功后调用），尊重 expose=false 的撤销标记。
 * @param {string} root 共享树根。
 * @param {string|undefined} profileName 当前 profile 目录名。
 * @param {string} name 包名。
 * @returns {boolean} 是否真的写入了登记（幂等命中/被撤销/被跳过都返回 false）。
 */
function autoPinOne(root, profileName, name) {
  if (typeof profileName !== 'string' || profileName.length === 0) return false
  const revoked = readPanelLedger(root).profiles[profileName]?.revoked ?? {}
  if (revoked[name] !== undefined) return false
  const outcome = setPanelVisibility(root, profileName, [name], true)
  return outcome.ok === true && (outcome.changed ?? []).includes(name)
}

/**
 * 自动登记（默认行为）：把当前 profile **已启用**、但官方 Plugins 面板还看不到的独立 bundle
 * 登记成 `link:` 依赖。复用 setPanelVisibility 的全部约束（幂等、不覆盖用户依赖、跳过组件/
 * client-only/受保护 scope、只改当前 profile、备份 + 面板台账 + 生命周期台账）。
 *
 * 触发点：① apply 启动补扫（存量）；② /set 与工具 enable/disable 成功后（增量，对称）。
 * 撤销尊重：`expose=false` 撤销过的包记进面板台账的 `revoked`，自动登记不再碰它，
 * 直到用户显式 `expose=true` 重新登记。
 *
 * @param {string} root 共享树根。
 * @param {string|undefined} profileName 当前 profile 目录名；拿不到就什么都不做。
 * @param {any[]|undefined} bundles pluginManager.listBundles() 的结果；不可用就什么都不做。
 * @returns {{ok: boolean, changed: string[], kept: string[], skipped: Array<{name: string, reason: string}>, reason?: string}} 结果。
 */
function autoPanelSync(root, profileName, bundles) {
  const empty = { ok: true, changed: [], kept: [], skipped: [] }
  if (typeof profileName !== 'string' || profileName.length === 0) return { ...empty, reason: 'current-profile-unavailable' }
  if (!Array.isArray(bundles)) return { ...empty, reason: 'bundles-unavailable' }
  const profile = listProfiles(root).find((item) => item.name === profileName)
  if (profile === undefined) return { ...empty, reason: 'profile-not-found' }
  const enabledInTree = new Set(scanTree(root).filter((item) => item.hasBundle === true).map((item) => item.name))
  // 已启用（在 bundles 清单里 enabled=true）且 dependencies 里还没有 link: 入口 → 需要补登记。
  // 注意：不能把"在 dsh.profile.bundles 里"当成面板已可见——宿主清单在启动时读取，
  // 启用后未重启的包正是"已启用但面板不可见"的存量，必须补登记。
  const deps = profile.manifest?.dependencies ?? {}
  const candidates = bundles
    .filter((item) => item?.enabled === true && typeof item.name === 'string' && enabledInTree.has(item.name) && typeof deps[item.name] !== 'string')
    .map((item) => item.name)
  if (candidates.length === 0) return empty
  // 撤销尊重：用户显式 expose=false 撤销过的包，自动登记不再碰。
  const revoked = readPanelLedger(root).profiles[profileName]?.revoked ?? {}
  const wanted = candidates.filter((name) => revoked[name] === undefined)
  const skipped = candidates.filter((name) => revoked[name] !== undefined)
    .map((name) => ({ name, reason: '已被 expose=false 显式撤销，自动登记尊重该选择（显式 expose=true 可重新登记）' }))
  if (wanted.length === 0) return { ...empty, skipped }
  const outcome = setPanelVisibility(root, profileName, wanted, true)
  if (outcome.ok !== true) return { ok: false, changed: [], kept: [], skipped, reason: outcome.error }
  return { ok: true, changed: outcome.changed ?? [], kept: outcome.kept ?? [], skipped: [...skipped, ...(outcome.skipped ?? [])] }
}

/**
 * 构造共享树的 HTTP handler。**只读 + 启用开关 + 升级任务**：
 * install/rollback 走任务化的 performInstall（同源底层函数），豁免授予、目录级回滚、registry 配置留在 CLI。
 * @param {{ rootOf: () => string, getBundles: () => Promise<any[]|undefined>, getManager: () => any, currentProfile?: () => string|undefined }} deps 依赖。
 * @returns {(req: any, res: any) => Promise<void>} handler。
 */
function createRouteHandler(deps) {
  /** 升级/回滚任务的槽：同一时刻只允许一个（共享树是全局变更，排队无意义）。 */
  let installJob = null
  const settings = deps.settings ?? {}
  const installSettings = () => ({
    buildDir: typeof settings.buildDir === 'string' && settings.buildDir.length > 0 ? resolve(settings.buildDir) : dshHomePath('cache', 'shared-tree-build'),
    registry: typeof settings.registry === 'string' && settings.registry.length > 0 ? settings.registry : undefined,
    timeoutMs: typeof settings.timeoutMs === 'number' && settings.timeoutMs > 0 ? settings.timeoutMs : 300_000,
  })
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
      if (method === 'GET' && pathname === `${ROUTE_PREFIX}/panel`) {
        const params = new URL(req.url ?? '/', 'http://x').searchParams
        const profileName = String(params.get('profile') ?? '').trim() || String(deps.currentProfile?.() ?? '').trim()
        if (profileName.length === 0) {
          sendJson(res, 400, { ok: false, error: 'profile is required' })
          return
        }
        const report = panelReport(deps.rootOf(), profileName)
        sendJson(res, report.ok === true ? 200 : 404, report.ok === true ? { ok: true, value: report } : { ok: false, error: report.error })
        return
      }

      if (method === 'POST' && pathname === `${ROUTE_PREFIX}/panel`) {
        const body = await readJsonBody(req)
        const exposed = body?.exposed
        if (typeof exposed !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'exposed must be a boolean' })
          return
        }
        const profileName = String(body?.profile ?? '').trim() || String(deps.currentProfile?.() ?? '').trim()
        if (profileName.length === 0) {
          sendJson(res, 400, { ok: false, error: 'profile is required' })
          return
        }
        const requested = Array.isArray(body?.target) ? body.target : [body?.target]
        const names = requested.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0)
        if (names.length === 0) {
          sendJson(res, 400, { ok: false, error: 'target is required' })
          return
        }
        const outcome = setPanelVisibility(deps.rootOf(), profileName, names, exposed)
        if (outcome.ok !== true) {
          sendJson(res, 400, { ok: false, error: outcome.error ?? 'failed' })
          return
        }
        sendJson(res, 200, {
          ok: true,
          value: { ...outcome, report: panelReport(deps.rootOf(), profileName) },
        })
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
        // 宿主原生链路写入（setBundleEnabled 改当前 profile 的 package.json）不经我们的备份，
        // 用差异记账补台账：否则这些开关在停用时不会被还原。
        const packagesBefore = captureProfileFiles(root, 'package.json')
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
            // 默认登记（启用/停用对称）：启用后让面板能看到它的配置页；停用后让面板仍能
            // 列出/再次启用它。都只写 link: 依赖，不写 bundles、不加载（隔离语义不变）。
            let panelPinned = false
            if (!failed) {
              try {
                panelPinned = autoPinOne(root, deps.currentProfile?.(), name)
              } catch {
                // 登记失败不影响启用/停用本身。
              }
            }
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
              panelPinned,
              safetyNote: SAFETY_NOTES[name] ?? null,
            })
          } catch (error) {
            results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }
        recordProfileFileChanges(root, 'profile-bundles', 'package.json', packagesBefore, captureProfileFiles(root, 'package.json'))
        sendJson(res, 200, { ok: true, value: { enabled, results, status: buildStatusData(root, await deps.getBundles()) } })
        return
      }
      // ── 升级 UI 的新路由 ──────────────────────────────────────────────────

      if (method === 'GET' && pathname === `${ROUTE_PREFIX}/impact`) {
        const packageName = String(new URL(req.url ?? '/', 'http://x').searchParams.get('pkg') ?? '').trim()
        if (packageName.length === 0) {
          sendJson(res, 400, { ok: false, error: 'pkg is required' })
          return
        }
        const root = deps.rootOf()
        const treeVersion = readManifest(join(root, packageName))?.version ?? null
        const { profiles } = profileImpact(root, packageName, treeVersion)
        sendJson(res, 200, {
          ok: true,
          value: {
            name: packageName,
            treeVersion,
            profiles,
            referencing: profiles.filter((row) => row.referenced).length,
            history: historyOf(root, packageName),
          },
        })
        return
      }

      if (method === 'GET' && pathname === `${ROUTE_PREFIX}/deps`) {
        const params = new URL(req.url ?? '/', 'http://x').searchParams
        const packageName = String(params.get('pkg') ?? '').trim()
        const wanted = String(params.get('ver') ?? 'latest').trim() || 'latest'
        if (packageName.length === 0) {
          sendJson(res, 400, { ok: false, error: 'pkg is required' })
          return
        }
        if (!SAFE_SPEC.test(`${packageName}@${wanted === 'latest' ? '1.0.0' : wanted}`)) {
          sendJson(res, 400, { ok: false, error: 'invalid package or version' })
          return
        }
        const root = deps.rootOf()
        const conf = installSettings()
        // latest 先解析成精确版本；这一步需要访问 registry，失败时给可读的降级结果。
        let version = wanted
        if (wanted === 'latest') {
          const latest = await pnpmView(packageName, conf)
          const resolved = typeof latest === 'string' ? latest : latest?.version
          if (typeof resolved !== 'string' || resolved.length === 0) {
            sendJson(res, 200, { ok: true, value: { available: false, error: '无法从 registry 读取最新版本（网络或包名问题），请改用 CLI 核对', checks: [], ok: null, version: null } })
            return
          }
          version = resolved
        }
        const manifest = await pnpmView(`${packageName}@${version}`, conf)
        if (manifest === undefined) {
          sendJson(res, 200, { ok: true, value: { available: false, error: `无法从 registry 读取 ${packageName}@${version} 的元数据`, checks: [], ok: null, version } })
          return
        }
        const checks = buildDependencyChecks(packageName, version, manifest, root)
        sendJson(res, 200, {
          ok: true,
          value: {
            available: true,
            version,
            latest: wanted === 'latest' ? version : null,
            peerDependencies: manifest?.peerDependencies ?? {},
            engines: manifest?.engines ?? {},
            checks: checks.checks,
            ok: checks.ok,
          },
        })
        return
      }

      if (method === 'POST' && pathname === `${ROUTE_PREFIX}/install`) {
        const body = await readJsonBody(req)
        const specs = Array.isArray(body?.packages) ? body.packages.map((item) => String(item).trim()).filter((item) => item.length > 0) : []
        if (specs.length === 0) {
          sendJson(res, 400, { ok: false, error: 'packages is required' })
          return
        }
        const invalid = specs.filter((item) => !SAFE_SPEC.test(item))
        if (invalid.length > 0) {
          sendJson(res, 400, { ok: false, error: `包名不合法：${invalid.join(', ')}` })
          return
        }
        if (installJob !== null && installJob.state === 'running') {
          sendJson(res, 409, { ok: false, error: '已有安装任务在进行中（共享树是全局变更，同一时刻只允许一个）' })
          return
        }
        const root = deps.rootOf()
        const conf = installSettings()
        installJob = {
          id: `install-${Date.now()}`,
          kind: 'upgrade',
          state: 'running',
          stage: 'prepare',
          stages: INSTALL_STAGES,
          detail: '',
          startedAt: new Date().toISOString(),
          result: null,
        }
        performInstall({ specs, replace: body?.replace !== false, kind: 'upgrade', root, ...conf }, (stage, detail) => {
          if (installJob !== null) {
            installJob.stage = stage
            installJob.detail = detail
          }
        }).then((result) => {
          if (installJob !== null) {
            installJob.state = result.ok ? 'done' : 'failed'
            installJob.stage = result.stage ?? installJob.stage
            installJob.error = result.error ?? null
            installJob.result = result.ok ? result : null
          }
        }).catch((error) => {
          if (installJob !== null) {
            installJob.state = 'failed'
            installJob.error = error instanceof Error ? error.message : String(error)
          }
        })
        sendJson(res, 200, { ok: true, value: { jobId: installJob.id } })
        return
      }

      if (method === 'GET' && pathname === `${ROUTE_PREFIX}/install/progress`) {
        sendJson(res, 200, {
          ok: true,
          value: installJob ?? { state: 'idle', stage: null, stages: INSTALL_STAGES },
        })
        return
      }

      if (method === 'POST' && pathname === `${ROUTE_PREFIX}/rollback`) {
        const body = await readJsonBody(req)
        const packageName = String(body?.name ?? '').trim()
        const version = String(body?.version ?? '').trim()
        if (packageName.length === 0 || version.length === 0) {
          sendJson(res, 400, { ok: false, error: 'name and version are required' })
          return
        }
        if (!SAFE_SPEC.test(packageName) || !SAFE_VERSION.test(version)) {
          sendJson(res, 400, { ok: false, error: 'invalid package name or version' })
          return
        }
        if (installJob !== null && installJob.state === 'running') {
          sendJson(res, 409, { ok: false, error: '已有安装任务在进行中' })
          return
        }
        const root = deps.rootOf()
        const conf = installSettings()
        installJob = {
          id: `rollback-${Date.now()}`,
          kind: 'rollback',
          state: 'running',
          stage: 'prepare',
          stages: INSTALL_STAGES,
          detail: `${packageName}@${version}`,
          startedAt: new Date().toISOString(),
          result: null,
        }
        performInstall({ specs: [`${packageName}@${version}`], replace: true, kind: 'rollback', root, ...conf }, (stage, detail) => {
          if (installJob !== null) {
            installJob.stage = stage
            installJob.detail = detail
          }
        }).then((result) => {
          if (installJob !== null) {
            installJob.state = result.ok ? 'done' : 'failed'
            installJob.stage = result.stage ?? installJob.stage
            installJob.error = result.error ?? null
            installJob.result = result.ok ? result : null
          }
        }).catch((error) => {
          if (installJob !== null) {
            installJob.state = 'failed'
            installJob.error = error instanceof Error ? error.message : String(error)
          }
        })
        sendJson(res, 200, { ok: true, value: { jobId: installJob.id } })
        return
      }

      if (method === 'POST' && pathname === `${ROUTE_PREFIX}/check-profiles`) {
        const body = await readJsonBody(req)
        const packageName = String(body?.name ?? '').trim()
        if (!SAFE_SPEC.test(packageName)) {
          sendJson(res, 400, { ok: false, error: 'name is required' })
          return
        }
        sendJson(res, 200, { ok: true, value: checkProfilesAfterUpgrade(deps.rootOf(), packageName) })
        return
      }

      // ── 逐插件详情/调试 ──────────────────────────────────────────────────

      if (method === 'GET' && pathname === `${ROUTE_PREFIX}/entries`) {
        const packageName = String(new URL(req.url ?? '/', 'http://x').searchParams.get('pkg') ?? '').trim()
        if (!SAFE_SPEC.test(packageName)) {
          sendJson(res, 400, { ok: false, error: 'pkg is required' })
          return
        }
        const result = packageEntries(deps.rootOf(), packageName)
        if (!result.found) {
          sendJson(res, 200, { ok: false, error: '该包不在共享树里' })
          return
        }
        sendJson(res, 200, { ok: true, value: result })
        return
      }

      if (method === 'GET' && pathname === `${ROUTE_PREFIX}/debug`) {
        const packageName = String(new URL(req.url ?? '/', 'http://x').searchParams.get('pkg') ?? '').trim()
        if (!SAFE_SPEC.test(packageName)) {
          sendJson(res, 400, { ok: false, error: 'pkg is required' })
          return
        }
        if (!existsSync(join(deps.rootOf(), packageName))) {
          sendJson(res, 200, { ok: false, error: '该包不在共享树里' })
          return
        }
        sendJson(res, 200, { ok: true, value: buildDebugInfo(deps.rootOf(), packageName, await deps.getBundles()) })
        return
      }

      if (method === 'POST' && pathname === `${ROUTE_PREFIX}/set-entry`) {
        const body = await readJsonBody(req)
        const profileName = String(body?.profile ?? '').trim()
        const entryId = String(body?.entryId ?? '').trim()
        if (profileName.length === 0 || entryId.length === 0) {
          sendJson(res, 400, { ok: false, error: 'profile and entryId are required' })
          return
        }
        const outcome = setProfileEntryOverride(deps.rootOf(), profileName, entryId, {
          ...(body?.disabled === undefined ? {} : { disabled: body.disabled === true }),
          ...(body?.config === undefined ? {} : { config: body.config }),
        })
        if (!outcome.ok) {
          sendJson(res, 200, { ok: false, error: outcome.error })
          return
        }
        sendJson(res, 200, { ok: true, value: outcome })
        return
      }

      // ── 原版插件详情复刻：描述 + 行级功能开关 ────────────────────────────

      if (method === 'GET' && pathname === `${ROUTE_PREFIX}/detail`) {
        const params = new URL(req.url ?? '/', 'http://x').searchParams
        const packageName = String(params.get('pkg') ?? '').trim()
        const language = String(params.get('lang') ?? 'zh').trim() === 'en' ? 'en' : 'zh'
        if (!SAFE_SPEC.test(packageName)) {
          sendJson(res, 400, { ok: false, error: 'pkg is required' })
          return
        }
        if (!existsSync(join(deps.rootOf(), packageName))) {
          sendJson(res, 200, { ok: false, error: '该包不在共享树里' })
          return
        }
        const manager = deps.getManager()
        const document = await bundleDetailDocument(manager, deps.rootOf(), packageName, language)
        sendJson(res, 200, { ok: true, value: { ...document, docPath: document.path } })
        return
      }

      if (method === 'GET' && pathname === `${ROUTE_PREFIX}/detail-image`) {
        const params = new URL(req.url ?? '/', 'http://x').searchParams
        const packageName = String(params.get('pkg') ?? '').trim()
        const rel = String(params.get('rel') ?? '').trim()
        const docPath = params.get('doc')
        if (!SAFE_SPEC.test(packageName) || rel.length === 0) {
          sendJson(res, 400, { ok: false, error: 'pkg and rel are required' })
          return
        }
        const root = deps.rootOf()
        const image = detailImagePath(root, packageName, rel, docPath === null ? null : String(docPath))
        if (image === null) {
          sendJson(res, 404, { ok: false, error: 'image not found' })
          return
        }
        const type = IMAGE_TYPES[extname(image).toLowerCase()]
        // 只伺服真正的图片类型；未知扩展名（README.md、package.json、.js…）一律 404，防止把任意文件当下载。
        if (type === undefined) {
          sendJson(res, 404, { ok: false, error: 'not an image file' })
          return
        }
        const size = statSync(image).size
        if (size > 8 * 1024 * 1024) {
          sendJson(res, 404, { ok: false, error: 'image too large' })
          return
        }
        const body = readFileSync(image)
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': body.length })
        res.end(body)
        return
      }

      if (method === 'GET' && pathname === `${ROUTE_PREFIX}/rows`) {
        const params = new URL(req.url ?? '/', 'http://x').searchParams
        const packageName = String(params.get('pkg') ?? '').trim()
        const language = String(params.get('lang') ?? 'zh').trim() === 'en' ? 'en' : 'zh'
        if (!SAFE_SPEC.test(packageName)) {
          sendJson(res, 400, { ok: false, error: 'pkg is required' })
          return
        }
        if (!existsSync(join(deps.rootOf(), packageName))) {
          sendJson(res, 200, { ok: false, error: '该包不在共享树里' })
          return
        }
        const manager = deps.getManager()
        const result = await bundleRows(manager, deps.rootOf(), packageName, language)
        sendJson(res, 200, { ok: true, value: result })
        return
      }

      if (method === 'POST' && pathname === `${ROUTE_PREFIX}/set-row`) {
        const body = await readJsonBody(req)
        const entryId = String(body?.entryId ?? '').trim()
        const enabled = body?.enabled
        if (entryId.length === 0 || typeof enabled !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'entryId and boolean enabled are required' })
          return
        }
        const manager = deps.getManager()
        // 原版 Plugins 页同一条写入链路：pluginManager.setPluginEnabled（写 profile 用户层并热重载）。
        if (manager !== undefined && typeof manager.setPluginEnabled === 'function') {
          // 宿主自己落盘不经我们的备份 → 差异记账补台账（停用时才还原得了）。
          const patchBefore = captureProfileFiles(deps.rootOf(), 'cordis.patch.yml')
          try {
            const outcome = await manager.setPluginEnabled(entryId, enabled)
            recordProfileFileChanges(deps.rootOf(), 'patch-file', 'cordis.patch.yml', patchBefore, captureProfileFiles(deps.rootOf(), 'cordis.patch.yml'))
            const application = outcome?.application ?? null
            const failed = outcome?.error !== undefined && outcome?.error !== null
            sendJson(res, 200, {
              ok: !failed,
              value: {
                application,
                nextStep: outcome?.nextStep ?? null,
                restartRequired: application === 'restart-required',
                error: failed ? (outcome.error.code ?? 'failed') : null,
              },
            })
            return
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
            return
          }
        }
        // 服务不可用时的兜底：写当前会话指定 profile 的覆盖层（与 /set-entry 同一条落盘逻辑）。
        const profileName = String(body?.profile ?? '').trim()
        if (profileName.length === 0) {
          sendJson(res, 503, { ok: false, error: 'pluginManager is not available and no profile given for the patch fallback' })
          return
        }
        const outcome = setProfileEntryOverride(deps.rootOf(), profileName, entryId, { disabled: !enabled })
        if (!outcome.ok) {
          sendJson(res, 200, { ok: false, error: outcome.error })
          return
        }
        sendJson(res, 200, { ok: true, value: { application: 'restart-required', nextStep: outcome.note, restartRequired: true, error: null } })
        return
      }

      if (method === 'POST' && pathname === `${ROUTE_PREFIX}/set-profile`) {
        const body = await readJsonBody(req)
        const profileName = String(body?.profile ?? '').trim()
        const packageName = String(body?.target ?? '').trim()
        const enabled = body?.enabled
        if (typeof enabled !== 'boolean' || profileName.length === 0 || packageName.length === 0) {
          sendJson(res, 400, { ok: false, error: 'profile, target and boolean enabled are required' })
          return
        }
        const outcome = setProfileBundle(deps.rootOf(), profileName, packageName, enabled)
        if (!outcome.ok) {
          sendJson(res, 200, { ok: false, error: outcome.error })
          return
        }
        sendJson(res, 200, { ok: true, value: outcome })
        return
      }

      // ── 生命周期：状态 / 显式还原 / destroy ──────────────────────────────

      if (method === 'GET' && pathname === `${ROUTE_PREFIX}/lifecycle`) {
        sendJson(res, 200, { ok: true, value: lifecycleStatus(deps.rootOf(), { firstRun: deps.settings?.firstRun === true }) })
        return
      }

      if (method === 'POST' && pathname === `${ROUTE_PREFIX}/lifecycle-restore`) {
        const body = await readJsonBody(req)
        if (body?.confirm !== true) {
          sendJson(res, 400, { ok: false, error: 'confirm: true is required' })
          return
        }
        sendJson(res, 200, { ok: true, value: restoreFromLedger(deps.rootOf()) })
        return
      }

      if (method === 'POST' && pathname === `${ROUTE_PREFIX}/lifecycle-baseline-restore`) {
        const body = await readJsonBody(req)
        if (body?.confirm !== true) {
          sendJson(res, 400, { ok: false, error: 'confirm: true is required（基线还原会覆盖启用之后的所有配置变更）' })
          return
        }
        sendJson(res, 200, { ok: true, value: restoreBaseline(deps.rootOf()) })
        return
      }

      if (method === 'POST' && pathname === `${ROUTE_PREFIX}/lifecycle-destroy`) {
        const body = await readJsonBody(req)
        if (body?.confirm !== 'DESTROY') {
          sendJson(res, 400, { ok: false, error: "confirm: 'DESTROY' is required（清空共享树是高危动作）" })
          return
        }
        sendJson(res, 200, { ok: true, value: destroyTree(deps.rootOf()) })
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

  // ── 生命周期：启用=建树+各 profile 基线快照；停用（宿主 dispose）=按台账自动还原本插件写过的变更 ──
  let lifecycleFirstRun = false
  try {
    ensureTreeDir(rootOf())
    const snapshot = snapshotBaseline(rootOf())
    lifecycleFirstRun = snapshot.created === true
    if (snapshot.corrupt === true) {
      console.error('[dsh-shared-tree] 生命周期台账损坏：拒绝重建基线快照（防止用当前可能已改过的文件覆盖最初基线）。请检查 .dsh-shared-tree-lifecycle.json，修复或确认删除后重启。')
    } else if (lifecycleFirstRun) {
      console.log(`[dsh-shared-tree] 已初始化共享树并记录各 profile 基线快照（台账：${join(rootOf(), '.dsh-shared-tree-lifecycle.json')}）`)
    }
  } catch (error) {
    console.error('[dsh-shared-tree] 生命周期初始化失败（不影响插件其余功能，可稍后用 shared_tree action=lifecycle 重试）：', error)
  }

  // ── 启动补扫（存量）：当前 profile 已启用、但官方面板还看不到的独立 bundle，默认补登记 ──
  // 异步执行：apply 本身保持同步；pluginManager 未就绪/读不到清单时静默跳过（下次启用动作仍会登记）。
  void (async () => {
    try {
      const bundles = await profileBundles(ctx)
      const outcome = autoPanelSync(rootOf(), currentProfileName(ctx), bundles)
      if (outcome.changed.length > 0) {
        console.log(`[dsh-shared-tree] 启动补扫：已把 ${outcome.changed.length} 个已启用但面板不可见的包默认登记进官方插件面板（${outcome.changed.join('、')}）；重启 DSH 后面板可见。`)
      }
      for (const item of outcome.skipped) {
        console.log(`[dsh-shared-tree] 启动补扫跳过 ${item.name}：${item.reason}`)
      }
    } catch (error) {
      console.error('[dsh-shared-tree] 启动补扫失败（不影响插件其余功能）：', error)
    }
  })()

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      try {
        const report = restoreFromLedger(rootOf())
        console.log(`[dsh-shared-tree] 插件停用：已还原 ${report.reverted.length} 条配置变更、跳过 ${report.skipped.length} 条（明细见 .dsh-shared-tree-restore-report.json）`)
      } catch (error) {
        console.error('[dsh-shared-tree] 停用还原失败（可用 scripts/lifecycle-restore.mjs 手工还原）：', error)
      }
    }, 'dsh-shared-tree: lifecycle restore')
  }

  ctx.tools.register(defineTool({
    name: 'shared_tree',
    description: '管理跨 profile 共享插件树（<DSH_HOME>/profiles/node_modules）。status 查看树的包与 junction 健康；search 搜索树里的包；enable/disable 决定当前 profile 是否启用树里的某个 bundle（启用/停用后都会默认登记进官方 Plugins 面板）；install 把 npm 包装进共享树（临时目录 hoisted 构建，只合并顶层包目录，绝不动 @deepseek-ai 的 junction）；verify 复核每个包的树哈希；panel 查看/手动调整官方 Plugins 面板可见性（写 profile 的 link: 依赖，不加载、不改变启用状态；expose=false 撤销后自动登记不再碰该包）。共享树被所有 profile 复用，改动会影响其他 profile，所以先 search 再决定。',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'search', 'enable', 'disable', 'install', 'verify', 'lifecycle', 'panel'], description: '操作类型。' },
      query: { type: 'string', description: 'search：按包名/描述关键字过滤（不区分大小写）。' },
      kind: { type: 'string', enum: ['all', 'bundle', 'client', 'library'], description: 'search：按类型过滤。bundle 可作 profile bundle 加载，client 仅浏览器侧，library 是依赖库。' },
      onlyEnabled: { type: 'boolean', description: 'search：只看当前 profile 已启用的包。' },
      target: { type: 'string', description: 'enable/disable/panel：目标包名，或用逗号分隔多个包名。' },
      profile: { type: 'string', description: 'panel：目标 profile 目录名（缺省=当前 profile）。' },
      expose: { type: 'boolean', description: 'panel：true（默认）登记为面板可见；false 撤销本插件写过的登记。' },
      packages: { type: 'array', items: { type: 'string' }, description: 'install：要装进共享树的包名或 name@version 列表。' },
      replace: { type: 'boolean', description: 'install：目标包已存在时是否覆盖（默认 false，只跳过）。' },
      limit: { type: 'number', description: 'search：最多返回多少条（默认 40）。' },
      mode: { type: 'string', enum: ['status', 'restore', 'restore-dry-run', 'baseline', 'baseline-dry-run', 'destroy', 'destroy-dry-run'], description: 'lifecycle：子操作。restore/baseline/destroy 需要显式确认。' },
      confirm: { type: 'boolean', description: 'lifecycle：restore/baseline 需 confirm=true；destroy 需 confirm=true 且 mode 为 destroy（dry-run 除外）。' },
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
        const bundlesBefore = captureProfileFiles(root, 'package.json')
        const currentProfile = currentProfileName(ctx)
        for (const packageName of wanted) {
          try {
            const outcome = await manager.setBundleEnabled(packageName, enable)
            const lines = [`- ${packageName}：${describeApplication(outcome.application)}`]
            if (outcome.nextStep !== undefined) lines.push(`  ${outcome.nextStep}`)
            if (outcome.error !== undefined && outcome.error.code !== undefined) lines.push(`  错误：${outcome.error.code}`)
            if (enable && SAFETY_NOTES[packageName] !== undefined) lines.push(`  ⚠ ${SAFETY_NOTES[packageName]}`)
            // 默认登记（启用/停用对称）：启用后面板能看到配置页；停用后面板仍能列出/再次启用。
            if ((outcome.error === undefined || outcome.error === null) && autoPinOne(root, currentProfile, packageName)) {
              lines.push(enable
                ? '  已默认登记进官方插件面板（link: 依赖；重启 DSH 后面板可见）'
                : '  已在插件面板保留入口（link: 依赖，不会加载该插件）')
            }
            results.push(lines.join('\n'))
          } catch (error) {
            results.push(`- ${packageName}：失败（${error instanceof Error ? error.message : String(error)}）`)
          }
        }
        recordProfileFileChanges(root, 'profile-bundles', 'package.json', bundlesBefore, captureProfileFiles(root, 'package.json'))
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

      if (args.action === 'lifecycle') {
        const mode = args.mode ?? 'status'
        if (mode === 'status') {
          const status = lifecycleStatus(root)
          const lines = [
            `生命周期：${status.initialized ? `已初始化（${status.createdAt}）` : '未初始化（尚未记录基线快照）'}`,
            `基线目录：${status.baselineDir ?? '—'}`,
            `快照 profile：${(status.profiles ?? []).map((item) => typeof item === 'string' ? item : item.profile).join('、') || '—'}`,
            `台账变更：${status.changes} 条`,
          ]
          if (args.confirm !== true && (mode === 'restore' || mode === 'destroy')) {
            lines.push('', '该模式需要 confirm=true 才会执行。')
          }
          return lines.join('\n')
        }
        if (mode === 'restore-dry-run' || mode === 'restore') {
          const needConfirm = mode === 'restore' && args.confirm !== true
          if (needConfirm) return '还原会改写 profile 配置文件：请带 confirm=true 执行（可先跑 mode=restore-dry-run 预览）。'
          const outcome = restoreFromLedger(root, { dryRun: mode === 'restore-dry-run' })
          return [
            mode === 'restore-dry-run' ? '还原预览（未落盘）：' : '还原完成：',
            ...outcome.reverted.map((item) => `  ↩ ${item}`),
            ...outcome.skipped.map((item) => `  ⤼ 跳过：${item}`),
            `共 ${outcome.reverted.length} 条可还原，${outcome.skipped.length} 条跳过。`,
          ].join('\n')
        }
        if (mode === 'baseline-dry-run' || mode === 'baseline') {
          const needConfirm = mode === 'baseline' && args.confirm !== true
          if (needConfirm) {
            return ['基线还原会把每个 profile 的 package.json / cordis.patch.yml 恢复成启用时刻的快照原文',
              '（启用之后的所有配置变更——含宿主链路与手工改动——都会被回滚，现状会留 .bak-shared-tree-baseline 备份）。',
              '请带 confirm=true 执行（可先跑 mode=baseline-dry-run 预览）。'].join('\n')
          }
          const outcome = restoreBaseline(root, { dryRun: mode === 'baseline-dry-run' })
          return [
            mode === 'baseline-dry-run' ? '基线还原预览（未落盘）：' : '基线还原完成：',
            ...outcome.reverted.map((item) => `  ↩ ${item}`),
            ...outcome.skipped.map((item) => `  ⤼ ${item}`),
            `共 ${outcome.reverted.length} 个文件恢复基线，${outcome.skipped.length} 条跳过。`,
          ].join('\n')
        }
        if (mode === 'destroy-dry-run' || mode === 'destroy') {
          if (mode === 'destroy' && args.confirm !== true) {
            return 'destroy 会清空共享树里的包目录（保留 @deepseek-ai junction 与台账/基线）：请带 confirm=true 执行（可先跑 destroy-dry-run 预览）。'
          }
          const outcome = destroyTree(root, { dryRun: mode === 'destroy-dry-run' })
          return [
            mode === 'destroy-dry-run' ? 'destroy 预览（未删除）：' : 'destroy 完成：',
            `将删除/已删除 ${outcome.removed.length} 个顶层条目`,
            `保留：${outcome.kept.join('、') || '（无）'}`,
          ].join('\n')
        }
        throw new Error(`unknown lifecycle mode: ${mode}`)
      }

      if (args.action === 'panel') {
        const profileName = String(args.profile ?? '').trim() || String(currentProfileName(ctx) ?? '').trim()
        if (profileName.length === 0) {
          return '无法确定当前 profile（profileContext 与 pluginManager 都不可用）。请用 profile 参数显式指定，或稍后重试。'
        }
        const wanted = String(args.target ?? '').split(',').map((item) => item.trim()).filter((item) => item.length > 0)
        // 不带 target = 只读报告：树里的 bundle 有哪些在 / 不在该 profile 的官方面板里。
        if (wanted.length === 0) {
          const report = panelReport(root, profileName)
          if (report.ok !== true) return report.error
          const lines = [
            `profile：${profileName}`,
            `树里的 bundle：${report.treeBundles.length} 个`,
            `官方面板可见（${report.visible.length}）：${report.visible.join('、') || '（无）'}`,
            `官方面板看不见（${report.hidden.length}）：${report.hidden.join('、') || '（无）'}`,
          ]
          if (report.hidden.length > 0) {
            lines.push('', '看不见的原因：宿主 pluginManager.readBundles() 的候选集合只来自 profile 清单（dsh.profile.bundles ∪ dependencies），从不 readdir 共享树。')
            lines.push('已启用的包会在启动补扫/启用动作时默认登记；未启用的包可用 shared_tree action=panel target=<包名,…> 手动登记（不加载、不改变启用状态）。')
          }
          return lines.join('\n')
        }
        const expose = args.expose !== false
        const outcome = setPanelVisibility(root, profileName, wanted, expose)
        if (outcome.ok !== true) return `未执行：${outcome.error}`
        const lines = [
          `profile：${profileName}`,
          `动作：${expose ? '登记为面板可见（link: 依赖）' : '撤销面板登记'}`,
          `已改动（${outcome.changed.length}）：${outcome.changed.join('、') || '（无）'}`,
          `已是最新（${outcome.kept.length}）：${outcome.kept.join('、') || '（无）'}`,
        ]
        if (outcome.skipped.length > 0) {
          lines.push(`跳过（${outcome.skipped.length}）：`)
          for (const item of outcome.skipped) lines.push(`- ${item.name}：${item.reason}`)
        }
        if (outcome.note !== undefined) lines.push('', outcome.note)
        if (outcome.changed.length > 0) lines.push('', '需重启 DSH（或该 profile）后官方面板才会重新拉取清单。')
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
      currentProfile: () => currentProfileName(ctx),
      settings: { buildDir, registry, timeoutMs, get firstRun() { return lifecycleFirstRun } },
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