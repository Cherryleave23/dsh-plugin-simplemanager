# DSH 插件管理机制分析与本插件实现对照

> 面向对象：维护本插件管家与调研官方插件链路的人。
> 素材来源：本插件 `src/index.ts / host.ts / pnpm.ts` 实现 + 官方源 `cordis-plugin-loader`、`cordis-plugin-include`、`packages/boot/app-boot`（deepseek-harness-v0.1.1-rc.2）。
> 每个问题固定回答六个维度：用了什么工具、做了什么、变动了什么、怎么生效、生效前后数据链路表现、是否为桌面壳做了特化或妥协。

## 0 装配模型背景：官方是怎么把插件"装配"起来的

要读下面七个问题，先看官方装配的三层结构（`app-boot` 的 profile 组装）：

1. **bundle 编译层** —— `profile package.json` 里的 `dsh.profile.bundles` 是一个有序包名清单；它进一步把包内的 `cordis.yml`（包根声明 `dsh.bundle.patch`）作为 bundle 层装配清单读入。这一层是"发行时编译/登记进去"的，运行期基本不可变。
2. **patch 层** —— 每个 profile 一个 `cordis.patch.yml`（官方常量 `PROFILE_PATCH_FILENAME`）。它是一份 `- insert:` 条目列表，`applyEntryPatches` 把每个 `insert` 的 `{ id, name, config }` **最后应用**到装配结果上。这是"用户/工具临时覆盖装配"的官方落点。
3. **overlay / `--patch` 层** —— 更上层的用户覆盖（可选）。

`cordis-plugin-loader` 的 `EntryTree` 是所有装配的运行时载体：`create / remove / update` 三个方法在推入/拆除 entry 后，**都会自动调用 `.tree.write()`** 把树状态持久化到它绑定的文件。所以从官方角度，"改装配 + 落盘"是同一个运行时接口，并不存在分离的"改文件"动作。这个事实是后面第 4、6、7 题的关键。

## 1 官方如何安装插件

- **工具**：官方命令 `dsh plugin add file:<包根>`。
- **做了什么**：分三路。
  1. 用 pnpm 把插件本体 + 依赖闭包装入当前 profile 的共享 `node_modules`；
  2. 把包名登记进 `profile package.json` 的 `dsh.profile.bundles`；
  3. 若该包声明了 `dsh.bundle.patch`，在 profile 的 `cordis.yml` 顶层序列登记一个装配 entry（块起点是 `- id:` / `- name:`）。
- **变动了什么**：`node_modules/` 出现该包（含闭包）；`package.json.bundles` 多一个包名；`cordis.yml` 顶层多一个 entry 块。
- **怎么生效**：重启后再走 loader 装配（bundle 层登记 → patch 层最后应用 → EntryTree 装配运行）。面板里 `buildCatalog` 经 `assembledModuleNames` 收拢它，`source=profile`，进入"可启停"档。
- **生效前后数据链路**：生效前列表里没有/该包不装配；生效后 `node_modules + bundles + cordis.yml` 三处齐全，列表出现且可启停。三处缺一（比如只装了包不登记）就会出现"物理在但没装配"的幽灵/残留态——这正是卸载要对称清理的原因。
- **是否为桌面壳特化**：否。`dsh plugin add` 在 CLI 与桌面壳一致，命令本身不感知载体。

## 2 官方如何卸载插件

- **工具**：官方命令 `dsh plugin remove <name>`。
- **做了什么**：与安装严格对称：移出 `dsh.profile.bundles`、移出 `cordis.yml` 该 entry、pnpm 移除包与闭包。
- **变动了什么**：三处登记回退 + `node_modules` 移除。
- **怎么生效**：重启后 loader 不再装配。若不重启，本进程里已装配的 entry 可能仍在运行，直到重启才消失。
- **生效前后数据链路**：卸载前可启停、可被装配；卸载后登记清空、物理包移除，重启列表消失。若登记没清干净，`cordis.yml` 残留 entry 会让 loader 重启时仍装配该已删包 → 报 `cannot resolve package` 或残留可启停条目（本插件 P-038/P-039 修复的就是这条链路）。
- **是否为桌面壳特化**：否，通用。

