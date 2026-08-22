# dsh-plugin-simplemanager（插件管家）

> DSH 插件统一管理面板：内核版本看板 + 第三方插件全生命周期管控。
> 内置「官方内置 / 第三方插件」分类，支持自定义文件夹、拖拽移动、内联备注、
> 一键启停（写装配层补丁并实时热生效）、内核更新检测、运行时临时加载与真注入，
> 并提供「重载界面」一键让热加载插件的 client 卡片立即显现。
> 全部装卸走官方插件管理命令（`dsh plugin add/remove`），依赖闭包随装卸完整进退。

## 项目简介

**插件管家**（`dsh-plugin-simplemanager`）是 DSH 宿主内的一个核心服务插件，把「哪些第三方插件可用、当前是否在运行、属于哪个分类、有什么备注、内核有没有新版本」统一到一个管理面板。它的核心价值是：**在不触碰 DSH 内核的前提下，用一种可验证、可回滚、零残留的官方方式管理插件——既支持持久安装，也支持开发期的运行时热插拔**。

## 功能特性

- **运行时状态徽标**：实时读取所有插件运行状态并展示（运行中 / 加载中 / 待加载 / 失败 / 已卸载 / 卸载中）。
- **一键启停（热启停）**：快速启用 / 停用第三方插件，写入 profile 装配层补丁，并对运行 entry `update({ disabled })` 立即热生效（无需重启）；运行时定位不到则落盘、重启装配生效。
- **插件分类管理**：内置「官方内置」「第三方插件」两个分类，另可创建自定义文件夹；拖拽移动、内联备注。
- **内核版本看板**：展示当前 DSH 内核版本，检测 npm 最新版本；有更新时**仅提示，不自动更新**。
- **运行时临时加载（热插拔）**：不落盘地临时加载一个插件，仅当前进程生效，重启即消失、零磁盘残留。
- **重载界面（CLIENT 层重载）**：一键刷新渲染进程、重新执行 boot 注入，让热加载插件的 client 卡片立即出现在界面，**不重启内核**。
- **普适化依赖获取**：临时加载前先跑 `pnpm add`，把任意插件的依赖闭包装进共享 node_modules（不假设插件自带依赖）。
- **真注入（转正）**：临时插件测试通过后一键持久化装配——安装依赖闭包 + 写入装配清单，重启后持久生效。
- **官方插件只读**：官方内置插件默认仅展示为「已启用」，不提供停用入口，避免误操作破坏内核。

## 安装指南

### 前置依赖

- DSH 宿主（`dsh` CLI）及目标 profile；内核版本 `>=4.0.0-rc`，建议 `0.1.1-rc.2`。
- `node`（≥20）与 `pnpm`（≥9）——临时加载的依赖获取依赖 `pnpm`；`Electron` 桌面壳下会自动定位系统真实 `node.exe`。

### 前置前置说明

本插件为**开发者自研的 DSH 插件包**，当前发布为本地 bundle，通过官方插件管理命令以 `file:` 协议安装。

### 安装

```sh
# 在插件包所在目录（含 package.json 的 dsh-c/）执行：
dsh plugin add ./dsh-c
# 指定 profile：
dsh plugin --profile <name> add "file:/path/to/dsh-c"
```

安装后首次进入 **设置 → 插件 → 插件管家** 即可开始使用。

## 使用说明

面板访问：`设置 → 插件 → 插件管家`。

| 我想… | 操作 |
| --- | --- |
| 查看内核版本 / 是否有更新 | 打开插件管家，看「内核」区域（仅展示最新版本与更新提示） |
| 把插件归到自己的分类 | 先「新建文件夹」，再把插件**拖拽**到该文件夹 |
| 记下某个插件的用途 | 在插件卡片上**添加备注**（内联编辑） |
| 停用一个第三方插件 | 点击插件卡片上的**开关**，立即热生效，无需重启 |
| 看某个插件的运行状态 | 看插件卡片右上角的**状态徽标**（运行中 / 失败 / 待加载…） |
| 临时试用一个插件（不落盘） | 点「+ 运行时临时加载插件」，输入包名或本地路径后加载；关进程即彻底移除 |
| 让热加载插件的 client 卡片立即显示 | 点「**↻ 重载界面**」，仅刷新渲染进程，不重启内核 |
| 把临时插件正式装上（转正） | 临时插件卡片上点 **转正**，安装依赖并写入装配清单，重启后持久生效 |
| 移除一个临时插件 | 临时插件卡片上点 **✕**，仅当前进程移除，不影响磁盘 |
| 看官方内置插件 | 「官方内置」分类下只读浏览，开关不可用 |

### API

