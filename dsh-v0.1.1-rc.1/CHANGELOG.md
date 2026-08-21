# CHANGELOG — dsh-plugin-simplemanager @ dsh-v0.1.1-rc.1

> 本文件记录 **v0.1.1-rc.1 相对当前扁平源码头（`dsh-c` v0.1.0）的首次版本化**（更新原因 + 更新内容）。
> 本插件此前无既定 `dsh-v<PREV>` 版本目录，本目录为首次版本化产物，不与其他插件「相邻版本对比」混为一谈。
> 官方源码参考：`../dsh-official/deepseek-harness-v0.1.1-rc.1/`（rc.1）。

---

## 1. 更新原因（为什么适配 v0.1.1-rc.1）

官方 DSH 内核演进到 v0.1.1-rc.1（对比报告 `docs/0.1.1-rc.1.md`，基线 rc.7 → rc.1）。
本插件此前为扁平活插件（`dsh plugin add ./dsh-c`，无版本目录），本次首次版本化：
把当前源码归位进标准 `dsh-v<VERSION>` 四件套结构，并在 v0.1.1-rc.1 官方源码下完成 typecheck 验证，
为后续版本对比与回退留存既成历史。

## 2. 更新内容（扁平源码头 → v0.1.1-rc.1）

### 2.1 消费面核对结论（三级闸门）

对照官方消费面报告，插件全面机械取证（`probe-consumption.mjs`，13 项信号均零命中）后判定：

| 官方破坏项 | 插件是否消费 | 适配动作 |
| --- | --- | --- |
| `commands.execute` 插入 `images` | 未消费 | 无动作 |
| `session-projection` 重构 | 未消费 | 无动作 |
| `credentials/updated` 改名 | 未监听 | 无动作 |
| 移除 `client/schema-form`/`web-react` | 未依赖 | 无动作 |
| `frontend-static` SPA fallback→404 | 未依赖（用 `webServer.register`） | 无动作 |
| 新增 `authorization`/`fileReferences`/index 注入 | 未消费 | 无动作（可选采用） |

**结论：插件无需 TS 代码迁移。**

### 2.2 首次版本化结构与目录变更

- **新建版本目录** `dsh-v0.1.1-rc.1/`（本插件首个 `dsh-v<完整版本号>` 版本目录）。
- **源码归位**：扁平源码（`src/` + `lib/` + 各配置文件）从 `dsh-c` 根归位进 `plugin/`（结构规范化，零增删文件）。
- **typecheck 环境**：`typecheck-tmp/generate-tsconfig.mjs` 指向 `dsh-official/deepseek-harness-v0.1.1-rc.1`；
  host 范围（`index.ts`/`host.ts`/`shims.d.ts`）与插件自身 `tsconfig.json` 对齐，client.tsx 归 build 平面（tsdown）。
  `@standard-schema/spec` 属官方 vendor/cordis 第三方依赖，typecheck 从 `dsh-c` 的 pnpm store 解析（版本一致）。
- **MANIFEST.md / CHANGELOG.md**：依标准结构新建。

### 2.3 本次的坑与规避（记录供后续版本）

- **client 与 host 分属三平面**：插件自身 `tsconfig.json` 只 typecheck `index.ts`/`host.ts`/`shims.d.ts`，
  `client.tsx` 由 `tsdown`（build 平面）打包，其 slot 注册类型面（`@deepseek-ai/dsh-client-ui-slots`）不在宿主 tsc 平面。
  初版 typecheck include 误含 `**/*.tsx` 报出 client.tsx 2 处 TS2559/TS2353，改为与插件自身 tsconfig 对齐后归零——
  这是三平面纪律（typecheck / build 各用各工具链）的实际落点，非代码问题。
- **official 源码无 node_modules**：rc.1 官方源码裸拷（无 node_modules），观察到的 `vendor/cordis` TS 错误为官方源码自身
  TS6 内部噪音（`fiber.ts` 60/545/583 + `utils.ts` 119 共 4 处），非插件消费面问题，登记即可。

### 2.4 验证结果

- typecheck：host 范围 0 错误；官方 v0.1.1-rc.1 源码 `vendor/cordis` 4 处 TS6 内部噪音（已知可接受）。
- client 构建 / 实机运行：待 v0.1.1-rc.1 内核 desktop 可用后验证（MANIFEST 验证状态勾选待办）。

## 3. 相对扁平源码头（dsh-c v0.1.0）的源码差异

插件 `plugin/src` 代码与当前正源码一致（本次仅首次版本化的目录归位 + typecheck 环境 + MANIFEST/CHANGELOG 新建，
无 `plugin/src` 代码改动）。