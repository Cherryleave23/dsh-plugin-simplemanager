# 插件管家 · 操作 × 文件状态 × 卡牌状态 矩阵

> 目的：把「我们做了一次操作之后，相关的配置/装配/物理文件应当处于什么状态」以及「前端卡片应当显示成什么状态」统一梳理成一张可对照的表。
> 每次改动了操作逻辑（安装/卸载/启停/转正/热装/文件夹/备注/排序），都应回到这里对照：操作是否在正确的落点留下了正确的文件状态、卡牌判定是否与文件状态自洽。
> 本文档是**现行代码的事实快照**；改动实现后先同步此处口径，再动代码。

---

## 0. 相关落点清单（操作写到哪、卡牌从哪读）

一张操作会影响 **四类落点**，卡牌判定就是“把这四类读回来算出来”的结果。

### 0.1 配置文件 / 装配文件（persistent，落磁盘）

| 落点文件 | 路径 | 谁的 | 内容 | 写入入口 | 读取入口 |
|---|---|---|---|---|---|
| 全局层补丁 | `{profileDir}/cordis.patch.yml` | 桌面壳 / `dsh plugin` 官方 | `- insert:` 块的 `- id:` 条目集合 = patch 启停面 | `SimpleManagerHost.setPatchEnabled(id,name,enable)` | `readPatchEnabledIds()` |
| profile 装配清单 | `{profileDir}/package.json` 的 `dsh.profile.bundles[]` | `dsh plugin add` 官方 | 已装配 bundle 包名集合 | `SimpleManagerHost.removeBundle(name)`（目前只删） | `readBundles()` |
| bundle 层装配清单 | `{profileDir}/cordis.yml` | `dsh plugin add` 官方 | 顶层 `- id/name:` 条目集合 = bundle 装配面 | `SimpleManagerHost.removeBundleEntry(name)`（目前只删） | `isBundleAssembled(name)` 直读 |
| 分类/备注/别名/闭包/排序/热装登记 | `~/.dsh/simplemanager/data.json`（overlay） | 插件管家自持 | folders/assignments/notes/aliases/closureDeps/folderOrder/pluginOrder/hotInstalls | `SimpleManagerHost.writeOverlay` 及其子方法 | `readOverlay()` |
| 作用域覆盖配置 | `~/.dsh/simplemanager/config.json` | 插件管家自持 | `scopeOverrides`（包名 → official/shell/third） | `setScopeOverride` | `readConfig()` |
| 插件自持数据目录 | `~/.dsh/<包名|去dsh-短名|去@scope短名>` | 插件本身 | 插件的网关配置/缓存等 | 插件自己写 | `clearData` 卸载时按候选名删除 |

### 0.2 物理包（profile node_modules）

| 落点 | 路径 | 说明 |
|---|---|---|
| 插件物理包 | `{profileDir}/node_modules/<name>` | pnpm 链接/真拷贝；`pushProfileBundle` 只把声明了 `meta.dsh.bundle.patch` 的包视为可管理第三方 |
| 闭包依赖 | 同 node_modules 下的依赖 | `pnpm add` / `pnpm remove` 维护 |

### 0.3 运行时装配态（内存，不落盘）

| 落点 | 谁维护 | 含义 |
|---|---|---|
| loader/pluginInventory 装配表 | dsh 内核 | 已组建 entry 的 moduleName、enabled、fiberPhase、entryId |
| `tempInfos`（Map） | 插件管家内存 | 临时加载闭包：entryId / spec / installedDeps |
| `promotedPending`（Set） | 插件管家内存 | 已转正待重启 |
| `recentlyUninstalled`（Set） | 插件管家内存 | 本会话已卸载、待重启收敛 |

### 0.4 运行时状态词（fiber phase，卡牌「运行中/待加载/…」来源）

```ts
FIBER_PHASE = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading']
// loaderLiveMap()：phase = 上述之一；无活跃 fiber / 仅停用 → null
```

