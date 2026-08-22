# DSH 运行时状态与插件生命周期机制调研

> 面向对象：插件管家（`dsh-plugin-simplemanager`）的下一阶段升级。
> 调研基线：官方内核 `deepseek-harness-v0.1.1-rc.2`（源码随仓库分发）。
> 结论性质：全部机制事实均从 v0.1.1-rc.2 官方源码机械取证，逐条标注源码路径与行号可复核。
> 目的：通过彻底理解 DSH 的运行时状态、插件嵌入管理、启停与热加载，为插件管家从「配置态整理」升级为「运行时治理」提供技术依据。

---

## 0. 摘要

- DSH 一切皆插件（Cordis），无特权内核；插件并列挂载于唯一的 `loader` 服务管理的一棵 entry 树。
- **loader 是插件嵌入管理的唯一事实来源**：`EntryTree`（树）+ `Entry`（节点）+ `EntryGroup`（分组），提供 `entries / resolve / create / remove / update / import` 完整读写管理面；持久化由子类实现 `write()`。
- 启停归根结底是对单个 `Entry` 的 `update(options)`：不同增量决定不同动作——改 `config` 可**原地热更新**，改 `disabled` 走 dispose/init，改 `name/inject/group` 走 dispose+restart。
- 热加载真实存在，但**是 Facebook/HMR 引擎级**的（模块置换 + fiber 重载），不等于「改 patch 即热生效」；插件管家当前把「热生效」寄托在 `loader.reload()` 上，需谨慎框定边界。
- 官方已提供**只读**可观测服务 `pluginInventory.list()`（快照式，无事件订阅），与 loader 的**完整读写面**之间有一个断裂：**读的是静止快照，写要靠 host 侧注入 loader**。这恰是插件管家的升级缝隙。

---

## 1. 运行时状态模型：Cordis 的 Fiber

### 1.1 Fiber 状态机

Cordis 用 Fiber 表示一个运行中的插件/服务的生命周期实例。`PluginInventoryGateway`（v0.1.1-rc.2 源码 `packages/host/plugin-inventory/src/index.ts:23-40`）完整映射了 Fiber 六个状态：

| FiberState | PluginFiberPhase | 含义 |
|---|---|---|
| `PENDING` | `pending` | 已登记，尚未开始加载 |
| `LOADING` | `loading` | 正在 import / 应用 |
| `ACTIVE` | `active` | 已启动并运行 |
| `FAILED` | `failed` | 启动失败（`entry.fiber` 存在） |
| `UNLOADING` | `unloading` | 正在卸载 |
| `DISPOSED` | `null` | 已销毁（此时不存在活跃 fiber） |

关键点：
- 状态是**读侧**信息，由 Cordis 内部的 `plugin/status` 事件与 `Entry.fiber.state` 维护。
- `pluginInventory.list()` **每次调用直读 loader**（`src/index.ts:54` 注释明言不做第二层缓存），因此拿到的是实时条目，但**仅限非 group 条目**（`entry.options.group` 被跳过，`src/index.ts:60`）。

---

## 2. 插件如何嵌入管理：Loader 的三层模型

### 2.1 包结构 `vendor/loader`

`vendor/loader/src/` 下按职责拆分：

| 文件 | 职责 |
|---|---|
| `index.ts` | `Loader` 服务类 + Cordis 事件接线 |
| `config/tree.ts` | `EntryTree`：插件树的读改写抽象，`write()` 留给子类持久化 |
| `config/entry.ts` | `Entry`：单个插件节点，生命周期与热更新核心 |
| `config/group.ts` | `EntryGroup`：分组节点 |
| `config/isolate.ts` | 服务隔离辅助 |
| `internal.ts` | Node 内部模块加载兼容 |

### 2.2 `EntryOptions`：节点的序列化形态（`config/entry.ts:9-22`）

每个插件节点在装配文件里就是一条 `EntryOptions`：

```ts
interface EntryOptions {
  id: string        // 树内稳定 id
  name: string      // 交由 entry tree import 的模块 specifier
  config?: any      // 插件配置
  group?: boolean   // 是否嵌套分组
  disabled?: boolean// 阻止本条目及其后代运行（可用 !!js 表达式）
  inject?: Inject   // 本条目所需 service 依赖
}
```

- `disabled` 支持 `!!js` 表达式，会**对 loader 上下文求值**（`entry.ts:104-108` `disabledOf`），并沿父链向上传播：任一父条目 disabled 则整棵子树禁用（`entry.ts:88-98`）。
- `group` 永远视为启用（`entry.ts:90`）。

### 2.3 树的读改写管理面（`config/tree.ts`）

`EntryTree` 提供插件管理所需的全部操作：

