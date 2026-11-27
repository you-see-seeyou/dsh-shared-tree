#!/usr/bin/env node
/**
 * dsh-shared-tree 生命周期独立还原脚本。
 *
 * 用途：插件已被物理删除（或卸载）后，代码无法再自动还原——用这个脚本读台账手工还原。
 * 零依赖，纯 Node 内置（>=20），不需要 dsh-shared-tree 已安装。
 *
 * 用法：
 *   node scripts/lifecycle-restore.mjs                 # 还原（交互安全：先打印预览再执行）
 *   node scripts/lifecycle-restore.mjs --dry-run       # 只预览
 *   node scripts/lifecycle-restore.mjs --status        # 只看台账状态
 *   node scripts/lifecycle-restore.mjs --destroy --confirm  # 清空共享树包目录（保留 @deepseek-ai junction 与台账）
 *
 * 环境变量 DSH_HOME 可覆盖主目录（默认 ~/.dsh）。
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { destroyTree, ensureTreeDir, lifecycleStatus, restoreBaseline, restoreFromLedger } from '../lib/lifecycle.js'

const args = new Set(process.argv.slice(2))
const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
  ? resolve(process.env.DSH_HOME)
  : join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const root = join(home, 'profiles', 'node_modules')

if (args.has('--status')) {
  console.log(JSON.stringify(lifecycleStatus(root), null, 2))
  process.exit(0)
}

if (!existsSync(join(root, '.dsh-shared-tree-lifecycle.json'))) {
  console.error(`没有找到生命周期台账：${join(root, '.dsh-shared-tree-lifecycle.json')}`)
  console.error('（该插件从未启用过，或台账已被删除——没有可还原的内容。）')
  process.exit(1)
}

if (args.has('--baseline')) {
  const dryRun = args.has('--dry-run')
  if (!dryRun && !args.has('--confirm')) {
    console.log('基线还原预览（未落盘，加 --confirm 才真正执行；会把每个 profile 的 package.json/cordis.patch.yml')
    console.log('恢复成启用时刻的快照原文，启用之后的所有配置变更——含手工改动——都会被回滚）：')
    const preview = restoreBaseline(root, { dryRun: true })
    for (const item of preview.reverted) console.log(`  ↩ ${item}`)
    for (const item of preview.skipped) console.log(`  ⤼ ${item}`)
    console.log(`共 ${preview.reverted.length} 个文件将恢复基线，${preview.skipped.length} 条跳过。`)
    process.exit(0)
  }
  const outcome = restoreBaseline(root, { dryRun })
  console.log(dryRun
    ? `dry-run：将恢复 ${outcome.reverted.length} 个文件到基线，跳过 ${outcome.skipped.length} 条。`
    : `基线还原完成：${outcome.reverted.length} 个文件已恢复（现状留 *.bak-shared-tree-baseline 备份），跳过 ${outcome.skipped.length} 条。明细见 .dsh-shared-tree-baseline-report.json。`)
  process.exit(0)
}

if (args.has('--destroy')) {
  if (!args.has('--confirm')) {
    console.log('destroy 预览（未删除，加 --confirm 才真正执行）：')
    const preview = destroyTree(root, { dryRun: true })
    console.log(`  将删除 ${preview.removed.length} 个顶层条目`)
    console.log(`  保留：${preview.kept.join('、') || '（无）'}`)
    process.exit(0)
  }
  const outcome = destroyTree(root)
  console.log(`destroy 完成：删除 ${outcome.removed.length} 个顶层条目；保留：${outcome.kept.join('、') || '（无）'}`)
  process.exit(0)
}

const dryRun = args.has('--dry-run')
if (!dryRun) {
  console.log('预览：')
  const preview = restoreFromLedger(root, { dryRun: true })
  for (const item of preview.reverted) console.log(`  ↩ ${item}`)
  for (const item of preview.skipped) console.log(`  ⤼ 跳过：${item}`)
  console.log(`共 ${preview.reverted.length} 条将还原，${preview.skipped.length} 条跳过。`)
  if (preview.reverted.length === 0) {
    console.log('没有可还原的条目，结束。')
    process.exit(0)
  }
}
ensureTreeDir(root)
const outcome = restoreFromLedger(root, { dryRun })
if (dryRun) {
  console.log(`dry-run：将还原 ${outcome.reverted.length} 条，跳过 ${outcome.skipped.length} 条。`)
} else {
  console.log(`还原完成：${outcome.reverted.length} 条已还原，${outcome.skipped.length} 条跳过。`)
  console.log('明细见共享树根的 .dsh-shared-tree-restore-report.json。')
}
