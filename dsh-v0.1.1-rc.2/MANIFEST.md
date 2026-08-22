# MANIFEST — dsh-plugin-simplemanager @ dsh-v0.1.1-rc.2

> 本文件是版本清单：**强制声明**本版本插件所依赖的官方 DSH 插件/包及其精确版本。
> 官方 DSH 更新后，先对照本清单判断是否需要为本版本插件做适配，再决定是否升级。
> 本版本相对上一版本目录 `dsh-v0.1.1-rc.1` 的更新原因与更新内容见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 插件信息

| 项 | 值 |
| --- | --- |
| 插件包名 | `dsh-plugin-simplemanager` |
| 插件版本 | `0.1.0`（v0.1.1-rc.2 适配版，沿用扁平源码头版本号） |
| 适配目标 | **官方 dsh 内核 v0.1.1-rc.2** |
| 官方内核版本 | `0.1.1-rc.2` |
| 官方源码 | `../dsh-official/deepseek-harness-v0.1.1-rc.2/`（GitHub release） |
| 源码位置 | `./plugin/` |
| typecheck 环境 | `./typecheck-tmp/`（指向 `dsh-official/deepseek-harness-v0.1.1-rc.2`，host 范围与插件自身 tsconfig 对齐） |

> 版本化说明：本插件为扁平活插件（`dsh plugin add ./dsh-c`）。`dsh-v0.1.1-rc.1/` 为**首个版本化目录**；
> `dsh-v0.1.1-rc.2/` 由 `dsh-v0.1.1-rc.1` 按标准四件套 `robocopy /E /SL` 复制（<PREV> 已是标准结构，无需扁平归一化），
> 仅重指 typecheck 环境 + 改写契约文档。适配后（见 `CHANGELOG.md` §4）又追加了插件自身功能演进（运行时状态徽标 + 临时加载/卸载）。

## 官方安装 / 卸载（bundle 装配）

插件 `package.json` 声明 `dsh.bundle.patch`（→ `cordis.patch.yml`），加载走官方 `dsh plugin` 命令：

```sh
node <DSH>/.../@deepseek-ai/dsh/lib/bin.js \
  plugin --profile <name> add "file:<本目录>/plugin"
```

- 安装用 `file:` 协议（pnpm 落实依赖闭包）。
- 卸装 `dsh plugin remove dsh-plugin-simplemanager` 由官方命令移除依赖与装配登记。

## 依赖的官方插件（peerDependencies，范围声明；精确版本为 rc.2 官方源码实读）

插件 `package.json` 的 peerDependencies / client inject 声明使用跨版本宽松范围，以兼容多 rc 内核。
本版本实际直面 v0.1.1-rc.2 官方源码，其精确版本如下（逐包实读 `deepseek-harness-v0.1.1-rc.2/packages/**/package.json`）：

| 官方包 | rc.2 精确版本 | 消费侧 |
| --- | --- | --- |
| @deepseek-ai/cordis | 4.0.1 | host（`Context` 类型） |
| @deepseek-ai/dsh-client-ui-slots | 0.1.1-rc.2 | client（`slots` 注册标签页） |
| @deepseek-ai/dsh-client-runtime | 0.1.1-rc.2 | client（`dsh.client.inject` 声明） |
| @deepseek-ai/dsh-host-webserver | 0.1.1-rc.2 | host（`webServer.register` / prefix `/simplemanager`） |

> 上述包名与路径在 rc.2 未改名移位（`packages/client/ui-slots`、`packages/client/runtime`、`packages/host/webserver`、`vendor/cordis`）。
> host 运行时动态探测（`ctx.get()`，非 peerDep）：`desktopProfiles`（定位 profile）、`loader`（live enabled / reload 热生效）。
> 其余 `@deepseek-ai/dsh-*` 内核插件仅作扫面对象（host.ts `scanCatalog`），不作为注入面。

## 第三方运行时依赖（插件自带，非官方）

无（插件为数据处理 + webServer 装配插件，仅面向前端 UI 的浏览器 bundle 用 react，属 client 构建侧，非 host 运行时依赖）。

## 相对 `dsh-v0.1.1-rc.1` 的适配结论（v0.1.1-rc.2）

按三级闸门（版本 → 签名 → 语义）对照官方变化报告 `docs/0.1.1-rc.2.md`（基线 rc.1 → rc.2，报告头与 <PREV> 一致，报告即真实区间）：
插件**无需代码迁移**。机械取证（`probe-consumption.mjs`）对报告全部破坏/行为/新增信号逐项命中判定均 **0 命中**，判定表如下：

| 报告破坏/行为项 | 涉信号（第三方可 grep） | 插件命中 | 适配动作 |
| --- | --- | --- | --- |
| `attachment-local` `saveImageFile`/`validateImageFile` 加必填 `policy` | `saveImageFile` / `validateImageFile` | 0 | 无动作 |
| `llm-deepseek` 移除 `maxRequestImageBytes` 配置维 | `DEFAULT_MAX_REQUEST_IMAGE_BYTES` / `maxRequestImageBytes` / `DeepSeekConnectionOptions` | 0 | 无动作 |
| `permission-presets` 移除 `refreshDefaultForReuse` | `refreshDefaultForReuse` | 0 | 无动作 |
| `apiproxy` 移除 `session.create.reuseWorkspaceBlank` | `reuseWorkspaceBlank` | 0 | 无动作 |
| `client/runtime` `SessionsPort.create` 收缩 opts | `SessionsPort` | 0 | 无动作 |
| `permission/preset` payload `origin` 回退 | `permission/preset` / `origin` | 0 | 无动作 |
| `attachment` `saveImage` 规范化契约 / `originalDimensions` | `saveImage` / `originalDimensions` | 0 | 无动作 |
| 新增 `readImageRequest` / `ImageRequestPolicy` / `prepareCall` / Files API | `readImageRequest` / `ImageRequestPolicy` / `prepareCall` / `DeepSeekFilesClient` / `DeepSeekFileStore` | 0 | 无动作（可选采用） |
| 其余生成面（`commands.execute` / `userQuestions` / `approval` / `sessionProjection` / `credentials*` / `tools` / `schedule` / `storage`…） | — | 未消费 | 无动作 |

> 整体双保险：`src/*.ts(x)` 全量检索 host 仅消费 `@deepseek-ai/dsh` 版本读取（npm registry）、`dsh-client-ui-slots`（`SlotsService` 注册标签页）、
> `webServer` / `loader` / `desktopProfiles` 三项运行时探测——均不在 rc.2 变更面内，确认零命中。

## 关键 API 契约（v0.1.1-rc.2）

- `ctx.webServer.register({ kind, path, handler })` —— 插件主注入面，rc.2 签名无破坏，未变。
- `ctx.get('desktopProfiles')` / `ctx.get('loader')` —— 运行时动态探测，仅内部实现按情况降级，非注入面。

## 验证状态

- [x] typecheck：host 范围（`index.ts`/`host.ts`/`shims.d.ts`）0 错误（官方 v0.1.1-rc.2 源码 `vendor/cordis` 4 处 TS6 内部噪音，与 rc.1 同型，已知可接受）
- [ ] client 构建（tsdown，三平面 build 平面）：待实机/构建环境验证
- [ ] 实机运行验证（待 v0.1.1-rc.2 内核可用后执行；`dsh plugin add` 到 profile 走 `file:` 协议）