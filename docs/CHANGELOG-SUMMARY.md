# 变更总结：共享插件树管理（dsh-shared-tree）

> 本文件由发布前整理，描述从最初的「共享树管理」快照到当前 HEAD 的全部改动。
> 内容严格依据仓库实际 diff 与提交记录，不含任何个人或机器信息。

## 1. 动机

`dsh-shared-tree` 管理 `<DSH_HOME>/profiles/node_modules` 这份**跨 profile 共享的插件树**。
最初版本只提供 `status` / `search` / `enable` / `disable` / `install` / `verify` 六个工具动作
与一个只读侧边栏面板。实际使用中暴露出三类问题，构成本轮改动的动机：

1. **官方 Plugins 面板看不到共享树里的包**。宿主 `pluginManager.readBundles()` 的候选集合只来自
   profile 清单（`dsh.profile.bundles` ∪ `dependencies` ∪ 安装目录 ∪ 官方目录），从不 readdir
   共享树目录。因此共享树里的包一旦没有进入当前 profile 的清单，面板就再也列不出它。
2. **升级入口缺失且判据不可靠**。界面曾提供行内「升级」，但在一次客户端精简中被删除；
   恢复后又发现底层 registry 解析与依赖检查存在缺陷，导致升级按钮大面积不出现或被错误置灰。
3. **每次刷新都扫描 registry 太慢**。版本检测每包两次 `pnpm view`，实测 3–7 秒/包，
   全量 35–40 秒，却被放在界面刷新路径上。

同时，界面需要一次明确的**减法**：把一个功能庞杂的自建详情页收敛为「只读目录 + 跳转官方配置页」，
再以长期保留的形式把升级能力加回来。

## 2. 服务端（`lib/index.js`、`lib/lifecycle.js`）

### 2.1 生命周期台账与还原（`lib/lifecycle.js` 新增 442 行）

- 启用时对每个 profile 做基线快照（`package.json` / `cordis.patch.yml`），台账落在共享树根下的
  `.dsh-shared-tree-lifecycle.json`。
- 停用插件时按台账**只还原本插件写过的变更**：先比对当前内容是否仍是插件写入的 `after` 快照，
  一致才还原为 `before`；用户后来手工改过的条目跳过并报告，绝不整包回滚 profile。
- 还原前留 `*.bak-shared-tree-restore` 双向备份；成功的条目从台账摘除，重复 dispose 不重复处理。
- 台账损坏时**拒绝重建**（避免用可能已被改过的文件覆盖最初基线）与拒绝记录变更。
- 提供独立还原脚本 `scripts/lifecycle-restore.mjs`，用于插件被物理删除后仍能还原。
- 另有「基线还原」（`restoreBaseline`）与「清空共享树」（`destroyTree`）两个高危动作，
  均需显式确认，且保留 `@deepseek-ai` junction、台账与基线。

### 2.2 官方 Plugins 面板可见性（panel）

- ``declaredNamesOf()`` 复刻宿主 `readBundles()` 的候选集合判据。
- ``panelReport()`` 输出 `visible` / `hidden` / `components`；组件按 **entry id 是否被树内另一个
  bundle 声明**判定，与「是否已启用」无关，因此未启用的组件也能识别。
- ``setPanelVisibility()`` 把包登记为当前 profile 的
  `dependencies[name] = "link:<树内绝对路径>"`：
  - **只写 `dependencies`，绝不写 `dsh.profile.bundles`** —— 包不会被加载；
  - 面板因此能看到它（`installed: true` / `enabled: false`），可打开配置页、可在面板里自行启用；
  - 只改指定的那一个 profile；组件、client-only 包、受保护 scope 一律跳过；
  - 用户自己写的同名依赖不覆盖、不删除（撤销只回退本插件写的那一条）；
  - 改前备份 `package.json.bak-shared-tree`，写入面板台账 `.dsh-shared-tree-panel.json`，
    并记入生命周期台账。
- **默认登记**（`autoPanelSync` / `autoPinOne`）：已启用的独立 bundle 自动登记，无需手动操作。
  触发点三处：启动补扫（存量）、启用/停用成功后（增量，对称）、点行跳转前（兜底）。
- **撤销尊重**：`expose=false` 撤销过的包记入面板台账 `revoked`，上述三处自动登记都不再碰它，
  直到显式 `expose=true` 重新登记。

### 2.3 版本更新检测：定时扫描 + 磁盘缓存

- ``scanUpdates()``：唯一的 registry 打点。并发 3，逐包写
  `{current, latest, available, upgradable, downgrade, checks, ok, error}`，
  结果落盘 `.dsh-shared-tree-updates.json`（含 `scannedAt` / `durationMs`）。