## 3 在桌面壳上的特殊情况

桌面壳（DSH Desktop）给环境强加了几条 CLI 没有的约束：

- **捆绑内核**：桌面壳发行内嵌固定版本内核，无法在运行时切换内核。插件里内核切换功能因此被移除（`resolveProfileDir` 注释标注 P-046）。CLI 端没这个限制。
- **官方业务包内嵌**：`@deepseek-ai/dsh-*`、`@deepseek-ai/cordis`、`schemastery` 等由桌面壳发行内嵌提供，**不进入 profile 的 node_modules**。因此插件在装/卸第三方时必须跳过这些官方包（`isOfficialSystemDep` 白名单），绝不能把它们当可回收闭包删掉，否则删崩基础功能（P-042/P-045 红线）。
- **动态热装对官方 peer 的二次解析受限**：桌面壳 overlay 对"动态热装一个依赖 `@deepseek-ai/dsh-*` 的包"有解析限制。插件 `tempLoad`/`promote` 用 `skipOfficialPeers` 跳过装官方业务 peer，让桌面壳 overlay 回落选发行内嵌来源（P-033）。
- **运行时 node_modules 位置**：桌面壳在 `resources/app.asar.unpacked/node_modules`；插件 `runtimeNodeModules()` 用 `process.resourcesPath` / `process.execPath` / `LOCALAPPDATA` 枚举候选路径去定位（无官方服务，路径猜测，已登入 MANIFEST「不许碰清单」）。
- **注入服务**：桌面壳注入 `desktopProfiles`、`desktopPnpm` 等服务。插件只条件读取 `desktopProfiles.current.dir` 定位 profile 根；`resolveProfileDir` 无该服务时回退 `process.cwd()`（这是对 CLI 端的一个妥协：profile 定位在 CLI 下不精确）。
- **profile 由 bundle 编译进发行**：`dsh.profile.bundles` 在桌面上是发行装配的一部分，因此插件的"disable 掉一个 bundle 编译来的官方/壳体插件"这类操作天然受限（改动会被发行盖回，本插件因此对官方/壳体插件禁卸、只允许第三方）。

**特化判定**：桌面壳的所有特化点都源于"捆绑内核 + 发行内嵌官方包 + 注入服务"。为了让插件**同一份代码在 CLI 和桌面壳都能用**，插件刻意不依赖 `desktopPnpm` 等注入服务，改为自包含（直接跑 pnpm + 直接读写官方格式文件）。代价是绕过了官方命令面（见 MANIFEST「不许碰清单」），换来的是宿主不可知——这些直写在 CLI 端同样成立。

## 4 官方对热插拔的支持 + 我们如何实现

- **官方支持**：官方没有提供"热插拔插件"的高层命令。它暴露的是运行时 loader 接口：`ctx.loader.create / remove / update`。这三个接口在已启动的 Cordis root 内装配/拆除 entry，并自动 `.tree.write()` 一并持久化。所以"官方热插拔"= 运行时改装配树。
- **我们如何热装（临时加载）**：`tempLoad` 五步。
  1. `pnpmAdd(profileDir, spec, { skipOfficialPeers: true })` 真实装包 + 拉齐依赖闭包（无论插件自带 node_modules 与否）；
  2. `specPackageName` 解析真实包名（路径/registry 均可）；
  3. `ctx.loader.create({ name: 包名, config: {}, disabled: false })` 在已启动 root 里装配并启动 entry —— 官方热装入口（C-05：name 必须可被 loader import 的 bare specifier，禁止本地 file 路径）；
  4. 读 fiber 态供面板观测；
  5. 登记 `tempInfos` + 持久化 `hotInstalls`（供跨重启清理物理残留）。
  **临时语义**：核心是**不写 patch** —— 重启即消失，成为真正"临时的热装"。
