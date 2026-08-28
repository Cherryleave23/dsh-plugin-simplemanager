# dsh-web 引导·激活·服务注入模型 —— 前端重载预检的普适性研究

> 状态：已收敛（全部依据 dsh 官方 monorepo 源码，rc.2）
> 口径（硬约束）：本文件**只收录能落回官方源码的实证结论**；凡无官方源码依据的推导一律不写。
> 官方源码树：`dsh-official/deepseek-harness-v0.1.1-rc.2/packages`，关键文件见下。
> 引用代号：`W=boot.ts`（web 端 boot 引擎）、`A=app-boot`（host 端对照）、`L=cordis-plugin-loader`（外部依赖，见 §2 声明）。

---

## 0. 一句话结论

**web 前端重载预检判据 = 官方 `packages/client/web/src/boot.ts` 的 `assertEntriesActive` 门禁**：
一个 entry 停在 `active` 当且仅当其 `inject` 里每个服务 `ctx.get(service) !== undefined`（真名见 §3 ①）。
凡 `inject` 缺最终可达服务 ⇒ 该 entry 恒为 `pending (waiting for service: X)`，**apply 永不执行** ⇒ 其 apply/渲染层的任何失败在真实重载里都不可达，预检不得据此报"会崩"。

---

## 1. 要回答的普适问题

1. web boot 的 load 队列由谁消费、以何顺序、同步/异步？（→ §3 ③：`Promise.all(loader.create)` + `loader.await()`）
2. entry 的 `inject` 在引导引擎里的真实角色；`pending (waiting for service: X)` 由哪个逻辑产生？（→ §3 ①：`assertEntriesActive` 的 `ctx.get===undefined`）
3. 激活 `pending → active` / `active → failed` 由什么驱动？（→ 推论于 §4，官方源码可证的部分仅到"pending 缺服务"层）
4. entry apply 抛错 vs 等不到服务而 pending，是两种结局 ？（→ §3 ①：failed→`fiber.await()` 取 stack；pending→列缺服务）
5. 引导期可达服务集能否程序化确定？（→ §5：由 manifest 内 client 包 `provide` 注册名 + `boot.ts` 的 `loader.create` 全集推导）
6. 由此推导**重载预检的普适判据**。（→ §4）

---

## 2. 官方源码实证：关键包与可作证边界

> **诚实声明（重要）**：下列所有**门禁与激活语义**均来自 `packages/client/web/src/boot.ts`（web 端真实 boot 引擎）——
> 这是浏览器加载第三方插件 client 半边时**真正执行的代码**。
> `packages/boot/app-boot/src/index.ts` 是 **host/`dsh` bin 端**的并行实现，与 web 端**不同**（函数名 `assertEntriesActivated`、报错文案不同），不冒充 web 引擎。
>
> **未随本 monorepo 提供的源码**：`@deepseek-ai/cordis`（fiber 内部）、`@deepseek-ai/cordis-plugin-loader` 的**实现源码**未 vendored 在本仓库（`packages` 下无其 `src/`；它们是本仓库的外部依赖，见 `app-boot/package.json`）。因此：
> - fiber 状态机内部（`_refresh/_setEpoch/_getImpl` 等）**不写**——无官方源码依据。
> - `state: 'pending'` 只作为 boot.ts 里可见的字符串标签使用，其语义（"inject 服务未齐"）由 `assertEntriesActive` 的判据间接可证，**不延伸到未记录的内部实现**。
> 若需更深层(cordis core)证据，须另取 `@deepseek-ai/cordis` 官方仓库源码（不在本任务范围）。

| 职责 / 与引导的关系 | 官方源码（唯一依据） |
|---|---|
| **web 端 boot 引擎**：模块系统 → `ctx.plugin(Loader)` → `loader.create` 全部并发 → `loader.await()` → `assertEntriesActive` 门禁 | `packages/client/web/src/boot.ts` |
| host 端对照（非 web，仅作差异说明） | `packages/boot/app-boot/src/index.ts`（`assertEntriesActivated`） |
| 浏览器束：壳启动 + 运行时 glue 插件；`cordis.patch.yml` 为浏览器半边花名册来源 | `packages/client/web-app/src/startup.ts` |
| 客户端运行时服务提供者（slots/sessions/workspaces/connection…），`super(ctx,'X')` 注册 | `packages/client/runtime/src/client/*.ts` |
| 其余 client UI provider（提供 §5 白名单服务） | `packages/client/{ui-*,connection,modules,…}/src` |
| 动态插件浏览器半边（Agent 会话临时插件，非静态 web boot） | `packages/extensions/cordis-client-runner/src` |
| cordis core / cordis-plugin-loader | **本仓库无源码**（外部依赖），不展开 |