- Host 用 `ctx.effect` 注册定时器：启动 5 秒后首扫，之后每 **6 小时**（`scanIntervalMs` 可配，
  下限 60 秒）；`unref()` 不拖住进程退出；dispose 时清定时器。
- `GET /updates` 读缓存，`POST /updates` 立即扫一次（同一时刻只允许一个，重复请求 409）。

### 2.4 顺带修复的缺陷

1. **`pnpm view` 输出解析错位**（阻断级）。
   旧实现用 `lastIndexOf('{')` 取 JSON 主体，而 `pnpm view <pkg> --json` 的对象体里嵌套
   `versions`（对象）、`time`（对象）、`dist` 等，最后一个 `{` 落在对象**内部**，切出的片段
   不是合法 JSON，导致**每个包**都解析失败、`/deps` 全部返回「registry 不可达」、界面上一个
   升级按钮都没有。新增 ``sliceJsonBody()``：从第一个 `{`/`[` 起按括号平衡（正确跳过字符串与
   转义）切到真实闭合位置。
2. **依赖检查误判**（把升级按钮大面积置灰）。
   - `satisfiesRange()` 不支持 `||` 并联，`engines.node: "^22.19 || >=24"` 在 node 24 上被判不满足；
   - 宿主自带 peer（`react` / `react-dom` / `@deepseek-ai/*`）打进 `app.asar`，磁盘上本就不存在，
     旧实现一律 `ok=false`。
   修正：支持 `||` 并联；新增 `isHostProvidedPeer()`，这类 peer 标 `hostProvided: true / ok: null`
   不拦；只有明确 `ok === false`（如缺真第三方 peer）才拦。
3. **降级方向被当成升级**。
   实测遇到一个从 git commit 安装的插件：树内版本高于 registry 上的最高版本
   （registry 只有更旧的一个版本，没有更新版本可升）。旧判据用「不相等」，会把它当成
   「可升级 高版本 → 低版本」，实际是降级。新增 `compareVersions()`，只认
   `latest > current`；版本不可解析时也不提供按钮。实测可升级列表由 5 个修正为正确的 4 个。

### 2.5 新增/变更路由

| 路由 | 作用 |
|---|---|
| `GET /dsh-shared-tree/status` | 插件列表 + `linked` 只读分区 + 计数 + junction 健康 + 清单摘要 |
| `GET /dsh-shared-tree/lifecycle` | 生命周期状态 |
| `GET /dsh-shared-tree/verify` | 逐包 sha256 复核 |
| `GET /dsh-shared-tree/impact` | 升级影响面 |
| `GET /dsh-shared-tree/deps` | 单包 registry 版本 + 依赖检查 |
| `GET /dsh-shared-tree/updates` | 定时扫描缓存（含 `upgradable` / `scanning` / `nextScanAt` / `intervalMs`） |
| `POST /dsh-shared-tree/updates` | 立即扫描一次 |
| `POST /dsh-shared-tree/panel` | 登记/撤销面板可见性 |
| `POST /dsh-shared-tree/install` | 覆盖式升级（任务化，单并发） |
| `POST /dsh-shared-tree/install/progress` | 进度（四阶段） |
| `POST /dsh-shared-tree/check-profiles` | 升级后逐 profile 验证 |
| `POST /dsh-shared-tree/set` / `set-row` / `set-entry` / `set-profile` | 启停与覆盖层写入 |
| `POST /dsh-shared-tree/rollback` | 回滚到历史版本 |

## 3. 客户端（`lib/client.js`）

### 3.1 精简：删除自建详情页与全部功能按钮

先做减法，把面板收敛为**只读目录 + 跳转入口**（`lib/client.js` 从 2089 行降到约 640 行）：

- 删除 `DetailPanel` 整体（描述文档 / 功能开关 / 依赖检查 / 版本回滚 / 逐 profile 灰度 /
  功能项覆盖 / 调试 七区块）；
- 删除行内「启用/关闭」「详情」「功能」「升级」按钮、行内功能行展开、「校验」按钮、
  生命周期「恢复到基线」按钮（状态条保留为只读）；
- 删除 `SmallSwitch`、`renderMarkdown`、`toneOf` 及相关 state 与样式；
- 字典从 140 key 收敛到 44 key（中英对齐）。

**点行行为**：独立 bundle 先 `ensurePanelVisible()`（面板列不出就先登记 `link:` 依赖），
再 `pluginNavigation.openBundle()` 跳官方配置页；组件与 client-only 包不跳转，只给提示。

### 3.2 恢复升级能力（长期保留）

以删除前的实现为基准恢复，不另起机制：