---

## 1. 操作 → 文件/装配/物理 状态变化（矩阵主体）

> 约定缩写：**patch** = cordis.patch.yml，**bundles** = package.json 的 `dsh.profile.bundles`，**cordis.yml** = bundle 层装配清单，**overlay** = `~/.dsh/simplemanager/data.json`，**self-data** = `~/.dsh/<插件数据目录>`，**nm** = profile `node_modules`。

| 操作 | patch | bundles | cordis.yml | overlay | self-data | nm 物理包 | 运行时装配表 | 管家内存 |
|---|---|---|---|---|---|---|---|---|
| **临时加载 tempLoad** | 不变 | 不变 | 不变 | `hotInstalls += 包名` | 不变 | **加入**插件包+闭包（`pnpm add`，skip 官方 peer） | `loader.create` 热装配（active） | `tempInfos += {entryId,spec,installedDeps}`；清 `recentlyUninstalled` |
| **临时卸载 tempRemove** | 不变 | 不变 | 不变 | `hotInstalls -= 包名` | 不变 | **移除**主包+独占闭包（按引用保护保留） | `update({disabled:true})` 解绑服务 → `loader.remove` | `tempInfos -=` |
| **转正 promote** | **加入**该包 `- insert:` 块 | 不变 | 不变 | `closureDeps[包]=本次补装闭包`；`hotInstalls -=` | 不变 | **确保**插件包+闭包（`pnpm add`） | 不变（原临时 entry 运行至退出） | `tempInfos -=`、`promotedPending +=` |
| **启用 toggle(off→on)**·patch 面 | **加入**该包 | 不变 | 不变 | 不变 | 不变 | 不变 | `update({disabled:false})` 或 `loader.create` 热装配 | 不变 |
| **停用 toggle(on→off)**·patch 面 | **移除**该包 | 不变 | 不变 | 不变 | 不变 | 不变 | `update({disabled:true})`（entry 留树，fiber 空） | 不变 |
| **启用 toggle**·bundle 面（isBundleAssembled） | 不变（若历史误写则清掉旧条目） | 不变 | 不变 | 不变 | 不变 | 不变 | `update({disabled:false})` / `create` | 不变 |
| **停用 toggle**·bundle 面 | 不变 | 不变 | 不变 | 不变 | 不变 | 不变 | `update({disabled:true})` | 不变 |
| **启用 toggle**·临时面（tempInfos 命中） | 不变（不写 patch，仅运行时） | 不变 | 不变 | 不变 | 不变 | 不变 | `update({disabled:false})` | 不变 |
| **停用 toggle**·临时面 | 不变 | 不变 | 不变 | 不变 | 不变 | 不变 | `update({disabled:true})` | 不变 |
| **真卸载 uninstall**（不勾清数据） | **移除**该包 | **移除**该包 | **移除**该包 entry | 删 notes/aliases/assignments；`closureDeps[包]=[]`；`hotInstalls -=` | **保留** | **移除**主包+独占闭包（强删孤儿目录） | `loader.remove`（若存活） | `tempInfos -=`、`promotedPending -=`、`recentlyUninstalled +=` |
| **真卸载 uninstall**（勾选清数据） | **移除**该包 | **移除**该包 | **移除**该包 entry | 同上 | **删除** 3 个候选自持目录 | 同上 | 同上 | 同上 |
| **文件夹 create/rename/delete/move** | 不变 | 不变 | 不变 | `folders`/`assignments`/`folderOrder`/`pluginOrder` 变更（删文件夹→其内插件回落第三方） | 不变 | 不变 | 不变 | 不变 |
| **排序 reorder/移动落位** | 不变 | 不变 | 不变 | `pluginOrder[folder]` 变更 | 不变 | 不变 | 不变 | 不变 |
| **备注 note** | 不变 | 不变 | 不变 | `notes[包]` 增删 | 不变 | 不变 | 不变 | 不变 |
| **别名(重命名)** | 不变 | 不变 | 不变 | `aliases[包]` 变更 | 不变 | 不变 | 不变 | 不变 |
| **app 启动守护** | —（读） | —（读） | —（读） | 读 `hotInstalls` | 不变 | 回收「登记热装、不在装配/材料中的残留包」 | — | `forgetHotInstall` 已回收项 |

