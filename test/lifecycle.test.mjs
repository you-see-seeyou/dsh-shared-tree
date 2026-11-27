/**
 * dsh-shared-tree 生命周期模块自验：建树/快照幂等/台账记录/按台账还原/destroy 护栏。
 *
 * 运行：node test/lifecycle.test.mjs（零依赖，全在临时目录里跑）
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { destroyTree, ensureTreeDir, lifecycleStatus, listProfileNames, readLedger, recordChange, restoreFromLedger, snapshotBaseline } from '../lib/lifecycle.js'

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

console.log('')
console.log(`${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