| 方法 | 作用 | 源码行 |
|---|---|---|
| `entries()` | 遍历树内所有条目（含嵌套子树） | `tree.ts:27-33` |
| `resolve(id)` | 按 id 解析条目（支持 `主:子` 命名空间） | `tree.ts:76-87` |
| `resolveGroup(id)` | 解析分组 | `tree.ts:89-94` |
| `create(options, parent, position)` | 动态新增条目 → 落盘 | `tree.ts:97-104` |
| `remove(id)` | 停止并移除条目 → 落盘 | `tree.ts:107-111` |
| `update(id, options, parent?, position?)` | 更新/移动条目 → 落盘 | `tree.ts:114-142` |
| `import(name)` | 从 specifier 或 `cordis:` 内置导入插件 | `tree.ts:145-162` |
| `write()` | **持久化抽象**，子类实现 | `tree.ts:165` |

- 持久化是通过子类实现 `write()` 完成的。`Loader` 自身的 `write()` 是 no-op（`index.ts:162-164`），**根 loader 树在内存中**；真正落盘的 writer 由装载配置文件的子类提供（profile 装载端）。
- `update()` 里做了移动回滚：若移动后 `entry.update` 失败，会把条目 unlink 回原分组并重试（`tree.ts:123-139`）。

### 2.4 `Entry` 生命周期与差异化热更新（`config/entry.ts:142-246`）

`Entry.update(options)` 是整个启停/热加载机制的**中枢**。它对增量按「是否触及重启面」做了精确分流：

```
update(options, create?, force?)
  ├─ 计算 diff（deepEqual 逐字段）
  ├─ diff 为空且非 force → 直接 return（无动作）
  ├─ 无现有 fiber（未启动）→ 直接 init / 不启动
  ├─ disabled 生效（新态下被禁用）→ dispose 现有 fiber，保留条目
  ├─ 只改 config（replace=false）
  │     → _patchContext(diff)：Context 换原型 + fiber.update(config) 原地热更新  ← 真正的热加载
  └─ 改 name / inject / group（replace=true）
        → import 新插件 → dispose 旧 fiber → 启动新 fiber
        → 失败则回滚重启旧插件
```

关键结论：
1. **改 `config` 是原地热更新**（`_patchContext` 里 `this.fiber.update(this.options.config, true)`，`entry.ts:118-120`），无需重建 fiber —— 这是 Cordis 热加载的第一类。
2. **改 `name / inject / group` 走 dispose + restart**，且带完整回滚（`entry.ts:214-245`）。
3. **`disabled` 从 false→true** 走 `_dispose`（`entry.ts:181-192`），fiber 被销毁但 `options` 保留在树上 —— 这正是「停用 = 保留条目但禁运行」的语义，与插件管家「写入 patch 的 insert 清单」互为硬币两面。

Cordis 自身对 `internal/update`（`index.ts:103-115`）有一个全局前置钩子：插件在运行中 `ctx.config` 变更会**回写** `entry.options.config` 并调用 `entry.parent.tree.write()` 落盘。

### 2.5 事件面（`index.ts:35-59` 的 `declare module Events`）

| 事件 | 触发时机 | 对插件管家的意义 |
|---|---|---|
| `loader/config-update` | 配置文件更新 | 可做变更通知 |
| `loader/entry-init` | 条目创建 | 观测新增插件 |
| `loader/partial-dispose` | 条目被部分卸载/更新 | 观测插件被改动 |
| `loader/patch-context` | 上下文补丁 | 内部机制 |

这些事件**未在 `pluginInventory` 上做对外订阅面**——官方只给了 list 快照，没给增量推送。插件管家做「实时状态」要么轮询 `pluginInventory.list()`，要么自行订阅 loader 事件（后者需要 host 侧注入，见 §4）。

---

## 3. 可观测性：官方已给「只读快照」

### 3.1 `PluginInventoryGateway`（`packages/host/plugin-inventory/src/index.ts`）

- 是一个 **TypertRemoteService**，注册名 `pluginInventory`（`src/index.ts:47`），`inject: ['loader']`（`src/index.ts:44`）。
- 唯一远程方法 `@Remote('list')`：返回 `{ entries: { entryId, moduleName, enabled, fiberPhase }[] }`（`src/index.ts:56-69`）。
- **enabled 与 fiberPhase 同源**：`enabled = !entry.disabled`，`fiberPhase` 由 `entry.fiber.state` 映射（`src/index.ts:64-65`）。

### 3.2 与插件管家现有实现的关系

插件管家 `host.ts` 目前**不用** `pluginInventory`，而是直接 `ctx.get('loader').entries()` 读 `moduleName -> !disabled`（`plugin/src/index.ts:268-281`）。两者信息基本一致，但 `pluginInventory.list()` 额外暴露了 **fiberPhase（active/failed/pending）**，这正是「插件到底活没活、挂没挂」的判据——插件管家当前只看到 enabled/disabled，**看不到 failed 状态**。

---

## 4. 启停与热加载的边界：宿主侧注入 vs 客户端桥

