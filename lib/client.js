/**
 * dsh-shared-tree 的浏览器侧（侧边栏图标 + 主列面板 + 右栏 tab）。
 *
 * 约定（照 dsh-super-kanban / dsh-prompt-rewriter 的既有做法）：
 *   - `window.__ModuleLoader__.load({ id, factory })` 的 **id 必须等于包名**；
 *     写成短名会让系统找不到工厂、回退单资源 URL 再执行一次 → duplicate factory → web boot 失败。
 *   - 只 require('react')；**不** require 任何 @deepseek-ai/dsh-client-* 包
 *     （它们会在版本间变化，且抛错的组件会让槽位直接空白）。
 *   - **未 inject 的服务不能读**：cordis 客户端上下文在未声明注入的服务上取值会抛
 *     `cannot get property "x" without inject`，不是返回 undefined。所以 locale 必须写进
 *     inject，可选服务要用 ctx.inject([...], cb)。
 *   - 数据走 Host 的 `/dsh-shared-tree/*` 路由，与 `shared_tree` 工具同源。
 *   - 搜索/过滤全在本组件内完成，只读，不发写请求；唯一的写请求是 POST /set。
 *
 * @module dsh-shared-tree/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-shared-tree',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** 路由前缀，与 Host 的 ROUTE_PREFIX 一致。 */
    const API = '/dsh-shared-tree'
    /** locale 命名空间。 */
    const NS = 'dsh-shared-tree'
    /** 面板 id：`main` 的 key 与 `sidebar.panellist` 的 id 必须一致，否则点不开对应面板。 */
    const PANEL_ID = 'dsh-shared-tree'
    /** 右栏 tab 的 kind / id。 */
    const SIDE_KIND = 'dsh-shared-tree'
    /** 组件局部样式类名前缀（避免与宿主类名相撞）。 */
    const CLS = 'dst'

    /** 界面文案字典：扁平 key → 文本。en/zh 的 key 必须一一对应。 */
    const DICTS = {
      en: {
        title: 'Shared plugin tree',
        search: 'Search name or description…',
        kindAll: 'All',
        kindBundle: 'dsh.bundle',
        kindClient: 'dsh.client',
        kindLibrary: 'Runtime library',
        selectKind: 'Filter by category',
        selectState: 'Filter by enabled state',
        stateAll: 'Any state',
        stateOn: 'Enabled',
        stateOff: 'Disabled',
        refresh: 'Refresh',
        verify: 'Verify',
        empty: 'No package in the shared tree matches.',
        missingTree: 'The shared tree directory does not exist yet.',
        loading: 'Loading…',
        loadFailed: 'Could not read the shared tree',
        bridgeDown: 'The UI data channel is unavailable (the Host webServer is not mounted). Use the shared_tree tool instead.',
        enable: 'Enable',
        disable: 'Disable',
        working: 'Working…',
        enabledTag: 'enabled',
        disabledTag: 'disabled',
        unknownTag: 'unknown',
        pendingTag: 'enable pending restart',
        junctionOk: 'junctions intact',
        junctionBad: 'junctions damaged',
        needRestart: 'Restart DSH to apply',
        overridden: 'Saved, but a higher-priority layer overrides it — not in effect',
        cancelled: 'Cancelled; files restored, nothing changed',
        actionFailed: 'Action failed',
        applied: 'Applied',
        verifyClean: 'The shared tree matches this plugin\'s manifest.',
        verifyDiff: 'Differs from the manifest (unrecorded / drifted) — see the rows below.',
        verifyCounts: 'In sync / drifted / unrecorded / missing',
        noRows: 'Nothing to report.',
        countEnabled: 'enabled',
        filteredNote: '{n} pure dependency libraries hidden (hoisted by pnpm, not plugins)',
        componentsNote: '{n} component(s) grouped under their owner',
        linkedTitle: 'Linked plugins in this profile ({n})',
        linkedNote: 'Read-only. These are installed as local link: paths, so they do not live in the shared tree and cannot be enabled or disabled here. Use the Plugins page to switch them.',
        linkedBadge: 'linked',
        linkedTarget: 'Path',
        componentOf: 'component of {owner}',
        componentHint: 'Not independently enableable: {owner} already provides this entry id; enabling it separately would insert the id twice and break Settings (issue #470). Switch it in {owner}\'s own settings page.',
        stateUnknown: 'This profile\'s enabled state could not be read (pluginManager unavailable), so every row shows unknown and the buttons are disabled.',
        safetyNote: 'Note',
        hint: 'Packages arrive here from pnpm hoisted installation or this plugin\'s install action, so the count changes; searching and filtering are read-only.',
        rootLabel: 'Tree',
        manifestLabel: 'Manifest',
        updatedLabel: 'updated',
        detail: 'Details',
        upgrade: 'Upgrade',
        rollback: 'Roll back',
        back: 'Back',
        impactTitle: 'Referencing profiles',
        depsTitle: 'Dependency check',
        versionTitle: 'Versions',
        currentVersion: 'Installed',
        latestVersion: 'Latest on registry',
        confirmUpgrade: 'Confirm upgrade',
        fixedExact: 'Pin exact version',
        affectedProfiles: 'This upgrade affects {n} profile(s):',
        noAffected: 'No profile references this package yet.',
        start: 'Start upgrade',
        cancel: 'Cancel',
        stagePrepare: 'Prepare',
        stageBuild: 'Download & build (pnpm)',
        stageMerge: 'Merge into tree',
        stageVerify: 'Verify tree',
        upToDate: 'Already on the latest version.',
        noHistory: 'No upgrade history recorded yet.',
        rollbackTo: 'Roll back to',
        exemptWarn: 'This version declares engines.dsh {required} that could not be verified automatically — confirm manually before upgrading.',
        satisfy: 'satisfied',
        unsatisfied: 'NOT satisfied',
        unknownCheck: 'unknown',
        depsUnavailable: 'Registry metadata unavailable — upgrade stays enabled, please verify manually.',
        profileEnable: 'Enable',
        profileDisable: 'Disable',
        restartNote: 'Saved to this profile\'s dsh.profile.bundles — restart that profile to apply.',
        verifyProfiles: 'Post-upgrade verification',
        checkMatch: 'version matches tree',
        checkMismatch: 'version differs from tree',
        checkLocal: 'local copy',
        jobFailed: 'Upgrade failed',
        jobRunning: 'Upgrading…',
        jobDone: 'Upgrade finished',
        workingOnIt: 'Working…',
        peerLabel: 'peer',
        nodeLabel: 'node engine',
        dshLabel: 'dsh engine',
        installConflict: 'Another install task is already running.',
        historyLabel: 'History versions',
        impactLoadFailed: 'Could not load impact data',
        featuresTitle: 'Provided features (loader entries)',
        debugTitle: 'Debug',
        entryEnabledTag: 'on',
        entryDisabledTag: 'off (overridden)',
        configKeysLabel: 'config keys',
        patchTextLabel: 'Patch source',
        targetProfileLabel: 'Apply to profile',
        featureLoadFailed: 'Could not load entries',
        debugLoadFailed: 'Could not load debug info',
        hashOkTag: 'hash matches manifest',
        hashBadTag: 'hash drifted',
        hashUnknownTag: 'hash unknown',
        bundleUnknown: 'not visible to this profile',
        availabilityLabel: 'availability',
        rowsLabel: 'rows',
        referencedBy: 'referenced by',
        wholeRowHint: 'Click the row for details / debug',
        docSection: 'Description',
        docRetry: 'Retry',
        docFailed: 'Could not load the description',
        docMissing: 'This plugin ships no description document.',
        rowsSection: 'Feature switches',
        rowsFilter: 'Filter rows…',
        rowOff: 'off',
        rowStateIdle: 'idle',
        rowSwitchLabel: 'Toggle {name}',
        tabDoc: 'Description',
        tabUpgrade: 'Upgrade',
        tabVersion: 'Versions & integrity',
        tabProfiles: 'Profiles',
        lifeInit: 'Lifecycle: initialized',
        lifeProfiles: 'baseline profiles',
        lifeChanges: 'tracked changes',
        lifeUninitialized: 'Lifecycle: no baseline snapshot recorded yet',
        lifeGuide: 'Initialized: the shared tree was created and baseline snapshots of every profile were recorded. Disabling this plugin automatically reverts only the config changes made through it.',
      },
      zh: {
        title: '共享插件树',
        search: '搜索包名或描述…',
        kindAll: '全部',
        kindBundle: 'dsh.bundle',
        kindClient: 'dsh.client',
        kindLibrary: '纯运行时库',
        selectKind: '按类别过滤',
        selectState: '按启用状态过滤',
        stateAll: '全部状态',
        stateOn: '已启用',
        stateOff: '未启用',
        refresh: '刷新',
        verify: '校验',
        empty: '共享树里没有匹配的包。',
        missingTree: '共享树目录还不存在。',
        loading: '读取中…',
        loadFailed: '读取共享树失败',
        bridgeDown: '界面数据通道不可用（Host 的 webServer 未挂载）。请改用 shared_tree 工具。',
        enable: '启用',
        disable: '关闭',
        working: '处理中…',
        enabledTag: '已启用',
        disabledTag: '未启用',
        unknownTag: '状态未知',
        pendingTag: '已启用，待重启',
        junctionOk: 'junction 完好',
        junctionBad: 'junction 异常',
        needRestart: '需重启 DSH 生效',
        overridden: '已保存，但被更高优先级层覆盖，当前不生效',
        cancelled: '已取消，文件已还原，没有改动',
        actionFailed: '操作失败',
        applied: '已生效',
        verifyClean: '共享树与本插件清单一致。',
        verifyDiff: '与清单有差异（未登记 / 漂移），见下方明细。',
        verifyCounts: '一致 / 漂移 / 未登记 / 缺失',
        noRows: '没有需要注意的行。',
        countEnabled: '已启用',
        filteredNote: '已隐藏 {n} 个纯依赖库（pnpm hoisted 提升，非插件）',
        componentsNote: '{n} 个组件已归入其归属插件',
        linkedTitle: '本 profile 的 link: 插件（{n}）',
        linkedNote: '只读。这些是本地 link: 路径安装的插件，物理上不在共享树里，不能在这里启用或关闭；开关请到 Plugins 页。',
        linkedBadge: 'linked',
        linkedTarget: '路径',
        componentOf: '{owner} 的组件',
        componentHint: '不可独立启用：{owner} 已经提供了这个 entry id，单独启用会让 id 被插入两次、导致设置页存不下来（issue #470）。请在 {owner} 自己的设置页里切换。',
        stateUnknown: '读不到本 profile 的启用状态（pluginManager 不可用），所有行显示为状态未知，按钮已禁用。',
        safetyNote: '注意',
        hint: '树里的包来自 pnpm hoisted 提升或本插件的 install，数量会变化；搜索与过滤是只读的。',
        rootLabel: '树位置',
        manifestLabel: '清单',
        updatedLabel: '更新于',
        detail: '详情',
        upgrade: '升级',
        rollback: '回滚',
        back: '返回',
        impactTitle: '引用该包的 profile',
        depsTitle: '依赖检查',
        versionTitle: '版本',
        currentVersion: '当前安装',
        latestVersion: 'registry 最新',
        confirmUpgrade: '确认升级',
        fixedExact: '锁定精确版本',
        affectedProfiles: '本次升级影响 {n} 个 profile：',
        noAffected: '还没有 profile 引用这个包。',
        start: '开始升级',
        cancel: '取消',
        stagePrepare: '准备',
        stageBuild: '下载与构建（pnpm）',
        stageMerge: '合并进共享树',
        stageVerify: '校验共享树',
        upToDate: '已经是最新版本。',
        noHistory: '暂无升级历史记录。',
        rollbackTo: '回滚到',
        exemptWarn: '该版本声明了 engines.dsh {required}，本机版本无法自动核对——升级前请人工确认。',
        satisfy: '满足',
        unsatisfied: '不满足',
        unknownCheck: '未知',
        depsUnavailable: '读不到 registry 元数据——升级按钮保持可用，请人工核对版本。',
        profileEnable: '启用',
        profileDisable: '关闭',
        restartNote: '已写入该 profile 的 dsh.profile.bundles，需重启该 profile 生效。',
        verifyProfiles: '升级后逐 profile 验证',
        checkMatch: '版本与树一致',
        checkMismatch: '版本与树不一致',
        checkLocal: '本地副本',
        jobFailed: '升级失败',
        jobRunning: '升级中…',
        jobDone: '升级完成',
        workingOnIt: '处理中…',
        peerLabel: 'peer',
        nodeLabel: 'node 引擎',
        dshLabel: 'dsh 引擎',
        installConflict: '已有安装任务在进行中。',
        historyLabel: '历史版本',
        impactLoadFailed: '影响面数据加载失败',
        featuresTitle: '提供的功能项（loader entries）',
        debugTitle: '调试',
        entryEnabledTag: '启用',
        entryDisabledTag: '已禁用（覆盖层）',
        configKeysLabel: '配置键',
        patchTextLabel: '补丁原文',
        targetProfileLabel: '应用到 profile',
        featureLoadFailed: '功能项加载失败',
        debugLoadFailed: '调试信息加载失败',
        hashOkTag: '哈希与清单一致',
        hashBadTag: '哈希漂移',
        hashUnknownTag: '哈希未知',
        bundleUnknown: '本 profile 不可见',
        availabilityLabel: '可用性',
        rowsLabel: '注册行数',
        referencedBy: '被引用',
        wholeRowHint: '点击行进入详情/调试',
        docSection: '描述',
        docRetry: '重试',
        docFailed: '描述加载失败',
        docMissing: '该插件没有描述文档。',
        rowsSection: '功能开关',
        rowsFilter: '筛选功能行…',
        rowOff: '关闭',
        rowStateIdle: '空闲',
        rowSwitchLabel: '切换 {name}',
        tabDoc: '描述',
        tabUpgrade: '升级',
        tabVersion: '版本与完整性',
        tabProfiles: 'profile 应用',
        lifeInit: '生命周期：已初始化',
        lifeProfiles: '基线 profile',
        lifeChanges: '台账变更',
        lifeUninitialized: '生命周期：尚未记录基线快照',
        lifeGuide: '已初始化：共享树目录已创建、各 profile 基线快照已记录。停用本插件会自动还原它做过的配置变更（手工改动不受影响）。',
      },
    }

    /** 由 apply 填入的翻译函数（locale 不可用时退回中文字典）。 */
    let translate = (key) => DICTS.zh[key] ?? key

    /**
     * 取一条文案并填充 {name} 占位符。
     * @param {string} key 文案键。
     * @param {Record<string, string|number>} [values] 占位符取值。
     * @returns {string} 文案。
     */
    function fill(key, values) {
      const template = translate(key)
      if (values === undefined) return template
      return template.replace(/\{(\w+)\}/g, (whole, name) => (
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole
      ))
    }

    /**
     * 发一个 GET。
     * @param {string} path 路由路径。
     * @returns {Promise<any>} 解析后的 value。
     */
    async function getJson(path) {
      const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload.value
    }

    /**
     * 发一个 POST。
     * @param {string} path 路由路径。
     * @param {any} body 请求体。
     * @returns {Promise<any>} 解析后的 value。
     */
    async function postJson(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload.value
    }

    /** 样式表：容器与控件只用宿主主题 token（--dsw-alias-*），缺失时优雅降级。 */
    const styles = {
      root: {
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: '7px',
        padding: '10px', boxSizing: 'border-box',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-base, transparent)',
        fontSize: '12px', lineHeight: 1.5,
      },
      header: { display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' },
      title: { fontSize: '13px', fontWeight: 600, marginRight: 'auto' },
      meta: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '11px' },
      controls: { display: 'flex', flexWrap: 'wrap', gap: '6px', flex: '0 0 auto' },
      input: {
        flex: '1 1 130px', minWidth: '110px', padding: '4px 7px', fontSize: '12px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))',
        borderRadius: '5px',
      },
      select: {
        padding: '4px 6px', fontSize: '12px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))',
        borderRadius: '5px',
      },
      button: {
        padding: '4px 9px', fontSize: '12px', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))',
        borderRadius: '5px',
      },
      primaryButton: {
        padding: '3px 9px', fontSize: '11px', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
        background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #3b6ef5))',
        border: '1px solid transparent', borderRadius: '5px',
      },
      list: {
        flex: '1 1 auto', minHeight: 0, overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: '5px', paddingRight: '2px',
      },
      row: {
        display: 'flex', alignItems: 'flex-start', gap: '7px', padding: '6px 7px',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2))',
        borderRadius: '6px',
      },
      rowMain: { minWidth: 0, flex: '1 1 auto' },
      /** 一行 + 它的组件子行的容器：保证子行紧随归属行，不被 flex 间距拆开。 */
      group: { display: 'flex', flexDirection: 'column', gap: '3px' },
      /** 组件子行：左侧缩进 + 竖线，视觉上从属于上一行。 */
      childRow: {
        display: 'flex', alignItems: 'flex-start', gap: '7px', padding: '5px 7px 5px 9px',
        marginLeft: '12px',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05))',
        borderLeft: '2px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
        borderRadius: '0 6px 6px 0',
      },
      childName: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary, inherit)' },
      /** 只读分区：与上方可操作列表用一条分隔线拉开，视觉上看得出它不可操作。 */
      linkedSection: {
        display: 'flex', flexDirection: 'column', gap: '5px', marginTop: '10px',
        paddingTop: '9px', borderTop: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
      },
      linkedHeader: { display: 'flex', alignItems: 'center', gap: '6px' },
      linkedRow: {
        display: 'flex', alignItems: 'flex-start', gap: '7px', padding: '6px 7px',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05))',
        border: '1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
        borderRadius: '6px',
      },
      name: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px', wordBreak: 'break-all' },
      version: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '11px', marginLeft: '4px' },
      badges: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '3px' },
      badge: {
        fontSize: '10px', padding: '1px 5px', borderRadius: '4px',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
      },
      badgeOn: {
        fontSize: '10px', padding: '1px 5px', borderRadius: '4px',
        color: 'var(--dsw-alias-state-success-primary, inherit)',
        border: '1px solid var(--dsw-alias-state-success-primary, currentColor)',
      },
      badgeWarn: {
        fontSize: '10px', padding: '1px 5px', borderRadius: '4px',
        color: 'var(--dsw-alias-state-warn-primary, inherit)',
        border: '1px solid var(--dsw-alias-state-warn-primary, currentColor)',
      },
      notice: {
        padding: '6px 8px', borderRadius: '6px', fontSize: '11px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))',
      },
      warn: { color: 'var(--dsw-alias-state-warn-primary, inherit)' },
      error: { color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-danger, inherit))' },
      ok: { color: 'var(--dsw-alias-state-success-primary, inherit)' },
      verifyRows: {
        flex: '0 0 auto', maxHeight: '34%', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: '2px',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11px',
      },
      hint: {
        flex: '0 0 auto', fontSize: '11px',
        color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit))',
      },
      // ── 升级 UI ──
      detailHead: { display: 'flex', alignItems: 'center', gap: '7px', flex: '0 0 auto' },
      sectionTitle: { fontSize: '12px', fontWeight: 600, marginTop: '4px' },
      section: {
        display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2))',
        borderRadius: '6px',
      },
      kvRow: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' },
      overlay: {
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(127,127,127,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      },
      modal: {
        width: 'min(430px, 92%)', maxHeight: '72%', overflowY: 'auto', padding: '12px',
        borderRadius: '8px', fontSize: '12px', lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-base, rgba(127,127,127,0.98))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.4))',
        display: 'flex', flexDirection: 'column', gap: '8px',
      },
      modalActions: { display: 'flex', gap: '6px', justifyContent: 'flex-end' },
      progressBarOuter: { height: '6px', borderRadius: '3px', background: 'rgba(127,127,127,0.25)', overflow: 'hidden' },
      progressBarInner: { height: '100%', background: 'var(--dsw-alias-brand-primary, #3b6ef5)', transition: 'width 0.3s' },
      stageRow: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11px' },
      stageDot: { width: '7px', height: '7px', borderRadius: '50%', flex: '0 0 auto', background: 'rgba(127,127,127,0.35)' },
      stageDotActive: { width: '7px', height: '7px', borderRadius: '50%', flex: '0 0 auto', background: 'var(--dsw-alias-brand-primary, #3b6ef5)' },
      stageDotDone: { width: '7px', height: '7px', borderRadius: '50%', flex: '0 0 auto', background: 'var(--dsw-alias-state-success-primary, currentColor)' },
      miniToggle: {
        padding: '2px 7px', fontSize: '10.5px', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))',
        borderRadius: '4px',
      },
      miniToggleOn: {
        padding: '2px 7px', fontSize: '10.5px', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
        background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #3b6ef5))',
        border: '1px solid transparent', borderRadius: '4px',
      },
      // ── 描述区：DetailDocument.module.css 逐条对齐（token 一致，深浅主题自动正确）──
      docSectionWrap: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 },
      docDocument: {
        minWidth: 0,
        maxHeight: 'min(560px, 60vh)',
        overflowY: 'auto',
        borderTop: '0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))',
        borderBottom: '0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))',
        scrollbarGutter: 'stable',
        padding: '12px 0',
        overflowWrap: 'anywhere',
        font: 'var(--dsw-font-markdown-base, inherit)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        cursor: 'text',
      },
      docFailure: { display: 'flex', alignItems: 'center', gap: '10px' },
      docErrorLine: {
        display: 'inline-flex', alignItems: 'center', gap: '6px', margin: 0,
        fontSize: '13px', lineHeight: '20px',
        color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-danger, inherit))',
      },
      docSkeleton: { display: 'flex', flexDirection: 'column', gap: '10px' },
      docBar: {
        display: 'block', height: '12px', borderRadius: 'var(--dsw-radius-xs, 4px)',
        background: 'var(--dsw-alias-bg-skeleton, rgba(127,127,127,0.3))',
        animation: 'dst-skeleton 2s cubic-bezier(0.36, 0, 0.64, 1) infinite',
      },
      mdPre: {
        background: 'var(--dsw-alias-markdown-code-bg, var(--dsw-alias-markdown-inline-code, rgba(127,127,127,0.15)))',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        padding: '8px', overflowX: 'auto', maxHeight: '320px',
        margin: '8px 0', whiteSpace: 'pre', wordBreak: 'normal',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11px',
      },
      docBarLong: { width: 'min(480px, 90%)' },
      docBarShort: { width: 'min(240px, 50%)' },
      docRetryBtn: {
        padding: '3px 10px', fontSize: '12px', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))',
        borderRadius: '5px',
      },
      // ── tab 切换 ──
      tabBar: { display: 'flex', gap: '4px', flex: '0 0 auto', flexWrap: 'wrap' },
      tabBtn: {
        padding: '4px 10px', fontSize: '12px', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        background: 'transparent', border: '1px solid transparent', borderRadius: '6px',
      },
      tabBtnActive: {
        padding: '4px 10px', fontSize: '12px', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))',
        borderRadius: '6px',
      },
    }

    /**
     * 把 /set 的 application 翻成用户能看懂的措辞与语气。
     * @param {string|null} application 结果。
     * @returns {{tone: string, messageKey: string}} 语气与文案 key。
     */
    function toneOf(application) {
      switch (application) {
        case 'applied': return { tone: 'ok', messageKey: 'applied' }
        case 'restart-required': return { tone: 'warn', messageKey: 'needRestart' }
        case 'overridden': return { tone: 'warn', messageKey: 'overridden' }
        case 'cancelled': return { tone: 'warn', messageKey: 'cancelled' }
        default: return { tone: 'error', messageKey: 'actionFailed' }
      }
    }

    /** 检查行的人类可读类别名。 */
    function checkKindLabel(kind, t) {
      if (kind === 'peer') return t('peerLabel')
      if (kind === 'node') return t('nodeLabel')
      return t('dshLabel')
    }

    /**
     * Markdown 渲染（原版 MarkdownText.module.css 的降级复刻）：
     * 标题/段落/列表/代码/粗体/链接/图片，字体与间距全部走原版同一批主题 token。
     * 图片：![alt](src) —— http(s) 直渲染；相对路径经宿主 /detail-image 伺服（原版 serveDetailFile 同机制）。
     * @param {string} text Markdown 文本。
     * @param {{ name: string, docPath: string|null }} images 相对图片解析锚点（包名 + 文档路径）。
     * @returns {any[]} React 元素数组。
     */
    function renderMarkdown(text, images) {
      const out = []
      const lines = String(text ?? '').split(/\r?\n/)
      let paragraph = []
      let fence = null
      const FONT_HEAD = 'var(--dsw-font-markdown-h1)'
      const mdStyle = {
        h1: { font: FONT_HEAD, margin: '32px 0 16px' },
        h2: { font: 'var(--dsw-font-markdown-h2, var(--dsw-font-markdown-h1, inherit))', margin: '32px 0 16px' },
        h3: { font: 'var(--dsw-font-markdown-h3, inherit)', margin: '32px 0 16px' },
        h4: { font: 'var(--dsw-font-markdown-h4, inherit)', margin: '16px 0' },
        p: { margin: '16px 0' },
        li: { margin: '4px 0' },
      }
      const imageUrl = (src) => {
        if (!images || /^(https?:)?\/\//i.test(src) || /^data:/i.test(src)) return src
        return `${API}/detail-image?pkg=${encodeURIComponent(images.name)}&doc=${encodeURIComponent(images.docPath ?? '')}&rel=${encodeURIComponent(src)}`
      }
      const inline = (raw) => {
        const parts = String(raw).split(/(`[^`]+`|\*\*[^*]+\*\*|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\))/g)
        return parts.filter((part) => part.length > 0).map((part, index) => {
          const code = /^`([^`]+)`$/.exec(part)
          if (code !== null) {
            return h('code', {
              key: index,
              style: {
                fontSize: '0.875em',
                backgroundColor: 'var(--dsw-alias-markdown-inline-code, rgba(127,127,127,0.15))',
                border: '0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))',
                borderRadius: '3px', padding: '0 4px',
                fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
              },
            }, code[1])
          }
          const bold = /^\*\*([^*]+)\*\*$/.exec(part)
          if (bold !== null) return h('strong', { key: index, style: { fontWeight: 600 } }, bold[1])
          const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(part)
          if (image !== null) {
            return h('img', {
              key: index,
              src: imageUrl(image[2]),
              alt: image[1],
              title: image[1],
              style: { maxWidth: '100%', height: 'auto', borderRadius: 'var(--dsw-radius-sm, 6px)', margin: '8px 0' },
              onError: (event) => { event.currentTarget.style.display = 'none' },
            })
          }
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
          if (link !== null) {
            return h('a', {
              key: index, href: link[2], target: '_blank', rel: 'noreferrer',
              style: { color: 'var(--dsw-alias-link, inherit)' },
            }, link[1])
          }
          return part
        })
      }
      const flush = () => {
        if (paragraph.length > 0) {
          out.push(h('p', { key: `p${out.length}`, style: mdStyle.p }, ...paragraph))
          paragraph = []
        }
      }
      for (const line of lines) {
        const fenceMatch = /^```/.exec(line)
        if (fenceMatch !== null) {
          if (fence === null) { flush(); fence = [] }
          else { out.push(h('pre', { key: `f${out.length}`, style: styles.mdPre, 'data-code': true }, fence.join('\n'))); fence = null }
          continue
        }
        if (fence !== null) { fence.push(line); continue }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line)
        if (heading !== null) {
          flush()
          out.push(h(heading[1].length <= 2 ? 'h2' : heading[1].length === 3 ? 'h3' : 'h4', {
            key: `h${out.length}`, style: mdStyle[`h${heading[1].length}`] ?? mdStyle.h4,
          }, inline(heading[2])))
          continue
        }
        const list = /^\s*[-*]\s+(.*)$/.exec(line)
        if (list !== null) {
          flush()
          out.push(h('div', { key: `l${out.length}`, style: { marginLeft: '16px', ...mdStyle.li } }, '• ', inline(list[1])))
          continue
        }
        if (line.trim().length === 0) { flush(); continue }
        paragraph.push(...inline(line), ' ')
      }
      if (fence !== null) out.push(h('pre', { key: `f${out.length}`, style: styles.mdPre, 'data-code': true }, fence.join('\n')))
      flush()
      return out
    }

    /**
     * 拨动开关（原版 Switch 的降级复刻）：胶囊 + 圆钮，role="switch"，只用主题 token。
     * @param {{ checked: boolean, disabled?: boolean, busy?: boolean, title?: string, label: string, onChange: Function }} props 见名知义。
     * @returns {any} React 元素。
     */
    function SmallSwitch({ checked, disabled, busy, title, label, onChange }) {
      const pill = {
        width: '30px', height: '16px', borderRadius: '8px', padding: 0, position: 'relative',
        cursor: disabled === true ? 'not-allowed' : 'pointer', opacity: disabled === true || busy === true ? 0.55 : 1,
        border: `1px solid ${checked && disabled !== true
          ? 'var(--dsw-alias-state-success-primary, currentColor)'
          : 'var(--dsw-alias-border-l1, rgba(127,127,127,0.4))'}`,
        background: checked && disabled !== true
          ? 'var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary, currentColor))'
          : 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.15))',
      }
      const knob = {
        position: 'absolute', top: '1px', width: '12px', height: '12px', borderRadius: '50%',
        left: checked ? '15px' : '1px', transition: 'left 0.15s',
        background: checked && disabled !== true ? 'var(--dsw-alias-label-primary-foreground, #fff)' : 'var(--dsw-alias-label-secondary, currentColor)',
      }
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label,
        className: `${CLS}-btn`, style: pill, disabled: disabled === true || busy === true,
        title: title ?? label,
        onClick: () => onChange(!checked),
      }, h('span', { style: knob, 'aria-hidden': true }))
    }

    /**
     * 包详情页：影响面区（逐 profile 灰度开关）/ 依赖区（peer+engines）/ 版本区（回滚下拉）。
     * 数据自取自 /impact 与 /deps；灰度开关走 /set-profile；回滚走 /rollback + 父级任务轮询。
     * @param {{ name: string, treeVersion: string|null, onBack: Function, onUpgrade: Function, onJobStarted: Function, t: Function, fill: Function }} props 见名知义。
     * @returns {any} React 元素。
     */
    function DetailPanel({ name, treeVersion, onBack, onUpgrade, onJobStarted, t, fill }) {
      const [impact, setImpact] = useState(null)
      const [impactError, setImpactError] = useState(null)
      const [deps, setDeps] = useState(null)
      const [depsError, setDepsError] = useState(null)
      const [busyProfile, setBusyProfile] = useState(null)
      const [notice, setNotice] = useState(null)
      const [rollbackChoice, setRollbackChoice] = useState('')
      const [busyRollback, setBusyRollback] = useState(false)
      // ── 功能项 / 调试 ──
      const [entriesData, setEntriesData] = useState(null)
      const [entriesError, setEntriesError] = useState(null)
      const [debugData, setDebugData] = useState(null)
      const [debugError, setDebugError] = useState(null)
      const [targetProfile, setTargetProfile] = useState('')
      const [busyEntry, setBusyEntry] = useState(null)
      // ── 原版详情复刻：描述文档 + 行级功能开关 ──
      const [doc, setDoc] = useState(null)
      const [docError, setDocError] = useState(null)
      const [rowsData, setRowsData] = useState(null)
      const [rowsError, setRowsError] = useState(null)
      const [rowsFilter, setRowsFilter] = useState('')
      const [busyRow, setBusyRow] = useState(null)
      // tab 状态：必须在任何引用它的依赖数组之前声明（TDZ 防线，黑屏回归测试会静态扫描）。
      const [tab, setTab] = useState('doc')

      /** 描述文档单独取（重试只重拉文档，不连带重发其余 5 个请求——原版 retry 语义）。 */
      const fetchDoc = useCallback(async () => {
        try {
          setDoc(await getJson(`/detail?pkg=${encodeURIComponent(name)}&lang=${String(globalThis.navigator?.language ?? 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh'}`))
          setDocError(null)
        } catch (failure) {
          setDoc(null)
          setDocError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [name])

      /** 影响面 + 依赖 + 功能项 + 调试 + 描述 + 功能行各取一次；单项失败不拦详情页（各自显示错误态）。
       *  注意：必须先于所有引用它的 useCallback 依赖数组声明（依赖数组在渲染期求值，滞后声明即 TDZ 崩溃 → 黑屏）。 */
      const loadDetail = useCallback(async () => {
        setImpactError(null)
        try {
          const impactValue = await getJson(`/impact?pkg=${encodeURIComponent(name)}`)
          setImpact(impactValue)
          // profile 选择器的默认值：第一个引用了该包的 profile，否则第一个。
          setTargetProfile((prev) => {
            if (prev.length > 0) return prev
            const names = (impactValue?.profiles ?? []).map((row) => row.profile)
            const firstReferenced = (impactValue?.profiles ?? []).find((row) => row.referenced)?.profile
            return firstReferenced ?? names[0] ?? ''
          })
        } catch (failure) {
          setImpactError(failure instanceof Error ? failure.message : String(failure))
        }
        setDepsError(null)
        try {
          setDeps(await getJson(`/deps?pkg=${encodeURIComponent(name)}&ver=latest`))
        } catch (failure) {
          setDeps(null)
          setDepsError(failure instanceof Error ? failure.message : String(failure))
        }
        setEntriesError(null)
        try {
          setEntriesData(await getJson(`/entries?pkg=${encodeURIComponent(name)}`))
        } catch (failure) {
          setEntriesData(null)
          setEntriesError(failure instanceof Error ? failure.message : String(failure))
        }
        setDebugError(null)
        try {
          setDebugData(await getJson(`/debug?pkg=${encodeURIComponent(name)}`))
        } catch (failure) {
          setDebugData(null)
          setDebugError(failure instanceof Error ? failure.message : String(failure))
        }
        await fetchDoc()
        setRowsError(null)
        try {
          setRowsData(await getJson(`/rows?pkg=${encodeURIComponent(name)}`))
        } catch (failure) {
          setRowsData(null)
          setRowsError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [name, fetchDoc])

      useEffect(() => { void loadDetail() }, [loadDetail])

      /** 行开关：优先原版写入链路 manager.setPluginEnabled（/set-row 宿主侧已按此优先）。 */
      const toggleRow = useCallback(async (entryId, enabled) => {
        setBusyRow(entryId)
        setNotice(null)
        try {
          const result = await postJson('/set-row', { entryId, enabled, profile: targetProfile })
          if (result.ok !== true) {
            setNotice({ tone: 'error', message: `${entryId}: ${result.error ?? t('actionFailed')}` })
            return
          }
          const { tone, messageKey } = toneOf(result.value?.application)
          setNotice({ tone, message: `${entryId}: ${t(messageKey)}${result.value?.nextStep ? ` — ${result.value.nextStep}` : ''}` })
          await loadDetail()
        } catch (failure) {
          setNotice({ tone: 'error', message: `${entryId}: ${failure instanceof Error ? failure.message : String(failure)}` })
        } finally {
          setBusyRow(null)
        }
      }, [targetProfile, loadDetail, t])

      /** 描述文档重试（原版 BundleDetailSection 的 retry 语义：只重拉文档）。 */
      const retryDoc = useCallback(async () => {
        setDocError(null)
        setDoc(null)
        await fetchDoc()
      }, [fetchDoc])

      /** 灰度开关：改目标 profile 的 dsh.profile.bundles。 */
      const toggleProfile = useCallback(async (profile, enabled) => {
        setBusyProfile(profile)
        setNotice(null)
        try {
          const outcome = await postJson('/set-profile', { profile, target: name, enabled })
          setNotice(outcome.ok === true
            ? { tone: 'ok', message: t('restartNote') }
            : { tone: 'error', message: outcome.error ?? t('actionFailed') })
          await loadDetail()
        } catch (failure) {
          setNotice({ tone: 'error', message: failure instanceof Error ? failure.message : String(failure) })
        } finally {
          setBusyProfile(null)
        }
      }, [name, loadDetail, t])

      /** 回滚：POST /rollback 起任务，进度由父级的轮询统一展示。 */
      const doRollback = useCallback(async () => {
        if (rollbackChoice.length === 0) return
        setBusyRollback(true)
        setNotice(null)
        try {
          await postJson('/rollback', { name, version: rollbackChoice })
          onJobStarted(name)
        } catch (failure) {
          setNotice({ tone: 'error', message: failure instanceof Error ? failure.message : String(failure) })
        } finally {
          setBusyRollback(false)
        }
      }, [name, rollbackChoice, onJobStarted, t])

      const referencing = (impact?.profiles ?? []).filter((row) => row.referenced)
      const upgradeBlocked = deps?.ok === false
      const targetVersion = deps?.version ?? null
      const upToDate = targetVersion !== null && treeVersion !== null && targetVersion === treeVersion
      const exemptRow = (deps?.checks ?? []).find((row) => row.kind === 'dsh' && row.ok === null)
      const history = impact?.history ?? []

      const depsSection = () => h('div', { style: styles.section },
        h('div', { style: styles.sectionTitle }, t('depsTitle')),
        deps === null && depsError === null ? h('div', { style: styles.hint }, t('loading')) : null,
        depsError !== null ? h('div', { style: { ...styles.hint, ...styles.warn } }, t('depsUnavailable')) : null,
        deps !== null && deps.available !== true ? h('div', { style: { ...styles.hint, ...styles.warn } }, deps.error ?? t('depsUnavailable')) : null,
        deps !== null && deps.available === true
          ? h('div', { style: styles.kvRow },
            h('span', { style: styles.version }, `${t('latestVersion')}: v${deps.version ?? '?'}`),
            upToDate ? h('span', { style: styles.badgeOn }, t('upToDate')) : null,
            ...deps.checks.map((row) => h('span', {
              key: `${row.kind}:${row.name}`,
              title: `required ${row.required} / installed ${row.installed ?? '?'}`,
              style: row.ok === false ? styles.badgeWarn : row.ok === true ? styles.badgeOn : styles.badge,
            }, `${checkKindLabel(row.kind, t)} ${row.name} ${row.required} — ${row.ok === false ? t('unsatisfied') : row.ok === true ? t('satisfy') : t('unknownCheck')}`)),
            exemptRow !== undefined
              ? h('div', { style: { ...styles.hint, ...styles.warn } }, fill('exemptWarn', { required: exemptRow.required }))
              : null)
          : null)

      const impactSection = () => h('div', { style: styles.section },
        h('div', { style: styles.sectionTitle }, t('impactTitle')),
        impactError !== null ? h('div', { style: { ...styles.hint, ...styles.error } }, `${t('impactLoadFailed')}: ${impactError}`) : null,
        impact === null && impactError === null ? h('div', { style: styles.hint }, t('loading')) : null,
        impact !== null && referencing.length === 0 ? h('div', { style: styles.hint }, t('noAffected')) : null,
        referencing.map((row) => h('div', { key: row.profile, style: styles.kvRow },
          h('span', { style: styles.name }, row.profile),
          h('span', { style: styles.version },
            row.version === null ? '' : `v${row.version}${row.via === 'local' ? ` (${t('checkLocal')})` : ''}`),
          h('span', { style: row.enabled ? styles.badgeOn : styles.badge },
            row.enabled ? t('enabledTag') : t('disabledTag')),
          h('button', {
            type: 'button', className: `${CLS}-btn`,
            style: row.enabled ? styles.miniToggle : styles.miniToggleOn,
            disabled: busyProfile !== null || busyRollback,
            onClick: () => void toggleProfile(row.profile, !row.enabled),
            title: `${row.enabled ? t('profileDisable') : t('profileEnable')} @ ${row.profile}`,
          }, busyProfile === row.profile ? t('workingOnIt') : (row.enabled ? t('profileDisable') : t('profileEnable')))),
        ),
        null)

      const versionSection = () => h('div', { style: styles.section },
        h('div', { style: styles.sectionTitle }, t('versionTitle')),
        h('div', { style: styles.kvRow },
          h('span', { style: styles.version }, `${t('currentVersion')}: v${treeVersion ?? '?'}`),
          deps?.version !== undefined && deps?.version !== null
            ? h('span', { style: styles.version }, `${t('latestVersion')}: v${deps.version}`)
            : null,
          h('button', {
            type: 'button', className: `${CLS}-btn`, style: styles.primaryButton,
            disabled: upgradeBlocked || upToDate || (deps !== null && deps.available === false && deps.ok !== null),
            onClick: () => onUpgrade(name, targetVersion),
            title: upgradeBlocked ? t('depsTitle') : t('upgrade'),
          }, t('upgrade'))),
        upgradeBlocked ? h('div', { style: { ...styles.hint, ...styles.warn } }, t('unsatisfied')) : null,
        h('div', { style: styles.kvRow },
          h('span', { style: styles.hint }, t('rollbackTo')),
          h('select', {
            style: styles.select, value: rollbackChoice, 'aria-label': t('rollbackTo'),
            onChange: (event) => setRollbackChoice(event.target.value),
          },
            h('option', { value: '' }, t('historyLabel')),
            history.length === 0 ? h('option', { value: '' }, t('noHistory')) : null,
            history.map((row) => h('option', { key: `${row.version}@${row.at}`, value: row.version }, `v${row.version}`))),
          h('button', {
            type: 'button', className: `${CLS}-btn`, style: styles.button,
            disabled: rollbackChoice.length === 0 || busyRollback,
            onClick: () => void doRollback(),
          }, busyRollback ? t('workingOnIt') : t('rollback'))))

      /** 功能项开关/参数：写目标 profile 的 cordis.patch.yml 覆盖层。 */
      const toggleEntry = useCallback(async (entryId, disabled) => {
        if (targetProfile.length === 0) return
        setBusyEntry(entryId)
        setNotice(null)
        try {
          const outcome = await postJson('/set-entry', { profile: targetProfile, entryId, disabled })
          setNotice(outcome.ok === true
            ? { tone: 'ok', message: outcome.value?.note ?? t('restartNote') }
            : { tone: 'error', message: outcome.error ?? t('actionFailed') })
          await loadDetail()
        } catch (failure) {
          setNotice({ tone: 'error', message: failure instanceof Error ? failure.message : String(failure) })
        } finally {
          setBusyEntry(null)
        }
      }, [targetProfile, loadDetail, t])

      const profileNames = (impact?.profiles ?? []).map((row) => row.profile)

      /** 描述区：原版 DetailDocument 的一比一复刻——loading 骨架 / found 滚动文档 / failure 重试。 */
      const docSection = () => {
        const docBody = docError !== null
          ? h('div', { style: styles.docFailure },
            h('p', { style: styles.docErrorLine, role: 'alert' },
              h('span', { style: { ...styles.stageDot, background: 'var(--dsw-alias-state-error-primary, currentColor)' }, 'aria-hidden': true }),
              `${t('docFailed')}${docError ? `: ${docError}` : ''}`),
            h('button', { type: 'button', className: `${CLS}-btn`, style: styles.docRetryBtn, onClick: () => void retryDoc() }, t('docRetry')))
          : doc === null
            ? h('div', { style: styles.docSkeleton, role: 'status', 'aria-busy': 'true' },
              h('span', { className: `${CLS}-bar-anim`, style: { ...styles.docBar, ...styles.docBarLong } }),
              h('span', { className: `${CLS}-bar-anim`, style: { ...styles.docBar, ...styles.docBarLong } }),
              h('span', { className: `${CLS}-bar-anim`, style: { ...styles.docBar, ...styles.docBarShort } }))
            : doc.found !== true
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                h('span', { style: styles.hint }, t('docMissing')),
                h('button', { type: 'button', className: `${CLS}-btn`, style: styles.docRetryBtn, onClick: () => void retryDoc() }, t('docRetry')))
              : h('div', {
                style: styles.docDocument, role: 'region',
                'aria-label': t('docSection'), tabIndex: 0, 'data-detail-document': true,
              }, renderMarkdown(doc.markdown, { name, docPath: doc.docPath ?? doc.path ?? null }))
        return h('div', { style: styles.docSectionWrap, 'data-plugin-detail-doc': true }, docBody)
      }

      /** 功能开关区：原版 RowsSection 的复刻（状态点 + 行 id + 状态一行 + 拨动开关，多行带过滤）。 */
      /** 只读判定：宿主声明 readOnly 或数据来自补丁解析兜底（不可写）。
       *  （rowsSection 定义在前、此处调用在后，靠的是箭头函数体延迟执行；刻意保持只读判定集中一处。） */
      const rowDataReadOnly = (row) => rowsData?.manageable === false || Boolean(row.readOnlyReason)

      const rowsSection = () => {
        const rows = rowsData?.rows ?? []
        const query = rowsFilter.trim().toLowerCase()
        const shown = query.length === 0
          ? rows
          : rows.filter((row) => `${row.entryId} ${row.moduleName ?? ''}`.toLowerCase().includes(query))
        return h('div', { style: styles.section, 'data-plugin-rows': true },
          h('div', { style: styles.kvRow },
            h('div', { style: styles.sectionTitle }, t('rowsSection')),
            h('span', { style: styles.hint }, `${rows.length}`)),
          rowsError !== null ? h('div', { style: { ...styles.hint, ...styles.error } }, `${t('debugLoadFailed')}: ${rowsError}`) : null,
          rowsData === null && rowsError === null ? h('div', { style: styles.hint }, t('loading')) : null,
          rows.length > 8
            ? h('input', {
              style: styles.input, type: 'search', value: rowsFilter,
              placeholder: t('rowsFilter'), 'aria-label': t('rowsFilter'),
              onChange: (event) => setRowsFilter(event.target.value),
            })
            : null,
          rows.length > 0 && shown.length === 0 ? h('div', { style: styles.hint }, t('empty')) : null,
          shown.map((row) => {
            const rowTitle = row.entryId ?? row.rowId ?? '?'
            return h('div', { key: rowTitle, style: styles.kvRow, 'data-plugin-row': rowTitle },
              h('span', {
                style: row.enabled === true ? styles.stageDotDone : styles.stageDot,
                'aria-hidden': true, title: row.phase ?? t('rowStateIdle'),
              }),
              h('span', { style: styles.name, title: rowTitle }, rowTitle),
              row.moduleName !== null && row.moduleName !== name && row.moduleName !== rowTitle
                ? h('code', { style: styles.version }, row.moduleName)
                : null,
              h('span', { style: row.enabled === true ? styles.badgeOn : styles.badge },
                row.enabled === true ? (row.phase === null ? t('rowStateIdle') : row.phase) : t('rowOff')),
              h('span', { style: { flex: '1 1 auto' } }),
              h(SmallSwitch, {
                checked: row.enabled === true,
                disabled: rowDataReadOnly(row) || busyRow !== null,
                busy: busyRow === rowTitle,
                label: fill('rowSwitchLabel', { name: rowTitle }),
                title: row.readOnlyReason ?? undefined,
                onChange: (next) => void toggleRow(rowTitle, next),
              }),
              row.readOnlyReason !== null
                ? h('span', { style: { ...styles.hint, ...styles.warn }, title: row.readOnlyReason }, '🔒')
                : null)
          }))
      }

      const featuresSection = () => h('div', { style: styles.section },
        h('div', { style: styles.sectionTitle }, t('featuresTitle')),
        entriesError !== null ? h('div', { style: { ...styles.hint, ...styles.error } }, `${t('featureLoadFailed')}: ${entriesError}`) : null,
        entriesData !== null && entriesData.error !== undefined ? h('div', { style: { ...styles.hint, ...styles.warn } }, entriesData.error) : null,
        entriesData !== null && entriesData.error === undefined
          ? h('div', { style: styles.kvRow },
            h('span', { style: styles.hint }, t('targetProfileLabel')),
            h('select', {
              style: styles.select, value: targetProfile, 'aria-label': t('targetProfileLabel'),
              onChange: (event) => setTargetProfile(event.target.value),
            },
              profileNames.length === 0 ? h('option', { value: '' }, '—') : null,
              profileNames.map((profileName) => h('option', { key: profileName, value: profileName }, profileName))))
          : null,
        (entriesData?.entries ?? []).length === 0 && entriesData !== null && entriesData.error === undefined
          ? h('div', { style: styles.hint }, t('noAffected'))
          : null,
        (entriesData?.entries ?? []).map((entry) => h('div', { key: `${entry.id}`, style: styles.kvRow },          h('span', { style: styles.name, title: entry.id }, entry.id),
          entry.name !== null && entry.name !== entry.id ? h('span', { style: styles.version }, entry.name) : null,
          h('span', { style: entry.disabled ? styles.badgeWarn : styles.badgeOn },
            entry.disabled ? t('entryDisabledTag') : t('entryEnabledTag')),
          entry.configKeys.length > 0
            ? h('span', { style: styles.badge, title: entry.configKeys.join(', ') }, `${t('configKeysLabel')} ${entry.configKeys.length}`)
            : null,
          h('button', {
            type: 'button', className: `${CLS}-btn`,
            style: entry.disabled ? styles.miniToggleOn : styles.miniToggle,
            disabled: busyEntry !== null || targetProfile.length === 0,
            onClick: () => void toggleEntry(entry.id, !entry.disabled),
            title: `${entry.disabled ? t('profileEnable') : t('profileDisable')} ${entry.id} @ ${targetProfile}`,
          }, busyEntry === entry.id ? t('workingOnIt') : (entry.disabled ? t('profileEnable') : t('profileDisable')))),
        ),
        entriesData !== null && entriesData.patchText.length > 0
          ? h('details', null,
            h('summary', { style: styles.hint }, t('patchTextLabel')),
            h('pre', {
              style: { ...styles.verifyRows, maxHeight: '22%', margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
            }, entriesData.patchText))
          : null,
        null)

      const debugSection = () => h('div', { style: styles.section },
        h('div', { style: styles.sectionTitle }, t('debugTitle')),
        debugError !== null ? h('div', { style: { ...styles.hint, ...styles.error } }, `${t('debugLoadFailed')}: ${debugError}`) : null,
        debugData !== null
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('div', { style: styles.kvRow },
              h('span', { style: styles.version }, `${t('currentVersion')}: v${debugData.version ?? '?'}`),
              h('span', { style: styles.badge }, debugData.kind),
              h('span', {
                style: debugData.hashOk === true ? styles.badgeOn : debugData.hashOk === false ? styles.badgeWarn : styles.badge,
                title: 'tree hash vs manifest',
              }, debugData.hashOk === true ? t('hashOkTag') : debugData.hashOk === false ? t('hashBadTag') : t('hashUnknownTag')),
              h('span', { style: styles.badge }, `${t('featuresTitle')}: ${debugData.entriesCount}`)),
            h('div', { style: styles.kvRow },
              h('span', { style: styles.version }, t('referencedBy')),
              debugData.referenced.length === 0
                ? h('span', { style: styles.hint }, t('noAffected'))
                : debugData.referenced.map((profileName) => h('span', { key: profileName, style: styles.badge }, profileName))),
            h('div', { style: styles.kvRow },
              h('span', { style: styles.version }, 'bundle'),
              debugData.inCurrentProfile.known !== true
                ? h('span', { style: styles.badgeWarn }, t('bundleUnknown'))
                : [
                  h('span', { key: 'e', style: debugData.inCurrentProfile.enabled ? styles.badgeOn : styles.badge },
                    debugData.inCurrentProfile.enabled ? t('enabledTag') : t('disabledTag')),
                  h('span', { key: 'a', style: styles.badge, title: debugData.inCurrentProfile.availability ?? '' },
                    `${t('availabilityLabel')}: ${debugData.inCurrentProfile.availability ?? '?'}`),
                  h('span', { key: 'r', style: styles.badge }, `${t('rowsLabel')}: ${debugData.inCurrentProfile.rows}`),
                ]),
            debugData.entriesError !== null
              ? h('div', { style: { ...styles.hint, ...styles.warn } }, debugData.entriesError)
              : null)
          : null)

      // tab 式信息架构：四个区块全部保持挂载，非激活 tab 仅 display:none —— 切换不重挂、状态不丢。
      const TABS = [
        { key: 'doc', label: t('tabDoc') },
        { key: 'upgrade', label: t('tabUpgrade') },
        { key: 'version', label: t('tabVersion') },
        { key: 'profiles', label: t('tabProfiles') },
      ]
      const paneStyle = (key) => tab === key
        ? { display: 'flex', flexDirection: 'column', gap: '7px', minHeight: 0, flex: '1 1 auto', minWidth: 0 }
        : { display: 'none' }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px', minHeight: 0, flex: '1 1 auto' } },
        h('div', { style: styles.detailHead },
          h('button', { type: 'button', className: `${CLS}-btn`, style: styles.button, onClick: onBack }, t('back')),
          h('span', { style: styles.title }, name),
          h('span', { style: styles.version }, treeVersion === null ? '' : `v${treeVersion}`),
          h('span', { style: styles.hint }, t('wholeRowHint'))),
        h('div', { style: styles.tabBar, role: 'tablist' },
          TABS.map((item) => h('button', {
            key: item.key, type: 'button', role: 'tab', 'aria-selected': tab === item.key,
            className: `${CLS}-btn`, style: tab === item.key ? styles.tabBtnActive : styles.tabBtn,
            onClick: () => setTab(item.key),
          }, item.label))),
        h('div', { style: paneStyle('doc'), role: 'tabpanel', 'data-tab': 'doc' },
          docSection(),
          rowsSection()),
        h('div', { style: paneStyle('upgrade'), role: 'tabpanel', 'data-tab': 'upgrade' },
          depsSection(),
          versionSection()),
        h('div', { style: paneStyle('version'), role: 'tabpanel', 'data-tab': 'version' },
          debugSection()),
        h('div', { style: paneStyle('profiles'), role: 'tabpanel', 'data-tab': 'profiles' },
          impactSection(),
          featuresSection()),
        // 操作反馈只渲染一次（doc tab 的行开关与 profiles tab 的灰度/entry 开关共享同一个 notice）。
        h('div', { 'aria-live': 'polite', style: { flex: '0 0 auto' } },
          notice !== null
            ? h('div', {
              style: {
                ...styles.notice,
                ...(notice.tone === 'error' ? styles.error : notice.tone === 'ok' ? styles.ok : styles.warn),
              },
            }, notice.message)
            : null))
    }

    /**
     * 升级确认弹窗：固定精确版本开关 + 影响面列表 + 开始/取消。
     * @param {{ pkg: {name: string, version: string|null, impact: any}, exact: boolean, setExact: Function, onStart: Function, onCancel: Function, t: Function, fill: Function }} props 见名知义。
     * @returns {any} React 元素。
     */
    function ConfirmModal({ pkg, exact, setExact, onStart, onCancel, t, fill }) {
      const referencing = (pkg.impact?.profiles ?? []).filter((row) => row.referenced)
      const spec = pkg.version !== null && exact ? `${pkg.name}@${pkg.version}` : pkg.name
      return h('div', { style: styles.overlay, role: 'dialog', 'aria-modal': true },
        h('div', { style: styles.modal },
          h('div', { style: styles.title }, t('confirmUpgrade')),
          h('div', { style: styles.kvRow },
            h('span', { style: styles.name }, pkg.name),
            pkg.version !== null ? h('span', { style: styles.version }, `→ v${pkg.version}`) : null),
          h('label', { style: styles.kvRow },
            h('input', { type: 'checkbox', checked: exact, onChange: (event) => setExact(event.target.checked) }),
            t('fixedExact'),
            h('code', { style: styles.version }, spec)),
          pkg.impact === null
            ? h('div', { style: styles.hint }, t('loading'))
            : referencing.length === 0
              ? h('div', { style: styles.hint }, t('noAffected'))
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                h('div', { style: styles.hint }, fill('affectedProfiles', { n: referencing.length })),
                referencing.map((row) => h('div', { key: row.profile, style: styles.kvRow },
                  h('span', { style: styles.name }, row.profile),
                  h('span', { style: styles.version }, row.version === null ? '' : `v${row.version}`),
                  h('span', { style: row.enabled ? styles.badgeOn : styles.badge },
                    row.enabled ? t('enabledTag') : t('disabledTag'))))),
          h('div', { style: styles.modalActions },
            h('button', { type: 'button', className: `${CLS}-btn`, style: styles.button, onClick: onCancel }, t('cancel')),
            h('button', {
              type: 'button', className: `${CLS}-btn`, style: styles.primaryButton,
              disabled: pkg.version === null || pkg.impact === null,
              onClick: () => onStart(spec),
            }, t('start')))))
    }

    /**
     * 安装/回滚任务进度卡：四阶段进度条 + 完成后逐 profile 验证结果。
     * @param {{ job: any, check: any, onClose: Function, t: Function, fill: Function }} props 见名知义。
     * @returns {any} React 元素。
     */
    function JobCard({ job, check, onClose, t, fill }) {
      const stages = job.stages ?? ['prepare', 'build', 'merge', 'verify']
      const stageIndex = stages.indexOf(job.stage)
      const doneRatio = job.state === 'done' ? 1 : job.state === 'failed' ? 1 : Math.max(0, stageIndex) / stages.length
      const labels = { prepare: 'stagePrepare', build: 'stageBuild', merge: 'stageMerge', verify: 'stageVerify' }
      return h('div', { style: styles.section, 'aria-live': 'polite' },
        h('div', { style: styles.kvRow },
          h('span', { style: styles.sectionTitle },
            job.state === 'running' ? t('jobRunning') : job.state === 'done' ? t('jobDone') : t('jobFailed')),
          h('span', { style: styles.version }, job.detail ?? ''),
          h('button', {
            type: 'button', className: `${CLS}-btn`, style: styles.miniToggle, onClick: onClose,
          }, t('cancel'))),
        h('div', { style: styles.progressBarOuter },
          h('div', { style: { ...styles.progressBarInner, width: `${Math.round(doneRatio * 100)}%` } })),
        stages.map((stage, index) => h('div', { key: stage, style: styles.stageRow },
          h('span', { style: index < stageIndex || job.state === 'done' ? styles.stageDotDone : index === stageIndex && job.state !== 'failed' ? styles.stageDotActive : styles.stageDot }),
          h('span', {
            style: index === stageIndex && job.state === 'running' ? styles.sectionTitle : styles.hint,
          }, t(labels[stage] ?? stage)))),
        job.state === 'failed' && job.error
          ? h('div', { style: { ...styles.hint, ...styles.error } }, job.error)
          : null,
        job.state === 'done' && check !== null
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('div', { style: styles.sectionTitle }, `${t('verifyProfiles')} — ${check.name}@${check.treeVersion ?? '?'}`),
            check.rows.length === 0
              ? h('div', { style: styles.hint }, t('noAffected'))
              : check.rows.map((row) => h('div', { key: row.profile, style: styles.kvRow },
                h('span', { style: styles.name }, row.profile),
                h('span', { style: styles.version }, row.version === null ? '' : `v${row.version}`),
                h('span', { style: row.matchesTree ? styles.badgeOn : styles.badgeWarn },
                  row.matchesTree ? t('checkMatch') : t('checkMismatch')),
                h('span', { style: row.enabled ? styles.badgeOn : styles.badge },
                  row.enabled ? t('enabledTag') : t('disabledTag')))))
          : null)
    }

    /**
     * 面板组件：列出共享树里的包，可搜索/过滤，可逐个开关。
     * 三处入口（主列面板 / 侧边栏图标选中的面板 / 右栏 tab）共用它。
     * @returns {any} React 元素。
     */
    function SharedTreePanel() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [verify, setVerify] = useState(null)
      const [pending, setPending] = useState({})
      const [query, setQuery] = useState('')
      const [kind, setKind] = useState('all')
      const [state, setState] = useState('all')
      // ── 升级 UI 的状态 ──
      const [detailName, setDetailName] = useState(null)
      const [job, setJob] = useState(null)
      const [check, setCheck] = useState(null)
      const [confirm, setConfirm] = useState(null)
      const [exact, setExact] = useState(true)
      // 生命周期状态条（总览页）：状态与渲染必须同在本组件作用域内（2026-11-27 黑屏回归教训）。
      const [lifecycle, setLifecycle] = useState(null)
      const jobTargetRef = useRef(null)
      const alive = useRef(true)
      const epoch = useRef(0)

      const t = useCallback((key) => translate(key), [])

      useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      /** 拉一次树状态（只读）。epoch 守卫防止旧响应覆盖新状态。 */
      const load = useCallback(async () => {
        const request = ++epoch.current
        setLoading(true)
        try {
          const value = await getJson('/status')
          if (!alive.current || request !== epoch.current) return
          setData(value)
          setError(null)
        } catch (failure) {
          if (!alive.current || request !== epoch.current) return
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          if (alive.current && request === epoch.current) setLoading(false)
        }
        try {
          const value = await getJson('/lifecycle')
          if (alive.current) setLifecycle(value)
        } catch {
          // 生命周期状态拉不到不影响主列表。
        }
      }, [])

      useEffect(() => { void load() }, [load])

      // ── 升级任务轮询：running 时每 800ms 问一次进度；结束时取逐 profile 验证结果 ──
      useEffect(() => {
        if (job === null || job.state !== 'running') return undefined
        const timer = setInterval(() => {
          void (async () => {
            let value
            try {
              value = await getJson('/install/progress')
            } catch {
              return
            }
            if (!alive.current || value === null || value.state === 'idle') return
            setJob(value)
            if (value.state !== 'running') {
              if (value.state === 'done' && jobTargetRef.current !== null) {
                setCheck(null)
                try {
                  const result = await postJson('/check-profiles', { name: jobTargetRef.current })
                  if (alive.current) setCheck(result)
                } catch {
                  if (alive.current) setCheck(null)
                }
                jobTargetRef.current = null
              }
              if (alive.current) void load()
            }
          })()
        }, 800)
        return () => clearInterval(timer)
      }, [job !== null && job.state === 'running', load])

      /** 打开升级确认弹窗：先取影响面，弹窗里展示"影响 N 个 profile"。 */
      const openConfirm = useCallback(async (name, version) => {
        setExact(true)
        setConfirm({ name, version, impact: null })
        try {
          const impact = await getJson(`/impact?pkg=${encodeURIComponent(name)}`)
          setConfirm((prev) => (prev !== null && prev.name === name ? { ...prev, impact } : prev))
        } catch {
          // 影响面拿不到也允许继续：兜底为空列表（fail-open），弹窗显示"还没有 profile 引用"。
          setConfirm((prev) => (prev !== null && prev.impact === null ? { ...prev, impact: { profiles: [] } } : prev))
        }
      }, [])

      /** 开始升级：POST /install（总是覆盖），进度交给轮询。 */
      const startInstall = useCallback(async (spec) => {
        const target = confirm?.name ?? null
        setConfirm(null)
        setCheck(null)
        jobTargetRef.current = target
        setJob({ state: 'running', stage: 'prepare', stages: ['prepare', 'build', 'merge', 'verify'], detail: spec, error: null })
        try {
          await postJson('/install', { packages: [spec], replace: true })
        } catch (failure) {
          setJob({
            state: 'failed', stage: 'prepare', stages: ['prepare', 'build', 'merge', 'verify'],
            detail: spec, error: failure instanceof Error ? failure.message : String(failure),
          })
          jobTargetRef.current = null
        }
      }, [confirm])

      /** 子组件（详情页回滚）已 POST /rollback，让父级开始轮询进度。 */
      const jobStartedFromChild = useCallback((name) => {
        setCheck(null)
        jobTargetRef.current = name
        setJob({ state: 'running', stage: 'prepare', stages: ['prepare', 'build', 'merge', 'verify'], detail: name, error: null })
      }, [])

      /** 切换一个包的启用状态；成功后用服务端回带的 status 立即刷新界面。 */
      const toggle = useCallback(async (name, enabled) => {
        // 同样 bump epoch：让此前在飞的 Refresh/load 结果作废，避免旧快照覆盖新状态。
        const request = ++epoch.current
        setBusy(name)
        setNotice(null)
        try {
          const value = await postJson('/set', { target: name, enabled })
          if (!alive.current || request !== epoch.current) return
          if (value?.status !== undefined) setData(value.status)
          const result = (value?.results ?? []).find((item) => item.name === name)
          if (result === undefined) {
            await load()
            return
          }
          if (result.ok === false) {
            setNotice({ tone: 'error', message: `${name}: ${result.error ?? t('actionFailed')}` })
            return
          }
          const { tone, messageKey } = toneOf(result.application)
          const detail = result.nextStep === null || result.nextStep === undefined ? '' : ` — ${result.nextStep}`
          setNotice({ tone, message: `${name}: ${t(messageKey)}${detail}` })
          if (result.restartRequired === true) {
            // 待重启的启用态在 listBundles 里还看不到，单独标记，避免显示成"未启用"。
            setPending((prev) => ({ ...prev, [name]: { enabled, note: result.nextStep ?? null } }))
          } else {
            setPending((prev) => {
              if (prev[name] === undefined) return prev
              const next = { ...prev }
              delete next[name]
              return next
            })
          }
          if (result.safetyNote) setNotice((prev) => ({ tone: 'warn', message: `${name}: ${result.safetyNote}` }))
        } catch (failure) {
          if (!alive.current || request !== epoch.current) return
          setNotice({
            tone: 'error',
            message: `${t('actionFailed')}: ${failure instanceof Error ? failure.message : String(failure)}`,
          })
        } finally {
          if (alive.current && request === epoch.current) setBusy(null)
        }
      }, [load, t])

      /** 跑一次只读校验（与 shared_tree action=verify 同源）。 */
      const runVerify = useCallback(async () => {
        setBusy('__verify__')
        setNotice(null)
        try {
          const value = await getJson('/verify')
          if (alive.current) setVerify(value)
        } catch (failure) {
          if (alive.current) {
            setNotice({
              tone: 'error',
              message: `${t('actionFailed')}: ${failure instanceof Error ? failure.message : String(failure)}`,
            })
          }
        } finally {
          if (alive.current) setBusy(null)
        }
      }, [t])

      const packages = data?.packages ?? []
      /** 读不到启用状态时，所有行按"状态未知"处理，并禁用开关按钮。 */
      const stateKnown = data === null || data?.profileBundlesAvailable !== false
      const anyBusy = busy !== null

      /**
       * 纯前端过滤：只读，不碰任何文件。
       * 类别判定用 `kind` 单个字段 —— 与 `shared_tree action=search kind=` 完全同一套语义，
       * 界面上勾选的结果因此与工具一致（有 dsh.bundle 的包 kind 就是 bundle，不会再出现在 client 下）。
       */
      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase()
        /** 一条包记录是否命中关键字（只匹配文本，不判断类别/状态）。 */
        const matchesText = (item) => needle.length === 0 ||
          `${item.name} ${item.version ?? ''} ${item.description ?? ''}`.toLowerCase().includes(needle)
        return packages.filter((item) => {
          // 组件没有独立的 enabled 状态，也不参与类别/状态过滤；
          // 只要归属行可见就整组展示，保证组件分组始终完整可读。
          const components = Array.isArray(item.components) ? item.components : []
          if (components.some((child) => matchesText(child))) return true
          if (kind !== 'all' && item.kind !== kind) return false
          if (state === 'on' && item.enabled !== true) return false
          if (state === 'off' && item.enabled === true) return false
          return matchesText(item)
        })
      }, [packages, query, kind, state])

      const junction = data?.junction
      const counts = data?.counts

      /** 一行里的类别标签：dsh.bundle / dsh.client。纯依赖库已被数据源过滤，不会有这种行。 */
      const kindBadges = (item) => {
        const badges = []
        if (item.hasBundle === true) badges.push(h('span', { key: 'b', style: styles.badge }, t('kindBundle')))
        if (item.hasClient === true) badges.push(h('span', { key: 'c', style: styles.badge }, t('kindClient')))
        return badges
      }

      /** 过滤说明：被隐藏的纯依赖库条数 + 被归组进归属插件的组件条数。 */
      const filterNotes = () => {
        if (counts === undefined) return null
        const parts = []
        if (counts.libraries > 0) parts.push(fill('filteredNote', { n: counts.libraries }))
        if (counts.components > 0) parts.push(fill('componentsNote', { n: counts.components }))
        if (parts.length === 0) return null
        return h('div', { style: styles.hint }, parts.join(' · '))
      }

      /**
       * 只读分区：本 profile 里以 `link:` 安装的插件（数据来自 Host 的 `linked`，源自 listBundles().source）。
       * 刻意**不渲染任何按钮** —— 这些包不在共享树里，开关归 Plugins 页；
       * 也不参与上面的四个计数，所以列表口径不受影响。
       */
      const linkedSection = () => {
        const linked = data?.linked ?? []
        if (linked.length === 0) return null
        return h('div', { style: styles.linkedSection, role: 'list' },
          h('div', { style: styles.linkedHeader },
            h('span', { style: styles.title }, fill('linkedTitle', { n: linked.length })),
            h('span', { style: styles.badge }, t('linkedBadge'))),
          h('div', { style: styles.hint }, t('linkedNote')),
          linked.map((item) => h('div', {
            key: `linked::${item.name}`, style: styles.linkedRow, role: 'listitem',
          },
            h('div', { style: styles.rowMain },
              h('div', null,
                h('span', { style: styles.name }, item.name),
                h('span', { style: styles.version },
                  item.version === null || item.version === undefined ? '' : `v${item.version}`)),
              h('div', { style: styles.badges },
                h('span', { style: styles.badge }, t('linkedBadge')),
                h('span', { style: item.enabled ? styles.badgeOn : styles.badge },
                  item.enabled ? t('enabledTag') : t('disabledTag'))),
              item.description
                ? h('div', {
                  className: `${CLS}-desc`, style: styles.hint, title: item.description,
                }, item.description)
                : null,
              h('div', {
                style: { ...styles.hint, wordBreak: 'break-all' },
                title: item.source,
              }, `${t('linkedTarget')}: ${String(item.source).replace(/^link:/, '')}`)))))
      }

      return h('div', { style: styles.root },
        // 组件局部样式：随卸载一起消失，只引用主题 token。内联 style 表达不了
        // :focus-visible / :disabled / 多行截断，这三样正是宿主控件的观感差异来源。
        h('style', null, `
          .${CLS}-btn { cursor: pointer; }
          .${CLS}-btn:disabled { cursor: not-allowed; opacity: 0.55; }
          .${CLS}-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, currentColor); outline-offset: 1px; }
          .${CLS}-desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
          @keyframes dst-skeleton { 0% { opacity: 1; } 40% { opacity: 0.6; } 80%, 100% { opacity: 1; } }
          @media (prefers-reduced-motion: reduce) { .${CLS}-bar-anim { animation: none; } }
        `),
        h('div', { style: styles.header },
          h('span', { style: styles.title }, t('title')),
          h('span', { style: styles.meta },
            counts === undefined
              ? t('loading')
              : `${counts.total} · ${counts.enabled} ${t('countEnabled')}`),
          h('button', {
            type: 'button', className: `${CLS}-btn`, style: styles.button,
            onClick: () => void load(), disabled: loading || anyBusy, title: t('refresh'),
          }, t('refresh')),
          h('button', {
            type: 'button', className: `${CLS}-btn`, style: styles.button,
            onClick: () => void runVerify(), disabled: anyBusy, title: t('verify'),
          }, t('verify')),
        ),
        data === null
          ? null
          : h('div', { style: styles.hint },
            `${t('rootLabel')}: ${data.root} · ${t('manifestLabel')}: ${data.manifest?.entries ?? 0}${data.manifest?.updated === null || data.manifest?.updated === undefined ? '' : ` (${t('updatedLabel')} ${data.manifest.updated})`}`),
        filterNotes(),
        junction === undefined
          ? null
          : h('div', { style: { ...styles.meta, ...(junction.healthy ? null : styles.warn) } },
            `@deepseek-ai junction ${junction.junctions}/${junction.total} ${junction.healthy ? t('junctionOk') : t('junctionBad')}`),
        lifecycle !== null
          ? h('div', { style: styles.hint, 'data-lifecycle': true },
            lifecycle.initialized
              ? `${t('lifeInit')} ${lifecycle.createdAt} · ${t('lifeProfiles')}: ${(lifecycle.profiles ?? []).length} · ${t('lifeChanges')}: ${lifecycle.changes}`
              : t('lifeUninitialized'))
          : null,
        lifecycle?.firstRun === true
          ? h('div', { style: { ...styles.notice, ...styles.ok }, 'data-lifecycle-guide': true },
            t('lifeGuide'))
          : null,
        stateKnown
          ? null
          : h('div', { style: { ...styles.notice, ...styles.warn } }, t('stateUnknown')),
        h('div', { style: styles.controls },
          h('input', {
            style: styles.input, value: query, placeholder: t('search'), 'aria-label': t('search'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h('select', {
            style: styles.select, value: kind, 'aria-label': t('selectKind'),
            onChange: (event) => setKind(event.target.value),
          },
            h('option', { value: 'all' }, t('kindAll')),
            h('option', { value: 'bundle' }, t('kindBundle')),
            h('option', { value: 'client' }, t('kindClient')),
          ),
          h('select', {
            style: styles.select, value: state, 'aria-label': t('selectState'),
            onChange: (event) => setState(event.target.value),
          },
            h('option', { value: 'all' }, t('stateAll')),
            h('option', { value: 'on' }, t('stateOn')),
            h('option', { value: 'off' }, t('stateOff')),
          ),
        ),
        error !== null
          ? h('div', { style: { ...styles.notice, ...styles.error } },
            `${t('loadFailed')}: ${error}`,
            /HTTP 404|HTTP 503|not available/.test(error) ? h('div', null, t('bridgeDown')) : null)
          : null,
        h('div', { 'aria-live': 'polite' },
          notice !== null
            ? h('div', {
              style: {
                ...styles.notice,
                ...(notice.tone === 'error' ? styles.error : notice.tone === 'ok' ? styles.ok : styles.warn),
              },
            }, notice.message)
            : null),
        verify !== null
          ? h('div', { 'aria-live': 'polite' },
            h('div', { style: { ...styles.meta, ...(verify.healthy ? null : styles.warn) } },
              `${verify.healthy ? t('verifyClean') : t('verifyDiff')} · ${t('verifyCounts')}: ${verify.same} / ${verify.drifted} / ${verify.unrecorded} / ${(verify.missing ?? []).length}`),
            h('div', { style: styles.verifyRows },
              (verify.rows ?? []).length === 0
                ? h('span', { style: styles.hint }, t('noRows'))
                : verify.rows.map((row, index) => h('div', {
                  key: index,
                  style: row.tone === 'drift' || row.tone === 'missing' ? styles.warn : null,
                }, row.text))))
          : null,
        loading && data === null
          ? h('div', { style: styles.hint }, t('loading'))
          : detailName !== null
            ? h('div', { style: styles.list },
              h(DetailPanel, {
                key: detailName,
                name: detailName,
                treeVersion: (data?.packages ?? []).find((item) => item.name === detailName)?.version ?? null,
                onBack: () => setDetailName(null),
                onUpgrade: (name, version) => void openConfirm(name, version),
                onJobStarted: jobStartedFromChild,
                t, fill,
              }))
            : h('div', { style: styles.list, role: 'list' },
            data !== null && data.exists === false
              ? h('div', { style: styles.notice }, t('missingTree'))
              : visible.length === 0
                ? h('div', { style: styles.hint }, t('empty'))
                : visible.map((item) => {
                  const waiting = pending[item.name]
                  const enabledNow = waiting === undefined ? item.enabled === true : waiting.enabled === true
                  const stateStyle = waiting !== undefined
                    ? styles.badgeWarn
                    : enabledNow ? styles.badgeOn : styles.badge
                  const stateText = waiting !== undefined
                    ? t('pendingTag')
                    : stateKnown ? (enabledNow ? t('enabledTag') : t('disabledTag')) : t('unknownTag')
                  const components = Array.isArray(item.components) ? item.components : []
                  return h('div', { key: item.name, style: styles.group },
                    h('div', { style: styles.row, role: 'listitem' },
                      h('div', {
                        style: { ...styles.rowMain, cursor: 'pointer' },
                        onClick: () => { setDetailName(item.name); setCheck(null) },
                        title: `${t('wholeRowHint')} — ${item.name}`,
                      },
                        h('div', null,
                          h('span', { style: styles.name }, item.name),
                          h('span', { style: styles.version },
                            item.version === null || item.version === undefined ? '' : `v${item.version}`)),
                        h('div', { style: styles.badges },
                          ...kindBadges(item),
                          h('span', { style: stateStyle }, stateText),
                          components.length > 0
                            ? h('span', { style: styles.badge }, `${components.length} 组件`)
                            : null),
                        item.description
                          ? h('div', {
                            className: `${CLS}-desc`, style: styles.hint, title: item.description,
                          }, item.description)
                          : null,
                        item.safetyNote
                          ? h('div', { style: { ...styles.hint, ...styles.warn } }, `${t('safetyNote')}: ${item.safetyNote}`)
                          : null),
                      // 不是独立可启用的 bundle（entry id 已由别的插件提供）时不给开关，
                      // 否则一键就会重复插入 entry id、让设置页存不下（issue #470）。
                      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '0 0 auto' } },
                        item.hasBundle === true && item.standaloneConflict === undefined
                          ? h('button', {
                            type: 'button', className: `${CLS}-btn`,
                            style: enabledNow ? styles.button : styles.primaryButton,
                            disabled: anyBusy || !stateKnown,
                            onClick: (event) => { event.stopPropagation(); void toggle(item.name, !enabledNow) },
                            title: `${enabledNow ? t('disable') : t('enable')} ${item.name}`,
                            'aria-label': `${enabledNow ? t('disable') : t('enable')} ${item.name}`,
                          }, busy === item.name ? t('working') : (enabledNow ? t('disable') : t('enable')))
                          : null,
                        h('button', {
                          type: 'button', className: `${CLS}-btn`, style: styles.button,
                          onClick: (event) => { event.stopPropagation(); setDetailName(item.name); setCheck(null) },
                          title: `${t('detail')} ${item.name}`,
                        }, t('detail')),
                        item.hasBundle === true || item.hasClient === true
                          ? h('button', {
                            type: 'button', className: `${CLS}-btn`, style: styles.button,
                            onClick: (event) => { event.stopPropagation(); void openConfirm(item.name, item.version) },
                            title: `${t('upgrade')} ${item.name}`,
                          }, t('upgrade'))
                          : null)),
                    // 组件行：不进顶层列表、没有独立开关，随归属包一起显示。
                    components.map((child) => h('div', {
                      key: `${item.name}::${child.name}`, style: styles.childRow, role: 'listitem',
                    },
                      h('div', { style: styles.rowMain },
                        h('div', null,
                          h('span', { style: { ...styles.name, ...styles.childName } }, child.name),
                          h('span', { style: styles.version },
                            child.version === null || child.version === undefined ? '' : `v${child.version}`)),
                        h('div', { style: styles.badges },
                          h('span', { style: styles.badge }, fill('componentOf', { owner: item.name })),
                          h('span', { style: styles.badge, title: child.conflictId }, child.conflictId)),
                        h('div', {
                          className: `${CLS}-desc`, style: styles.hint,
                          title: fill('componentHint', { owner: item.name }),
                        }, fill('componentHint', { owner: item.name }))),
                      null)))
                }),
            // 只读分区放在同一滚动区末尾，滚到底就能看到；不参与计数、无按钮。
            linkedSection()),
        job !== null
          ? h(JobCard, {
            job,
            check,
            onClose: () => { setJob(null); setCheck(null) },
            t, fill,
          })
          : null,
        confirm !== null
          ? h(ConfirmModal, {
            pkg: confirm, exact, setExact,
            onStart: (spec) => void startInstall(spec),
            onCancel: () => setConfirm(null),
            t, fill,
          })
          : null,
        h('div', { style: styles.hint }, t('hint')),
      )
    }

    /** 侧边栏图标：36×36，跟随主题色，不画背景板、不用 emoji。 */
    function SidebarIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      const stroke = props?.active === true
        ? 'var(--dsw-alias-brand-primary, currentColor)'
        : 'var(--dsw-alias-label-secondary, currentColor)'
      return h('svg', {
        width: size, height: size, viewBox: '0 0 36 36', 'aria-hidden': true,
        style: { display: 'block' },
      },
        h('g', {
          fill: 'none', stroke, strokeWidth: 1.8,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        },
          h('path', { d: 'M18 30.5V17.5' }),
          h('path', { d: 'M18 22.5C15 22.5 11.5 20.5 10.5 17' }),
          h('path', { d: 'M18 22.5C21 22.5 24.5 20.5 25.5 17' }),
          h('circle', { cx: 10.5, cy: 13.6, r: 3.4 }),
          h('circle', { cx: 25.5, cy: 13.6, r: 3.4 }),
          h('circle', { cx: 18, cy: 9.4, r: 3.4 }),
        ),
        h('rect', { x: 14.2, y: 29, width: 7.6, height: 5, rx: 1.3, fill: stroke }),
        h('circle', { cx: 18, cy: 17.5, r: 2.1, fill: stroke }),
      )
    }

    return {
      /**
       * slots 与 locale 都必须声明：cordis 的客户端 Context 在**未 inject** 的服务上
       * 取值会直接抛 `cannot get property "x" without inject`，不是返回 undefined。
       * sidebarRightTabs 故意不放进这里 —— 放进去会让整个客户端插件在缺少该服务的
       * profile 里都不激活，连带丢掉主列面板与侧边栏图标；改用 `ctx.inject([...])` 可选接入。
       */
      inject: ['slots', 'locale'],

      /**
       * 注册文案与界面。
       * @param {any} ctx 客户端上下文。
       */
      apply(ctx) {
        // 文案：注册本包字典并绑定命名空间；失败时退回内置中文字典。
        try {
          const registerLocale = ctx.locale.register.bind(ctx.locale)
          ctx.effect(() => {
            const disposers = []
            for (const [locale, dict] of Object.entries(DICTS)) {
              disposers.push(registerLocale(NS, locale, dict))
            }
            return () => { for (const dispose of disposers) dispose() }
          }, 'dsh-shared-tree: locale')
          const bound = ctx.locale.bind(NS)
          translate = (key) => {
            try {
              const value = bound(key)
              if (typeof value === 'string' && value.length > 0 && value !== key) return value
            } catch {
              // 退回字典。
            }
            return DICTS.zh[key] ?? key
          }
        } catch (error) {
          console.error('[dsh-shared-tree] 文案注册失败，使用内置字典', error)
        }

        const title = () => translate('title')

        // 1) 主列全局面板：点侧边栏图标后在主列展开完整列表。
        try {
          ctx.slots.inject('main', function* () {
            yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, SharedTreePanel)
          })
        } catch (error) {
          console.error('[dsh-shared-tree] main 面板注册失败', error)
        }

        // 2) 左侧边栏图标行（id 必须与 main 的 key 相同）。
        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: title, locale: NS },
            SidebarIcon,
          ))
        } catch (error) {
          console.error('[dsh-shared-tree] 侧边栏图标注册失败', error)
        }

        // 3) 右侧边栏 tab（原生右栏，与 super-kanban / better-sidebar 同一套 API）。
        //    ctx.inject 让这段只在宿主真提供 sidebarRightTabs 时才执行。
        try {
          ctx.inject(['sidebarRightTabs'], (sideCtx) => {
            sideCtx.effect(() => sideCtx.sidebarRightTabs.register({
              id: SIDE_KIND,
              kind: SIDE_KIND,
              priority: 'extension',
              title,
              guide: [{
                id: 'shared-tree',
                order: 40,
                title,
                description: () => translate('hint'),
              }],
            }), 'dsh-shared-tree: side tab type')
            sideCtx.slots.inject('sidebar.right.pane.tab', () => sideCtx.slots.register(
              { name: 'sidebar.right.pane.tab', key: SIDE_KIND },
              SharedTreePanel,
            ))
          })
        } catch (error) {
          console.error('[dsh-shared-tree] 右栏 tab 注册失败', error)
        }
      },
    }
  },
})