- **我们如何热卸（临时卸载）**：`tempRemove`：`ctx.loader.remove(entryId)` 拆除 entry + 按引用计数回收不再被其他活跃临时插件/持久装配引用的闭包依赖；`forgetHotInstall` 移除热装记录。
- **生效前后数据链路**：热装前该包未装配；热装后 node_modules 有包、`ctx.loader.create` 已装配并启动 → 立即可用；重启后因没写 patch，装配消失（但 `hotInstalls` 记录据此把物理包也回收，避免污染目录扫描，P-033）。
- **是否为桌面壳特化**：`ctx.loader.create/remove` 和 pnpm 两者都是通用手段（内核/CLI 都对）。`skipOfficialPeers` 是针对桌面壳 overlay 解析限制的特化开关；在 CLI 端跳过官方业务 peer 也没有副作用（官方包本就不该由第三方闭包携带）。

## 5 我们如何实现"转正"（临时 → 持久）

- **工具**：`promote` 内部流程。
- **做了什么**（`promote`）：
  1. 冲突检测：若 `readBundles().has(name)` 或 `readPatchEnabledIds().has(name)` → 已是持久安装，拒绝转正（避免覆盖已装文件/装配）；
  2. `pnpmAdd(profileDir, spec, { skipOfficialPeers: true })` 把插件物理装入共享 `node_modules` 并装齐闭包；
  3. `verifyInstalled` 校验装包结果，不过则回滚（插件 + 本次补装闭包全回收）；
  4. `host.setPatchEnabled(packageName, packageName, true)` —— **把插件写进 profile 层 patch（`- insert:` 加一条 `{ id, name, config:{} }`），这是持久化的全部**；
  5. `setClosureDeps(packageName, 本次补装闭包)` 记录闭包，供真卸载回收；
  6. `forgetHotInstall` 不再算待清理热装；`tempInfos.delete` + `promotedPending.add` → UI 标「已转正待重启」。
- **变动了什么**：`cordis.patch.yml` 的 `- insert:` 块多一条该插件条目；本次临时补装的闭包被记进 closureDeps。
- **怎么生效**：重启后由 patch 层"最后应用"装配为持久。**本进程内原临时 entry 仍运行至退出**（转正不重开，UI 以 promoted 档标记避免与持久安装混淆）。桌面壳若复核写回，转正成为持久登记。
- **生效前后数据链路**：转正前是"临时档"（重启即消失）；转正后写入了 patch insert → "持久档"（重启仍在）。冲突检测用 `bundles ∪ patchEnabled` 判定持久装配，这正是 P-041 修的核心：不能把"node_modules 里有该包"当成持久装配（否则热装的第三方会被误判为已装）。
- **是否为桌面壳特化**：转正只写 profile 层 patch（官方 profile patch 语义），不写 `bundles` / `cordis.yml` —— 因此对 CLI 端同样成立，非桌面壳特化。`skipOfficialPeers` 是前述特化开关。

## 6 我们如何完成卸载

- **工具**：`uninstall`，全程自包含。
- **前置防线**：官方内核插件（`scope === 'official'`）与桌面壳组件（`scope === 'shell'`）直接拒绝，只允许卸载 profile 层第三方插件——守基础功能红线。
- **做了什么**（分三段落盘）：
  0. **移除装配登记**：`ctx.loader.remove(entryId)`（若在运行则热卸）→ `setPatchEnabled(name, name, false)` 移除 patch 里该条 `- id`（与启用同源）→ `removeBundle` 从 `package.json.bundles` 移除 → `removeBundleEntry` 按块精确移除 `cordis.yml` 里该 entry。**三处登记一次清干净**，正是第 2 题官方卸载要对称做的三处；
  1. **物理移除 + 闭包按引用回收**：`pnpmRemove` 主包；`rmSync(..., force:true)` 强删孤儿物理目录（历史 `file:` 真拷贝、pnpm 不认的目录，P-043 兜底）；按引用回收补装闭包（仍被其他已装插件 / 活跃临时插件 / 其他 closureDeps 使用则保留；`isOfficialSystemDep` 绝对不回收）；
  2. **清理自持数据**：`delete notes/aliases/assignments` + `setClosureDeps([])`；`promotedPending.delete` + `recentlyUninstalled.add`（若 loader 未即时拆除 / 桌面壳复核写回导致列表仍显示该条目，`buildView` 把它正确标为「已卸载、不可启停」而非正常插件，P-039）。
