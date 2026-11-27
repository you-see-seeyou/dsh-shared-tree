# 共享插件树（dsh-shared-tree）

管理 `<DSH_HOME>/profiles/node_modules` 这份**跨 profile 共享的插件树**：往树里装包、搜索树里有什么、决定当前 profile 启用树里的哪些 bundle。

## 为什么是这份目录

`profiles/<name>/node_modules` 的**上一级**就是 `profiles/node_modules`。Node 解析模块时会沿目录祖先链逐级查找，所以放在 `profiles/node_modules` 的包，对所有 profile 都是"按名可见"的——不必每个 profile 各装一份。

实测的解析链（从 `profiles/desktop/package.json` 出发）：

```
<DSH_HOME>\profiles\desktop\node_modules   ← profile 自己的
<DSH_HOME>\profiles\node_modules           ← 共享树（本文档管的这个）
<DSH_HOME>\node_modules
<DSH_HOME 所在盘>\node_modules
...
```

它不是插件、不是一个包：这份目录里**没有** `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`，只有一个 `.dsh-shared-tree.json` 清单（本插件的记账文件，DSH 不读它）。树里每一项都是各自独立的 npm 包。

## 三个动作

### 1. 装包进树

```
shared_tree action=install packages=["dsh-taskboard@0.10.0","dsh-mnemon@0.5.53"]
```

做的事：在 `<DSH_HOME>/cache/shared-tree-build` 用 `nodeLinker: hoisted` 构建 → 算**依赖闭包** → 只把顶层包目录复制进树 → 记 sha256 到清单。

关键约束（都是实测踩出来的）：

- **绝不碰 `@deepseek-ai`**：那是 dsh 安装目录的 10 个 junction。在 `profiles/` 层跑 pnpm 会把它们剪掉。装包时 `@deepseek-ai/*` 依赖被识别为"由 junction 提供"，不复制。
- **组合包必须整族进**：`dsh-mnemon` 主包 `require` 18 个子包和 `zod`/`yaml`/`fflate`。零本地副本的 profile 沿祖先链解析不到它们就 `MODULE_NOT_FOUND`。所以 install 算的是闭包，不是单个包。
- **包名要过白名单**：只接受 `name` 或 `name@version`，防止 shell 元字符进 pnpm 参数。

### 2. 搜索

```
shared_tree action=search query=mnemon
shared_tree action=search kind=bundle          # 只列可作 bundle 加载的
shared_tree action=search onlyEnabled=true     # 只看本 profile 已启用的
```

每个结果标注类型：`bundle`（能作 profile bundle 加载）、`client`（只有浏览器侧）、`library`（纯依赖库，如 zod）。同时显示**当前 profile 里是否已启用**。

### 3. 决定本 profile 启用哪些

```
shared_tree action=enable  target=dsh-taskboard
shared_tree action=disable target=dsh-taskboard
```

底层调 `pluginManager.setBundleEnabled()`——和 Plugins 页面、`dsh plugin` 是同一条路径，写的是**当前 profile** 的 `package.json` 的 `dsh.profile.bundles`。

- 共享的是**包文件**，不是启用状态。A profile 启用 `dsh-taskboard` 不影响 B profile。
- 启用会真的挂载插件。`dsh-mnemon` 这类有存储的包，工具会给出隔离提示（默认 `storageScope: global` 会落到 `~/.mnemon` 与全机其他 profile 共用记忆库）。
- 结果会说明 `applied` / `restart-required` / `overridden`，并按需给出下一步。

## App 界面（侧边栏图标 / 主列面板 / 右栏 tab）

这三处入口都渲染**同一个只读目录面板**（插件列表 + 搜索 + 过滤 + 刷新）：

| 入口 | 槽位 | 说明 |
|---|---|---|
| 左侧边栏图标 | `sidebar.panellist`（list） | `id` 必须与 `main` 的 `key` 相同，否则点图标打不开面板 |
| 主列面板 | `main`（keyed） | 点侧边栏图标后在主列展开完整列表 |
| 右栏 tab | `sidebarRightTabs.register()` + `sidebar.right.pane.tab`（keyed） | 原生右侧栏，与 `dsh-super-kanban` / `dsh-better-sidebar` 同一套 API |

### 列表只显示"具备插件语义"的包