---

## 3. 探测记录（官方源码实证，逐条落回 `web/src/boot.ts`）

> 本节全部内容均引 `packages/client/web/src/boot.ts`（159 行）与 `packages/client/web/src/loader-status.ts`（`STATE_LABELS`）。

### ① 门禁核心：`assertEntriesActive`（boot.ts:138-158）

```ts
// packages/client/web/src/boot.ts:138
private assertEntriesActive(ctx: Context): void {
  for (const entry of ctx.loader.entries()) {
    const name = entry.options.name
    if (entry.fiber === undefined) {
      failures.push(`${name}: import failed (see console for the import error)`)   // 无 fiber ⇒ import 失败
      continue
    }
    const state = STATE_LABELS[entry.fiber.state]
    if (state === 'active') continue
    if (state === 'pending') {
      const missing = Object.keys(entry.fiber.inject)
        .filter(service => ctx.get(service) === undefined)   // ← 唯一判据：ctx.get(service)===undefined
      failures.push(`${name}: pending (waiting for service${missing.length===1?'':'s'}: ${missing.join(', ')||'unknown'})`)
    } else {
      failures.push(`${name}: ${state}`)                     // loading / failed / …（boot.ts 仅 pending 细分）
    }
  }
  if (failures.length > 0) {
    throw new Error(`web boot: ${failures.length} entr${failures.length===1?'y':'ies'} did not activate\n${failures.join('\n')}`)
  }
}
```

- **`ctx.get(service) === undefined` 是 pending 的唯一判据** → 预检 `RELOAD_REACHABLE_SERVICES` 门禁即复刻此行。
- apply 抛错 → fiber 落 `failed` state → 走 `else` 分支报 `${name}: failed`（真实错误文案来自 `STATE_LABELS`，boot.ts 只在 `pending` 细分 from service）。
- 抓取的实测 `dsh-test-fixture: pending (waiting for service: effect)`，根因 = fixture `inject:['slots','effect']` 且 `effect` 不作为 Service 提供 ⇒ `ctx.get('effect')===undefined` ⇒ pending。

### ② `runPluginBoot`：load 队列消费方式（boot.ts:113-135）

```ts
await ctx.plugin(Loader)                           // 注册 loader 服务
const loader = ctx.loader
loader.internal = this.modules as never            // 把客户端模块系统接给 loader
const rows = this.manifest.plugins.map(row => row.id)
await Promise.all(rows.map(async (name) => {       // ① 全部并发 loader.create，非逐条 load
  const id = await loader.create({ name })
  if (loader.resolve(id).fiber === undefined) this.page.setState(name, 'failed')
}))
await loader.await()                               // ② 等所有 entry 达稳态（含 pending，不抛）
this.assertEntriesActive(ctx)                      // ③ 门禁
```

- `manifest.plugins` = 浏览器要装配的静态插件全部（含核心 UI provider + 启用第三方插件 client 半边），**每一个 = 一个 loader entry = 一个 fiber**。
- **`loader.await()` 等的是稳态、不是全 `active`** → pending 能过 await()，只在 `assertEntriesActive` 被拦 → **缺服务是确定性打回，不是随机挂起**。

### ③ web boot 时间线（成链）

```
window.__ModuleLoader__（宿主注入的模块系统）
   → modules = __ModuleLoader__.create({ boot:…, staticModules, … })   // boot.ts:61
   → manifest = modules.manifest                                        // boot.ts:67（静态插件清单）
   → ctx = new Context()
   → ctx.plugin(Loader) → ctx.loader                                    // boot.ts:114
   → 并发: manifest.plugins.loader.create({name})                        // boot.ts:127
   → await loader.await()                                               // boot.ts:133
   → assertEntriesActive(ctx)                                          // boot.ts:134 —— 任一非 active 即 throw
        · import failed（fiber 无）
        · pending → 列缺服务 (ctx.get===undefined)
        · 其它 state → 列标签
```

---

## 4. 重载预检判据（由官方 boot.ts 直接推导，不依赖 cordis core 内部）