### 4.1 插件管家当前的启停实现（`plugin/src/index.ts`）

- **写面**：`SimpleManagerHost.setPatchEnabled()`（`host.ts:252-260`）对 `cordis.patch.yml` 做**行级文本编辑**，插入/移除 `- insert:` 下的 `- id:` 条目块（`editPatch`，`host.ts:416-458`），写前备份 + 原子写。
- **读面**：`readPatchEnabledIds()`（`host.ts:237-246`）用正则解析 `- id:` 行，得到「已纳入启用清单」的 id 集合。
- **融合**：`enabledFor()`（`index.ts:283-290`）合并两个维度——第三方插件 `enabled = loader 实时态 ?: patchEnabled`。
- **热生效**：`hotApplyLoader()`（`index.ts:296-307`）尝试 `ctx.get('loader').reload()`，为尽力而为；loader 无 reload 配合面时返回 `hotApplied=false`，UI 提示「将在重启后生效」。

### 4.2 关键缺口

从源码看，`Loader` 类本身**没有公开 `reload()`**（`vendor/loader/src/index.ts` 全类无此方法）——`reload` 是装载配置文件子树（profile 端）才可能有的能力。这意味着插件管家当前的 `hotApplyLoader` 大概率长期返回 `false`，**「热生效」实际并不成立，只能靠重启**。这是插件管家第一个要正视的机制现实。

### 4.3 更可靠的启停路径（给升级的建议）

- **路径 A（读侧治理）**：统一改用 `pluginInventory.list()` 消费 fiberPhase + enabled，把「活没活、挂没挂」做进面板。
- **路径 B（写侧治理）**：若要「改配置即热更新」，应对单个 `Entry` 做 `update({ config })`（走 §2.4 的原地热更新分支），而不是整树 `reload`。这需要在 host 侧注入 `loader`，暴露一条受控的 bridge 给客户端面板 —— 与官方 `plugin-inventory` 自己 `inject: ['loader']` 的做法同构、合规。
- **路径 C（安全前提）**：停用/更新前，基于 tree 内 `inject` 关系计算「谁依赖谁」，做连带失效提示与快照回滚（见 §5）。

---

## 5. 对插件管家升级的落点（承接上一轮「运行时治理层」建议）

| 档 | 依赖的官方面 | 是否触碰写面 | 风险 |
|---|---|---|---|
| 状态实时可视（active/failed/pending + 报错） | `pluginInventory.list()` | 否，纯读 | 极低 |
| 依赖连锁提示（停用 A 会连带 B/C） | loader tree 的 `inject` 关系遍历 | 否，只读计算 | 低 |
| 变更安全与快照回滚（状态+配置+备注整体快照） | loader `update/create/remove` + 自持 overlay | 是，受控写 | 中（需 bridge + 回滚） |

三档共同遵守一条铁律：**全部走官方公开面（`pluginInventory` 只读 + `loader` 读写），不读 DSH 内部状态文件、不依赖私有 API**，符合 dsh-plugin-dev-theory 六判据的「组合优先 / 兼容优先 / 宿主不可知」。

---

## 6. 附：本次源码取证索引

> 均为 `deepseek-harness-v0.1.1-rc.2`，行号以调研当时为准。

| 事实 | 坐标 |
|---|---|
| Fiber 状态枚举与 phase 映射 | `packages/host/plugin-inventory/src/index.ts:23-40` |
| `pluginInventory.list()` 直读 loader、跳过 group | `packages/host/plugin-inventory/src/index.ts:54-69` |
| `EntryOptions` 字段定义 | `vendor/loader/src/config/entry.ts:9-22` |
| `disabled` 的 `!!js` 求值与父链传播 | `vendor/loader/src/config/entry.ts:88-108` |
| `Entry.update` 差异化（config 热更 / replace 重启 / 回滚） | `vendor/loader/src/config/entry.ts:142-246` |
| `_patchContext` 原地 `fiber.update(config)` | `vendor/loader/src/config/entry.ts:114-122` |
| `EntryTree.create/remove/update/resolve/import/write` | `vendor/loader/src/config/tree.ts:27-165` |
| `Loader` 根树 in-memory、`write()` no-op | `vendor/loader/src/index.ts:162-164` |
| loader 事件面（config-update/entry-init/partial-dispose/patch-context） | `vendor/loader/src/index.ts:35-59` |
| `internal/update` 回写 config 并落盘 | `vendor/loader/src/index.ts:103-115` |
| `Loader` 无公开 `reload()`（当前热生效不成立的根因） | `vendor/loader/src/index.ts:60-200` 全类核对 |
| 插件管家当前启停（patch 文本编辑） | `dsh-c/plugin/src/host.ts:237-260,416-458` |
| 插件管家当前热生效（`loader.reload()` 尽力而为） | `dsh-c/plugin/src/index.ts:296-307` |