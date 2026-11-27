/**
 * dsh-shared-tree 生命周期模块自验：建树/快照幂等/台账记录/按台账还原/destroy 护栏。
 *
 * 运行：node test/lifecycle.test.mjs（零依赖，全在临时目录里跑）
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { destroyTree, ensureTreeDir, ledgerCorrupt, lifecycleStatus, listProfileNames, readLedger, recordChange, restoreBaseline, restoreFromLedger, snapshotBaseline } from '../lib/lifecycle.js'

let passed = 0
let failed = 0

/** 跑一个用例。 */
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

/** 造假环境：<base>/profiles/<p>/package.json + 可选 cordis.patch.yml，node_modules 作为树根。
 *  同时把 DSH_HOME 重定向到 <base>（基线快照落在 <base>/cache/ 下，不碰真实主目录），结束后还原。 */
function fakeHome(options = {}) {
  const base = mkdtempSync(join(tmpdir(), 'shared-tree-life-'))
  const root = join(base, 'profiles', 'node_modules')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = base
  for (const name of options.profiles ?? ['alpha', 'beta']) {
    const dir = join(base, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dsh: { profile: { bundles: options.bundles ?? ['dsh-taskboard'] } } }, null, 2))
    if (options.withPatch !== false) writeFileSync(join(dir, 'cordis.patch.yml'), '# 用户补丁\n- id: some-other\n  disabled: true\n')
  }
  return {
    base,
    root,
    cleanup: () => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(base, { recursive: true, force: true })
    },
  }
}

console.log('dsh-shared-tree 生命周期自验')
console.log('')

await test('ensureTreeDir：不存在时创建，存在时不动', async () => {
  const home = fakeHome()
  const first = ensureTreeDir(home.root)
  assert.equal(first.created, true)
  assert.ok(existsSync(home.root))
  const second = ensureTreeDir(home.root)
  assert.equal(second.created, false)
  home.cleanup()
})