- **立即检查**：`POST /updates` 触发一次服务端扫描；日常刷新只 `loadUpdates()` 读 `GET /updates`
  缓存 —— **刷新不再触发任何 registry 请求**。
- **可升级判据**：`compareVersionStrings()`（与服务端同源），只认 `latest > current`。
- **行内「升级」按钮**：仅在可升级时出现，版本号旁显示 `→ v新版`。
- **确认弹窗 `ConfirmModal`**：精确版本锁定 + 影响面 + 依赖检查（`ok===false` 置灰）。
- **进度卡 `JobCard`**：四阶段（prepare/build/merge/verify），800ms 轮询 `/install/progress`；
  完成后 `POST /check-profiles` 逐 profile 验证 + 刷新列表 + 重读缓存。
- **成功后 6 秒自动收起**进度卡（结论落到通知区，卡上有「几秒后自动收起」提示）；
  **失败不自动收起** —— 错误必须留在界面上，只能手动关闭。收起前校验仍是 `done` 态，
  避免误关新一轮任务。

### 3.3 界面位置

三处入口渲染同一个面板：左侧边栏图标（`main` 面板）、`sidebarRightTabs` 右栏 tab、
以及侧边栏图标行。三处注册各自 try/catch，任何一处失败只少一个入口。

## 4. 实测数据

| 项目 | 实测值 |
|---|---|
| 全量版本扫描（20 个包，每包两次 `pnpm view`） | **35–39 秒** |
| 界面刷新读缓存 `GET /updates` | **1–2 毫秒** |
| 修复前 `/deps` 成功率 | 0 / 20（全部「registry 不可达」） |
| 修复后依赖检查 `ok=false` 的包 | 由 12 个降到 1 个（该包缺真第三方 peer） |
| 修复后可升级包数 | 5 → **4**（排除降级方向的 1 个） |
| 修复后成功升级样例 | 一个插件 1.7.0 → 1.7.1，逐 profile 验证「版本与树一致 / 已启用」 |

## 5. 测试结论

用 `npm test` 串联三套自验，**全部通过**：

| 套件 | 项数 | 覆盖重点 |
|---|---|---|
| `test/shared-tree.test.mjs` | **88** | 工具 8 个 action、HTTP 通道、`application` 语义、只读保证、面板登记/撤销/组件拒登记/生命周期联动、默认登记（幂等、不覆盖用户依赖、启动补扫、撤销尊重）、`pnpm` 输出解析、依赖检查（`\|\|` 并联、宿主 peer）、版本更新缓存（落盘/回放/损坏降级/并发 409/严格版本比较） |
| `test/client.test.mjs` | **30** | 模块 id、槽位注册、locale 双语言对齐、inject 行为回归、竞态保护、类别过滤与工具同源、可访问性、无硬编码配色、精简契约（防复活）、写请求白名单、升级能力契约、成功后自动收起 |
| `test/lifecycle.test.mjs` | **13** | 基线快照幂等、变更记账、按台账还原、损坏台账拒绝、基线还原、清空共享树 |

合计 **131 项全绿**。另有三套脚本（`live-smoke`、`real-route-dryrun`、`real-linked-dryrun`）
为手工冒烟用，不参与 `npm test`。

## 6. 新增/变更的配置项

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `treeRoot` | `<DSH_HOME>/profiles/node_modules` | 共享树根 |
| `buildDir` | `<DSH_HOME>/cache/shared-tree-build` | `pnpm` 构建目录 |
| `registry` | 未设置（用 pnpm 自身配置） | 首选 registry |
| `timeoutMs` | `300000` | 安装/构建超时 |
| `scanIntervalMs` | `21600000`（6 小时） | **新增**：版本扫描间隔，下限 60000 |
| `scanOnStart` | `true` | **新增**：启动后是否先扫一次（延时 5 秒） |

## 7. 兼容性影响

- **需要重启 DSH**：服务端（`lib/index.js`、`lib/lifecycle.js`）改动与客户端 bundle 均需重启生效。
- **首次启用会创建基线快照**并写台账；停用插件会按台账还原它做过的配置变更，
  用户手工改动不受影响（内容不一致的条目跳过并报告）。
- **默认登记会修改 profile 的 `dependencies`**（写入 `link:` 条目），但**不改变**
  `dsh.profile.bundles`，因此不改变任何 profile 的加载行为。
- **新增本地产物文件**（均在 `.gitignore` 中）：`.dsh-shared-tree-{lifecycle,panel,updates}.json`
  与两个 report 文件；不进版本控制。
- 删除的行内「启用/关闭」「详情」「功能」「校验」按钮所对应的**服务端路由与工具动作全部保留**，
  仍可经 `shared_tree` 工具或 HTTP 直接使用，功能无损失。