### 关键分支判定（toggle 时落哪个持久面）

`patchWritable = !bundleMerged && !tempInfos.has(id)`；其中来源轴判定与 buildView 同口径：`sourceOf`（scope → 会话热装 → 持久层 → 孤儿），**孤儿直接 fail 拒绝启停**；`bundleMerged = sourceOf==='persistent' && isBundleAssembled(id)`。
- **bundle 面**：`isBundleAssembled`（bundles ∪ cordis.yml）命中 → **永不写 patch**，重启由该层恢复；仅当历史误写 patch 时清掉旧条目。
- **临时面**：`tempInfos.has(id)` → **不写 patch**，toggle 仅运行时。
- **其余（promote 转正 / 持久安装的第三方）** → patch 即面板持久装配面，启/停都写 patch。

---

## 2. 卡牌状态判定：从「文件/装配/内存态」算出「卡片显示态」（三轴模型）

前端卡片 = 后端 `buildView()` 产物。状态判定收敛为**三根正交轴**：**来源轴 source**（会否跨重启 + 官方性）、**运行态轴 runtime**（此刻跑没跑）、**出现性**（在不在列表）。**唯一标准 = 真实装配数据**：数据变，徽标才变；启停（toggle）只改运行态轴，不碰来源轴与出现性。

### 2.1 来源轴 source（唯一状态轴；判断顺序 scope → 会话热装 → 持久层 → 物理残留）

| `source` | 判定（优先级依次） | 含义 / 隔离 |
|---|---|---|
| `official` | `b.scope==='official'` | 官方内核包，不可启停、不可卸载 |
| `shell` | `b.scope==='shell'` | 桌面壳/客户端运行时，归第三方文件夹但不可停用 |
| `temporary` | `tempInfos.has(name)` | 本会话热装，重启即消失；出「转正 + ✕」 |
| `persistent` | `patchEnabled.has(name) \|\| isBundleAssembled(name)` | patch ∪ bundle 命中，跨重启存活；可启停、可真卸载 |
| `orphan` | 物理在但以上皆非（残留） | **隔离**：禁用启停（防热的孤儿被一键启停"复活"成持久安装，toggle 直接 fail），只给「清理/重装」 |

### 2.2 运行态轴 runtime（标准 = loader entry.enabled + fiber.phase）

由来源轴 + live 联合算出：
- `source==='orphan'` → `none`（未装配）；
- 无 live：`enabled ? none : disabled`；
- 有 live 且 `!enabled` → `disabled`；
- 有 live 且 enabled → `phase ?? loading`。

| `runtime` | 文案 | 颜色 |
|---|---|---|
| `active` | 运行中 | 成功绿 |
| `disabled` | 已停用 | 中性 |
| `failed` | 失败 | 危险红 |
| `pending` | 待加载 | 警告黄 |
| `loading` | 加载中 | 中性 |
| `disposed` / `unloading` | 已卸载 / 卸载中 | 中性 |
| `none` | 未装配 | 最弱中性 |

### 2.3 单张卡片（当前结构）

| 字段 | 来源算式 |
|---|---|
| `scope` | `b.scope`（resolveScope） |
| `source` | 见 2.1 |
| `enabled` | 非 third：`live===undefined ? true : live.enabled`；third：`live===undefined ? persistent : live.enabled` |
| `runtime` | 见 2.2 |
| `toggleable` | `scope==='third' && source!=='orphan'`（状态框可点击启停） |
| `removable` | `scope==='third' && (persistent\|\|orphan)`（按钮文案：持久→「卸载」、孤儿→「清理」） |
| `promoteable` | `source==='temporary'`（「转正」） |
| `tempRemoveable` | `source==='temporary'`（「✕」） |
| `pendingRestart` | `promotedPending.has(name)`（「转正·待重启」注记） |
| `folder` / `note` / `alias` / `dependencies` | 同旧（overlay / b.dependencies） |

