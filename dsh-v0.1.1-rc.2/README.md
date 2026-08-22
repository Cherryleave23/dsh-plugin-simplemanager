# dsh-plugin-simplemanager（插件管家）

> 适配内核：**DSH `0.1.1-rc.2`** ｜ 插件包版本：**`0.1.0`**（扁平源码头版本号，随官方 rc 演进维护）

插件管家是 DSH 宿主内的一个核心服务插件，将「哪些第三方插件可用、当前是否在运行、属于哪个分类、有什么备注、内核有没有新版本」统一到一个管理面板。核心价值是：**在不触碰 DSH 内核的前提下，用一种可验证、可回滚、零残留的官方方式管理插件——既支持持久安装，也支持开发期的运行时热插拔与转正**。

---

## 一、项目简介

`dsh-plugin-simplemanager` 面向 DSH 桌面壳（Desktop）的**插件生命周期管理**场景。它以 `webServer` 暴露 `/simplemanager` 数据/操作 API，并在 client 侧渲染管理面板，覆盖从「扫描已安装插件 → 分类/备注 → 一键启停 → 热插拔试用 → 转正持久化 → 彻底卸载」的完整闭环。

一句话：**DSH 第三方的插件管家——看得见状态、管得了装卸、试得了热插拔、收得干净。**

---

## 二、功能特性

- **运行时状态徽标**：实时读取已装配插件的 `disabled` 与 `fiber.state`，按官方 Cordis `FiberState` 枚举映射为可读相位（运行中 / 加载中 / 待加载 / 失败 / 已卸载 / 卸载中 / 未加载），卡片右上角着色展示。
- **一键启停（热启停）**：对已装配第三方插件执行 `loader.update(entryId, { disabled })`——改 `disabled` 走 Cordis 官方 dispose/init 差异化语义，**立即生效、无需重启**；同时写 profile 层 `cordis.patch.yml` 保证重启后装配正确；运行时定位不到 entry（未装配）则仅落盘、提示重启装配。
- **插件分类管理**：内置「官方内置」「第三方插件」两个分类，另可创建自定义文件夹；支持拖拽移动、内联备注、显示名别名。
- **内核版本看板**：展示当前 DSH 内核版本，检测 npm 最新版本；有更新时**仅提示、不自动更新**。
- **运行时临时加载（热插拔）**：根 `Loader.create()` 挂载到根树，根 Loader 的 `write()` 为 no-op——**不落盘、零磁盘残留**，关闭 DSH 进程即彻底消失。
- **普适化依赖获取**：临时加载前先在 profile 目录 `pnpm add` 装齐依赖闭包（失败不阻塞热注入、仅提示），任意插件即使自带依赖不全也能 resolve。
- **真注入（转正）**：临时插件测试通过后一键持久化——`pnpm add` 物理装入 + `setPatchEnabled` 写 profile 层 patch 装配清单，重启后由 patch 装配持久生效。
- **彻底卸载**：移除磁盘包（含 pnpm 未登记的孤儿目录强删兜底）+ 依赖闭包 + 三层装配登记（deps / bundles / patch）+ 自持数据，卸载后不残留、重启不再重现。
- **重载界面**：一键重载 CLIENT 渲染进程并重新执行 boot 注入，让热加载插件的 client 卡片立即显现，无需重启内核。
- **官方插件只读**：官方内置插件默认仅展示为「已启用」，不提供停用入口，避免误操作破坏内核。

---

## 三、快速开始

在已具备 DSH 桌面壳的前提下，安装本插件包到目标 profile 后，进入 **设置 → 插件 → 插件管家** 即可开始使用：

```sh
# 安装到当前 profile
node <DSH>/lib/bin.js plugin add "file:<本版本目录>"

# 指定 profile
node <DSH>/lib/bin.js plugin --profile <name> add "file:<本版本目录>"
```

最小验证路径：安装 → 打开插件管家 → 看到「内核」区域与「第三方插件」列表 → 临时拖入一个分类 → 点击卡片开关注入启停。

---

## 四、安装指南

### 前置依赖

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| DSH 内核 | `0.1.1-rc.2`（适配目标；peer 范围 cordis `>=4.0.0-rc <5`） | 本版本直面官方 rc.2 源码 |
| DSH 桌面壳 | 提供 `webServer` / `loader` / `desktopProfiles` 服务 | host 运行时动态探测 |
| node | ≥ 20 | 编译与运行 |
| pnpm | ≥ 9 | 依赖闭包的装卸；桌面壳下自动定位系统真实 `node.exe` |

### 安装

本插件以官方 `dsh plugin add`（dsd `file:` 协议）安装到 profile，依赖闭包由 pnpm 落实：

```sh
# 方式一：dsh CLI（推荐）
dsh plugin --profile <name> add "file:D:\path\to\dsh-v0.1.1-rc.2"

# 方式二：node 直调官方 bin（等同 dsh CLI 实现）
node <DSH>/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile <name> add "file:D:\path\to\dsh-v0.1.1-rc.2"
```