预检 = **预测一次 web reload 后，每个参与插件停在哪个 state，整页是否被 `assertEntriesActive` 打回**。

**Step 1 — 收集每个目标的 `inject` 声明**（`entry.options.inject` → `entry.fiber.inject` 的键集，boot.ts:149 读取的正是它）。

**Step 2 — 对每个 inject 名做可达性分类（复刻 `ctx.get(name)===undefined`，取代 mock 直跑 apply）**，三态：

| inject 名 | 官方判定 `ctx.get(name)` | 预检分类 | 预检动作 |
|---|---|---|---|
| 在可达白名单（§5）内 | 非 undefined（可达） | **可达** | 进入 apply 深挖 |
| 是 cordis ctx 方法（`effect/track/on/…`） | 恒 undefined | **硬不可达** | 阻断·服务门禁，report `pending (waiting for service: X)`，**禁止深挖 apply** |
| 两者皆非（未知命名） | 不确定 | **未知** | 放行+提示待核对（避免把「未采集的真实服务」误拦） |

**Step 3 — 合成预检结论（与真实重载结局严格对齐）**：

| 目标情况 | 真实 reload 结局 | 预检应报 |
|---|---|---|
| 任一 inject 名**硬不可达**（ctx 方法/拼错等服务） | `pending (waiting for service: X)`，`assertEntriesActive` **throw 打回整页**，apply 不执行 | **【阻断·服务门禁】** 主错 `pending (waiting for service: X)`；**不深挖 apply** |
| 任一 inject 名**未知** | 不确定（可为可达或不可达） | **【关注·待核对】** 列未知名，放行重载 |
| 所有 inject 可达，`apply(ctx)` 抛错 | fiber 落 `failed`，门禁报 `${name}: failed`，整页打回 | **【阻断·apply 抛错】**（仅门禁全可达后的深层判据） |
| 所有 inject 可达，apply 正常 | `active` | 通过/无风险 |

> **关键修正**：对「硬不可达」的目标**必须只看门禁、禁止深挖 apply** —— 深挖会捕到真实 reload 根本不触发的深层错误（fixture `track` 空指针即此例：真实 reload 里 apply 不会跑），且会让"必打回"被误当"可放行"（旧实现在此 `ok=true` + 警告，是错的：pending 会被 `assertEntriesActive` 打回整页）。

---

## 5. 可达 Service 白名单（程序化采集，官方源码）

**来源 = manifest 内每个 client 包的 `provide` 注册名**。boot.ts:124 的 `manifest.plugins` 即浏览器装配全集；其中每个 provider 包对其 `extends Service` 的构造调用 `super(ctx,'<名>')` 或 `reflect.provide('<名>',…)` 注册服务名。

采集器 `scripts/scan-official-services.mjs` 扫 `packages/client/**/src`（rc.2），得 19 个服务名（rc.2 实测）：

```
chatFileMentions · clientModules · commandUi · connection · conversation
conversationEvents · conversationViews · inputTriggers · layout · locale
modelDirectories · modules · sessions · settingsSchema · settingsScope
slots · theme · uiRenderer · workspaces
```

另并入 boot 机制自身注册、非 client 包但在 `loader.create` 前必注册的一个：
`loader`（boot.ts:114 `ctx.plugin(Loader)` → `ctx.loader`；注：注入 `loader` 另有 Loader[check] 语义，见 §6 边界 3）。

**§4-落地白名单**：
```ts
const RELOAD_REACHABLE_SERVICES = new Set<string>([
  'chatFileMentions','clientModules','commandUi','connection','conversation',
  'conversationEvents','conversationViews','inputTriggers','layout','locale',
  'modelDirectories','modules','sessions','settingsSchema','settingsScope',
  'slots','theme','uiRenderer','workspaces',
  'loader', // boot.ts:114 ctx.plugin(Loader) 注册
])
const nonGuaranteed = (inject ?? []).filter((s) => !RELOAD_REACHABLE_SERVICES.has(s))
```
- **等价性（与 boot.ts:149 一致）**：`ctx.get(name)===undefined` 在 web 端就是对上述 `provide` 注册名的查询；`effect/track/on/…` 非 Service、不在注册名集合 → `ctx.get===undefined` → pending。白名单本身 =「web boot 期 manifest 内 provider 会注册的 Service 名」，与真实门禁同一判定面。
- **容器证实**：`client/runtime/src/client/slots.ts` 的 `SlotRegistry extends Service` 注册 `slots`；`runtime` 其余服务同此。`uiRenderer` 由 `ui-renderer` 以 `reflect.provide('uiRenderer',…)` 注册（采集器覆盖 `reflect.provide` 形态）。
- **版本自适应**：dsh 升级后 `node scripts/scan-official-services.mjs <新版 packages/client>` 重扫替换即可。