- **怎么生效**：**不重启**。`ctx.loader.remove` 即时拆除运行 entry；patch / bundles / cordis.yml 三处登记清空后，重启也不会再装配。
- **生效前后数据链路**：卸载前"已装配、可启停"；卸载后登记清、物理删、运行 entry 已卸 → 列表消失。残留判定看 `recentlyUninstalled`：若桌面复核写回或 loader 未即时拆除而列表仍见该条目，标「已卸载、不可启停」而不是正常可启停插件。
- **是否为桌面壳特化**：三处登记清理都针对官方通用装配文件（patch / bundles / cordis.yml），通用。唯一特化点是强删孤儿物理目录（这是桌面壳走 `file:` 真拷贝安装路径才产生的孤儿，P-043）。

## 7 启停功能：是不是"停改 patch、启加回来就行"

结论先说（本版已修复）：**"bundle 层插件启会误写 patch → duplicate → 起失效"的根因已被对症修掉，启/停现在运行时对称生效且不再污染装配层。**

实测查证后的真实根因（此前"对称"结论只看对了 patch 层）：

- **停（disable，patch 层）**：`next=false` → `setPatchEnabled(id, id, false)`：`editPatch` 把 `- insert:` 里该 `- id: <id>` 条目（连同其子行）移除，若只剩空 `- insert:` 壳则收敛为合法空数组 `[]`；运行时再 `ctx.loader.update(entryId, { disabled: true })` 置 disabled。停用后的 entry **仍留在 loader 树**（disabled、fiber 置空），`pluginInventory.list()` 也照样列出它（`enabled: !entry.disabled`，`fiberPhase: null`）。
- **启（enable，patch 层）**：`next=true` → `setPatchEnabled(id, id, true)`：`editPatch` 加回 `{ id, name, config:{} }`；运行时 `ctx.loader.update(entryId, { disabled: false })` 重新启动 fiber（entry 还在树里，`update` 走"重新 init"分支）。
- **真正的坑（bundle 层）**：官方 `dsh plugin add` 装的插件装配在 `cordis.yml`/bundles 层、**从不在 patch**。旧 `toggle` 无条件 `setPatchEnabled(id, true)`——给 bundle 插件停完再启时**把它写进了 patch**，重启后 cordis.yml 和 patch 各装配一份 → **`duplicate loader entry id`**（用户实测 dsh-msg-link 报此错），插件加载失败 → 表现为"光有停没有起"。另外 patch 层插件停后 `patchEnabled` 集合已无它，若再拿 `patchEnabled.has(id)` 判"是否写 patch"会漏写 → 启只落运行时、重启又停。

本次修复（`src/index.ts` toggle + `src/host.ts` 新增 `isBundleAssembled`）：

- 新增 host `isBundleAssembled(id)`（读 profile `package.json` `dsh.profile.bundles` + `cordis.yml` 顶层序列项）区分装配层。
- **只对非 bundle、非会话临时的插件写 patch**（`patchWritable = !bundleMerged && !isSessionTemp`）；bundle 插件启停一律运行时，且若检测到历史误写进 patch 的条目则清掉（自我修复旧 corruption、防重启 duplicate）。
- 运行时定位 entry 改用 `live.entryId ?? findLoaderEntryId(ctx,id)`：`findLoaderEntryId` 直接遍历 `ctx.loader.entries()`（含 disabled 条目），不再依赖 pluginInventory 是否过滤；tree 里确实没有时才走 `ctx.loader.create`（非 bundle 插件），并在 persistable 时补写 patch。

- **生效前后数据链路**：
  - 停前：patch insert 含该 `- id`（patch 层）/ cordis.yml 登记（bundle 层），运行时 entry active；停后：patch 移除条目（patch 层）/ 不碰 cordis.yml（bundle 层），运行时立即 disabled（both）。
  - 启前：patch 无该 `- id`（或不活跃）；启后：patch 加回条目（patch 层）/ 不写 patch（bundle 层，重启由该层恢复），运行时立即重启 fiber（both）。bundle 层不会再产生 duplicate。