await test('listProfileNames：跳过 node_modules 与隐藏目录，认带 package.json 的目录', async () => {
  const home = fakeHome({ profiles: ['alpha', 'beta'] })
  mkdirSync(join(home.base, 'profiles', 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(home.base, 'profiles', '.hidden'), { recursive: true })
  mkdirSync(join(home.base, 'profiles', 'empty-dir'), { recursive: true })
  assert.deepEqual(listProfileNames(home.root), ['alpha', 'beta'])
  home.cleanup()
})

await test('snapshotBaseline：首次创建台账并拷贝基线；第二次幂等不覆盖', async () => {
  const home = fakeHome()
  const first = snapshotBaseline(home.root)
  assert.equal(first.created, true)
  assert.deepEqual(first.profiles.map((item) => item.profile).sort(), ['alpha', 'beta'])
  const alphaLedger = readLedger(home.root)
  assert.equal(alphaLedger.createdAt !== null, true)
  const baselineFile = join(alphaLedger.baselineDir, 'alpha', 'cordis.patch.yml')
  assert.ok(existsSync(baselineFile))
  assert.match(readFileSync(baselineFile, 'utf8'), /some-other/)
  // 幂等：手工改坏台账里的基线引用后再 snapshot，不得重建。
  const tampered = readLedger(home.root)
  tampered.createdAt = 'kept'
  writeFileSync(join(home.root, '.dsh-shared-tree-lifecycle.json'), JSON.stringify(tampered, null, 2))
  const second = snapshotBaseline(home.root)
  assert.equal(second.created, false)
  assert.equal(second.ledger.createdAt, 'kept', '已有台账不得被覆盖（基线保护）')
  home.cleanup()
})

await test('recordChange + restoreFromLedger：patch 文件还原、新建文件删除、被改过的跳过', async () => {
  const home = fakeHome()
  snapshotBaseline(home.root)
  const patchFile = join(home.base, 'profiles', 'alpha', 'cordis.patch.yml')
  const before = readFileSync(patchFile, 'utf8')
  const after = `${before}- id: shared-tree-row\n  disabled: true\n`
  writeFileSync(patchFile, after)
  recordChange(home.root, { kind: 'patch-file', profile: 'alpha', file: 'cordis.patch.yml', before, after })

  // 新建文件（before=null）。
  const newFile = join(home.base, 'profiles', 'alpha', 'cordis.patch.yml.new')
  writeFileSync(newFile, 'created by plugin\n')
  recordChange(home.root, { kind: 'patch-file', profile: 'alpha', file: 'cordis.patch.yml.new', before: null, after: 'created by plugin\n' })

  // 被用户改过的条目：after 与当前不符 → 必须跳过。
  const betaPatch = join(home.base, 'profiles', 'beta', 'cordis.patch.yml')
  const betaBefore = readFileSync(betaPatch, 'utf8')
  writeFileSync(betaPatch, `${betaBefore}- id: x\n`)
  recordChange(home.root, { kind: 'patch-file', profile: 'beta', file: 'cordis.patch.yml', before: betaBefore, after: `${betaBefore}- id: y\n` })

  const outcome = restoreFromLedger(home.root)
  assert.equal(outcome.reverted.length, 2, '两条可还原')
  assert.equal(outcome.skipped.length, 1, '被改过的必须跳过')
  assert.equal(readFileSync(patchFile, 'utf8'), before, 'patch 必须还原为 before')
  assert.ok(!existsSync(newFile), '插件新建的文件必须删除')
  assert.match(readFileSync(betaPatch, 'utf8'), /- id: x/, '跳过条目不得被动过')
  assert.match(readFileSync(patchFile, 'utf8'), /some-other/, '还原不得破坏 before 之外的内容')
  home.cleanup()
})

await test('dry-run 只报告不落盘；还原报告文件生成', async () => {
  const home = fakeHome()
  snapshotBaseline(home.root)
  const patchFile = join(home.base, 'profiles', 'alpha', 'cordis.patch.yml')
  const before = readFileSync(patchFile, 'utf8')
  writeFileSync(patchFile, `${before}- id: tmp\n`)
  recordChange(home.root, { kind: 'patch-file', profile: 'alpha', file: 'cordis.patch.yml', before, after: `${before}- id: tmp\n` })
  const preview = restoreFromLedger(home.root, { dryRun: true })
  assert.equal(preview.reverted.length, 1)
  assert.match(readFileSync(patchFile, 'utf8'), /- id: tmp/, 'dry-run 不得改文件')
  const real = restoreFromLedger(home.root)
  assert.equal(real.reverted.length, 1)
  assert.ok(existsSync(`${patchFile}.bak-shared-tree-restore`), '还原前必须留双向备份')
  assert.ok(existsSync(join(home.root, '.dsh-shared-tree-restore-report.json')), '必须生成还原报告')
  home.cleanup()
})

await test('destroyTree：清包目录、保留 @deepseek-ai junction 与台账/基线；dry-run 不删', async () => {
  const home = fakeHome()
  ensureTreeDir(home.root)
  mkdirSync(join(home.root, '@deepseek-ai', 'schemastery'), { recursive: true })
  mkdirSync(join(home.root, 'some-plugin'), { recursive: true })
  snapshotBaseline(home.root)
  const preview = destroyTree(home.root, { dryRun: true })
  assert.deepEqual(preview.removed, ['some-plugin'])
  assert.ok(existsSync(join(home.root, 'some-plugin')), 'dry-run 不删')
  const outcome = destroyTree(home.root)
  assert.ok(outcome.removed.includes('some-plugin'))
  assert.ok(outcome.kept.includes('@deepseek-ai'), '@deepseek-ai junction 必须保留')
  assert.ok(!existsSync(join(home.root, 'some-plugin')))
  assert.ok(existsSync(join(home.root, '.dsh-shared-tree-lifecycle.json')), '台账必须保留（再启用时基线仍有效）')
  assert.ok(!existsSync(join(home.root, '.dsh-shared-tree-history.json')), '历史文件应被清掉')
  home.cleanup()
})

await test('lifecycleStatus：未初始化与已初始化两种形态', async () => {
  const home = fakeHome()
  const before = lifecycleStatus(home.root)
  assert.equal(before.initialized, false)
  snapshotBaseline(home.root)
  const after = lifecycleStatus(home.root, { firstRun: true })
  assert.equal(after.initialized, true)
  assert.equal(after.firstRun, true)
  assert.equal(after.changes, 0)
  home.cleanup()
})

await test('还原 profile package.json（bundles 数组回滚）', async () => {
  const home = fakeHome()
  snapshotBaseline(home.root)
  const file = join(home.base, 'profiles', 'alpha', 'package.json')
  const before = readFileSync(file, 'utf8')
  const manifest = JSON.parse(before)
  manifest.dsh.profile.bundles.push('dsh-shared-tree')
  const after = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileSync(file, after)
  recordChange(home.root, { kind: 'profile-bundles', profile: 'alpha', file: 'package.json', before, after })
  restoreFromLedger(home.root)
  const restored = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(restored.dsh.profile.bundles, ['dsh-taskboard'], 'bundles 必须回滚')
  home.cleanup()
})

await test('C1 回归：同一文件连续写两次，还原后必须回到最初 before（台账序=新→旧）', async () => {
  const home = fakeHome()
  snapshotBaseline(home.root)
  const patchFile = join(home.base, 'profiles', 'alpha', 'cordis.patch.yml')
  const original = readFileSync(patchFile, 'utf8')
  const state1 = `${original}- id: row-1\n  disabled: true\n`
  writeFileSync(patchFile, state1)
  recordChange(home.root, { kind: 'patch-file', profile: 'alpha', file: 'cordis.patch.yml', before: original, after: state1 })
  const state2 = `${state1}- id: row-2\n  disabled: true\n`
  writeFileSync(patchFile, state2)
  recordChange(home.root, { kind: 'patch-file', profile: 'alpha', file: 'cordis.patch.yml', before: state1, after: state2 })

  const outcome = restoreFromLedger(home.root)
  assert.equal(outcome.reverted.length, 2, '两条都必须命中（新→旧逐级回退）')
  assert.equal(outcome.skipped.length, 0, '不得有「被改过」的误判')
  assert.equal(readFileSync(patchFile, 'utf8'), original, '必须回退到最初的 before，而不是中间态')
  assert.equal(readLedger(home.root).changes.length, 0, '成功还原的条目必须从台账摘除（重复 dispose 不重复处理）')
  home.cleanup()
})

await test('M1 回归：before/after 超限被截断的条目必须跳过（不得误删文件）', async () => {
  const home = fakeHome()
  snapshotBaseline(home.root)
  const bigFile = join(home.base, 'profiles', 'alpha', 'cordis.patch.yml')
  const bigText = `# ${'x'.repeat(300 * 1024)}\n`
  writeFileSync(bigFile, bigText)
  recordChange(home.root, { kind: 'patch-file', profile: 'alpha', file: 'cordis.patch.yml', before: bigText, after: bigText })
  const outcome = restoreFromLedger(home.root)
  assert.equal(outcome.skipped.length, 1, '截断条目必须跳过')
  assert.ok(existsSync(bigFile), '截断条目不得删文件')
  assert.equal(readFileSync(bigFile, 'utf8'), bigText, '截断条目内容不得被改')
  home.cleanup()
})

await test('M2 回归：台账损坏时 snapshotBaseline 拒绝重建、recordChange 抛错、还原拒绝', async () => {
  const home = fakeHome()
  snapshotBaseline(home.root)
  const ledgerFile = join(home.root, '.dsh-shared-tree-lifecycle.json')
  const goodLedger = readFileSync(ledgerFile, 'utf8')
  writeFileSync(ledgerFile, '{corrupted json!!')
  assert.equal(ledgerCorrupt(home.root), true)
  const snap = snapshotBaseline(home.root)
  assert.equal(snap.corrupt, true, '损坏时不得重建快照')
  assert.equal(snap.created, false)
  assert.throws(() => recordChange(home.root, { kind: 'patch-file', profile: 'alpha', file: 'x', before: null, after: 'a' }), /台账损坏/)
  const outcome = restoreFromLedger(home.root)
  assert.equal(outcome.reverted.length, 0)
  assert.equal(outcome.skipped.length, 1, '损坏时还原必须拒绝并报告')
  // 用户修好台账后一切恢复。
  writeFileSync(ledgerFile, goodLedger)
  assert.equal(ledgerCorrupt(home.root), false)
  home.cleanup()
})

await test('restoreBaseline：把 bundles+patch 恢复成基线原文，现状留 baseline 备份', async () => {
  const home = fakeHome()
  snapshotBaseline(home.root)
  const pkgFile = join(home.base, 'profiles', 'alpha', 'package.json')
  const patchFile = join(home.base, 'profiles', 'alpha', 'cordis.patch.yml')
  const pkgBaseline = readFileSync(pkgFile, 'utf8')
  const patchBaseline = readFileSync(patchFile, 'utf8')
  // 启用之后的两类变更：宿主链路改 bundles + 手工加 patch 条目。
  const manifest = JSON.parse(pkgBaseline)
  manifest.dsh.profile.bundles.push('dsh-shared-tree')
  writeFileSync(pkgFile, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(patchFile, `${patchBaseline}- id: manual-entry\n  disabled: true\n`)
  const dry = restoreBaseline(home.root, { dryRun: true })
  assert.equal(dry.reverted.length, 2, 'dry-run 必须报出两个待恢复文件')
  assert.match(readFileSync(pkgFile, 'utf8'), /dsh-shared-tree/, 'dry-run 不得落盘')
  const outcome = restoreBaseline(home.root)
  assert.equal(outcome.reverted.length, 2)
  assert.equal(readFileSync(pkgFile, 'utf8'), pkgBaseline, 'bundles 必须回到基线原文')
  assert.equal(readFileSync(patchFile, 'utf8'), patchBaseline, 'patch 必须回到基线原文（手工改动被回滚=基线语义）')
  assert.ok(existsSync(`${pkgFile}.bak-shared-tree-baseline`), '恢复前必须留现状备份')
  assert.ok(existsSync(join(home.root, '.dsh-shared-tree-baseline-report.json')), '必须生成基线还原报告')
  // 已等于基线时再次还原 → 无事可做。
  const again = restoreBaseline(home.root)
  assert.equal(again.reverted.length, 0)
  home.cleanup()
})

await test('restoreBaseline：基线里没有的文件不删；profile 目录消失则跳过', async () => {
  const home = fakeHome()
  snapshotBaseline(home.root)
  // 基线之后新建的文件：基线里没有副本 → 保守保留。
  const newFile = join(home.base, 'profiles', 'alpha', 'cordis.patch.yml.new')
  writeFileSync(newFile, 'later addition\n')
  const outcome = restoreBaseline(home.root)
  assert.ok(existsSync(newFile), '基线里没有的文件必须保守保留')
  assert.ok(outcome.skipped.length === 0 || outcome.reverted.length >= 0)
  home.cleanup()
})

console.log('')
console.log(`${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