**fixture 验证**：`dsh-test-fixture`（`inject:['slots','effect']`）→ `effect ∉ 白名单` → 门禁侧 `ctx.get('effect')===undefined` → `maskedByGate=true` → 主结论 `pending (waiting for service: effect)`，apply 的 `track` 空指针只作「潜在缺陷」呈现 —— 与官方 `assertEntriesActive` 真实输出逐字一致。

**残余边界**：若插件注入一个官方真存在、但采集未覆盖（非 `packages/client`、或非字面量注册）的服务名 → 误判不可达 → 只告警不阻断（低估风险侧）。`scan-official-services.mjs` 已覆盖 `packages/client` 全部 src，触发概率极低。

---

## 6. 已知边界与未覆盖（诚实留白）

1. **cordis-core 内部状态机未展开**：`active/pending/failed` 的 fiber 内部流转（`_refresh/_setEpoch/…`）**非本 monorepo 源码**，本文不假设其实现；只用了 boot.ts 可见的 state 标签与门禁判据。
2. **动态插件路径未展开**：Agent 会话临时插件走 `packages/extensions/cordis-client-runner/src`，其门禁不同于静态 web boot，预检覆盖动态插件须另立判据。
3. **`loader` 注入特例**：`Loader[Service.check]`（注入 `loader` 时若 Loader 仍有任务则暂缓）在 `@deepseek-ai/cordis-plugin-loader`（本仓库无源码）中；预检对 `loader` 当作可达处理，与常规并不冲突（manifest 全创建后 await 会清空任务）。
4. **provider 也 pending 的级联**：目标 inject 的 provider 若自身 pending/failed，目标同样被判 pending —— 预检递归到 provider 激活性暂未落到代码。
5. **渲染期崩溃（L6）不在门禁内**：`<div>` 渲染级错误发生在 boot 门禁之外，预检不可达，属既有弃权项。

---

## 附录 A · 重载预检实现：三态门禁 vs vm 沙箱（两套方案备选记录）

> 目的：把两种后端探测途径作为**独立备选**记录下来，便于日后取舍。当前采纳为「三态门禁」。
> 归属：两者都是「客户端插件 client 半边的 reload 预检」的探测后端，产出统一写进 `ClientSmokeReport`。

### A1 方案一（当前采纳）· 三态门禁

- **思路**：判据驱动。等价复刻官方 `web/src/boot.ts:149` 门禁 `missing = Object.keys(fiber.inject).filter(s => ctx.get(s)===undefined)`，把每个 inject 名分成三态再决定是否执行 apply：
  - **可达**（∈ §5 白名单）→ 深挖 apply/渲染；
  - **硬不可达**（∈ `NON_INJECTABLE_CTX_METHODS`，如 `effect/on/emit/…`）→ 阻断，报 `pending (waiting for service: X)`，**不深挖 apply**；
  - **未知**（两者皆非）→ 放行 + 「待核对」提示。
- **与真实 reload 对齐**：是。硬不可达=真实打回整页；可达=真实执行 apply。
- **优点**：只报「真实会触发的错」；对齐官方 `assertEntriesActive`；无 mock 假阳性；实现中等。
- **缺点 / 主动舍弃**：**探测不到「被门禁屏蔽的深层缺陷」**（fixture `track` 空指针不再报出，尽管它在未来服务就绪后会炸）；依赖官方源码白名单（§5）的准确性。
- **可回填增益**：denied 分支可加**非阻断 info**（"潜在缺陷 X，服务就绪后触发"），不改变阻断结论——目前未实现，留待需要时加前端开关。

### A2 方案二（备选，早期原型）· vm 沙箱全执行

