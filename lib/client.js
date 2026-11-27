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
 *   - 搜索/过滤全在本组件内完成，只读，不发写请求。
 *
 * 界面定位（2026-11-27 精简后）：本面板只是共享树的**只读目录 + 跳转入口**。
 * 启用/停用、升级、功能行开关、描述文档一律在官方 Plugins 页（或 shared_tree 工具）里做，
 * 客户端不再自建详情页，也不再提供任何功能按钮。
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
    /** 升级成功后进度卡自动收起的延时：够看清「逐 profile 验证」结论，又不至于一直占着面板。 */
    const JOB_AUTO_DISMISS_MS = 6000

    /** 界面文案字典：扁平 key → 文本。en/zh 的 key 必须一一对应。 */
    const DICTS = {
      en: {
        title: 'Shared plugin tree',
        search: 'Search name or description…',
        kindAll: 'All',
        kindBundle: 'dsh.bundle',
        kindClient: 'dsh.client',
        selectKind: 'Filter by category',
        selectState: 'Filter by enabled state',
        stateAll: 'Any state',
        stateOn: 'Enabled',
        stateOff: 'Disabled',
        refresh: 'Refresh',
        empty: 'No package in the shared tree matches.',
        missingTree: 'The shared tree directory does not exist yet.',
        loading: 'Loading…',
        loadFailed: 'Could not read the shared tree',
        bridgeDown: 'The UI data channel is unavailable (the Host webServer is not mounted). Use the shared_tree tool instead.',
        enabledTag: 'enabled',
        disabledTag: 'disabled',
        unknownTag: 'unknown',
        junctionOk: 'junctions intact',
        junctionBad: 'junctions damaged',
        countEnabled: 'enabled',
        filteredNote: '{n} pure dependency libraries hidden (hoisted by pnpm, not plugins)',
        componentsNote: '{n} component(s) grouped under their owner',
        linkedTitle: 'Linked plugins in this profile ({n})',
        linkedNote: 'Read-only. These are installed as local link: paths, so they do not live in the shared tree. Use the Plugins page to manage them.',
        linkedBadge: 'linked',
        linkedTarget: 'Path',
        componentOf: 'component of {owner}',
        componentHint: 'Not independently enableable: {owner} already provides this entry id; enabling it separately would insert the id twice and break Settings (issue #470). Switch it in {owner}\'s own settings page.',
        stateUnknown: 'This profile\'s enabled state could not be read (pluginManager unavailable), so every row shows unknown.',
        hint: 'Directory of the shared tree. Click a bundle row to open its configuration in the official Plugins page; enable/disable and feature switches happen there (or via the shared_tree tool). Upgrades can be triggered here: Check updates lists newer versions, and each row gets an Upgrade button.',
        rootLabel: 'Tree',
        manifestLabel: 'Manifest',
        updatedLabel: 'updated',
        openConfigHint: 'Open this plugin’s own configuration page in the official Plugins panel',
        componentRowHint: 'A component, not a standalone plugin: switch it in {owner}’s settings page',
        clientRowHint: 'Client-only package: it has no bundle configuration page; manage it in the official Plugins page',
        jumpFailed: 'Could not open the official Plugins page (the navigation service is unavailable, or registering the link: dependency was refused).',
        lifeInit: 'Lifecycle: initialized',
        lifeProfiles: 'baseline profiles',
        lifeChanges: 'tracked changes',
        lifeUninitialized: 'Lifecycle: no baseline snapshot recorded yet',
        lifeGuide: 'Initialized: the shared tree was created and baseline snapshots of every profile were recorded. Disabling this plugin automatically reverts only the config changes made through it.',
        checkNow: 'Check now',
        checkNowHint: 'Scan the registry once now (slow: a few seconds per package). Normal refreshes read the scheduled scan result.',
        checking: 'Scanning…',
        scanInBackground: 'A scheduled scan is running in the background…',
        neverScanned: 'No scheduled scan yet (runs every {interval}). Click "Check now" to scan once.',
        scannedAt: 'scanned {at}',
        checkFailed: 'Could not scan',
        upgradesFound: '{n} plugin(s) have newer versions',
        noUpgrades: 'All plugins are up to date (or the registry is unreachable).',
        upgrade: 'Upgrade',
        upgradeTo: 'Upgrade to v{version}',
        depsUnavailable: 'Registry metadata unavailable — upgrade stays enabled, please verify manually.',
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
        jobRunning: 'Upgrading…',
        jobDone: 'Upgrade finished',
        jobFailed: 'Upgrade failed',
        jobDoneHint: ' (this panel closes by itself; the list is already refreshed)',
        jobAutoDismissHint: 'Closes automatically in a few seconds',
        verifyProfiles: 'Post-upgrade verification',
        checkMatch: 'version matches tree',
        checkMismatch: 'version differs from tree',
        satisfy: 'satisfied',
        unsatisfied: 'NOT satisfied',
        unknownCheck: 'unknown',
        peerLabel: 'peer',
        nodeLabel: 'node engine',
        dshLabel: 'dsh engine',
        exemptWarn: 'This version declares engines.dsh {required} that could not be verified automatically — confirm manually before upgrading.',
        upgradeBlocked: 'Dependency checks failed — upgrade is disabled. Verify manually before retrying.',
      },
      zh: {
        title: '共享插件树',
        search: '搜索包名或描述…',
        kindAll: '全部',
        kindBundle: 'dsh.bundle',
        kindClient: 'dsh.client',
        selectKind: '按类别过滤',
        selectState: '按启用状态过滤',
        stateAll: '全部状态',
        stateOn: '已启用',
        stateOff: '未启用',
        refresh: '刷新',
        empty: '共享树里没有匹配的包。',
        missingTree: '共享树目录还不存在。',
        loading: '读取中…',
        loadFailed: '读取共享树失败',
        bridgeDown: '界面数据通道不可用（Host 的 webServer 未挂载）。请改用 shared_tree 工具。',
        enabledTag: '已启用',
        disabledTag: '未启用',
        unknownTag: '状态未知',
        junctionOk: 'junction 完好',
        junctionBad: 'junction 异常',
        countEnabled: '已启用',
        filteredNote: '已隐藏 {n} 个纯依赖库（pnpm hoisted 提升，非插件）',
        componentsNote: '{n} 个组件已归入其归属插件',
        linkedTitle: '本 profile 的 link: 插件（{n}）',
        linkedNote: '只读。这些是本地 link: 路径安装的插件，物理上不在共享树里，管理请到 Plugins 页。',
        linkedBadge: 'linked',
        linkedTarget: '路径',
        componentOf: '{owner} 的组件',
        componentHint: '不可独立启用：{owner} 已经提供了这个 entry id，单独启用会让 id 被插入两次、导致设置页存不下来（issue #470）。请在 {owner} 自己的设置页里切换。',
        stateUnknown: '读不到本 profile 的启用状态（pluginManager 不可用），所有行显示为状态未知。',
        hint: '共享树目录：点 bundle 行跳到官方 Plugins 页里它的配置面板；启用/停用、功能开关在那里（或 shared_tree 工具）做。升级可在本面板触发：「检查更新」列出有新版本的插件，行内出现「升级」按钮。',
        rootLabel: '树位置',
        manifestLabel: '清单',
        updatedLabel: '更新于',
        openConfigHint: '跳到官方 Plugins 页里该插件自己的配置面板',
        componentRowHint: '组件，不是独立插件：请在 {owner} 的设置页里切换',
        clientRowHint: '仅客户端包，没有 bundle 配置页；请到官方 Plugins 页管理',
        jumpFailed: '无法打开官方 Plugins 页（导航服务不可用，或登记 link: 依赖被拒绝）。',
        lifeInit: '生命周期：已初始化',
        lifeProfiles: '基线 profile',
        lifeChanges: '台账变更',
        lifeUninitialized: '生命周期：尚未记录基线快照',
        lifeGuide: '已初始化：共享树目录已创建、各 profile 基线快照已记录。停用本插件会自动还原它做过的配置变更（手工改动不受影响）。',
        checkNow: '立即检查',
        checkNowHint: '现在真扫一次 registry（较慢：每包数秒）。平时刷新只读定时扫描的结果。',
        checking: '扫描中…',
        scanInBackground: '后台定时扫描进行中…',
        neverScanned: '还没有定时扫描结果（每 {interval} 自动扫一次）。可以点「立即检查」扫一次。',
        scannedAt: '扫描于 {at}',
        checkFailed: '扫描失败',
        upgradesFound: '{n} 个插件有新版本',
        noUpgrades: '所有插件都是最新版本（或 registry 不可达）。',
        upgrade: '升级',
        upgradeTo: '升级到 v{version}',
        depsUnavailable: '读不到 registry 元数据——升级按钮保持可用，请人工核对版本。',
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
        jobRunning: '升级中…',
        jobDone: '升级完成',
        jobFailed: '升级失败',
        jobDoneHint: '（本面板会自动收起，列表已刷新）',
        jobAutoDismissHint: '几秒后自动收起',
        verifyProfiles: '升级后逐 profile 验证',
        checkMatch: '版本与树一致',
        checkMismatch: '版本与树不一致',
        satisfy: '满足',
        unsatisfied: '不满足',
        unknownCheck: '未知',
        peerLabel: 'peer',
        nodeLabel: 'node 引擎',
        dshLabel: 'dsh 引擎',
        exemptWarn: '该版本声明了 engines.dsh {required}，本机版本无法自动核对——升级前请人工确认。',
        upgradeBlocked: '依赖检查不通过——升级按钮已禁用，请人工核对后再试。',
      },
    }

    /** 由 apply 填入的翻译函数（locale 不可用时退回中文字典）。 */
    let translate = (key) => DICTS.zh[key] ?? key

    /** 由 apply 填入的客户端上下文（用于懒取宿主 pluginNavigation / pluginManager 服务）。 */
    let hostCtx = null

    /**
     * 读官方 Plugins 面板当前能看到哪些包名。
     *
     * 直接问宿主 `pluginManager.listBundles()`（面板自己的数据源），不猜：
     * 面板的候选集合只来自 profile 清单，和共享树目录里有什么无关。
     * @returns {Promise<string[]|null>} 包名列表；服务不可用时 null（表示"未知"，不要据此下结论）。
     */
    async function panelVisibleNames() {
      try {
        const remote = hostCtx?.remote?.pluginManager
        if (remote === undefined || typeof remote.listBundles !== 'function') return null
        const result = await remote.listBundles()
        const list = result?.ok === true ? result.value : Array.isArray(result) ? result : null
        if (!Array.isArray(list)) return null
        return list.map((item) => item?.name).filter((name) => typeof name === 'string')
      } catch (error) {
        console.error('[dsh-shared-tree] 读取官方面板清单失败', error)
        return null
      }
    }

    /**
     * 让共享树里的一个包重新出现在官方 Plugins 面板（必要时登记 link: 依赖）。
     * @param {string} name 包名。
     * @returns {Promise<'listed'|'exposed'|'expose-failed'>} 结果。
     */
    async function ensurePanelVisible(name) {
      const names = await panelVisibleNames()
      if (names !== null && names.includes(name)) return 'listed'
      try {
        const result = await postJson('/panel', { target: name, exposed: true })
        if (result?.ok !== true) return 'expose-failed'
        const after = await panelVisibleNames()
        // after 为 null 表示读不到清单：登记已成功，仍然尝试跳转（宿主会自行判断）。
        if (after === null || after.includes(name)) return 'exposed'
        return 'expose-failed'
      } catch (error) {
        console.error('[dsh-shared-tree] 登记面板可见失败', error)
        return 'expose-failed'
      }
    }

    /**
     * 打开官方 Plugins 页里该插件自己的配置面板（宿主 pluginNavigation.openBundle）。
     *
     * 面板列不出的包先登记成当前 profile 的 link: 依赖（不加载、不改变启用状态），再跳转；
     * 宿主没提供 pluginNavigation、或登记被拒时返回 false，由调用方给出提示。
     * @param {string} name 共享树里的包名。
     * @returns {Promise<boolean>} 是否成功转交宿主。
     */
    async function openOfficialConfig(name) {
      try {
        const nav = hostCtx?.get?.('pluginNavigation')
        if (!nav || typeof nav.openBundle !== 'function') return false
        const state = await ensurePanelVisible(name)
        if (state === 'expose-failed') return false
        nav.openBundle(name)
        return true
      } catch (error) {
        console.error('[dsh-shared-tree] 打开官方配置页失败', error)
      }
      return false
    }

    /**
     * 比较两个版本号（忽略预发布后缀，数字段逐个比）。
     *
     * 只有 `latest > current` 才算可升级。相等是"已最新"；更小说明当前装的是别的来源
     * （如从 git commit 装的 `dsh-douyin@0.3.2`，而 registry 上只有 `0.0.1`）——那是降级方向，
     * 绝不能给升级按钮。判据与服务端 `compareVersions` 同源。
     * @param {string} left 左侧版本。
     * @param {string} right 右侧版本。
     * @returns {number|null} >0 左大；<0 右大；0 相等；不可解析 null。
     */
    function compareVersionStrings(left, right) {
      const parse = (value) => {
        if (typeof value !== 'string' || value.length === 0) return null
        const core = value.trim().replace(/^[v=\s]+/, '').split('-')[0]
        const parts = core.split('.').map((part) => Number.parseInt(part, 10))
        if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return null
        return parts
      }
      const a = parse(left)
      const b = parse(right)
      if (a === null || b === null) return null
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const l = a[index] ?? 0
        const r = b[index] ?? 0
        if (l !== r) return l - r
      }
      return 0
    }

    /**
     * 把 ISO 时间格式化成本地「MM-DD HH:mm」（扫描时间展示用）。
     * @param {string|null} iso ISO 时间。
     * @returns {string} 格式化结果；无法解析时原样返回。
     */
    function formatTime(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return '—'
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return iso
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
    }

    /**
     * 把间隔毫秒格式化成「N 小时 / N 分钟」。
     * @param {number|null} ms 间隔。
     * @returns {string} 格式化结果。
     */
    function formatInterval(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
      if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`
      return `${Math.round(ms / 60_000)}min`
    }

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
        Object.hasOwn(values, name) ? String(values[name]) : whole
      ))
    }

    /**
     * 发一个 GET 并取 value。
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
      /** 只读分区：与上方目录列表用一条分隔线拉开，视觉上看得出它不可操作。 */
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
      notice: {
        padding: '6px 8px', borderRadius: '6px', fontSize: '11px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))',
      },
      warn: { color: 'var(--dsw-alias-state-warn-primary, inherit)' },
      error: { color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-danger, inherit))' },
      hint: {
        flex: '0 0 auto', fontSize: '11px',
        color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit))',
      },
      // ── 升级 UI（2026-11-27 恢复，长期保留）──
      primaryButton: {
        padding: '3px 9px', fontSize: '11px', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
        background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #3b6ef5))',
        border: '1px solid transparent', borderRadius: '5px',
      },
      badgeWarn: {
        fontSize: '10px', padding: '1px 5px', borderRadius: '4px',
        color: 'var(--dsw-alias-state-warn-primary, inherit)',
        border: '1px solid var(--dsw-alias-state-warn-primary, currentColor)',
      },
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
    }

    /** 检查行的人类可读类别名（升级确认弹窗的依赖检查用）。 */
    function checkKindLabel(kind, t) {
      if (kind === 'peer') return t('peerLabel')
      if (kind === 'node') return t('nodeLabel')
      return t('dshLabel')
    }

    /**
     * 升级确认弹窗：固定精确版本开关 + 影响面列表 + 依赖检查 + 开始/取消。
     * 与 38555d5 删除前的实现同源（ConfirmModal），依赖检查从原详情页 depsSection 移入。
     * @param {{ pkg: {name: string, version: string|null, impact: any, deps: any}, exact: boolean, setExact: Function, onStart: Function, onCancel: Function, t: Function, fill: Function }} props 见名知义。
     * @returns {any} React 元素。
     */
    function ConfirmModal({ pkg, exact, setExact, onStart, onCancel, t, fill }) {
      const referencing = (pkg.impact?.profiles ?? []).filter((row) => row.referenced)
      const spec = pkg.version !== null && exact ? `${pkg.name}@${pkg.version}` : pkg.name
      const deps = pkg.deps
      const upgradeBlocked = deps?.ok === false
      const exemptRow = (deps?.checks ?? []).find((row) => row.kind === 'dsh' && row.ok === null)
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
          // 依赖检查（原详情页 depsSection 的判据）：ok===false 时禁用开始按钮。
          deps === null
            ? h('div', { style: styles.hint }, t('loading'))
            : deps.available !== true
              ? h('div', { style: { ...styles.hint, ...styles.warn } }, deps.error ?? t('depsUnavailable'))
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                h('div', { style: styles.kvRow },
                  ...deps.checks.map((row) => h('span', {
                    key: `${row.kind}:${row.name}`,
                    title: `required ${row.required} / installed ${row.installed ?? '?'}`,
                    style: row.ok === false ? styles.badgeWarn : row.ok === true ? styles.badgeOn : styles.badge,
                  }, `${checkKindLabel(row.kind, t)} ${row.name} ${row.required} — ${row.ok === false ? t('unsatisfied') : row.ok === true ? t('satisfy') : t('unknownCheck')}`))),
                exemptRow !== undefined
                  ? h('div', { style: { ...styles.hint, ...styles.warn } }, fill('exemptWarn', { required: exemptRow.required }))
                  : null,
                upgradeBlocked
                  ? h('div', { style: { ...styles.hint, ...styles.warn } }, t('upgradeBlocked'))
                  : null),
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
              disabled: pkg.version === null || pkg.impact === null || upgradeBlocked,
              onClick: () => onStart(spec),
            }, t('start')))))
    }

    /**
     * 升级任务进度卡：四阶段进度条 + 完成后逐 profile 验证结果。
     * 与 38555d5 删除前的实现同源（JobCard）。
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
          // 成功后会自动收起：提前告知，避免用户以为面板"自己消失了"是异常。
          job.state === 'done' ? h('span', { style: styles.hint }, t('jobAutoDismissHint')) : null,
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
     * 面板组件：共享树的只读目录（列表 + 搜索 + 过滤 + 刷新），点 bundle 行跳官方配置页。
     * 三处入口（主列面板 / 侧边栏图标选中的面板 / 右栏 tab）共用它。
     * @returns {any} React 元素。
     */
    function SharedTreePanel() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [notice, setNotice] = useState(null)
      const [query, setQuery] = useState('')
      const [kind, setKind] = useState('all')
      const [state, setState] = useState('all')
      // 生命周期状态条（只读）：状态与渲染必须同在本组件作用域内（2026-11-27 黑屏回归教训）。
      const [lifecycle, setLifecycle] = useState(null)
      // ── 升级 UI 的状态（2026-11-27 恢复，与 38555d5 删除前同源）──
      const [job, setJob] = useState(null)
      const [check, setCheck] = useState(null)
      const [confirm, setConfirm] = useState(null)
      const [exact, setExact] = useState(true)
      const jobTargetRef = useRef(null)
      // 可升级判据缓存：pkg → /deps?ver=latest 的结果（available/version/checks/ok）。
      const [updates, setUpdates] = useState({})
      const [checking, setChecking] = useState(false)
      const [updatesChecked, setUpdatesChecked] = useState(false)
      /** 定时扫描的元信息：上次扫描时间、耗时、下次时间、是否正在扫。 */
      const [scanMeta, setScanMeta] = useState({ scannedAt: null, durationMs: null, nextScanAt: null, intervalMs: null, scanning: false, upgradable: 0 })
      const updatesLoaded = useRef(false)
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

      // ── 升级任务轮询：running 时每 800ms 问一次进度；结束时取逐 profile 验证结果并刷新列表 ──
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
              if (alive.current) {
                // 升级完成：列表与版本信息刷新到最新状态，并清掉旧的可升级缓存。
                setUpdates({})
                setUpdatesChecked(false)
                void load()
                // 重读定时扫描缓存：本地版本已变，旧结论（如"有新版本"）已作废。
                void loadUpdates()
                if (value.state === 'done') {
                  // 成功：把结论落到通知区（组件卸载后仍有记录），随后自动收起进度卡。
                  setNotice({
                    tone: 'ok',
                    message: `${t('jobDone')}${value.detail ? ` — ${value.detail}` : ''}${t('jobDoneHint')}`,
                  })
                  setTimeout(() => {
                    if (!alive.current) return
                    setJob((prev) => (prev !== null && prev.state === 'done' ? null : prev))
                    setCheck(null)
                  }, JOB_AUTO_DISMISS_MS)
                }
                // 失败：**不自动收起** —— 用户需要读错误原因，只能手动「取消」关闭。
              }
            }
          })()
        }, 800)
        return () => clearInterval(timer)
      }, [job !== null && job.state === 'running', load, t])

      /**
       * 把服务端缓存的行形状（{current, latest, available, checks, ok}）转成组件内部统一形状
       * （{version, available, checks, ok}），两处判据共用同一个 upgradeInfo。
       * @param {Record<string, any>} entries 缓存行。
       * @returns {Record<string, any>} 转换后的表。
       */
      const adoptCache = (entries) => {
        const next = {}
        for (const [name, row] of Object.entries(entries ?? {})) {
          next[name] = {
            available: row?.available === true,
            version: typeof row?.latest === 'string' ? row.latest : null,
            checks: Array.isArray(row?.checks) ? row.checks : [],
            ok: row?.ok ?? null,
            error: row?.error ?? null,
          }
        }
        return next
      }

      /**
       * 读服务端的版本更新缓存（**不打 registry**）：定时扫描结果落盘，刷新页面只读它。
       * 只有用户显式点「立即检查」才会触发一次真实网络扫描。
       */
      const loadUpdates = useCallback(async () => {
        try {
          const cache = await getJson('/updates')
          if (!alive.current) return
          setUpdates(adoptCache(cache?.entries))
          setUpdatesChecked(cache?.scannedAt !== null && cache?.scannedAt !== undefined)
          setScanMeta({
            scannedAt: cache?.scannedAt ?? null,
            durationMs: cache?.durationMs ?? null,
            nextScanAt: cache?.nextScanAt ?? null,
            intervalMs: cache?.intervalMs ?? null,
            scanning: cache?.scanning === true,
            upgradable: Array.isArray(cache?.upgradable) ? cache.upgradable.length : 0,
          })
        } catch {
          // 缓存读不到保持"未检查"，不打扰用户（定时扫描会补上）。
        }
      }, [])

      /**
       * 立即检查：POST /updates 触发服务端**真扫一次**（结果落盘到缓存）。
       * 这不是刷新路径 —— 平时刷新只读缓存，不再每包 3–7 秒地打 registry。
       */
      const checkUpdates = useCallback(async () => {
        setChecking(true)
        try {
          const cache = await postJson('/updates', {})
          if (!alive.current) return
          setUpdates(adoptCache(cache?.entries))
          setUpdatesChecked(true)
          setScanMeta({
            scannedAt: cache?.scannedAt ?? null,
            durationMs: cache?.durationMs ?? null,
            nextScanAt: cache?.nextScanAt ?? null,
            intervalMs: cache?.intervalMs ?? null,
            scanning: false,
            upgradable: Array.isArray(cache?.upgradable) ? cache.upgradable.length : 0,
          })
        } catch (failure) {
          // 409 = 已有扫描在跑（定时器），不算错误。
          const text = failure instanceof Error ? failure.message : String(failure)
          if (!/already running/i.test(text)) {
            setNotice({ tone: 'warn', message: `${translate('checkFailed')}: ${text}` })
          }
        } finally {
          if (alive.current) setChecking(false)
        }
      }, [])

      // 挂载后读一次缓存（只读，不打 registry）。
      useEffect(() => {
        if (data !== null && !updatesLoaded.current) {
          updatesLoaded.current = true
          void loadUpdates()
        }
      }, [data !== null, loadUpdates])

      // 扫描进行中时轮询缓存（定时扫描可能正在跑），完成后自动停。
      useEffect(() => {
        if (scanMeta.scanning !== true) return undefined
        const timer = setInterval(() => { void loadUpdates() }, 5000)
        return () => clearInterval(timer)
      }, [scanMeta.scanning, loadUpdates])

      /** 一个包是否有新版本（判据与服务端 scanUpdates 同源：只认 latest > current）。 */
      const upgradeInfo = (item) => {
        const deps = updates[item.name]
        if (deps === undefined || deps.available !== true || typeof deps.version !== 'string') return null
        if (item.version === null || item.version === undefined) return deps
        // 版本必须**严格更新**才算可升级：相等是已最新，更小说明当前装的是别的来源（如 git commit），
        // 那是降级方向，绝不能给升级按钮。
        const order = compareVersionStrings(deps.version, item.version)
        if (order === null) return null
        return order > 0 ? deps : null
      }

      /** 打开升级确认弹窗：先取影响面与依赖检查，弹窗里展示"影响 N 个 profile"。 */
      const openConfirm = useCallback(async (name, version) => {
        setExact(true)
        setConfirm({ name, version, impact: null, deps: updates[name] ?? null })
        try {
          const impact = await getJson(`/impact?pkg=${encodeURIComponent(name)}`)
          setConfirm((prev) => (prev !== null && prev.name === name ? { ...prev, impact } : prev))
        } catch {
          // 影响面拿不到也允许继续：兜底为空列表（fail-open），弹窗显示"还没有 profile 引用"。
          setConfirm((prev) => (prev !== null && prev.impact === null ? { ...prev, impact: { profiles: [] } } : prev))
        }
        // 依赖检查缓存缺失时补拉一次（判据与删除前 depsSection 一致）。
        if (updates[name] === undefined) {
          try {
            const deps = await getJson(`/deps?pkg=${encodeURIComponent(name)}&ver=latest`)
            setConfirm((prev) => (prev !== null && prev.name === name ? { ...prev, deps } : prev))
          } catch {
            setConfirm((prev) => (prev !== null && prev.deps === null ? { ...prev, deps: { available: false, error: 'registry unreachable', checks: [], ok: null, version: null } } : prev))
          }
        }
      }, [updates])

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

      const packages = data?.packages ?? []
      /** 读不到启用状态时，所有行按"状态未知"处理（只读展示，不再有需要禁用的开关）。 */
      const stateKnown = data === null || data?.profileBundlesAvailable !== false

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
       * 刻意**不渲染任何按钮** —— 这些包不在共享树里，管理归 Plugins 页；
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

      /**
       * 行点击：独立 bundle 先 ensurePanelVisible 再跳官方配置页；
       * 组件与 client-only 包没有自己的配置页，不跳转，只给提示（自建详情页已删除）。
       * @param {any} item 包记录。
       */
      const onRowClick = (item) => {
        if (item.hasBundle === true && item.standaloneConflict === undefined) {
          void openOfficialConfig(item.name).then((opened) => {
            if (!opened) setNotice({ tone: 'warn', message: `${item.name}: ${t('jumpFailed')}` })
          })
          return
        }
        if (item.standaloneConflict !== undefined) {
          setNotice({ tone: 'warn', message: fill('componentRowHint', { owner: item.standaloneConflict.owner }) })
          return
        }
        setNotice({ tone: 'warn', message: t('clientRowHint') })
      }

      /** 行悬浮提示：独立 bundle 说明跳转去向，组件/client-only 说明为何不跳。 */
      const rowHint = (item) => {
        if (item.hasBundle === true && item.standaloneConflict === undefined) {
          return `${t('openConfigHint')} — ${item.name}`
        }
        if (item.standaloneConflict !== undefined) {
          return fill('componentRowHint', { owner: item.standaloneConflict.owner })
        }
        return t('clientRowHint')
      }

      return h('div', { style: styles.root },
        // 组件局部样式：随卸载一起消失，只引用主题 token。内联 style 表达不了
        // :focus-visible / :disabled / 多行截断，这三样正是宿主控件的观感差异来源。
        h('style', null, `
          .${CLS}-btn { cursor: pointer; }
          .${CLS}-btn:disabled { cursor: not-allowed; opacity: 0.55; }
          .${CLS}-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, currentColor); outline-offset: 1px; }
          .${CLS}-desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        `),
        h('div', { style: styles.header },
          h('span', { style: styles.title }, t('title')),
          h('span', { style: styles.meta },
            counts === undefined
              ? t('loading')
              : `${counts.total} · ${counts.enabled} ${t('countEnabled')}`),
          h('button', {
            type: 'button', className: `${CLS}-btn`, style: styles.button,
            onClick: () => void load(), disabled: loading || checking || (job !== null && job.state === 'running'), title: t('refresh'),
          }, t('refresh')),
          h('button', {
            type: 'button', className: `${CLS}-btn`, style: styles.button,
            onClick: () => void checkUpdates(),
            disabled: loading || checking || scanMeta.scanning === true || (job !== null && job.state === 'running'),
            title: t('checkNowHint'),
          }, checking || scanMeta.scanning === true ? t('checking') : t('checkNow')),
        ),
        // 可升级汇总 + 扫描元信息：定时扫描的结果，刷新页面不再重新探测。
        updatesChecked
          ? h('div', { style: styles.hint, 'data-updates-summary': true },
            (() => {
              const n = packages.filter((item) => upgradeInfo(item) !== null).length
              const head = n > 0 ? fill('upgradesFound', { n }) : t('noUpgrades')
              const when = scanMeta.scannedAt === null ? ''
                : ` · ${fill('scannedAt', { at: formatTime(scanMeta.scannedAt) })}`
              return `${head}${when}`
            })())
          : h('div', { style: styles.hint, 'data-updates-summary': true },
            scanMeta.scanning === true
              ? t('scanInBackground')
              : fill('neverScanned', { interval: formatInterval(scanMeta.intervalMs) })),
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
          ? h('div', { style: { ...styles.hint, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }, 'data-lifecycle': true },
            h('span', null,
              lifecycle.initialized
                ? `${t('lifeInit')} ${lifecycle.createdAt} · ${t('lifeProfiles')}: ${(lifecycle.profiles ?? []).length} · ${t('lifeChanges')}: ${lifecycle.changes}`
                : t('lifeUninitialized')))
          : null,
        lifecycle?.firstRun === true
          ? h('div', { style: styles.notice, 'data-lifecycle-guide': true },
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
            ? h('div', { style: { ...styles.notice, ...styles.warn } }, notice.message)
            : null),
        loading && data === null
          ? h('div', { style: styles.hint }, t('loading'))
          : h('div', { style: styles.list, role: 'list' },
            data !== null && data.exists === false
              ? h('div', { style: styles.notice }, t('missingTree'))
              : visible.length === 0
                ? h('div', { style: styles.hint }, t('empty'))
                : visible.map((item) => {
                  const enabledNow = item.enabled === true
                  const stateText = stateKnown ? (enabledNow ? t('enabledTag') : t('disabledTag')) : t('unknownTag')
                  const components = Array.isArray(item.components) ? item.components : []
                  const upgradable = upgradeInfo(item)
                  const jobRunning = job !== null && job.state === 'running'
                  return h('div', { key: item.name, style: styles.group },
                    h('div', { style: styles.row, role: 'listitem' },
                      h('div', {
                        style: { ...styles.rowMain, cursor: 'pointer' },
                        onClick: () => onRowClick(item),
                        title: rowHint(item),
                      },
                        h('div', null,
                          h('span', { style: styles.name }, item.name),
                          h('span', { style: styles.version },
                            item.version === null || item.version === undefined ? '' : `v${item.version}`),
                          upgradable !== null
                            ? h('span', { style: { ...styles.version, ...styles.warn } }, `→ v${upgradable.version}`)
                            : null),
                        h('div', { style: styles.badges },
                          ...kindBadges(item),
                          h('span', { style: enabledNow && stateKnown ? styles.badgeOn : styles.badge }, stateText),
                          components.length > 0
                            ? h('span', { style: styles.badge }, `${components.length} 组件`)
                            : null),
                        item.description
                          ? h('div', {
                            className: `${CLS}-desc`, style: styles.hint, title: item.description,
                          }, item.description)
                          : null),
                      // 行内「升级」按钮：只在检查出有新版本时出现；点击先弹确认（影响面 + 依赖检查）。
                      upgradable !== null
                        ? h('div', { style: { flex: '0 0 auto' } },
                          h('button', {
                            type: 'button', className: `${CLS}-btn`, style: styles.primaryButton,
                            disabled: checking || jobRunning,
                            onClick: (event) => { event.stopPropagation(); void openConfirm(item.name, upgradable.version) },
                            title: fill('upgradeTo', { version: upgradable.version }),
                            'aria-label': `${t('upgrade')} ${item.name}`,
                          }, t('upgrade')))
                        : null),
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
                        }, fill('componentHint', { owner: item.name }))))))
                  }),
            // 只读分区放在同一滚动区末尾，滚到底就能看到；不参与计数、无按钮。
            linkedSection()),
        // 升级任务进度卡 + 确认弹窗（与 38555d5 删除前同源）。
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
        hostCtx = ctx
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
