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
 * 读台账。缺失返回空台账（caller 随后整体重写）；**损坏返回 { corrupt: true }**——
 * 损坏时绝不静默重建（否则基线会被当前可能已改过的文件覆盖）。
 * @param {string} root 共享树根。
 * @returns {object} 台账；损坏时 { corrupt: true }。
 */
export function readLedger(root) {
  const file = join(root, LEDGER_FILE)
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw !== null && typeof raw === 'object' && Array.isArray(raw.changes)) return raw
    } catch {
      return { corrupt: true }
    }
    return { corrupt: true }
  }
  return { scheme: LEDGER_SCHEME, createdAt: null, baselineDir: null, profiles: [], changes: [] }
}

/**
 * 台账是否损坏（存在但解析失败/结构不对）。
 * @param {string} root 共享树根。
 * @returns {boolean} 是否损坏。
 */
export function ledgerCorrupt(root) {
  return readLedger(root).corrupt === true
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
  // 台账损坏（如手改坏 JSON）时绝不重建：重建会用「当前可能已被改过」的文件覆盖最初基线，
  // 且清空全部变更历史。此时要求用户先修好/确认删除坏台账文件。
  if (ledgerCorrupt(root)) {
    return { created: false, corrupt: true, profiles: [], baselineDir: null, ledger: readLedger(root) }
  }
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
  // 独立还原脚本复制一份到基线目录：插件被物理删除后，lib/ 里的原件也随之消失，
  // 这份副本是"删除后还原"的最后手段。
  try {
    const scriptSource = new URL('../scripts/lifecycle-restore.mjs', import.meta.url)
    const scriptText = readFileSync(scriptSource, 'utf8')
    mkdirSync(baselineDir, { recursive: true })
    writeFileSync(join(baselineDir, 'lifecycle-restore.mjs'), scriptText, 'utf8')
  } catch {
    // 脚本拷不到不致命（lib 里还有原件）。
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
 * 超限文本不静默置 null（null 的语义是「文件原本不存在→还原时删除」），
 * 改记 clipped 标记；带 clipped 标记的条目在还原时一律跳过并报告。
 * 台账损坏时抛错（index.js 侧已有 try/catch 兜底），避免丢失全部历史。
 * @param {string} root 共享树根。
 * @param {{ kind: string, profile: string, file: string, before: string|null, after: string|null }} change 变更。
 * @returns {number} 台账变更总数。
 */
export function recordChange(root, change) {
  if (ledgerCorrupt(root)) {
    throw new Error('生命周期台账损坏，拒绝记录变更（请先修复或确认删除 .dsh-shared-tree-lifecycle.json）')
  }
  const ledger = readLedger(root)
  const capture = (text) => {
    if (typeof text !== 'string') return { value: null, clipped: false }
    if (text.length > SNAPSHOT_MAX_BYTES) return { value: null, clipped: true }
    return { value: text, clipped: false }
  }
  const before = capture(change.before)
  const after = capture(change.after)
  ledger.changes = [{
    at: new Date().toISOString(),
    kind: change.kind,
    profile: change.profile,
    file: change.file,
    before: before.value,
    beforeClipped: before.clipped,
    after: after.value,
    afterClipped: after.clipped,
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
 * 按台账还原本插件写过的变更。
 * 台账序 = 新条目在前，处理顺序就是**新 → 旧**：同一文件被连续写 n 次时，先还原最新一条
 * 得到上一中间态，下一条立即匹配，逐级回退到最初的 before（倒序处理是错的，会卡在中间态）。
 * 每条：当前内容 === after 才还原为 before（before=null 且当前===after 则删除文件）；
 * before/after 被截断（clipped）或内容不一致 → 跳过并报告。还原前留 *.bak-shared-tree-restore 双向备份。
 * 成功还原的条目会从台账摘除（报告文件留档），重复 dispose 不会重复处理。
 * @param {string} root 共享树根。
 * @param {{ dryRun?: boolean }} [options] dryRun 只报告不落盘。
 * @returns {{ reverted: string[], skipped: string[], report: object }} 结果。
 */
export function restoreFromLedger(root, options = {}) {
  if (ledgerCorrupt(root)) {
    return { reverted: [], skipped: ['台账损坏，拒绝还原（请先修复或确认删除 .dsh-shared-tree-lifecycle.json）'], report: { reverted: 0, skipped: 1 } }
  }
  const ledger = readLedger(root)
  const reverted = []
  const skipped = []
  const remaining = []
  for (const change of Array.isArray(ledger.changes) ? ledger.changes : []) {
    const label = `${change.profile}:${change.kind}`
    if (change.beforeClipped === true || change.afterClipped === true) {
      skipped.push(`${label}（快照超限被截断，无法安全比对——跳过）`)
      remaining.push(change)
      continue
    }
    const file = resolve(root, '..', change.profile, change.file)
    const current = textOf(file)
    if (current === null || change.after === null || current !== change.after) {
      skipped.push(`${label}（当前内容与插件写入时不同，已跳过——可能你后来手工改过）`)
      remaining.push(change)
      continue
    }
    if (options.dryRun === true) {
      reverted.push(`${label}（dry-run：将还原）`)
      remaining.push(change)
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
    // 成功还原的条目摘出台账（报告文件留档），重复 dispose / 显式还原不会重复处理。
  }
  if (options.dryRun !== true) {
    ledger.changes = remaining
    writeLedger(root, ledger)
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
 * 捕获所有 profile 某个相对文件的当前文本（供宿主链路写入的差异记账）。
 * @param {string} root 共享树根。
 * @param {string} relFile 相对 profile 目录的文件名（如 'package.json'、'cordis.patch.yml'）。
 * @returns {Record<string, string|null>} profile → 文本（缺失为 null）。
 */
export function captureProfileFiles(root, relFile) {
  const map = {}
  for (const name of listProfileNames(root)) {
    const file = join(resolve(root, '..'), name, relFile)
    try {
      const text = readFileSync(file, 'utf8')
      map[name] = text.length > SNAPSHOT_MAX_BYTES ? null : text
    } catch {
      map[name] = null
    }
  }
  return map
}

/**
 * 把「宿主链路写入」的差异记进台账：对每个内容发生变化的 profile 记一条。
 * 用于走 pluginManager 原生写入的路径（/set、/set-row 的 manager 分支）——
 * 宿主自己落盘不经我们的备份，差异记账是它们唯一的停用还原凭据。
 * @param {string} root 共享树根。
 * @param {string} kind 变更类别（'profile-bundles' | 'patch-file'）。
 * @param {string} relFile 相对文件名。
 * @param {Record<string, string|null>} before 写入前快照。
 * @param {Record<string, string|null>} after 写入后快照。
 * @returns {number} 记录的条数。
 */
export function recordProfileFileChanges(root, kind, relFile, beforeMap, afterMap) {
  let count = 0
  for (const [profile, before] of Object.entries(beforeMap)) {
    const after = afterMap[profile] ?? null
    if (before !== after) {
      try {
        recordChange(root, { kind, profile, file: relFile, before, after })
        count += 1
      } catch {
        // 台账损坏等场景：记账失败不致命（还原兜底还有独立脚本与基线）。
      }
    }
  }
  return count
}

/**
 * 基线还原：把每个 profile 的 package.json / cordis.patch.yml 恢复成启用时刻的快照原文。
 * 只恢复基线里**有副本**的文件；基线之后新建的文件不删（保守，报告里注明）。
 * 当前内容已等于基线 → 跳过；恢复前把现状备份为 *.bak-shared-tree-baseline（双向可回）。
 * @param {string} root 共享树根。
 * @param {{ dryRun?: boolean }} [options] dryRun 只报告。
 * @returns {{ reverted: string[], skipped: string[], report: object }} 结果。
 */
export function restoreBaseline(root, options = {}) {
  if (ledgerCorrupt(root)) {
    return { reverted: [], skipped: ['台账损坏，拒绝基线还原'], report: { reverted: 0, skipped: 1 } }
  }
  const ledger = readLedger(root)
  if (ledger.createdAt === null) {
    return { reverted: [], skipped: ['尚未初始化（没有基线快照）'], report: { reverted: 0, skipped: 1 } }
  }
  const reverted = []
  const skipped = []
  for (const entry of Array.isArray(ledger.profiles) ? ledger.profiles : []) {
    const profileDir = resolve(root, '..', entry.profile)
    if (!existsSync(profileDir)) {
      skipped.push(`${entry.profile}（profile 目录已不存在）`)
      continue
    }
    for (const file of Array.isArray(entry.files) ? entry.files : []) {
      const baselineFile = join(ledger.baselineDir ?? '', entry.profile, file)
      const current = join(profileDir, file)
      if (!existsSync(baselineFile)) continue
      const baseText = readFileSync(baselineFile, 'utf8')
      const curText = existsSync(current) ? readFileSync(current, 'utf8') : null
      if (curText === baseText) continue
      if (options.dryRun === true) {
        reverted.push(`${entry.profile}/${file}（dry-run：将恢复基线）`)
        continue
      }
      try {
        if (existsSync(current)) copyFileSync(current, `${current}.bak-shared-tree-baseline`)
        copyFileSync(baselineFile, current)
        reverted.push(`${entry.profile}/${file}`)
      } catch (failure) {
        skipped.push(`${entry.profile}/${file}（恢复失败：${failure instanceof Error ? failure.message : String(failure)}）`)
      }
    }
  }
  if (options.dryRun !== true) {
    const report = { at: new Date().toISOString(), mode: 'baseline', reverted, skipped }
    try {
      writeFileSync(join(root, '.dsh-shared-tree-baseline-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    } catch {
      // 报告写不下不影响还原本身。
    }
  }
  return { reverted, skipped, report: { reverted: reverted.length, skipped: skipped.length } }
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
    // 清掉 .bin：里面是指向已删包的 shim，留着只会产生悬空命令（pnpm 下次安装会重建）。
    try {
      rmSync(join(root, '.bin'), { recursive: true, force: true })
    } catch {
      // 清不掉不致命。
    }
  }
  return { removed, kept }
}