- **思路**：执行驱动。把 client bundle 在 `node:vm` 里真实跑一遍（import → factory → apply → render），任一环抛错即分步根因。
- **服务环境**：全 mock，且**惰性/绕过门禁**（给 `effect`/`liveSession` 等 stub，好让 apply 一路跑到头）——这是 A1 要修掉的点。
- **与真实 reload 对齐**：**否**。mock 绕过门禁 → 报出真实 reload 不触发的假错误（fixture `track` 空指针即由此骗出）。
- **优点**：覆盖广（理论上抓一切运行时错）；对「服务就绪后才会崩」的迁移缺陷敏感。
- **缺点**：假阳性高（真实 reload 不可达的错误被当阻断）；放行"必然 pending"的插件；成本高（搭沙箱 + mock 各服务/依赖闭包）。

### A2' 方案二升级版 · 真 cordis 沙箱（vm + 真实运行时）

> 由 A2 演进：把「全 mock」升级为「**真实 cordis 运行时**」。这是对原始「数据驱动门禁复刻」方案的官方源码重述（原始调研来自桌面壳，已修正）。

- **思路**：执行驱动，但执行环境 = 真实 cordis。在 node 沙箱里创建**真实 `Context`** + `ctx.plugin(Loader)`，把插件 bundle factory 喂给 loader，让真实 cordis 跑完整激活流程（inject 解析 → fiber 状态机 → pending/active/failed → apply）。
- **能放真实的（纯逻辑，不依赖浏览器）**：
  - `@deepseek-ai/cordis` core：`Context`/`Service`/fiber 状态机/`ctx.effect/on/...` 方法；
  - `@deepseek-ai/cordis-plugin-loader`：entry/fiber 管理。
- **不能放真实的（依赖浏览器 window/DOM/fetch）**：
  - 真实服务（slots/sessions/workspaces/connection/...）→ 仍以 **mock 服务注册到真实 Context**；
  - 渲染（react-dom 挂载）→ 仍 mock。
- **门禁**：从「复刻判据」变「**真实执行**」——`ctx.get()` 查询、pending 判定、fiber 流转全由真实 cordis 产出；`effect/track/...` 由真门禁自然判 pending，**deny 集可删**。
- **关键修正（相对桌面调研）**：官方 web 门禁是 `ctx.get(x)===undefined`（`web/src/boot.ts:149`），**无 strict 参数**；桌面 cordis 的 `ctx.get(h, strict)` 是另一套，照抄会过严（strict 找不到即 throw，把 error 与缺服务混为一谈）。预检必须按官方 web 版复刻，而非桌面版。
- **采集源**：官方源码 `packages/client/**/src`（`scan-official-services.mjs`），非桌面壳产物。
- **校准**：真实重载失败回喂（ground truth），持续修正 mock 服务层偏差（见 A2' 缺点）。
- **优点**：门禁 **100% 真实**（预检最核心、最确定的那半边）；apply 的 ctx 方法真实；deny 集可删；比 A1 更接近真实重载。
- **缺点**：真实服务仍 mock（服务数据层误差仍在，靠契约桩 + 真实校准兜底）；需引入 npm 官方包（**编译产物，非源码**——口径需确认）；浏览器 bundle 格式适配（`__ModuleLoader__` → node 模块加载）为主要工程量；渲染仍 mock。

### A2' 落地状态（已实现 · 仅门禁真 cordis）

> 用户拍板：实验深度 = **仅门禁真 cordis**（不深挖 apply/渲染）；依赖口径 = **接受 npm 编译产物**。

- **实现**：新增 `src/preflight.ts` 的 `realCordisGate(profileDir, injectNames, realReachableNames)`——用真实 `@deepseek-ai/cordis` 的 `Context` + `Service` 机制把可达服务注册进真实 ctx，再对每个 inject 名 `ctx.get(name)===undefined` 判定（对齐 `web/src/boot.ts:149`）。cordis 从 profile 的 `createRequire` 解析（与预检沙箱同源，kernel 进程无需自持 cordis）；解析不到则回退按 `realReachableNames` 近似。
- **接入**：`index.ts` 的 `clientSmokeTest` 新增 `realGate` 参数；`verifyClient` action 读 `body.mode==='real-cordis'` 走真门禁分支（仅门禁即返回，不深挖 apply/渲染）。`ClientSmokeReport` 新增 `realGate` 字段标记后端来源。
- **前端**：`client.tsx` 新增预检模式开关（`○ 三态门禁` / `● 真 cordis 门禁·实验`），localStorage 持久化（`dsh-plugin-simplemanager:preflightMode`，默认三态）；**切到实验室模式前弹 `askConfirm` 提醒**（说明仅门禁不深挖、依赖 profile 真实 cordis、门禁通过不代表 apply 无缺陷），确认后才开启。
- **验证（冒烟 `scripts/smoke-real-gate.mjs`）**：
  - fixture `[slots, effect]` → `missing=['effect']`（真门禁自然判 effect 缺服务，**deny 集可删**）✓
  - 正常 `[slots]` → 全可达 ✓；拼错 `[typoService]` → 判缺服务 ✓；空 `[]` → 无需判定 ✓
