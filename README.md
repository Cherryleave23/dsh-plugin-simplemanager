# dsh-plugin-simplemanager（插件管家）

> DSH 插件统一管理面板：内核版本看板 + 第三方插件管控。
> 默认拆分「官方内置 / 第三方插件」，支持自定义文件夹分类、拖拽移动、内联备注、
> 一键启停（写入全局层补丁并实时热生效）、内核更新检测（仅提示，不自动更新）。

## 功能特性

- **内核版本看板**：展示当前 DSH 内核版本，并检测 npm 最新版本（有更新时仅提示，不会自动更新）。
- **插件分类管理**：内置「官方内置」「第三方插件」两个分类，另可创建自定义文件夹。
- **拖拽移动**：把插件拖到任意文件夹完成归类。
- **内联备注**：给每个插件添加备注，右键/卡片内联编辑，便于记录用途。
- **一键启停**：快速启用 / 停用第三方插件，写入全局补丁并实时热生效（详见「启停说明」）。
- **官方插件只读**：官方内置插件默认只展示为「已启用」，不提供停用入口，避免误操作破坏内核。

## 安装

以本地 bundle 方式 `file:` 协议安装（运行时依赖会被一并安装）：

```sh
dsh plugin add ./dsh-c
# 若指定 profile：dsh plugin --profile <name> add "file:./dsh-v0.1.1-rc.2/plugin"
```

安装后首次运行，进入 **设置 → 插件 → 插件管家** 即可开始使用。

## 使用指南

| 我想… | 操作 |
| --- | --- |
| 查看内核版本 / 是否有更新 | 打开「插件管家」，看「内核」区域（仅展示最新版本与更新提示） |
| 把插件归到自己的分类 | 先「新建文件夹」，再把插件**拖拽**到该文件夹 |
| 记下某个插件的用途 | 在插件卡片上**添加备注** |
| 停用一个第三方插件 | 点击插件卡片上的**开关**，立即生效（或提示重启后生效） |
| 看官方内置插件 | 「官方内置」分类下只读浏览，开关不可用 |

### 数据与自持存储

- 分类 / 备注保存于 `~/.dsh/simplemanager/data.json`（原子写 + 自动备份），卸载插件后按官方机制清理自持数据。
- 内核最新版本检测走 npm registry（`registry.npmjs.org`，失败降级 `registry.npmmirror.com`），带缓存。

## 启停说明

启停会**写入当前 profile 的全局补丁**（`cordis.patch.yml` 的 `insert:` 数组），写前自动备份、原子写入，
异常时保持原文件不变。**实时热生效为尽力而为**：优先调用 loader 的重载；若宿主持久层不配合，
会提示「将在重启后生效」，落盘后重启即生效。官方内置插件不提供停用入口。

## 版本兼容

| 版本目录 | 适配目标内核 | 说明 |
| --- | --- | --- |
| `dsh-v0.1.1-rc.2/` | v0.1.1-rc.2 | 当前版本（详见其 `MANIFEST.md`，change 见 `CHANGELOG.md`） |
| `dsh-v0.1.1-rc.1/` | v0.1.1-rc.1 | 上一版本（首个版本化目录） |
| `dsh-c/`（本目录，扁平活插件） | 随内核 | 开发期正源码，`dsh plugin add ./dsh-c` 直接使用 |

> 各版本契约与依赖官方包的精确版本见各 `dsh-v*`/`MANIFEST.md`；相邻版本差异见各 `CHANGELOG.md`。

## 开发者

- 结构：`src/index.ts`（Host 入口）→ `src/host.ts`（宿主数据层）→ `src/client.tsx`（Client 面板）。
- 构建：`pnpm install && pnpm build`（tsc 编译 host 到 `lib/` + tsdown 打包 client 到 `lib/client.js`）。
- 宿主 typecheck：`node typecheck-tmp/node_modules/typescript/bin/tsc --noEmit -p typecheck-tmp/tsconfig.json`。
- 配网 API：webServer prefix `/simplemanager`（`/kernel`、`/browse`、`/toggle`、`/folders`、`/move`、`/note`）。

## 许可

BSD-3-Clause。