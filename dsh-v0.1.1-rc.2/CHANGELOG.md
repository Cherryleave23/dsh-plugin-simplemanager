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

## 4. 插件自身功能更新（v0.1.1-rc.2 目录后续演进）

> 本节记录官方 rc.2 适配完成后，对本版本目录 `plugin/src` 追加的**插件本体功能演进**；与 RC 2.1 适配结论无冲突。

### 4.1 运行时状态徽标（档位 1）

- 新增 `loaderLiveMap(ctx)`：经根 `loader.entries()` 逐条读取 `disabled` 与 `fiber.state`，
  按官方 Cordis `FiberState` 数字枚举（PENDING=0 / LOADING=1 / ACTIVE=2 / FAILED=3 / DISPOSED=4 / UNLOADING=5）
  映射为可读相位（`pending/loading/active/failed/disposed/unloading`）。
- `PluginView` 新增 `state: FiberPhaseName` 字段；client 卡片右上角新增状态徽标
  （运行中 / 加载中 / 待加载 / 失败 / 已卸载 / 卸载中 / 未加载），按语义着色（active=成功 / failed=危险 / 其它=中性）。

### 4.2 运行时临时加载 / 卸载（档位 2）

- 新增 `load` 面：`LoaderWriteFace { create, remove, entries }` + `/simplemanager/tempLoad`、`/tempRemove` 两个 API。
- `tempLoad` 走**根 `Loader.create()`** 挂载到根树；根 `Loader` 的 `write()` 为 **no-op**，不写任何盘
  （不碰 `cordis.patch.yml`，无磁盘残留），entry 仅存活于进程内存 `EntryTree`；**关闭 dsh 进程即彻底消失**。
- `tempRemove` 以内存白名单 `tempEntryIds` 定位，**只接受本面板临时 create 过的 entry**，不会误卸正式安装插件。
- `PluginView` 新增 `source: 'temp'` 与 `temporary: boolean`，client 区分展示临时插件（「临时」徽标 + ✕ 卸载）。
- 加载语义限制为运行时可解析的插件：已安装未装配插件 / `cordis:` 内置可解析名 / 本地目录路径。

### 4.3 验证

- typecheck（host 范围）：0 错误。
- client 构建（tsdown）：通过。
- 临时插件「重启即消失」属进程生命周期语义，实机验证待 v0.1.1-rc.2 内核可用后执行。

### 4.4 普适化依赖获取 + 真注入（热注入 → 转正）

> 承接 §4.2 的临时加载：把「实验性临时加载」升级为完整的「热注入 → 依赖获取 → 真注入」闭环。
> 机制依据官方 `dsh plugin`（`@deepseek-ai/dsh/lib/plugin-*.js` thin pnpm forwarder）：在 profile 目录跑 pnpm，依赖闭包装进共享 node_modules。

- **pnpm 装配器（host）**：新增 `anchorSpec` / `specPackageName` / `pnpmAdd`。
  - `anchorSpec`：本地路径 → `file:<绝对路径>`，`file:`/`link:` 透传，其余按包名（registry）。
  - `pnpmAdd(profileDir, spec)`：`spawnSync('pnpm', ['add', spec], { cwd: profileDir })`；pnpm 不在 PATH → `code=127` 结构化提示；阻塞式 + 超时。
- **普适化依赖获取**：`tempLoad` 现在先在 profile 目录做一次 `pnpm add`（装齐依赖闭包），失败不阻塞热注入、仅提示。保证任意插件（即便自带 node_modules 不全）依赖可 resolve。
- **真注入（`/promote`）**：`promote(ctx, host, name)` = `pnpmAdd(spec)`（物理装入 + 装依赖）→ `host.setPatchEnabled(packageName, packageName, true)`（写 profile 层 patch 登记装配清单）。走官方「profile 层 patch 最后应用」语义，不依赖插件是否声明 `dsh.bundle.patch` → 对任意插件普适。转正后原临时 entry 运行至退出，重启后由 patch 装配持久生效。
- **临时闭包重构**：`tempEntryIds: Set<string>` → `tempInfos: Map<name, {entryId, spec}>`；`buildView` 临时判定收紧为「仅本面板 tempLoad 创建的 entry」才算临时（已装未装配 / `cordis:` 内置不再被误标为临时）。
- **client**：临时插件卡片新增「**转正**」按钮（`/promote`），`tempLoad` 反馈依赖获取结果，`<input>` placeholder 提示支持本地路径。
- **消费面风险**：`pnpm add` 属受控写操作（写 profile 的 `node_modules` / `package.json` / `pnpm-lock.yaml`），与官方 `dsh plugin add` 落在同一 profile 目录，符合 DSH 官方装配语义；仅 `webServer` 本地前缀路由可触发。

### 4.5 热启停（启/停立即生效，非插拔）

> 修复上一轮「热生效不成立」的机制现实：`Loader` 并无公开 `reload()`，旧版 `hotApplyLoader` 依赖的
> `loader.reload()` 实际不存在（`vendor/loader/src/index.ts` 全类无此方法），热启停长期退化为「重启后生效」。

- **运行时热启停（写侧治理，文档 §4.3 路径 B）**：`toggle` 现在对**已装配**插件 entry 执行
  `loader.update(entryId, { disabled: !next })` → 停用走 dispose（保留条目），启用走 fiber 重建，**立即生效**。
  - 这是 Cordis 官方热更新语义（`config/entry.ts` 差异化 update：改 disabled 走 dispose/init），非插拔（create/remove）。
- **定位**：`LoaderLive` 增补 `entryId`（`loaderLiveMap` 取 `entry.id ?? name`），供更新入口定位。
- **`LoaderWriteFace.update(id, opts)`**：新增第 3 个写面方法（create/remove/update），与官方 `EntryTree.update` 对齐。
- **持久化协同**：toggle 仍写 profile `cordis.patch.yml`（insert 增删）保证重启后装配状态正确；运行时定位不到 entry（未装配）则仅落盘、`hotApplied=false`、提示重启装配。
- **简化**：删除无用的 `hotApplyLoader`（reload 分支）；`toggle` 返回 `hotApplied` 反映真实热生效。
- **client**：toggle 提示按 `hotApplied` 分流（「已启用/停用」vs「（重启后生效）」）——原有，无需改动。
- **边界**：对「bundle 默认启用的插件」热停用后，运行时立即停，但重启后若 bundle 自身 patch 未禁用可能恢复；不属本功能回滚范围，已注释。

### 4.6 验证

- typecheck（host 范围）：0 错误。
- client 构建（tsdown）：通过。
- 热启停实机验证待 v0.1.1-rc.2 内核可用后执行：toggle 后确认卡片状态徽标与状态实时翻转、无需重启。