共享树的 194 个顶层包里只有 20 个是插件，其余 174 个是 pnpm 按 `nodeLinker: hoisted` 提升进来的
纯依赖库（d3 / mermaid / codemirror / @lezer/* …）。它们没有 `dsh.*` 清单、没有 enable 语义，
所以在**数据源**（`buildStatusData`）就被过滤掉：不进列表、不计入分组计数，只报一个被过滤的条数。

判据是 `manifest.dsh` 是非空对象（`hasPluginManifest`），**不是包名白名单** ——
以后 pnpm 再提升进来任何依赖库都会自动被过滤，不需要维护名单。测试里专门加了一个反例：
往假树里新塞 `d3` / `mermaid`，断言它们自动消失、且"被过滤条数"+2。

工具侧的 `shared_tree action=status` 仍报告全貌，并显式给出拆分：
`顶层包：194 个（插件 20：bundle 16 / 仅 client 4；纯依赖库 174）`。
`action=search` 也不过滤（它是诊断工具，带显式的 `kind` 过滤）。

### mnemon 组件收进归属包

`dsh-mnemon` 的补丁已经插入了 `mnemon-strategy-*` / `mnemon-source-*` 这些 entry id；
那 4 个 strategy 子包各自也带补丁、插入**同一个 id**（`dsh-mnemon-source-*` 只有 `dsh.client`，
不带 `dsh.bundle`，所以不会撞 id）。

因此 `buildStatusData` 把"entry id 已由另一个已启用 bundle 提供"的包从顶层摘掉，
收进归属包的 `components` 数组里，界面上渲染成缩进子行：

- 子行**没有独立开关**（不会重复插入 id → 不会触发 issue #470）。
- 子行的开关由**归属包的状态 + profile patch 行**决定（例如 `- id: mnemon-strategy-auto-capture disabled: false`），
  子行上直接写明这一点。
- 关键字搜索命中子项时，归属行会显示出来（否则搜 "scoped" 会找不到）。
- 组件不参与类别/状态过滤（它们没有独立的 enabled 状态）。

实测真实共享树：**194 → 过滤 174 个依赖库 → 20 个插件 → 4 个组件归组 → 列表 16 行**。

### 只读分区：本 profile 的 `link:` 插件

面板底部还有一个**只读**分区，列出本 profile 里以 `link:` 本地路径安装的插件
（桌面实测 7 条：`dsh-agent-model-hub` / `dsh-llm-empty-text-guard` / `dsh-llm-failover-probe` /
`dsh-qwen-token-plan-cn-responses` / `dsh-rotation-signal` / `dsh-shared-tree` / `dsh-steer-busy`）。

- 数据来自 Host 的 `linked` 字段，源头是 `pluginManager.listBundles()` 里 `source` 以 `link:` 开头的条目；
  与共享树列表重名的条目会被剔除。
- **不并入 `packages`**，也**不进 `total / plugins / components / libraries` 任何计数** ——
  只多一个 `counts.linked` 供分区标题使用。实测加入该分区后四个计数完全不变（16 / 20 / 4 / 174）。
- 分区内**不渲染任何按钮**：这些包物理上不在共享树里（profile 本地 symlink 会遮蔽树内副本），
  启停要用 Plugins 页。因此结构上不存在"把自己关掉"的路径。
- 每条显示 `linked` 徽标、启用状态、以及 `link:` 原目标路径。

### 数据通道

界面不自己扫盘、不自己改 profile，全部走 Host 的 HTTP 路由：

| 路由 | 作用 |
|---|---|
| `GET /dsh-shared-tree/status` | 插件列表（含 `hasBundle` / `hasClient` / `kind` / `version` / `enabled` / `components`）+ `linked` 只读分区 + 计数 + junction 健康 + 清单摘要 |
| `GET /dsh-shared-tree/lifecycle` | 生命周期状态（只读展示：是否初始化、基线 profile 数、台账变更数） |
| `GET /dsh-shared-tree/deps` | registry 最新版本 + 依赖检查（可升级判据与确认弹窗的数据源） |
| `GET /dsh-shared-tree/impact` | 升级影响面（哪些 profile 引用该包） |
| `GET /dsh-shared-tree/install/progress` | 升级任务进度（四阶段） |
| `POST /dsh-shared-tree/panel` | `{ target, exposed, profile? }` → 登记/撤销 `link:` 依赖，让包重新出现在官方 Plugins 面板（不加载） |
| `POST /dsh-shared-tree/install` | `{ packages, replace }` → 覆盖式升级（任务化，同一时刻只允许一个） |
| `POST /dsh-shared-tree/check-profiles` | 升级完成后逐 profile 验证版本一致性 |

一致性是**结构保证**的，不靠约定：

- `/status` 与工具的 `status` 用同一组函数（`scanTree` / `withProfileState` / `junctionFacts` / `readTreeManifest` / `standaloneConflictOf`）。
- `/panel` 与工具的 `panel` 共用 `setPanelVisibility` / `panelReport`；默认登记（启动补扫/启用后）
  共用 `autoPanelSync` / `autoPinOne`，底层仍是同一个 `setPanelVisibility`。

界面内的搜索与过滤是**纯浏览器侧**数组过滤，不发任何写请求。
客户端写请求只有三个：`/panel`（点独立 bundle 行跳转前登记面板可见性）、
`/install`（行内「升级」按钮触发的覆盖式升级）、`/check-profiles`（升级后逐 profile 验证）；
**启用/停用、装包、功能行开关都不在界面里做**（归官方 Plugins 页与 `shared_tree` 工具 / 其余 HTTP 路由）。

### 点行行为与已删除的界面能力（2026-11-27 精简）

| 行类型 | 点击行为 |
|---|---|
| 独立 bundle | `ensurePanelVisible()`（必要时 `POST /panel` 登记）→ `pluginNavigation.openBundle(name)` 跳官方配置页；失败给 notice |
| 组件（entry id 归属树内另一个 bundle） | 不跳转，提示去归属插件的设置页切换 |
| 仅 client 包 | 不跳转，提示没有 bundle 配置页、去官方 Plugins 页管理 |

已删除：行内「启用/关闭」「详情」「功能」按钮、行内功能行展开、自建详情页
（描述/功能开关/依赖检查/版本回滚/逐 profile 灰度/功能项覆盖/调试）、详情页「配置页」与
「加入插件面板」按钮、「校验」按钮、生命周期「恢复到基线」按钮。
**服务端路由与工具 action 全部保留**（`/set`、`/rows`、`/set-row`、`/detail`、
`/rollback`、`/verify`、`/lifecycle-baseline-restore` 等仍可经工具或 HTTP 使用），只是客户端不再调用。

### 升级能力（2026-11-27 恢复，长期保留）

以 `38555d5` 删除前的实现为基准恢复，不另起机制：

| 环节 | 实现 | 与删除前的关系 |
|---|---|---|
| 可升级判据 | `GET /deps?pkg=<名>&ver=latest`：`available===true` 且 `version !== 树内版本` | 同源（原 DetailPanel 的 upToDate 判据） |
| 检查入口 | 顶部「检查更新」按钮 + 挂载后自动检查一次；4 路并发 + 增量上屏 + `done/total` 进度；汇总「N 个插件有新版本」 | 新增（原为逐包进详情页查看） |
| 升级入口 | 行内「升级」按钮（仅检查出有新版本时出现）+ 版本旁 `→ v新版本` | 同源（原行内按钮） |
| 确认弹窗 | `ConfirmModal`：精确版本锁定 + 影响面（`/impact`）+ 依赖检查（`ok===false` 置灰） | 同源，依赖检查从原 depsSection 移入 |
| 执行通道 | `POST /install`（`replace:true`）→ `JobCard` 四阶段进度（800ms 轮询 `/install/progress`） | 同源 |
| 完成反馈 | `POST /check-profiles` 逐 profile 验证 + `load()` 刷新列表 + 清空可升级缓存；**成功后 6 秒自动收起进度卡**（结论落到通知区；失败不自动收起） | 同源 + 自动收起（新增） |

升级不影响默认登记与跳转链路：`link:` 依赖指向树内目录，升级换的是目录内容，登记无需重做；
行点击仍 `ensurePanelVisible()` → `openBundle()`，组件/client-only 仍只给 notice。

#### 2026-11-27 修复的两个阻断缺陷（"界面上看不到升级按钮"的真因）

1. **`pnpmView` 的 JSON 切片错**：旧实现用 `lastIndexOf('{')` 取 JSON 主体，而
   `pnpm view <pkg> --json` 的对象体里嵌套 `versions`（对象）、`time`（对象）、`dist` 等，
   最后一个 `{` 落在对象**内部**，切出的片段不是合法 JSON → 每个包都 `PARSE_FAIL` →
   `/deps` 全部返回 `available:false`「无法从 registry 读取最新版本」→ `upgradeInfo` 恒为 null
   → 界面上**一个升级按钮都没有**。改为 `sliceJsonBody()`：从第一个 `{`/`[` 起按括号平衡
   （跳过字符串与转义）切到真实闭合位置。
2. **依赖检查误判**：
   - `satisfiesRange` 不支持 `||`，`engines.node: "^22.19 || >=24"` 在本机 24.21.0 上被判不满足；
   - 宿主自带 peer（`react` / `react-dom` / `@deepseek-ai/*`）打进 `app.asar`，磁盘查不到，
     旧实现一律 `ok=false`，使几乎所有插件 `deps.ok=false`，确认弹窗「开始升级」被置灰。
   修正：支持 `||` 并联；新增 `isHostProvidedPeer()`，这类 peer 标 `hostProvided:true / ok:null` 不拦；
   只有明确 `ok === false`（如缺第三方 `@huanlin/dsh-plugin-better-locale`）才拦。

### 默认登记进官方面板（2026-11-27）

共享树里**已启用**的独立 bundle 默认自动登记为当前 profile 的 `link:` 依赖，无需手动操作：

| 触发点 | 函数 | 范围 |
|---|---|---|
| 启动补扫（存量） | `apply` 内异步调 `autoPanelSync` | 当前 profile 已启用、`dependencies` 里还没有 link: 入口的独立 bundle |
| 启用/停用成功后（增量） | `/set` 与工具 enable/disable 调 `autoPinOne` | 刚操作的那个包（启用/停用对称） |
| 点行跳转（兜底） | 客户端 `ensurePanelVisible` → `POST /panel` | 被点击的包 |

约束（全部复用 `setPanelVisibility`）：只写 `dependencies`、绝不写 `dsh.profile.bundles`；
幂等；不覆盖/不删除用户已有依赖；组件与 client-only 跳过；只改当前 profile；
改前备份 + 面板台账 `.dsh-shared-tree-panel.json` + 生命周期台账。

**撤销尊重**：`expose=false` 撤销过的包记进面板台账 `revoked`，`autoPanelSync` / `autoPinOne`
都跳过它；显式 `expose=true` 重新登记时清除标记。

**宿主清单在启动时读取**：新登记的包需重启 DSH（或该 profile）后才能在官方面板看到。

### 容错

- 三处注册各写在自己的 `try/catch` 里：任何一处失败只少一个入口，不影响其他入口，也不影响工具。
- `webServer` 用 `ctx.inject(['webServer'], ...)` 可选注入；宿主没有它时工具照常工作，界面显示"数据通道不可用"。
- **`locale` 必须写进客户端 `inject`**：cordis 的客户端上下文在**未 inject** 的服务上取值会抛
  `cannot get property "x" without inject`，**不是返回 undefined**。因此
  `if (ctx.locale !== undefined)` 这种"可选访问"写法本身就会抛错。
  （这条是实测抓到的：首次装入后 renderer 日志出现
  `[dsh-shared-tree] 文案注册失败 … cannot get property "locale" without inject` 与
  `[dsh-shared-tree] 右栏 tab 注册失败 … cannot get property "sidebarRightTabs" without inject`。）
- `sidebarRightTabs` 用 `ctx.inject(['sidebarRightTabs'], (sideCtx) => …)` 可选接入，
  **不放进 `inject`**：放进去会让整个客户端插件在缺少该服务的 profile 里都不激活，
  连带丢掉侧边栏图标与主列面板。缺了就只少右栏 tab。
- 浏览器侧只 `require('react')`；`@deepseek-ai/dsh-client-*` 一个都不 require ——
  那些包会在版本间变化，且抛错的组件会让槽位**直接空白**。

### 怎么确认界面真的被组合进页面

客户端半边是**按需构建**的，URL 带内容版本号（`plugins/??<pkg>/client.js&rev=<hash>`），
所以猜 URL 会得到 404。可靠的验证路径：

```
GET /?token=<launchToken>        # 303 + Set-Cookie（token 换 cookie，必须手动处理重定向）
GET /  (带 cookie)               # 首页 HTML 里 window.__DSH_BOOT__ 就是组合后的模块图
GET /<boot 图里那条 url>          # 服务端真正发出去的客户端 bundle
```

`__DSH_BOOT__` 里出现 `{"id":"dsh-shared-tree","url":"plugins/??dsh-shared-tree/client.js&rev=…"}`
即证明客户端半边已被组合进页面。注意 `fetch` 不会跨重定向保留 cookie，
必须手动取 `set-cookie` 再发第二次请求。

## 只读体检

```
shared_tree action=status    # 树概况：包数、bundle 数、junction 健康、本 profile 已启用
shared_tree action=verify    # 逐包复核 sha256，报告版本漂移/内容变化/清单缺失
```

`status` 会明确报告 `@deepseek-ai junction: 10/10（完好）`——这是共享树最容易被 pnpm 破坏的地方，每次包操作后都该复查。

## 已知限制

1. **pnpm 会往这里提升依赖**。profile 用 `nodeLinker: hoisted`，安装时 pnpm 可能把依赖提升到祖先 `profiles/node_modules`，树就"自己长大"了。这些是被 hoist 进来的普通依赖，不是本插件装的东西；`verify` 会标为"未登记"。这是 hoisted 布局的固有行为，不是缺陷。
2. **没有 lockfile 守护**。这份目录没有 `package.json`/`pnpm-lock.yaml`，pnpm 不会替你校验完整性。改动只能靠 `.dsh-shared-tree.json` 的 sha256 复核。
3. **升级即全局生效**。树里的包被所有 profile 共用，升级会同时影响全部引用者，改前先备份并逐 profile 实跑。
4. **`@deepseek-ai/*` 只读**。本插件拒绝向该 scope 写入。
5. **界面写操作受限**。客户端写请求只有 `/panel`（面板登记）、`/install`（升级）、
   `/check-profiles`（升级后验证）；`enable` / `disable` / `verify` / 回滚只走
   `shared_tree` 工具、CLI 或官方 Plugins 页。
6. **启用态以 Host 为准，界面不缓存**。界面每次刷新都重拉 `/status`；`restart-required` 的包
   在 `listBundles()` 里仍是旧状态，需要重启后才会在界面与官方面板里更新。
7. **界面渲染未做浏览器实测**。契约层（槽位注册、inject 行为、locale、只读、配色）已用测试钉住，
   真实观感（深浅色、约 300px 窄栏下的密度与换行）需要在 App 里肉眼看。
8. **4 个 `dsh-mnemon-source-*` 仍是独立行**。它们只有 `dsh.client`、不带 `dsh.bundle`，
   所以既撞不上 entry id、也无法独立启用（点击只给提示，不跳转）。当前列表因此是
   **16 行 = 20 个插件 − 4 个归组组件**。如果希望把它们也收进 dsh-mnemon（列表变 12 行），
   改 `standaloneConflictOf` 的触发条件让它也覆盖 client-only 的 mnemon 组件即可。
9. **工具侧不过滤**。`shared_tree action=search` 仍能看到全部 194 个包（它带显式 `kind` 过滤，
   是诊断工具）；只有侧边栏列表按插件语义过滤。`action=status` 会显式给出插件/依赖库拆分。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `- id: shared-tree` 的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `treeRoot` | `<DSH_HOME>/profiles/node_modules` | 共享树根 |
| `buildDir` | `<DSH_HOME>/cache/shared-tree-build` | 临时构建目录 |
| `registry` | 沿用 pnpm 配置 | install 时首选的 npm registry |
| `timeoutMs` | `300000` | 单次 pnpm 超时 |

## 设计约束

- **零 `@deepseek-ai` 依赖**。插件从 profile 解析 `@deepseek-ai/*` 会遮蔽 CLI 内置 build，让整个 base 层的工具调度失效（`Cannot read properties of undefined (reading 'prepare')`）。所以 `dshHomePath`、`defineTool` 都是本地等价实现。
- **`pluginManager` 是懒取**。服务缺失时降级为可操作提示，而不是抛错崩溃。
- **所有 fs 操作都 fail-open**：读不到 package.json 的目录跳过，不中断扫描。