插件通过 webServer 在 `prefix /simplemanager` 暴露数据与操作接口供面板调用，主要端点：

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/simplemanager/kernel` | GET | 当前内核版本 |
| `/simplemanager/browse` | GET | 全量状态（内核 + 文件夹 + 插件状态 + 依赖 + 备注） |
| `/simplemanager/toggle` | POST | 启停第三方插件（热 + 持久两层协同） |
| `/simplemanager/tempLoad` | POST | 运行时临时加载（热注入，不落盘） |
| `/simplemanager/tempRemove` | POST | 临时卸载（仅限本面板临时创建的 entry） |
| `/simplemanager/promote` | POST | 真注入 / 转正（持久化装配） |
| `/simplemanager/folders` / `move` / `note` / `rename` | POST | 文件夹 / 移动 / 备注 / 显示名管理 |

用户名空间（临时加载请求体示例）：

```json
POST /simplemanager/tempLoad
{ "name": "D:\\path\\to\\my-plugin" }
```

响应：

```json
{ "ok": true, "depsApplied": true, "hotApplied": true, "packageName": "my-plugin" }
```

### 数据与自持存储

- 分类 / 备注保存于 `~/.dsh/simplemanager/data.json`（原子写 + 自动备份），卸载后按官方机制清理自持数据。
- 内核最新版本检测走 npm registry（`registry.npmjs.org`，失败降级 `registry.npmmirror.com`），带缓存。

## 配置选项

面板级设置暂未提供可视化配置页；行为均由固定默认驱动。**暂无用户可改配置项**。行为相关常量（如 pnpm 超时、registry 列表）通过环境变量可控，见开发者一节的说明。

## 开发与构建

### 源码目录简述

```
dsh-c/
├── src/
│   ├── index.ts    # Host 入口：webServer + loader 协同，装配 / 启停 / 热插拔 / 卸载
│   ├── host.ts     # 宿主数据层：patch 读写、目录扫描、状态枚举、自持数据
│   ├── client.tsx  # Client 面板：React UI + API 调用 + 启停 / 热加载 / 重载界面
│   ├── pnpm.ts     # 自包含 pnpm 运行器：依赖闭包装 / 卸、真实 node 定位
│   └── shims.d.ts  # 类型 shim
├── docs/
│   ├── debug-log.md                       # 踩坑与端到端验证记录（P-021~P-024）
│   └── DSH-runtime-and-plugin-lifecycle.md
├── cordis.patch.yml  # 装配清单（示例）
└── package.json      # 声明 dsh.bundle / dsh.client / exports
```

### 构建

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
- **临时加载**：根 `Loader.create()` 挂到根树；根 `Loader.write()` 为 no-op，既不写 patch 也不落盘，进程退出即随堆释放 → 零残留。
- **重载界面**：client 端 `window.location.reload()`，仅刷新渲染进程并重新执行 boot 注入，内核热装状态不受影响；用于让热加载插件的 client 卡片显现。
- **普适化依赖获取**：临时加载前在 profile 跑 `pnpm add <spec>`，依赖闭包装进共享 node_modules；`Electron` 下经 `pickNodeRunner()` 定位真实 `node.exe`。

## 版本兼容

| 版本目录 | 适配目标内核 | 说明 |
| --- | --- | --- |
| `dsh-v0.1.1-rc.2/` | v0.1.1-rc.2 | 当前版本（详见其 `MANIFEST.md`，change 见 `CHANGELOG.md`） |
| `dsh-v0.1.1-rc.1/` | v0.1.1-rc.1 | 上一版本（首个版本化目录） |
| `dsh-c/`（本目录，扁平活插件） | 随内核 | 开发期正源码，`dsh plugin add ./dsh-c` 直接使用 |

> 各版本契约与依赖官方包的精确版本见各 `dsh-v*`/`MANIFEST.md`；相邻版本差异见各 `CHANGELOG.md`。

## 贡献指南

欢迎提交 issue 与 PR。请遵循以下纪律：

- 改动**不得破坏基础功能**：不假设 / 不覆盖其他插件内部实现，优先复用官方 slot / service / patch。
- 装卸必须走官方渠道：不手拷产物、不私改装配层、不留下绕过官方装配的旁路。
- 每次改动走验证流水线：`typecheck → build → 同步 → 重启 → 日志 → 实测`，六步走完才算完成。
- 新功能需附带 MD 文档说明（用法与边界），并按项目印象将踩坑记入 `docs/debug-log.md`。
- 风格：`inject` 与真实消费严格对齐，禁止 `@ts-nocheck` / eval 类旁路，尽量不引入超出任务所需的抽象。

## 路线图（当前已实现 / 未来规划）

> 以下按「已实现」「未来规划」区分；规划项均*未完成*，仅表示演进方向。

**已实现**
- [x] 内核版本看板 + 更新检测（仅提示）
- [x] 第三方插件一键启停（写补丁 + 实时热生效）
- [x] 自定义文件夹 / 拖拽移动 / 内联备注
- [x] 运行时临时加载（热插拔）+ 普适化依赖闭包获取
- [x] 真注入（转正）
- [x] **重载界面**：一键重载 CLIENT 层，让热加载插件 client 卡片显现（无需整壳重启）
- [x] 卸载完整清除：移除磁盘包 + 依赖闭包 + 装配登记 + 自持数据

**未来规划**
- [ ] 「扫描候选但未装配」条目的视觉区分徽标（避免与已安装混淆，见 `docs/debug-log.md` P-023d）
- [ ] 面板级可视化配置页（分类默认、卡片密度等）
- [ ] 「临时加载 → client 预览」的自动重载联动
- [ ] 内核更新的一键应用能力（当前仅提示不自动更新）

## 许可证

BSD-3-Clause。