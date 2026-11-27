/**
 * dsh-shared-tree 生命周期管理：启用时建树 + 各 profile 基线快照；停用/显式还原时按台账回滚。
 *
 * 语义（与用户确认的方案一致）：
 *   - 启用（宿主 apply）：确保共享树目录存在；若尚无台账则为每个 profile 做基线快照
 *     （package.json / cordis.patch.yml 原文副本），台账记在 <root>/.dsh-shared-tree-lifecycle.json。
 *   - 停用（ctx.effect 清理）：按台账【只还原本插件写过的文件】——先比对当前内容是否仍是
 *     插件写入的 `after` 快照，一致才还原为 `before`（不一致说明用户后来改过，跳过并报告），
 *     绝不整包回滚 profile。还原动作本身先留 `*.bak-shared-tree-restore` 双向备份。
 *   - 物理删除插件后代码无法运行：scripts/lifecycle-restore.mjs 用同一个模块独立还原。
 *
 * 设计约束（勿改）：零依赖（Node 内置 only），与 index.js 无反向依赖（避免环）。
 *
 * @module dsh-shared-tree/lifecycle
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 台账文件名（在共享树根下，与清单/历史同层）。 */
export const LEDGER_FILE = '.dsh-shared-tree-lifecycle.json'
/** 台账 scheme。 */
export const LEDGER_SCHEME = 'dsh-shared-tree-lifecycle/1'
/** 基线快照根：<DSH_HOME>/cache/shared-tree-lifecycle/baseline/<profile>/。 */
const BASELINE_SUBPATH = ['cache', 'shared-tree-lifecycle', 'baseline']
/** 单条变更的 before/after 文本上限（超出按截断处理，还原时比对失败会跳过）。 */
const SNAPSHOT_MAX_BYTES = 256 * 1024
/** 台账最多保留的变更条数（新的在前）。 */
const LEDGER_MAX_CHANGES = 300

/**
 * DSH 用户主目录（DSH_HOME 优先，否则 ~/.dsh）。与 index.js 同语义的独立实现（避免环依赖）。
 * @returns {string} 绝对路径。
 */
export function dshHomePath() {
  const override = process.env.DSH_HOME
  return resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
}

/**
 * 列出所有 profile 目录名（<home>/profiles 下带 package.json 的目录，跳过 node_modules/隐藏目录）。
 * @param {string} root 共享树根。
 * @returns {string[]} profile 名（排序后）。
 */
export function listProfileNames(root) {
  const dir = resolve(root, '..')
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
    if (!existsSync(join(dir, entry.name, 'package.json'))) continue
    found.push(entry.name)
  }
  return found.sort()
}

/**
 * 读台账。缺失/损坏按空台账处理（caller 随后整体重写）。
 * @param {string} root 共享树根。
 * @returns {object} 台账。
 */
export function readLedger(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, LEDGER_FILE), 'utf8'))
    if (raw !== null && typeof raw === 'object' && Array.isArray(raw.changes)) return raw
  } catch {
    // 缺失或损坏按空台账处理。
  }
  return { scheme: LEDGER_SCHEME, createdAt: null, baselineDir: null, profiles: [], changes: [] }
}

/**
 * 写台账。
 * @param {string} root 共享树根。
 * @param {object} ledger 台账。
 */
function writeLedger(root, ledger) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
}

/**
 * 确保共享树目录存在。
 * @param {string} root 共享树根。
 * @returns {{ created: boolean, root: string }} 结果。
 */
export function ensureTreeDir(root) {
  const created = !existsSync(root)
  if (created) mkdirSync(root, { recursive: true })
  return { created, root }
}

/**
 * 启用时做基线快照（幂等：已有台账则不覆盖，保护最初基线）。
 * 对每个 profile：package.json 必有；cordis.patch.yml 可无。
 * @param {string} root 共享树根。
 * @returns {{ created: boolean, profiles: string[], baselineDir: string|null, ledger: object }} 结果。
 */
export function snapshotBaseline(root) {
  const existing = readLedger(root)
  if (existing.createdAt !== null) {
    return { created: false, profiles: existing.profiles ?? [], baselineDir: existing.baselineDir ?? null, ledger: existing }
  }
  const profileNames = listProfileNames(root)
  const baselineDir = resolve(dshHomePath(), ...BASELINE_SUBPATH)
  const profiles = []
  for (const name of profileNames) {
    const profileDir = resolve(root, '..', name)
    const target = join(baselineDir, name)
    mkdirSync(target, { recursive: true })
    const entry = { profile: name, files: [] }
    for (const file of ['package.json', 'cordis.patch.yml']) {
      const source = join(profileDir, file)
      if (!existsSync(source)) continue
      try {
        copyFileSync(source, join(target, file))
        entry.files.push(file)
      } catch {
        // 单个文件拷不动不致命，跳过。
      }
    }
    profiles.push(entry)
  }
  const ledger = {
    scheme: LEDGER_SCHEME,
    createdAt: new Date().toISOString(),
    baselineDir,
    profiles,
    changes: [],
  }
  writeLedger(root, ledger)
  return { created: true, profiles, baselineDir, ledger }
}

