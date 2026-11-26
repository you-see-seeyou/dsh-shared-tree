# dsh-shared-tree 依赖关系说明

本文档梳理插件的文件/模块依赖与外部依赖。结论先行：**本包 npm 依赖为零（`package.json` 无 `dependencies`/`devDependencies`），运行时只用 Node 内置模块 + 宿主注入的 `react`。**

## 1. 文件清单与角色

| 文件 | 角色 |
|---|---|
| `package.json` | 包清单：声明 `dsh.bundle`（`patch` → `cordis.patch.yml`）与 `dsh.client`（web 平台 + inject 三个 `@deepseek-ai/dsh-client-*` UI 契约包）。无 npm 依赖。 |
| `cordis.patch.yml` | Host 侧 bundle 补丁：向当前 profile 插入 id 为 `shared-tree` 的 loader entry（name 指回本包）。 |
| `lib/index.js` | **Host 侧**：注册 `shared_tree` 工具（6 个 action）、只读/写 HTTP 路由（`/dsh-shared-tree/*`）、install 的 pnpm hoisted 构建、verify 的 sha256 复核。只用 Node 内置模块。 |
| `lib/client.js` | **浏览器侧**：通过 `window.__ModuleLoader__.load({ id: 'dsh-shared-tree', factory })` 注册；`require('react')`；渲染侧边栏图标、主列 `main` 面板、右栏 tab 三处入口，数据来自 Host 路由。 |
| `locale/en.json`、`locale/zh.json` | 客户端文案（扁平 key，en/zh 一一对应）。 |
| `icon.svg` | 插件图标（宿主清单行用）。 |
| `docs/DETAIL.md` | 设计细节、已知限制、实测记录。 |
| `docs/DEPENDENCIES.md` | 本文档。 |
| `test/*.mjs` | 测试（见第 4 节），仅依赖被测模块与 `node:test`/`node:assert`。 |

## 2. 模块间依赖（谁引用谁）

```
cordis.patch.yml ──(id: shared-tree, name: dsh-shared-tree)──▶ lib/index.js        [Host 加载入口]
package.json dsh.client ──────────────────────────────────────▶ lib/client.js      [浏览器加载入口]

lib/index.js   ：import node:child_process / crypto / fs / os / path，无本地 import
lib/client.js  ：require('react')（宿主注入），fetch('/dsh-shared-tree/*')，无本地 import
lib/client.js ──(HTTP /dsh-shared-tree/*──与 shared_tree 工具同一后端)──▶ lib/index.js
locale/*.json  ：仅由 client 侧 locale 机制按 NS 'dsh-shared-tree' 使用（client.js 内置同源字典作回退）
```

两侧代码互不 import：Host 与浏览器各一个入口，靠共享常量（路由前缀 `/dsh-shared-tree`、locale 命名空间、面板 id）对齐。

## 3. 运行时对宿主（DSH / DeepSeek Harness）的依赖

| 依赖 | 来源 | 用途 | 缺失时的行为 |
|---|---|---|---|
| `tools` 注册表 | Host 服务注入 | 注册 `shared_tree` 工具 | 未注入则不注册工具 |
| `pluginManager` 服务 | `ctx.get('pluginManager')` 懒取 | `listBundles()` / `setBundleEnabled()`，enable/disable 与 Plugins 页同路径 | 降级为报告缺失，不崩 |
| `webServer` 服务 | `ctx.inject(['webServer'], …)` 可选注入 | 挂 `/dsh-shared-tree/status|verify|set` 路由 | 界面不可用，工具不受影响 |
| `react` | 浏览器侧宿主注入（DSH 客户端 bundle） | UI 渲染 | 工厂抛错，工具侧不受影响 |
| `window.__ModuleLoader__` | DSH web 客户端 | 客户端 bundle 注册 | 不加载 UI |
| `@deepseek-ai/dsh-client-ui-sidebar-right` / `dsh-client-locale` / `dsh-client-ui-layout` | `package.json` 的 `dsh.client.inject` 声明（**契约包，非运行时 import**） | 声明槽位/布局注入点 | 各入口独立 try/catch，少一个入口不影响其他 |

刻意**不**依赖 `@deepseek-ai/*` 的任何运行时包：npm 镜像版会遮蔽 CLI 内置 build，导致宿主工具调度失效（见 `lib/index.js` 头部注释）。

## 4. 外部工具依赖

| 工具 | 用途 | 引用位置 |
|---|---|---|
| Node.js ≥ 20（内置模块） | 运行时全部功能 | `lib/index.js` |
| `pnpm`（PATH 上任一版本） | 仅 `install` action：临时目录 `nodeLinker: hoisted` 构建依赖闭包 | `lib/index.js` `runPnpm()`；环境清理 HTTP(S)_PROXY、禁 `@deepseek-ai` junction 改写 |
| npm registry（走 pnpm 的既有配置，可选 `--registry` 覆盖） | `install` 下载包 | 同上 |
| `node:test` / `node:assert` | 测试 | `test/*.mjs` |

`verify` 用 `node:crypto` 算 sha256，不依赖外部命令。

## 5. 测试文件依赖

| 测试 | 依赖 |
|---|---|
| `test/shared-tree.test.mjs` | `../lib/index.js`，fake ctx（临时目录建假共享树） |
| `test/client.test.mjs` | `../lib/client.js`，假 `__ModuleLoader__`/react，纯契约层断言 |
| `test/live-smoke.mjs` | Host 在线冒烟（需真实 DSH 会话） |
| `test/real-route-dryrun.mjs` / `test/real-linked-dryrun.mjs` | 录制的真实 desktop 快照 dryrun（数据已匿名化为占位路径），无网络、无真实文件系统写 |