- **特化判定**：启停用的全是官方通用面（profile patch 读写 + `ctx.loader.update/create` + `ctx.loader.entries()` 遍历），非桌面壳特化。

- **已知边界（未做，单独登记）**：被停的 **bundle 层**插件的"停"目前只做到**运行时**停用（`ctx.loader.update` 生效），跨重启持久要靠官方 `cordis.yml`/bundles 层（官方 `dsh plugin remove` 为整包卸载、无官方"禁用一个 bundle entry"持久化 API）；原生 patch 管理（promote）的插件启停则双向持久。若需 bundle 插件"停"也跨重启，需自行对 `cordis.yml` 做禁写（脆弱，见 MANIFEST「不许碰清单」），未纳入本版。

## 8 重载界面前置预检：怎么提前抓「热注入没问题、但重载前端就崩」

**问题现象**：某些插件热注入（宿主侧 loader `create`/`apply`）没问题，但一刷新渲染进程就整页报错。静态存在性检查（client 文件在不在、非不非空）拦不住这类错——坏 client 得**真跑一遍**才露馅。此前仅凭"桌面端是否在运转"判断也不可靠（此前正常装配无法启动时同样表象）。

**方案**：把 client 的"可重载性"提前到**重载界面前**，在**内核进程**里用 `node:vm` 无头真实执行该插件已装入的 client bundle，分两步：

1. **load 注册**：`window.__ModuleLoader__.load(reg)` 是否按装配契约注册 entry、`factory` 是否为函数。
2. **factory 物化 + apply 挂载**：导出 `apply` 后，用桩 `ctx` 真实调用；`apply(ctx)` 抛错即"刷新时崩溃"的正面根因。

任一环抛错即返回带分步原因的诊断；`verifyClient` 端点对活跃插件批量执行，前端「重载界面」按钮先取预检结果：全部通过→照常确认重载；有风险→落明细（哪个插件、哪一步、什么原因）后**警告并仍允许重载**。

**产物定位**：`locateClientRoots(name, profileDir)` 按「临时加载源目录（`tempInfos.spec`）→ profile `node_modules`」两级找 client 产物，天然覆盖从任意目录临时加载的插件，不依赖其是否落进 profile。

**已知边界（演进方向，先记录未做）**：
- 只到「注册 + apply」两层；**不实挂渲染组件**（需 react-dom + 真实 DOM 才会触发的 `useState-of-null`/dual-react 类渲染崩，后续可加 SSR 渲染层）。
- 官方 dsh 运行时（`@deepseek-ai/dsh-client-runtime`、`dsh-client-ui-slots`）在预检沙箱里以**惰性递归代理**占位（真实桌面才注入），故依赖官方钩子用法的错误**不会**被误报、也暂抓不到——**真造模拟沙箱环境**（官方运行时真实仿真 + react-dom 挂载验证）是主要演进方向。
- 当前「警告仍可重载」而非**硬阻止**；把预检升级为（可配置的）阻断式是另一演进方向。

**测试插件**：`dsh-test-fixture` 提供 `good` / `broken` 两种 client 构建（`scripts/switch-fixture.mjs` 切换），`good` 与 `broken` **逻辑上只差一行**——`buildBoot` 里是否对 `session.source` 做 `?? noopEnhancer` 兜底。多阶段引导流水线（`collectMountPlan → probeSession → buildBoot` 组装**非空但深缺字段**的 `boot.live` 对象 → `apply` 分 `mountSection / mountLive` 挂载），故障在 `probeSession` 全程可选链"永不抛错"的掩护下，直到 `mountLive` 深度解构 `boot.live.source` 才空指针。该形态加载、物化、顶层 apply、浅层判空全部正常，只有预检的 apply 深度（同步穿入 effect）能把它抓出来。可重复地做普适性验证用 `scripts/preflight-matrix.mjs`（9 级难度阶梯 + 黄金实证）。

**普适性矩阵（难度梯度实证，`node scripts/preflight-matrix.mjs` 可复跑）**