> **出现性（一票否决）**：`buildCatalog` ∪ 临时补录 − `recentlyUninstalled.has(name)` 过滤 → 卸载完立即从列表消失（P-040；热装恢复显式清该标记）。**已剔除「已卸载/残留」徽标与 `residual` 字段**——P-039（标记残留）与 P-040（过滤消失）并存时，过滤先执行把卡剔走，`residual` 恒为 `false` 成死代码，故收敛为纯过滤方案。

### 2.4 状态框渲染（前端统一框，替代旧多徽标 + 开关）

```
[scope徽标]  [● 运行态 · 来源尾巴]  [转正·待重启?]  [转正/✕?]  [卸载|清理?]
```

- **状态框即启停开关**：`toggleable` 时点状态框切换启停，仅运行态轴变（运行中 ↔ 已停用），来源轴与出现性不动；孤儿红描边隔离、不可点。
- 已移除旧 `hot`（临时/待重启独立徽标）、`residual`（已卸载徽标）、`state`（独立徽标）与 on/off 开关——统合进状态框的「运行态文案 + 来源尾巴 + 因由注记」。

---

## 3. 自洽性校验（拿现状反查）

这几条是本实现**预期应成立**、且曾被踩过的坑，改动后应回归：

1. **临时加载 → 立即临时态**：`tempInfos` 命中即 `source='temporary'`，不依赖 node_modules 是否有包；转正后 `pendingRestart=true`（来源轴仍临时直至重启，patch 已写、重启后判为 persistent）。
2. **卸载 → 卡片立即消失而非残留**：`recentlyUninstalled` 在 buildView 一票过滤；热装恢复显式清该标记。已删除旧的「已卸载/残留」徽标与 `residual` 字段（P-039/P-040 并存收敛为纯过滤方案）。
3. **无运行态时，持久层决定 enabled**：third 回落 `persistent`（patch ∪ bundle）；toggle 停用后 patch 已清但 loader 仍显示 enabled（update 失败）时，以运行时为准、落盘已生效，走重启生效。
4. **bundle 面不碰 patch**：写了 patch 会与 cordis.yml 重复装配 → duplicate loader entry id（已知坑，P-003/P-040）。
5. **强制官方依赖不可回收**：真卸载/临时卸载依赖闭包回收处，`isOfficialSystemDep` 一律跳过（P-042 兜底），护住基础功能。
6. **卸载即从列表消失** 与 **重启后收敛** 两态并存：前者靠 buildView 过滤，后者靠装配文件已清（patch/bundles/cordis.yml/overlay）；两者缺一就会出现「关了又回来」或「一直残留」。

---

## 4. 已知脆弱面（改动需谨慎）

- 直写 `cordis.patch.yml` / `cordis.yml` / `package.json bundles` 属「装配层内部文件直写」（见 MANIFEST「不许碰清单」注释），格式非公共契约，升级内核时先对照消费面 diff。
- `buildView` 的「residual 过滤 → 卡片消失」与「loader 未即时拆除时列表仍显示」是互相拉扯的两条线，最终以**重启**为收敛判定。
- 官方插件判定有三套口径（`scopeOf/resolveScope`、`isOfficialSystemDep`、`detectOfficialPeerDeps`），职责不同：
  - `scopeOf`：卡牌 scope 分类（UI）；
  - `isOfficialSystemDep`：依赖回收红线（卸载时绝不碰）；
  - `detectOfficialPeerDeps`：热装时提示桌面壳 overlay 解析限制。
  改动任一判定，需确认不会牵连另两套的语义。