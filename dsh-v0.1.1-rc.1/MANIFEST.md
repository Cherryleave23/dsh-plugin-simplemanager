# MANIFEST — dsh-plugin-simplemanager @ dsh-v0.1.1-rc.1

> 本文件是版本清单：**强制声明**本版本插件所依赖的官方 DSH 插件/包及其精确版本。
> 官方 DSH 更新后，先对照本清单判断是否需要为本版本插件做适配，再决定是否升级。
> 本版本相对上一版本（当前扁平源码头 `dsh-c` v0.1.0）的更新原因与更新内容见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 插件信息

| 项 | 值 |
| --- | --- |
| 插件包名 | `dsh-plugin-simplemanager` |
| 插件版本 | `0.1.0`（v0.1.1-rc.1 适配版，沿用扁平源码头版本号） |
| 适配目标 | **官方 dsh 内核 v0.1.1-rc.1** |
| 官方内核版本 | `0.1.1-rc.1` |
| 官方源码 | `../dsh-official/deepseek-harness-v0.1.1-rc.1/`（源 `_scan_target`，npm `dsh-v0.1.1-rc.1` tag） |
| 源码位置 | `./plugin/` |
| typecheck 环境 | `./typecheck-tmp/`（指向 `dsh-official/deepseek-harness-v0.1.1-rc.1`，host 范围与插件自身 tsconfig 对齐） |

> 版本化说明：本插件此前为**扁平活插件**（直接 `dsh plugin add ./dsh-c`，无 `dsh-v<PREV>` 版本目录）。
> `dsh-v0.1.1-rc.1/` 为本插件**首次版本化目录**（从当前 `dsh-c` 正源码播种归位，不复制 node_modules）。
> 因此「相对 <PREV>」的 <PREV> 指扁平源码头，非某手册的既定版本目录。

## 官方安装 / 卸载（bundle 装配）

插件 `package.json` 声明 `dsh.bundle.patch`（→ `cordis.patch.yml`），加载走官方 `dsh plugin` 命令：

```sh
node <DSH>/.../@deepseek-ai/dsh/lib/bin.js \
  plugin --profile <name> add "file:<本目录>/plugin"
```

- 本插件为首次版本化副本；实机验证前请以 `file:` 协议安装（pnpm 会落实依赖闭包）。
- 卸装 `dsh plugin remove dsh-plugin-simplemanager` 由官方命令移除依赖与装配登记。

## 依赖的官方插件（peerDependencies，范围声明；精确版本为 rc.1 官方源码）

插件 `package.json` 的 peerDependencies / client inject 声明使用跨版本宽松范围，以兼容多 rc 内核。
本版本实际直面 v0.1.1-rc.1 官方源码，其精确版本如下（host / client 侧分别消费）：

| 官方包 | rc.1 精确版本 | 消费侧 |
| --- | --- | --- |
| @deepseek-ai/cordis | 4.0.1 | host（`Context` 类型） |
| @deepseek-ai/dsh-client-ui-slots | 0.1.1-rc.1 | client（`slots` 注册标签页） |
| @deepseek-ai/dsh-client-runtime | 0.1.1-rc.1 | client（`dsh.client.inject` 声明） |
| @deepseek-ai/dsh-host-webserver | 0.1.1-rc.1 | host（`webServer.register` / prefix `/simplemanager`） |

> host 运行时动态探测（`ctx.get()`，非 peerDep）：`desktopProfiles`（定位 profile）、`loader`（live enabled / reload 热生效）。
> 其余 `@deepseek-ai/dsh-*` 内核插件仅作扫面对象（host.ts `scanCatalog`），不作为注入面。

## 第三方运行时依赖（插件自带，非官方）

无（插件为数据处理 + webServer 装配插件，仅面向前端 UI 的浏览器 bundle 用 react，属 client 构建侧，非 host 运行时依赖）。

## 相对扁平源码头（dsh-c v0.1.0）的适配结论（v0.1.1-rc.1）

按三级闸门（版本 → 签名 → 语义）对照官方变化报告 `docs/0.1.1-rc.1.md`（基线 rc.7 → rc.1）：
插件**无需代码迁移**，本次仅做首次版本化（源码归位进 `plugin/` + typecheck 环境 + 契约文档）。判定如下：

- **`ctx.commands.execute` 中间插入 `images`**（报告 §破坏1）：插件**未消费** `ctx.commands.execute`，不命中。
- **`session-projection` 重构**（`schema`→`stateSchema` / `view`→`wire`，报告 §破坏2）：插件**未消费** `sessionProjections`，不命中。
- **`credentials/updated` 改名 `credentials/reference-updated`**（报告 §破坏11）：插件**未监听**该事件，不命中。
- **移除 `client/schema-form`、`client/web-react`**（报告 §移除）：插件 client 只依赖 `dsh-client-ui-slots`，不依赖被移除二包，不命中。
- **`host/frontend-static` SPA fallback→404**（报告 §行为）：插件用 `webServer.register` 自建 `/simplemanager`，不依赖 frontend-static fallback，不命中。
- **新增授权流 `ctx.authorization` / 文件引用 `ctx.fileReferences` / index 注入事件**（报告 §新增）：插件未消费新增能力，不命中（可选采用，非必需）。

> 版本命名说明：官方源码目录自 2026-08-21 起统一为 `deepseek-harness-v<完整版本号>`，
> 插件版本目录为 `dsh-v<完整版本号>`；本版本即为该规范下的本插件首版。

## 关键 API 契约（v0.1.1-rc.1）

- `ctx.webServer.register({ kind, path, handler })` —— 插件主注入面，rc.1 签名无破坏，未变。
- `ctx.get('desktopProfiles')` / `ctx.get('loader')` —— 运行时动态探测，仅内部实现按情况降级，非注入面。

## 验证状态

- [x] typecheck：host 范围（`index.ts`/`host.ts`/`shims.d.ts`）0 错误（官方 v0.1.1-rc.1 源码 `vendor/cordis` 4 处 TS6 内部噪音，已知可接受）
- [ ] client 构建（tsdown，三平面 build 平面）：待实机/构建环境验证
- [ ] 实机运行验证（待 v0.1.1-rc.1 内核 desktop 可用后执行；`dsh plugin add` 到 profile 走 `file:` 协议）