> **注意**：`<本版本目录>` 指含 `package.json` 的目录（本目录本身）。若按「扁平活插件」方式直接开发使用，也可 `dsh plugin add ./dsh-c`（见[插件根 README](../README.md)）。

### 卸载

```sh
dsh plugin remove dsh-plugin-simplemanager
```

由官方命令移除依赖与装配登记；本插件卸载时另做自持数据清理。

---

## 五、使用说明

### 面板访问

设置 → 插件 → 插件管家。

### 常见操作

| 我想… | 操作 |
| --- | --- |
| 查看内核版本 / 是否有更新 | 打开插件管家，看「内核」区域（仅展示最新版本与更新提示） |
| 把插件归到自己的分类 | 先「新建文件夹」，再把插件**拖拽**到该文件夹 |
| 记下某个插件的用途 | 在插件卡片上**添加备注**（内联编辑） |
| 停用 / 启用一个第三方插件 | 点击插件卡片上的**开关**，立即热生效，无需重启 |
| 看某个插件的运行状态 | 看插件卡片右上角的**状态徽标** |
| 临时试用一个插件（不落盘） | 点「+ 运行时临时加载插件」，输入包名或本地路径后加载；关进程即彻底移除 |
| 让热加载插件的 client 卡片立即显示 | 点「**↻ 重载界面**」，仅刷新渲染进程、不重启内核 |
| 把临时插件正式装上（转正） | 临时插件卡片上点 **转正**，安装依赖并写入装配清单，重启后持久生效 |
| 移除一个临时插件 | 临时插件卡片上点 **✕**，仅当前进程移除，不影响磁盘 |
| 看官方内置插件 | 「官方内置」分类下只读浏览，开关不可用 |

### API（webServer，prefix `/simplemanager`）

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/simplemanager/kernel` | GET | 当前内核版本 |
| `/simplemanager/browse` | GET | 全量状态（内核 + 文件夹 + 插件状态 + 依赖 + 备注） |
| `/simplemanager/toggle` | POST | 启停第三方插件（热 + 持久两层协同） |
| `/simplemanager/tempLoad` | POST | 运行时临时加载（热注入，不落盘） |
| `/simplemanager/tempRemove` | POST | 临时卸载（仅限本面板临时创建的 entry） |
| `/simplemanager/promote` | POST | 真注入 / 转正（持久化装配） |
| `/simplemanager/folders` / `move` / `note` / `rename` | POST | 文件夹 / 移动 / 备注 / 显示名管理 |

示例——临时加载一个本地插件：

```json
POST /simplemanager/tempLoad
{ "name": "D:\\path\\to\\my-plugin" }
```

```json
{ "ok": true, "depsApplied": true, "hotApplied": true, "packageName": "my-plugin" }
```

### 数据与自持存储

- 分类 / 备注 / 别名 / 闭包依赖 / 排序保存于 `~/.dsh/simplemanager/data.json`（原子写 + 自动备份），卸载后按官方机制清理。
- 内核最新版本检测走 npm registry（`registry.npmjs.org`，失败降级 `registry.npmmirror.com`），带缓存。

---

## 六、配置选项

面板级设置暂未提供可视化配置页，行为由固定默认驱动。**暂无用户可改配置项**。行为相关常量（pnpm 超时、registry 列表、scope 覆盖映射）通过 `src/config.ts` 与宿主环境变量可控，具体见开发一节。

---

## 七、开发与构建

### 源码目录简述

```
dsh-v0.1.1-rc.2/
├── src/
│   ├── index.ts    # Host 入口：webServer + loader 协同，装配 / 启停 / 热插拔 / 卸载
│   ├── host.ts     # 宿主数据层：patch 读写、目录扫描、状态枚举、自持数据
│   ├── client.tsx  # Client 面板：React UI + API 调用 + 启停 / 热加载 / 重载界面
│   ├── pnpm.ts     # 自包含 pnpm 运行器：依赖闭包装 / 卸、真实 node 定位
│   └── shims.d.ts  # 类型 shim
├── lib/            # 构建产物（index.js + client.js）
├── docs/
│   ├── debug-log.md                       # 踩坑与端到端验证记录（P-021~P-044）
│   └── DSH-runtime-and-plugin-lifecycle.md
├── cordis.patch.yml  # 装配清单（示例）
├── package.json      # 声明 dsh.bundle / dsh.client / exports / peerDependencies
└── tsdown.config.ts  # client 侧打包配置
```

### 环境要求与构建

- 工具链：`node ≥20`、`pnpm ≥9`、`typescript ~5.9`、`tsdown ^0.22`（打包 client）。

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc 编译 host 到 lib/ + tsdown 打包 client 到 lib/client.js
```

产物：
- `lib/index.js` → 内核 side（`exports["."]`）
- `lib/client.js` → client side（`exports["./client"]`）

### 运行机制要点