- **边界**：真门禁仅覆盖 inject 可达性；apply/渲染缺陷不在实验室模式覆盖内（与 A2' 设计一致）。

### A4 终局定案（后续 · 砍掉 VM mock 深挖，真实门禁为缺省）

> 演进结论：**VM mock 深挖毫无意义**——`apply`/渲染/数据驱动渲染全部跑在虚构 mock 环境里，保真度差且会误伤干净插件；「真实是否崩溃」的唯一可信判据来源是**真实运行**。故最终定案：

- **保留**：装配契约检测（`load` 注册 / `factory` 物化读 `apply`/`inject` 形状）；**真实 cordis 门禁**（`realCordisGate`，`ctx.get` 判可达；cordis 不可解析回退三态近似）。**真门禁即缺省，不再有“实验室”开关**。
- **删除**：③ `apply(mockCtx)` 执行、渲染挂载探测（react-dom/server 渲染注册组件）、数据驱动渲染探测（`driveRenderCrashes` + react-test-renderer + fetch 错误注入 + 未处理 rejection 隔离）等全套 VM 深挖；`realGate`/`renderData` 参数、`ClientSmokeReport.realGate` 字段、前端 `PreflightMode`/toggle/localStorage 一并移除。
- **兜底**：真实是否崩溃，交给**独立子进程真机试运行（guard 式启动级探针）**——外置 `dsh web` 子进程真实装配 + HTTP 健康检查 + 渲染心跳，判定插件是否导致启动崩溃，崩溃自动回滚隔离问题插件。预检自身不再承担“我一定判断得出会崩”的职责，只负责“契约 + 门禁”两个确定性判定。

**落地面**：`src/smoke.ts`/`src/preflight.ts`/`src/index.ts`（verifyClient/verifyPreflight 统一 3 参真门禁）、`src/client.tsx`（去掉模式开关与实验室文案）、`src/client-styles.ts`（删 `preflightSwitch*`）。

### A3 关系与选型结论

四条是一条收敛链，非并列：

```
vm 全执行（mock 绕过门禁）            ← A2 原型：宽覆盖、必误报
  → 白名单 masked + 仍深挖当 warns     ← 过渡：有门禁意识，但放行"必打回"且深挖出假错
  → 三态门禁（denied 阻断 / 可达深挖 / 未知放行）  ← A1 收敛：窄而准、对齐真实结局
  → 真 cordis 沙箱（真实门禁 + 真实 ctx 方法）    ← A2' 升级：门禁真实化、deny 集可删
```

**A1（三态门禁）vs A2'（真 cordis 沙箱）对比**：

| 维度 | A1 三态门禁 | A2' 真 cordis 沙箱 |
|---|---|---|
| 门禁判定 | 复刻判据（`ctx.get===undefined` 手写近似） | **真实执行**（真 cordis fiber 流转） |
| apply 的 ctx 方法 | mock | **真实** |
| 服务数据 | mock | mock（契约桩 + 校准兜底） |
| deny 集 | 需要（人工维护） | **可删**（真门禁自然判 pending） |
| 渲染 | mock | mock |
| 对齐度 | 门禁确定性、apply 概率性 | 门禁真实、apply 更接近真实 |
| 成本 | 中 | 高（真 cordis + bundle 适配） |
| 依赖口径 | 官方源码白名单 | npm 官方包（编译产物，非源码） |

**采纳理由（当前仍为 A1）**：A1 零外部运行时依赖、成本低、已对齐官方门禁判据，足以覆盖"缺服务→pending→打回"这一确定性主场景；A2' 的增益集中在"apply 的 ctx 方法真实化 + deny 集可删"，但引入 npm 编译产物依赖与 bundle 适配工程量，且服务数据层误差并未消除。**建议**：若后续要提升 apply 深挖可信度、或 deny 集维护成本上升，升级到 A2'；否则维持 A1。A2' 的「真实重载失败回喂」校准思想可独立先行采纳（零新增环境依赖）。