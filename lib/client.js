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
      }, [])

      useEffect(() => { void load() }, [load])

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
                      h('div', { style: styles.rowMain },
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
                      item.hasBundle === true && item.standaloneConflict === undefined
                        ? h('button', {
                          type: 'button', className: `${CLS}-btn`,
                          style: enabledNow ? styles.button : styles.primaryButton,
                          disabled: anyBusy || !stateKnown,
                          onClick: () => void toggle(item.name, !enabledNow),
                          title: `${enabledNow ? t('disable') : t('enable')} ${item.name}`,
                          'aria-label': `${enabledNow ? t('disable') : t('enable')} ${item.name}`,
                        }, busy === item.name ? t('working') : (enabledNow ? t('disable') : t('enable')))
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
                        }, fill('componentHint', { owner: item.name }))),
                      null)))
                }),
            // 只读分区放在同一滚动区末尾，滚到底就能看到；不参与计数、无按钮。
            linkedSection()),
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