- **启停**：写 profile 层 `cordis.patch.yml` 的 `insert:` 数组（原子写、写前备份），并对运行 entry `loader.update({ disabled })` 立即热生效。
- **临时加载**：根 `Loader.create()` 挂到根树；根 Loader 的 `write()` 为 no-op，既不写 patch 也不落盘，进程退出即随堆释放 → 零残留。
- **转正**：冲突检测以装配表（bundles + patch）为真值判「是否已持久安装」，不把物理命中误判为热装对象自身；`pnpmAdd` 跳过**官方系统依赖**（官方 `@deepseek-ai/dsh-*`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 由发行内嵌提供），避免卸载误删官方核心依赖，也让热装/转正不把官方包落进 profile（P-042/P-045）。
- **卸载**：对确认真卸载的第三方包物理目录 `rmSync` 强删兜底（pnpm 未登记的孤儿目录也可清），残留七位点（deps / bundles / patch / cordis.yml / node_modules / .pnpm / lock）全清才算干净（P-043）。
- **唯一官方白名单**：官方系统依赖判定集中在 host.ts `isOfficialSystemDep` 一处真源，pnpm.ts（闭包过滤）与 index.ts（卸载保护）统一复用，杜绝各处各自维护白名单漂移（P-045）。

---

## 八、版本兼容与发布

> 本仓库采用**版本目录**管理：每个 `dsh-v*` 目录对应该适配内核版本。本版本为**当前最新适配版**；后续仅维护并上传最新版。

| 版本目录 | 适配目标内核 | 说明 |
| --- | --- | --- |
| `dsh-v0.1.1-rc.2/` | v0.1.1-rc.2 | ✅ 当前版本（本文档；契约见 `MANIFEST.md`，变更见 `CHANGELOG.md`） |
| `dsh-v0.1.1-rc.1/` | v0.1.1-rc.1 | 上一版本（首个版本化目录） |

> 与官方内核的适配结论（三级闸门版本→签名→语义）、依赖官方包的精确版本、验证状态见各版本目录 `MANIFEST.md`；相邻版本差异见各 `CHANGELOG.md`。

---

## 九、贡献指南

欢迎提交 issue 与 PR。请遵循以下纪律：

- 改动**不得破坏基础功能**：不假设 / 不覆盖其他插件内部实现，优先复用官方 slot / service / patch。
- 装卸必须走官方渠道：不手拷产物、不私改装配层、不留下绕过官方装配的旁路。
- 每次改动走验证流水线：`typecheck → build → 同步 → 重启 → 日志 → 实测`，六步走完才算完成。
- 新功能需附带 MD 文档说明（用法与边界），并将踩坑记入 `docs/debug-log.md`。
- 风格：`inject` 与真实消费严格对齐，禁止 `@ts-nocheck` / eval 类旁路，尽量不引入超出任务所需的抽象。

---

## 十、路线图

### 已实现

- [x] 内核版本看板 + 更新检测（仅提示）
- [x] 第三方插件一键启停（写补丁 + 实时热生效）
- [x] 自定义文件夹 / 拖拽移动 / 内联备注 / 显示名别名
- [x] 运行时临时加载（热插拔）+ 普适化依赖闭包获取
- [x] 真注入（转正）
- [x] 转正持久装配：转正后写入 profile 层装配登记，重启后真正持久加载
- [x] 转正冲突判定纠偏：以装配表（bundles + patch）为真值判「已持久安装」，弃物理命中误判（P-041）
- [x] 转正跳过官方业务 peer：官方 `@deepseek-ai/dsh-*` 由发行内嵌提供，不装进 profile、不回收入闭包（P-042）
- [x] 官方系统依赖统一白名单：`isOfficialSystemDep`（含 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`）集中真源，热装/转正/卸载全链路复用，官方包不进 profile（P-045）
- [x] profile 收敛：清除 `dsh-plugins` 聚合残留与本地 `@deepseek-ai/cordis`，deps 仅留真身；验证 peer cordis 由发行内嵌 resolve（P-046）
- [x] 只走官方 pnpm：取指栈改为「corepack 精确缓存 → 官方裸命令 `pnpm`（PATH）→ desktop 捆绑仅末位」，纯官方环境完整可运行、desktop 仅适配（P-047）
- [x] file: 安装 ASCII 前置校验：目标含非 ASCII 目录时明确中文提示拦截，替代 pnpm 晦涩截断错误；ASCII/registry 照常放行（P-048）
- [x] 重载界面：一键重载 CLIENT 层，让热加载插件 client 卡片显现（无需整壳重启）
- [x] 卸载完整清除：移除磁盘包（含孤儿目录强删）+ 依赖闭包 + 装配登记 + 自持数据

### 未来规划

- [ ] 「扫描候选但未装配」条目的视觉区分徽标（避免与已安装混淆）
- [ ] 面板级可视化配置页（分类默认、卡片密度等）
- [ ] 「临时加载 → client 预览」的自动重载联动
- [ ] 内核更新的一键应用能力（当前仅提示不自动更新）

---

## 相关文档

- 插件通用介绍 / 根 README：[../README.md](../README.md)
- 依赖闭包 / API 契约 / 精确官方版本 / 验证状态：[MANIFEST.md](./MANIFEST.md)
- 本版变更明细：[CHANGELOG.md](./CHANGELOG.md)
- 踩坑与端到端验证记录：[docs/debug-log.md](./docs/debug-log.md)

---

## 许可证

BSD-3-Clause。