| 级 | 故障形态 | 预检判定 | 真实刷新崩 | 结论 |
| --- | --- | --- | --- | --- |
| L0 | 模块顶层抛错 | load 抓 | 崩 | TP 正确抓 |
| L1 | factory 物化抛错 | materialize 抓 | 崩 | TP 正确抓 |
| L2 | 未导出 apply（契约坠落） | shape 抓 | 崩 | TP 正确抓 |
| L3 | apply 顶层同步抛错 | apply 抓 | 崩 | TP 正确抓 |
| L4 | apply 内同步 effect 深处抛错 | apply 抓 | 崩 | TP 正确抓 |
| L5 | 宏任务（异步）里抛错 | **通过** | 崩 | **FN 漏报** |
| L6 | 渲染组件挂载时抛错 | **通过** | 崩 | **FN 漏报** |
| L7 | 依赖官方运行时注入面 | 通过 | 代理未判 | 盲区（惰性代理吞） |
| L8 | 完全正常（与刷新无关） | 通过 | 不崩 | TN 正确放过 |

**普适性结论（能力边界）**：预检覆盖到 **apply 的同步调用链（含同步 effect）**；凡故障在这条链上同步抛散即能抓（L0–L4，TP）。一旦故障被**推迟到异步执行**（L5 宏任务/后续 tick）、**挪到渲染挂载之后才发生**（L6 组件渲染 `useState-of-null` / 渲染期空指针），或**落在官方注入面内部**（L7，`@deepseek-ai/dsh-client-runtime` 等真实实现被惰性代理兜住），预检就失去普适性——它只**同步执行 apply，不做异步落地、不铺真实运行时、不渲染组件**。
与之对应，L5 / L6 / L7 正分别是「模拟沙箱环境（异步 drained / SSR 渲染层 / 官方运行时真实仿真）」演进方向要补的三块，也是文档§8 已知边界 的实证基座；L8 说明预检正确地**只对「client 能否被刷新加载」这一职责负责**，与刷新无关的正常插件不误报。整条边界为：**普适性限于同步 apply 链，越到「异步 / 渲染 / 官方面」，越逼近刷新无关，预检渐盲**。

## 附：桌面壳特化总判定

| 环节 | 官方/我们用的面 | 桌面壳特化点 | 通用性结论 |
| --- | --- | --- | --- |
| 安装 | `dsh plugin add`（bundles + cordis.yml + pnpm） | 无 | 全载体通用 |
| 卸载 | `dsh plugin remove`（三处对称） | 无 | 全载体通用 |
| 装配模型 | loader EntryTree + `write()` 自动落盘 | 发行内嵌 bundle 编译进 profile | 通用；bundle 层不可变是桌面壳发行特性 |
| 桌面壳自身 | `desktopProfiles` / 内嵌官方包 / asar 运行时根 | 捆绑内核不可切 | 仅桌面壳存在 |
| 热装 | `ctx.loader.create` + pnpm | `skipOfficialPeers`（overlay 对官方 peer 二次解析受限） | 通用，特化开关可不影响 CLI |
| 转正 | 写 profile 层 patch `- insert:` | `skipOfficialPeers`；promoted「待重启」徽标 | 通用 |
| 卸载 | `ctx.loader.remove` + patch/bundles/cordis.yml 三清 + 闭包回收 | 强删 `file:` 孤儿物理目录（P-043） | 通用，强删是桌面壳路径兜底 |
| 启停 | profile patch 读写 + `ctx.loader.update({disabled})` | 无 | 通用 |

总判：插件为保持宿主不可知，刻意不依赖桌面壳注入服务（`desktopPnpm`），因此"装了桌面壳的官方命令服务"这条路被放弃，换来的代价是**绕开官方命令面、按官方同格式直写装配文件**（已登记进 MANIFEST「不许碰清单」）。真正只有桌面壳才有、且在 CLI 端不成立的，只有：捆绑内核（无法切换）、发行内嵌官方包、`resources` 运行时根、`desktopProfiles`/`desktopPnpm` 注入。其余环节在 CLI 端均可正常使用。