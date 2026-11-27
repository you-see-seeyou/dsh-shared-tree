# dsh-shared-tree

管理 `<DSH_HOME>/profiles/node_modules` 这份**跨 profile 共享的插件树**，提供 `shared_tree` 工具与 App 内的侧边栏界面。

| action | 作用 |
|---|---|
| `status` | 树概况：包数、bundle 数、`@deepseek-ai` junction 健康、本 profile 已启用哪些 |
| `search` | 按关键字/类型/启用状态搜索树里的包 |
| `enable` / `disable` | 决定**当前 profile** 启用树里的哪些 bundle |
| `install` | 把 npm 包装进树（hoisted 构建 + 依赖闭包 + 只合并顶层目录） |
| `verify` | 逐包复核 sha256，报告版本漂移 / 内容变化 / 未登记 |

## App 界面

浏览器侧提供三处入口，都指向同一个面板（插件列表 + 搜索 + 过滤 + 逐个开关）：

1. **左侧边栏图标** → 点开后在**主列**展开完整列表（`main` 面板）。
2. **右侧边栏 tab**（原生右栏，`sidebarRightTabs` + `sidebar.right.pane.tab`）。

**列表只显示具备插件语义的包**：判据是包自带 `dsh.*` 清单（不是包名白名单），
所以 pnpm 按 hoisted 提升进来的纯依赖库（d3 / mermaid / codemirror …）会自动被过滤，
不进列表、不计入计数，只在顶部报一句"已隐藏 N 个纯依赖库"。
实测本机：194 个顶层包 → 过滤 174 个依赖库 → 20 个插件 → 4 个 mnemon strategy 组件
收进 `dsh-mnemon` 之下 → **列表 16 行**。

组件子行没有独立开关（它们的 entry id 已由归属包提供，单独启用会重复插入 id 触发 issue #470），
开关由归属包状态 + profile patch 行控制。

**点行直达官方配置页**：有 `dsh.bundle` 且不是「组件」的包，点行直接跳官方 Plugins 页里该插件
自己的配置面板（宿主 `pluginNavigation.openBundle`）；面板列不出它时先自动把它登记成当前
profile 的 `link:` 依赖（见下），再跳转。跳转失败（宿主没这个服务 / 登记被拒）或点的是组件时，
回退到本插件的自建详情页。详情页头部另有「配置页」与「加入插件面板」两个按钮。

## 官方面板可见性（panel）

**根因**：官方 Plugins 面板的数据源是宿主 `pluginManager.readBundles()`，它的候选集合
**只来自 profile 清单**（`dsh.profile.bundles` ∪ `dependencies` ∪ 安装目录 ∪ 官方目录），
从不 readdir `profiles/node_modules`。所以共享树里放着的包、一旦没有进当前 profile 的清单
（从未启用过 / 被停用摘掉了名字），面板就再也列不出它——它"消失"了。

**修复**：把包登记为当前 profile 的 `dependencies[name] = "link:<树内绝对路径>"`。
- 只写 dependencies，**绝不写 `dsh.profile.bundles`**——包不会被加载，停用/隔离语义不变；
- 面板因此能看到它（`installed: true / enabled: false`），可打开配置页、可在面板里自行启用；
- 只改**指定的那一个 profile**，其他 profile 与共享树目录零改动；
- 「组件」（entry id 已由树内另一个 bundle 声明，如 `dsh-mnemon-strategy-*`）一律拒登记
  ——在面板里出现独立开关只会诱发 issue #470；
- 用户自己写的同名依赖绝不覆盖、绝不删除（撤销只回退本插件写的那一条）；
- 改前备份 `package.json.bak-shared-tree`，写入面板台账 `.dsh-shared-tree-panel.json`，
  并记进生命周期台账（停用插件时随还原一起回滚）。

入口：
- 工具：`shared_tree action=panel`（无 target=只读报告；`target=a,b expose=true|false` 执行登记/撤销）。
- HTTP：`GET/POST /dsh-shared-tree/panel`。
- 界面：点行跳转时自动执行；详情页「加入插件面板」按钮手动执行；`disable` 停用后自动补登记。
- 需重启 DSH（或该 profile）后官方面板才会重新拉取清单。

面板底部还有一个**只读分区**，列出本 profile 以 `link:` 本地路径安装的插件
（桌面实测 7 条，含 `dsh-shared-tree` 自己），标 `linked` 徽标与原始路径。
分区内没有按钮，也**不计入** `total / plugins / components / libraries` 任何计数
（只多一个 `counts.linked`）；这些包物理上不在共享树里，启停请用 Plugins 页。

界面数据来自 Host 的只读路由 `/dsh-shared-tree/status`、`/dsh-shared-tree/verify`，
开关走 `POST /dsh-shared-tree/set` —— 与 `shared_tree` 工具调用**同一个** `pluginManager.setBundleEnabled`，
所以界面状态与 `status` / `verify` 结论不会分叉。搜索与过滤全在浏览器内完成，不发写请求。

三处注册各自 try/catch：任何一处失败（例如宿主没有 `sidebarRightTabs`）只少一个入口，
不影响其他入口，也不影响工具本身。

## 典型用法

```
shared_tree action=status
shared_tree action=search kind=bundle
shared_tree action=install packages=["dsh-taskboard@0.10.0"]
shared_tree action=enable target=dsh-taskboard
shared_tree action=verify
shared_tree action=panel
shared_tree action=panel target=dsh-douyin,dsh-config-manager
```

## 为什么放在 profiles/node_modules

`profiles/<name>/` 的上一级就是 `profiles/`，Node 沿祖先链解析时会经过 `profiles/node_modules`。放在这里的包对所有 profile 都是"按名可见"的，不必各自安装。

它不是插件：这份目录里没有 `package.json`，也没有 `cordis.patch.yml`，只有一个 `.dsh-shared-tree.json` 清单（本插件的记账文件）。

## 安全边界

- **绝不写 `@deepseek-ai/*`** —— 那是 dsh 安装目录的 10 个 junction。
- **组合包整族进** —— `dsh-mnemon` 需要 18 个子包 + `zod`/`yaml`/`fflate`，install 算的是依赖闭包。
- **零 `@deepseek-ai` 依赖** —— Host 与客户端两侧都只用 Node 内置模块 / `react`。
  客户端尤其不 require `@deepseek-ai/dsh-client-*`：那些包会在版本间变化，且抛错的组件会让槽位直接空白。
- **界面只读** —— 唯一的写请求是 `/dsh-shared-tree/set`（启用开关）；装包不在界面里做。

完整说明与已知限制见 [docs/DETAIL.md](docs/DETAIL.md)。

## 测试

```
npm test
```

- `test/shared-tree.test.mjs` —— Host 侧 33 项（工具 6 个 action + HTTP 通道 + `application` 语义 + `safetyNote` + 只读保证）。
- `test/client.test.mjs` —— 客户端契约 22 项（模块 id、槽位注册、locale 双语言对齐、inject 行为回归、
  并发/竞态保护、类别过滤与工具同源、未知状态、可访问性、无硬编码配色）。

渲染后的视觉表现需要有浏览器才能确认；无浏览器控制时只能验证到契约层。
但「客户端半边是否被组合进页面、服务端发出的 bundle 是否确为本插件代码」可以实测：
见 `docs/DETAIL.md` 的「怎么确认界面真的被组合进页面」。