/**
 * 记录一条本插件写过的变更（供停用/显式还原回滚）。
 * @param {string} root 共享树根。
 * @param {{ kind: string, profile: string, file: string, before: string|null, after: string|null }} change 变更。
 * @returns {number} 台账变更总数。
 */
export function recordChange(root, change) {
  const ledger = readLedger(root)
  const clip = (text) => (typeof text === 'string' && text.length > SNAPSHOT_MAX_BYTES ? null : text)
  ledger.changes = [{
    at: new Date().toISOString(),
    kind: change.kind,
    profile: change.profile,
    file: change.file,
    before: clip(change.before),
    after: clip(change.after),
  }, ...(Array.isArray(ledger.changes) ? ledger.changes : [])].slice(0, LEDGER_MAX_CHANGES)
  writeLedger(root, ledger)
  return ledger.changes.length
}

/**
 * 读文件文本；不存在返回 null；超限返回 null（无法安全比对，还原时会跳过该条）。
 * @param {string} file 文件路径。
 * @returns {string|null} 文本。
 */
function textOf(file) {
  try {
    const text = readFileSync(file, 'utf8')
    return text.length > SNAPSHOT_MAX_BYTES ? null : text
  } catch {
    return null
  }
}

/**
 * 按台账还原本插件写过的变更（倒序逐条）。
 * 每条：当前内容 === after 才还原为 before（before=null 且当前===after 则删除文件）；
 * 不一致说明用户后来改过 → 跳过并报告。还原前留 *.bak-shared-tree-restore 双向备份。
 * @param {string} root 共享树根。
 * @param {{ dryRun?: boolean }} [options] dryRun 只报告不落盘。
 * @returns {{ reverted: string[], skipped: string[], report: object }} 结果。
 */
export function restoreFromLedger(root, options = {}) {
  const ledger = readLedger(root)
  const reverted = []
  const skipped = []
  const changes = [...(Array.isArray(ledger.changes) ? ledger.changes : [])].reverse()
  for (const change of changes) {
    const label = `${change.profile}:${change.kind}`
    const file = resolve(root, '..', change.profile, change.file)
    const current = textOf(file)
    if (current === null || change.after === null || current !== change.after) {
      skipped.push(`${label}（当前内容与插件写入时不同，已跳过——可能你后来手工改过）`)
      continue
    }
    if (options.dryRun === true) {
      reverted.push(`${label}（dry-run：将还原）`)
      continue
    }
    try {
      copyFileSync(file, `${file}.bak-shared-tree-restore`)
    } catch {
      // 备份失败也继续还原（当前内容已存进 skipped 场景之外，after 在台账里可追溯）。
    }
    if (change.before === null) {
      rmSync(file, { force: true })
    } else {
      writeFileSync(file, change.before, 'utf8')
    }
    reverted.push(label)
  }
  if (options.dryRun !== true) {
    const report = { at: new Date().toISOString(), reverted, skipped }
    try {
      writeFileSync(join(root, '.dsh-shared-tree-restore-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    } catch {
      // 报告写不下不影响还原本身。
    }
  }
  return { reverted, skipped, report: { reverted: reverted.length, skipped: skipped.length } }
}

/**
 * 生命周期状态摘要（给 UI / 工具 / 路由共用）。
 * @param {string} root 共享树根。
 * @param {{ firstRun?: boolean }} [extra] 进程内标记（本次启用刚建台账）。
 * @returns {object} 状态。
 */
export function lifecycleStatus(root, extra = {}) {
  const ledger = readLedger(root)
  return {
    initialized: ledger.createdAt !== null,
    createdAt: ledger.createdAt,
    baselineDir: ledger.baselineDir,
    profiles: ledger.profiles ?? [],
    changes: (ledger.changes ?? []).length,
    ...extra,
  }
}

/**
 * 清空共享树（destroy）：删除顶层包目录与插件工件（清单/历史），保留 @deepseek-ai junction、
 * 台账与基线快照（再启用时基线仍有效）。高危动作，调用方必须先拿到用户确认。
 * @param {string} root 共享树根。
 * @param {{ dryRun?: boolean }} [options] dryRun 只报告。
 * @returns {{ removed: string[], kept: string[] }} 结果。
 */
export function destroyTree(root, options = {}) {
  const removed = []
  const kept = []
  if (!existsSync(root)) return { removed, kept }
  const protectedArtifacts = new Set([LEDGER_FILE, '.dsh-shared-tree.json', '.dsh-shared-tree-history.json', '.dsh-shared-tree-restore-report.json'])
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) { kept.push(entry.name); continue }
    if (entry.name === '@deepseek-ai') { kept.push(entry.name); continue }
    const full = join(root, entry.name)
    if (options.dryRun === true) { removed.push(entry.name); continue }
    try {
      rmSync(full, { recursive: true, force: true })
      removed.push(entry.name)
    } catch {
      kept.push(entry.name)
    }
  }
  if (options.dryRun !== true) {
    for (const artifact of ['.dsh-shared-tree.json', '.dsh-shared-tree-history.json']) {
      try {
        rmSync(join(root, artifact), { force: true })
      } catch {
        // 清不掉不致命。
      }
    }
  }
  void protectedArtifacts
  return { removed, kept }
}
