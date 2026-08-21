# CHANGELOG — dsh-plugin-simplemanager @ dsh-v0.1.1-rc.2

> 本文件记录 **v0.1.1-rc.2 相对 `dsh-v0.1.1-rc.1` 的版本适配**（更新原因 + 更新内容），严格覆盖 `0.1.1-rc.1 → 0.1.1-rc.2` 紧邻区间。
> 官方源码参考：`../dsh-official/deepseek-harness-v0.1.1-rc.2/`；对比报告：`dsh-official/docs/0.1.1-rc.2.md`。

---

## 1. 更新原因（为什么适配 v0.1.1-rc.2）

官方 DSH 内核演进到 v0.1.1-rc.2（以图片大图处理为主线的短增量）。对比报告 `docs/0.1.1-rc.2.md`
覆盖紧邻区间 rc.1 → rc.2，与 `docs/0.1.1-rc.1.md`（rc.7 → rc.1）区间不重叠、无矛盾。
本插件维护既有 `dsh-v0.1.1-rc.1` 版本目录，本次新建 `dsh-v0.1.1-rc.2` 副本并核对其消费面。

## 2. 更新内容（v0.1.1-rc.1 → v0.1.1-rc.2）

### 2.1 消费面核对结论（三级闸门）

按三级闸门（版本 → 签名 → 语义）对照 `docs/0.1.1-rc.2.md`：`<REPORT_BASE>`(rc.1) == `<PREV>`(rc.1)，
报告即真实区间。机械取证（`probe-consumption.mjs`，17 项信号零命中 + 全量双保险检索）后判定
**插件无需 TS 代码迁移**。命中表见 `MANIFEST.md`「相对 dsh-v0.1.1-rc.1 的适配结论」：

| 报告破坏/行为/新增项 | 插件命中 | 适配动作 |
| --- | --- | --- |
| `saveImageFile`/`validateImageFile` 加必填 `policy`（破坏） | 0 | 无动作 |
| `maxRequestImageBytes` 配置维移除（破坏） | 0 | 无动作 |
| `refreshDefaultForReuse` 移除（破坏，Web 空白复用下线） | 0 | 无动作 |
| `session.create.reuseWorkspaceBlank` 移除（破坏） | 0 | 无动作 |
| `SessionsPort.create` opts 收缩（破坏，client 契约） | 0 | 无动作 |
| `permission/preset` `origin` 回退（行为） | 0 | 无动作 |
| `saveImage` 规范化 / `originalDimensions`（行为） | 0 | 无动作 |
| Files API / `readImageRequest` / `ImageRequestPolicy` / `prepareCall`（新增） | 0 | 无动作（可选采用） |

> 双保险依据：插件 host 仅消费 `@deepseek-ai/dsh` 版本读取（npm registry）、`dsh-client-ui-slots`、及
> `webServer` / `loader` / `desktopProfiles` 三项运行时探测——均不在 rc.2 变更面内。

### 2.2 本版本目录结构

- **新建版本目录** `dsh-v0.1.1-rc.2/`：由 `dsh-v0.1.1-rc.1` 标准四件套 `robocopy /E /SL` 复制（仅排除旧 `_adapt_work`），
  保留符号链接，`plugin/src` 零增删。
- **typecheck 环境**：`typecheck-tmp/generate-tsconfig.mjs` 的 `baseDir`/`extends` 重指 `dsh-official/deepseek-harness-v0.1.1-rc.2`；
  运行生成 tsconfig（156 条 paths，与 <PREV> 一致，官方 rc.1→rc.2 无增删包）。
- **MANIFEST.md / CHANGELOG.md**：依 rc.2 事实改写；「依赖的官方插件」精确版本逐包实读官方源码（cordis 4.0.1、
  client-ui-slots / client-runtime / host-webserver 均为 0.1.1-rc.2，rc.2 未改名移位）。

> 规范化说明：本版本 <PREV>（rc.1）已是标准四件套，无需扁平归一化；「目录归位」规则不适用。

### 2.3 本次的坑与规避（记录供后续版本）

- **官方 rc.2 源码含 node_modules**（本地构建产物）：遍历 `packages/**/package.json` 精读版本时，粗力气泡
  （ConvertFrom-Json 管道）因部分包出错被整体吞掉输出，误判为「0 命中」。规避：改用文件级实读 + 精确路径
  （`packages/client/ui-slots`、`packages/client/runtime`、`packages/host/webserver`、`vendor/cordis`）。
- **官方源码 `vendor/cordis` TS6 噪音**：rc.2 同样在 `fiber.ts` 60/545/583 + `utils.ts` 119 报 4 处（与 rc.1 同型），
  非插件消费面问题，登记即可。

### 2.4 验证结果

- typecheck：host 范围 0 错误；官方 v0.1.1-rc.2 源码 `vendor/cordis` 4 处 TS6 内部噪音（已知可接受）。
- client 构建 / 实机运行：待 v0.1.1-rc.2 内核可用后验证（MANIFEST 验证状态勾选待办）。

## 3. 相对 `dsh-v0.1.1-rc.1` 的源码差异

插件 `plugin/src` 代码与 rc.1 完全一致（本次仅复制 + 重指 typecheck + 改写 MANIFEST/CHANGELOG，
无 `plugin/src` 代码改动）。