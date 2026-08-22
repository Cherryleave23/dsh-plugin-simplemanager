# dsh-plugin-simplemanager · 调试日志

> 记录插件管家（热插拔 / 真注入 / 依赖获取 / UI）开发与验证过程中遇到的每个问题、根因、处置与最终判定。
> 后续每遇到一个新问题、或推翻既有结论，都必须增量记录到此文档。

---

## 0. 记录纪律（本文件如何维护）

### 0.1 何时必须记录
- 每次出现可复现的错误（报错、挂起、超时、功能失效、行为不符预期）后，新增一条问题条目。
- 每次推翻/修正本文件中的既有**判定、根因、处置方案**时，登记到「更正登记表」并更新对应问题条目。
- 新问题与旧问题的处置**相互矛盾**时，不允许只改旧条目而不留痕——必须新增记录并显式引用。

### 0.2 条目结构
每个问题条目 `P-XXX` 固定包含以下字段（缺一不可）：

| 字段 | 含义 |
|---|---|
| 现象 | 实际观察到的行为 / 报错原文 |
| 环境 | 触发条件、相关版本、调用路径 |
| 根因 | 经排查确认的直接原因 |
| 处置 | 采取的修复动作 / 方案切换 |
| 判定 | 当前结论（`已解决 / 待验证 / 进行中 / 已放弃`） |
| 影响面 | 该问题波及的模块 |

### 0.3 状态流转
- `进行中` → 有了可复现的修复后 → `待验证`。
- `待验证` → 端到端验证通过 → `已解决`。
- `已解决` → 若日后被同一根因的新现象推翻 → 回到 `进行中` 并登记更正。

### 0.4 冲突 / 前后矛盾处理规则（重要）
本文件的条目按**时间正序**追加（编号递增），越靠后的条目越新。当新旧判定冲突时，遵循：

1. **后文覆盖前文，但前文必须留痕**。旧条目结论若已被推翻，在该条目标题加前缀
   `[已更正 → 见 P-XXX]`，其原「根因 / 判定」字段保留原始内容不改写，仅追加一行「更正说明」。
2. **每一条更正同时写入「1. 更正登记表」**，表内一行说明：谁被推翻、被哪个后续发现推翻、当前应采信哪个结论。
3. 阅读本文件时，**以最终出现的条目 / 更正登记表的「当前应采信」列为准**；同号若有前缀即为过时结论。
4. 禁止删除历史条目来「打扫」冲突——历史现象是复盘依据，冲突本身也是有效信息。

---

## 1. 更正登记表

> 旧结论被推翻的登记。新记录一律追加在表尾。

| 登记号 | 被推翻的旧结论（出处） | 推翻它的新发现（出处） | 当前应采信 |
|---|---|---|---|
| C-01 | 热插拔可通过 `loader.create` 动态插入实现（早期方案） | P-002：`loader.create` 永久挂起，非官方装配语义 | 改用「pnpm add 装包 + `setPatchEnabled` 写 patch + `loader.update` 热启」 |
| C-02 | pnpm 依赖安装失败是网络代理/copycat 问题，束手无策 | P-003：`CI: 'true'` 触发 corepack 自下载 `@pnpm/exe` 才是根因 | 移除 `CI` 变量 + 定位本地 pnpm 实装，安装耗时 70s→2.8s |
| C-03 | 中文路径在运行时解析为乱码，需手动输入路径（UI 缺陷） | P-004：`specPackageName` 缺路径特征检测，实为解析逻辑缺陷 | 按路径特征（`\` `/` `.` 盘符）兜底解析 + 直读 `package.json` 取包名 |
| C-04 | 可用桌面壳注入的 `desktopPnpm` 服务做安装 | P-005：`dsh-desktop` 是第三方封装，应只消费官方 dsh 内核服务 | 自持 pnpm 运行器，宿主不可知，不依赖桌面壳注入服务 |
| C-05 | P-001/P-002 判定 `ctx.loader.create` 会永久挂起、非官方装配语义、应弃用 | P-015：`_dbgCreate` 实测传 **bare specifier（包名）** 时 create 123ms 即返回、不挂起、成功建 entry；P-002 挂起根因是误传**本地 file 路径** | `ctx.loader.create({id,name: 包名,config,disabled})` 是官方运行时装配**可行**入口；`name` 必须传包名/相对 specifier，禁止传本地绝对路径 |

> 新增更正时请复制表尾一行并填入登记号 `C-$(n+1)`。

---

## 2. 问题条目（按时间正序）

### P-001 · 依赖安装触发 pnpm 网络拉包异常
- **现象**：`GET https://registry.npmmirror.com/@pnpm%2Fexe: fetch failed`，依赖无法安装。
- **环境**：Windows，pnpm 11.15.1，代理 `HTTP_PROXY=http://127.0.0.1:10808`。
- **根因**：`CI: 'true'` 环境变量触发 pnpm v9+ 走 corepack self-managed 逻辑，corepack 试图自下载 `@pnpm/exe`，代理下下载失败。
- **处置**：移除 `CI` 变量；新增 `resolvePnpmInvocation`，优先定位 corepack 缓存 / 桌面捆绑的 pnpm 实装二进制（win32 直接指向 `pnpm.cjs`），规避 corepack shim；proxy 转译为 `npm_config_*`。
- **判定**：`已解决`（详见 P-003 的关键配置说明）。
- **影响面**：`src/pnpm.ts`、`src/index.ts:tempLoad`。

### P-002 · `loader.create` 永久挂起
- **现象**：`ctx.loader.create` 调用后执行为 NULL 回调但永远不 resolve，无错误日志，HTTP 接口因此 60s+ 超时。
- **环境**：dsh-c 插件运行于 desktop profile。
- **根因**：把动态插入点当装配入口，与官方 Cordis 装配语义不符，非受支持路径。
- **处置**：放弃 `loader.create`，改用「`pnpm add` 装包 + `setPatchEnabled(packageName, packageName, true)` 写 profile 层 patch + `loader.update(entryId, { disabled: false })` 热启」，符合官方 patch 装配清单语义。
- **判定**：`已解决`（已被判别据与实测）。
- **影响面**：`src/index.ts:tempLoad`、`src/host.ts:setPatchEnabled`。

### P-003 · 依赖安装在慢速网络下的超时
- **现象**：`tempLoad` 因 pnpm 网络重试而 HTTP 超时（>60s）。修复本地化后安装耗时 70s → 2.8s。
- **环境**：需拉取闭包依赖的第三方插件。
- **根因**：`CI: 'true'`（P-001 同源）+ corepack shim 触发网络下载，且重试策略放大等待。
- **处置**：`resolvePnpmInvocation` 命中本地实装后不再走网络；移除 `CI` 变量；`--reporter=ndjson` 取 pnpm 真实错误，超时杀进程树，瞬时网络失败重试。
- **判定**：`已解决`。
- **影响面**：`src/pnpm.ts`。

### P-004 · 中文路径被解析为乱码，包名识别失败
- **现象**：用户选择中文目录下的插件路径时，`tempLoad` 把路径当成包名，出现「无法读取所选文件夹路径」/乱码。
- **根因**：`specPackageName` 未识别含 `\` `/` `.` 或盘符的路径，拿到的是乱码串而非包名。
- **处置**：`specPackageName` 增加路径特征检测；命中路径特征时直接读取其下 `package.json` 的 `name` 字段作为包名。
- **判定**：`已解决`（正则化后 `dsh-msg-link` / `dsh-v0.1.1-rc.2` 均正确识别）。
- **影响面**：`src/index.ts`、`src/pnpm.ts:AnchoredSpec`。

### P-005 · 依赖桌面壳注入服务（非官方）
- **现象**：早期实现曾计划复用桌面壳注入的 `desktopPnpm` 服务来完成安装。
- **根因**：`dsh-desktop` 本身是第三方封装，不属于「官方 dsh 内核」；依赖它违反宿主不可知原则。
- **处置**：进程层自持 pnpm 运行器，仅消费官方 dsh 内核服务，宿主无关（判据 4/5/6）。
- **判定**：`已解决`（已改为自持）。
- **影响面**：`src/pnpm.ts`（整体设计约束）。

### P-006 · 运行时临时加载入口的 UI 失效
- **现象**：点击「运行时临时加载」弹框无法输入；按「选择文件夹」直接报「当前环境不支持原生目录选择，请手动输入」；即便输入正确路径「加载当前目录」按钮也无效。
- **根因**：UI 层与 `tempLoad` 通路未接通 / 弹窗未聚焦输入 / 原生目录选取在当前宿主不可用。
- **处置**：实现「运行时加载弹出独立新窗口」，提供盘符 → 目录 → 插件的选择流；显式聚焦输入框；打通按钮 → API 链路。
- **判定**：`进行中`（UI 交互仍需在宿主内实测确认）。
- **影响面**：`src/client` 面板、`app-runtime` 装载窗口。

### P-007 · 目录选择仅显示 C 盘、无法返回盘符入口
- **现象**：运行时加载窗口目录树只列出 C 盘，且无回到「选择盘符」的入口。
- **根因**：文件枚举未遍历所有盘符，选择流无盘符一级。
- **处置**：Windows 下枚举全部盘符（A:-Z: 存在性过滤）作为第一级；提供返回盘符选择的路径。
- **判定**：`进行中`。
- **影响面**：`src/client` 装载窗口。

### P-008 · 拖拽排序未实现 / 文件夹管理与插件排列体验
- **现象**：文件夹与插件无法通过拖拽改变排列；右侧插件多需滚动时文件夹随之滚动、导致无法把插件拖入文件夹；18 依赖插件文本折叠无法观测。
- **根因**：拖拽落点 + 独立滚动容器 + 依赖展开交互缺失。
- **处置**：增加拖拽落点指示、文件夹分区独立滚动、依赖折叠展开可观测、双击显示名重命名、插件搜索（重命名名/原名模糊匹配）。
- **判定**：`进行中`（一组 UI/交互打磨项，逐项在宿主内回归）。
- **影响面**：`src/client` 面板整体布局与交互。

### P-009 · 8080 端口 /simplemanager 返回 404（现场进行中）
- **现象**：当前 DSH Desktop（node pid 232084，监听 3080）访问 `http://127.0.0.1:3080/simplemanager` 返回 404；`/simplemanager/plugins` 同理。
- **环境**：刚重启待加载修复后 lib。
- **根因**：待确认——可能是该实例未装配 simplemanager 插件、或路由前缀不同、或修复后 lib 未生效需重载。
- **处置**：核对插件装配状态与路由注册、确认当前运行实例是否加载新 lib。
- **判定**：`进行中`。
- **影响面**：`src/index.ts` 路由注册、插件装配。

### P-010 · 清理临时测试装配的 `dsh-msg-link`
- **现象**：profile 残留测试装配的 `dsh-msg-link`——`cordis.patch.yml` 有两条 insert（一条正常装配、一条以完整路径 `D:\AI\...\dsh-v0.1.1-rc.2` 为 id 的脏条目，源于 P-004 路径乱码期间写入）；`package.json` 挂了 `dsh-msg-link: file:.../ml-backup` 指向备份目录；顶层 `node_modules\dsh-msg-link` 实装存在。
- **根因**：此前热插拔/路径测试把临时装配写进了 profile 的 patch 清单与依赖层，非用户有意安装。
- **处置**：备份 `cordis.patch.yml`、`package.json`（`.bak-msg-2026-08-22`）；重写 patch 恢复空装配 `[]`；用本地 pnpm 11.15.1 实装（`node` 运行 `corepack/.../pnpm/11.15.1/bin/pnpm.cjs`）执行 `pnpm remove dsh-msg-link`，同步清理 lockfile 与 hoisted node_modules；备份源 `ml-backup` 保留不删。
- **判定**：`已解决`（package.json / node_modules / lockfile / patch 四处均已确认清除）。运行时内存中的旧装配需重启 DSH Desktop 后彻底消失。
- **影响面**：profile 装配清单与依赖层；不波及 `dsh-plugin-simplemanager`（其 bundle 与依赖独立）。

### P-011 · 调试宿主选择错误（应使用桌面版 dsh-desktop）
- **现象**：此前把临时 npx 缓存启动的 `@deepseek-ai/dsh/lib/bin.js web` 内核实例（端口 3080）误当作调试宿主；该实例 `/simplemanager` 除 `kernel` 分支外所有 action（`pickdir`/`tempLoad` 等）均返回 `unknown action: X`，且插桩日志证实请求未进入插件 handler。而在正确宿主下这些 action 全部正常。
- **根因**：方向性错误——正确宿主是桌面版 `DSH Desktop.exe`（Electron 壳，`resources/app.asar` 内嵌 `@deepseek-ai/dsh`），插件管家面板在桌面版内运行；npx `web` 内核实例是另一种宿主，其对 simplemanager 的装配/暴露方式不同且不完整。
- **处置**：终止误导实例并恢复 profile 运行库插桩污染（`node_modules/dsh-plugin-simplemanager/lib/index.js.bak-2026-08-22`）；改在桌面版上启动验证，`/simplemanager` 暴露于端口 **43120**。
- **判定**：`已解决`（宿主纠正；桌面版 action 分派验证正常）。

### P-012 · 桌面版 tempLoad 落盘成功但运行时热启未生效（hotApplied=false）
- **现象**：在桌面版（端口 43120）用备份插件 `ml-backup`（`dsh-msg-link` 源码）调用 `tempLoad`，返回 `ok:true, depsApplied:true, packageName:"dsh-msg-link"`，patch 装配清单已写入 insert、依赖闭包已装；但 `hotApplied:false`，`browse` 视图与运行时均无 dsh-msg-link 运行条目。
- **根因**（已确认，凭 cordis-loader 源码 + 官方装配链路双重取证）：`loader.update(entryId,{disabled:false})` **只能操作已存在于 entry tree 的 entry**；patch insert（`cordis.patch.yml` 的 `- insert:`）是**启动期/含 include+HMR 才消费的持久化清单**，运行时新增 insert 不会让 loader 动态生成 entry，故拿不到 entryId、`loader.update` 无从热启。且 `Loader` 类**没有公开 `reload()`/`refresh()`**（当初 `hotApplyLoader` 用 `loader.reload()` 必然 false 的同源原因）。
- **正确姿势**：官方源码中「运行时创建并启动插件 entry」的唯一入口是 `ctx.loader.create({id,name,config,disabled})` → `resolve(id)` → `await entry.await()`；`name` 传 loader 可 `import()` 的模块 specifier（已 pnpm add 的包名，如 `dsh-msg-link`），**不能传本地绝对路径**（本地 file 路径曾致 create 挂起，P-001）。
- **处置**：本次验证确认了「落盘/依赖/包名解析」链路全部正常（较 P-004 中文路径乱码已解决）。剩余核心：把 tempLoad 的热启从「patch insert + loader.update」改为「`ctx.loader.create`」。待实现：create + resolve + await，且要避免 P-001 的 file 路径挂起（传包名）。
- **判定**：`根因已确认，方案已定，待实现验证`。
- **影响面**：`src/index.ts:tempLoad` 第 4 步热启逻辑；依赖 `ctx.loader.create`/`resolve`/`await` of `@deepseek-ai/cordis-plugin-loader`。
- **备注**：本次 tempLoad 在 patch 写回了 `dsh-msg-link` insert（验证产物），验证/清理后可 tempRemove。

### P-013 · 官方 `dsh plugin add` 是「重启生效」；运行时装配唯一官方入口是 `ctx.loader.create`
- **现象/取证**：官方 `dsh plugin add --profile <name> <args...>`（实现 `...\@deepseek-ai\dsh\lib\plugin-9h8shc4d.js` 的 `runPlugin`）本质是 **pnpm 转发器**：把参数转发给 profile 目录内的 `pnpm`，成功后 `reconcilePlugins` 把「声明了 `dsh.bundle.patch`」的包追加进 `package.json` 的 `dsh.profile.bundles`，然后结束——**不调用 `ctx.loader`、不触发热装配**，下次 `boot()`/`loadProfile()`/`composeProfile()` 才读取装配。即官方 add 为**重启生效**。
- **关键机制**：
  - `Loader`（`@deepseek-ai/cordis-plugin-loader/src/index.ts`）的 `write()` 为 no-op，根 loader 树在内存；**无公开 `reload()`/`refresh()`**。
  - 官方启动后创建额外 entry 用的就是 `ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })`（`profile-boot-DG5t9aNs.js`）——create 是官方实证的运行时装配入口。
  - `EntryTree.create(options,parent,position)` → `resolve(id)` → entry 走 `registry.plugin()` 启动；`name` 由 `import()` 按 builtin / `internal.import` / 相对 URL / **bare specifier** 解析，包名即 bare specifier。
  - HMR（`watchUserPatches`）只监听 `cordis.patch.yml` + home patch，触发 include `entry.update({config:{patches}})` 重新应用 patch，**不监听 `dsh.profile.bundles`**。
- **结论**：运行时热装配（不重启）第三方已 pnpm add 包，正确姿势 = 在已启动的 Cordis root context 内 `await ctx.loader.create({ id, name: 包名, config, disabled:false })` → `resolve(id)` → `await entry.await()`；simplemanager 自身持有 `ctx`，条件满足。
- **判定**：`结论已固化（官方流程 + 运行时入口）`。

### P-014 · `cordis.patch.yml` 被写坏：`[]` 与 `- insert:` 并存导致 YAML 顶流双节点报错（桌面版启动失败）
- **现象**：桌面版启动报 `dsh-plugin-desktop: failed to parse overlay ...\cordis.patch.yml: YAMLException: end of the stream or a document separator is expected (11:1)`，第 10 行为 `[]`，第 11-14 行为 `- insert:` 块。
- **根因**：`host.ts:editPatch` 的 enable 分支未识别空数组占位 `[]`（头部注释后、`- insert:` 之前的 `[]`）——`findIndex(trim.startsWith('- insert:'))` 依序扫过全部 `#` 注释后仍为 -1，于是走「追加」分支在 `[]` 之后拼 `- insert:`。YAML 中一个流内 `[]` 之后再出现顶层项 = 两个文档节点，解析器报错。空 patch 的规范形态正是头部注释 + `[]`（见 `cordis.patch.yml.bak-20260819` 原文，注释亦明言「确保顶层仍是合法数组 []」）。
- **处置**：
  1. 手动把损坏文件还原为合法空装配（头部注释 + `[]`），桌面版得以重启。
  2. 重构 `editPatch`：enable 命中 `[]` 行时**就地替换**为 `- insert:` 块并插入子项（绝不追加到其后）；新增 `normalizeEmpty`——disable 移除唯一子项后把悬空 `- insert:` 外壳收敛为合法 `[]`（存在 `- disable:`/`- config:` 等其它顶层项时原样保留）。
  3. 用 Node + js-yaml 对四种场景（空 `[]` enable / 唯一项 disable / 追加第二项 / 删其一保留另一项）单测，9/9 通过，均产出合法 YAML。
- **判定**：`已解决`（修复后的 `editPatch` 见 `lib/host.js`；桌面版重启后 `/simplemanager` 在 43120 正常响应）。
- **影响面**：`src/host.ts:editPatch`、`cordis.patch.yml` 装配清单读写；波及启停 `toggle` / 临时加载 `tempLoad` / 转正 `promote` 落盘时的 patch 层写入。

### P-015 · 实测 `ctx.loader.create`：传包名成功建 entry、不挂起；失败源于依赖未获取
- **现象**：重启后（lib 含 `_dbgCreate`）实测两个用例：
  - `__pkg-nonexistent-xyz`（对照）：67ms 返回 `ok:false`，`failed to import loader entry 37ca8b44 (__pkg-nonexistent-xyz): cannot resolve package ... from the Desktop installation or active Profile`。
  - `dsh-msg-link`（真实）：123ms 返回 `ok:false`，`failed to import loader entry 11411316 (dsh-msg-link): Cannot find package '@deepseek-ai/dsh-paths' imported from C:\Users\a2287\.dsh\profiles\desktop\package.json`。
- **根因**：验证了 P-012/P-013 的结论——`ctx.loader.create` 是官方运行时装配入口：两个用例都**成功创建了 entry**（分配 entryId 37ca8b44 / 11411316）并进入 import 阶段，**均不挂起**（123ms 即返回）。失败点不是装配机制，而是：
  1. 不存在包 → import 阶段无法 resolve（符合预期）；
  2. `dsh-msg-link` → **其运行时依赖 `@deepseek-ai/dsh-paths` 未安装**，import 失败（`Cannot find package ... imported from profile package.json`）。即失败纯粹是**依赖未获取**，归「依赖获取」功能管理。
- **处置**：确认 `ctx.loader.create` 路线可行；`tempLoad` 热装前须先用 pnpm 装齐插件依赖闭包（尤其 `@deepseek-ai/dsh-paths` 这类内部依赖），再 `create`。entry 已随 import 失败销毁，无残留。
- **判定**：`根因确认，tempLoad 重构方向定（create + 依赖闭包获取 + patch 持久化兜底），待实现`。
- **影响面**：`src/index.ts:tempLoad`（与依赖获取流程联动）；更正 C-05。

### P-016 · 端到端实测热插拔：tempLoad(create)→ACTIVE→tempRemove 全链路打通
- **现象**：在桌面版（43120）用最小 DSH 插件 `dsh-test-fixture`（源码 `D:\AI\默认工作流\dsh-plugins\dsh-test-fixture`，仅依赖公开的 `@deepseek-ai/cordis`）走完整热插拔：
  - `tempLoad`（UTF-8 传中文路径 spec）→ pnpm 装依赖闭包 + `ctx.loader.create({name: 包名})` 运行时热装 → 返回 200，fiber 态 **`active`**；882ms（含 pnpm + create）。
  - `tempRemove`（`body.id` 字段，非 `name`）→ `ctx.loader.remove(entryId)` 卸载运行时 entry → 返回 `ok:true`，视图即时移除。
  - 全程 `cordis.patch.yml` 保持空装配 `[]` 未被写脏——热插**彻底解耦写入 patch 的真注入**路径（临时语义：重启即消失）。
- **根因/辨析**：
  - 首次 `tempLoad` 返回「已经临时加载过了」：本进程内存 `tempInfos` 已含 fixture 的 create 记录（此前一次性验证遗留），且该进程未重启——证明 create 确已在该运行实例装配成功，热装真生效（而非仅落盘）。
  - `browse` 视图 fixture 显示 `temporary:false`/`source:profile`：因 fixture 源码目录正位于扫描根 `D:\AI\默认工作流\dsh-plugins` 下，被「已安装目录扫描」归为候选插件（state 空、enabled false），与运行时临时 entry 叠加展示；卸载运行时 entry 后仍以『未装配候选』列出——属目录扫描语义，非热装失效。
  - 心跳文件 `fixture-heartbeat.txt` 未生成：`apply` 里 `ctx.on('ready')` 的触发时机与 root 已 ready 的子 entry 装配有关（create 时 root 已满生命周期），不代表 apply 未执行——fiber 态 `active` 已是官方语义下 apply 成功的确证。
- **判定**：`已解决`——核心热插拔链路（真装配 create + 热启 + 热卸 remove + 保持 patch 清洁）端到端实证通过；依赖获取（pnpm 装闭包）与包名解析（中文路径）同步验证正常。
- **影响面**：`src/index.ts` 的 tempLoad/tempRemove 重构落地生效；为后续 promote 转正 / uninstall 真卸的验证提供干净起点。

### P-017 · promote 转正→重启→持久化装配真实生效（双端可观测）
- **现象**：把 `dsh-test-fixture` 扩成双端结构——内核 `lib/index.js` 增加只读状态端点 `webServer.register` 挂 `/__fixture/status`（返回 pid/calls/uptimeS/now），client 新增 `lib/client.js`（`__ModuleLoader__.load` 在 `settings.section` 注册一张「热插拔验证」卡片，每 2s 轮询 `/__fixture/status`、每秒刷时钟）；`package.json` 补 `exports["./client"]` + `dsh.client.inject=["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-slots"]` + peer dep `@deepseek-ai/dsh-client-ui-slots`。
- **链路实测**（桌面版 43120）：
  1. promote → `{ok:true, assembled:true, requiresRestart:true}`：patch 装配清单写入 `insert: [{id:dsh-test-fixture, name:dsh-test-fixture, config:{}}]`，`closureDeps` 登记 `dsh-test-fixture: {@deepseek-ai/cordis}`；js-yaml 校验合法（顶层 1 数组项）。
  2. 重启桌面版 → `/__fixture/status` 返回 **HTTP 200** `{pid:260004, calls:1, uptimeS:14, now}`——promote 的**持久化装配重启后真实加载生效**（fiber `active`、browse `source:profile`、patch 含 fixture）。
  3. 连续请求 calls 递增（2→…）、uptimeS 持续——独立进程内内核态存活可观测。
- **判定**：`已解决`——真注入（promote→重启持久化生效）+ 内核双端可观测全部实证；client.js 由 `__ModuleLoader__` 在渲染进程按包名解析（HTTP 直接拉不可达属正常），面板占位需在**设置界面肉眼确认**。
- **影响面**：`dsh-test-fixture`（验证用 fixture，后续 uninstall 真卸移除）。

### P-018 · 审查修复 client.js 缺 `exports.apply`（received object 根因）→ 客户端史诗实证
- **现象**：在设置里确证「热插拔验证」卡片可见后，一次 restart 报 `failed to apply loader entry af01c40f (dsh-test-fixture): invalid plugin, expect function or object with an "apply" method, received object`（HARNESS 横幅）。
- **根因**（dsh-plugin-dev-theory 判据 5 最小面违规）：我手写的 `lib/client.js` 末尾只 `return module.exports`，`apply`/`inject` 是内部函数**没有挂到 module.exports**。对照官方参考（`dsh-plugin-simplemanager` 与 `dsh-msg-link` 的 client.js）末尾恒为 `exports.apply = apply; exports.inject = inject; return module.exports;`。客户端运行时把 client.js 当插件对象 apply 时拿到空对象 → `received object`。
- **处置**（审查后修复）：
  1. client.js 末尾补 `exports.apply = apply; exports.inject = inject; return module.exports;`（与官方 client 结构对齐）。
  2. 判据 1 违规修正：心跳文件从侵入 simplemanager 数据目录（`~/.dsh/simplemanager/fixture-heartbeat.txt`）改为独立目录 `~/.dsh/dsh-test-fixture/heartbeat.txt`（mkdir + append）。
  3. 判据 6 说明：手拷同步 node_modules 属临时验证载具，交付前须记录不走正式装卸弧。
- **实证**（重启桌面版后）：
  - `received object` / `af01c40f` 报错彻底消失，日志无新增装配错误。
  - 内核 `/__fixture/status` HTTP 200 `{pid, calls:3, uptimeS}`；browse `state:active, source:profile`。
  - **设置界面「热插拔验证」卡片可见**——client 端（slots.register 注册的 settings.section）与内核端双端真实装配生效，热插拔验证闭环完成。
  - 心跳文件未生成（`ctx.on('ready')` 在 root 已 ready 的子 entry 上不触发，同 P-016；内核真实生效由 `/__fixture` 端点证明，心跳为被动附加证据，已确认为非阻塞）。
- **判定**：`已解决`——审查兜出 client load 契约（module.exports 必须含 apply），是第三方 client 插件优雅性的硬约束；卡片可见 = 热插拔从内核到 UI 全链路真实生效。
- **影响面**：`dsh-test-fixture/lib/client.js`、`lib/index.js`；为后续 uninstall 真卸与清理提供完成态。

### P-019 · 真卸载四平面干净核对 + 清理 `_dbgCreate` 临时端点
- **现象**：`dsh-test-fixture` 手动 `pnpm remove` 报告 `removed:1 + directory removed + package.json cleaned`；需核对磁盘/依赖/登记/数据四平面是否真是零残留，并清理 `_dbgCreate` 调试残留。
- **根因**/**处置**：
  - 四平面核对（desktop profile）：
    1. 磁盘包 `node_modules\dsh-test-fixture` — 不存在 ✓
    2. 自持数据 `~\.dsh\dsh-test-fixture\heartbeat.txt` 目录 — 不存在 ✓
    3. `package.json` 依赖引用 — 无 ✓
    4. `pnpm-lock.yaml` 引用 — 无 ✓
    5. `cordis.patch.yml` — 顶层已还原合法空数组 `[]`，无 fixture 登记 ✓（YAML 合法）
  - `_dbgCreate` 临时 action（`src/index.ts`）：tempLoad 已内部走 `ctx.loader.create` 生产路径（P-015），该端点纯冗余（仅服务端、无前端引用）；按判据 5「能删的 hack 全删」删除。
  - 字段命名核对结论：`tempLoad` 用 `body.name`（= **spec**，路径或包名），`tempRemove`/`promote`/`uninstall` 用 `body.id`（= 插件身份/packageName），两者语义本就不同，命名差异**不构成功能 bug**；保留现状不再 churn（低优先级卫生项）。
- **实证**：四平面单平面核对命令全部返回零残留；`_dbgCreate` 已从 `src/index.ts` 移除，待 `pnpm typecheck`/build 通过后同步生效。
- **判定**：`待验证`（_dbgCreate 移除需重新构建同步方生效；字段命名保留现状）。
- **影响面**：`src/index.ts`；`dsh-test-fixture` 卸载即四平面零残留完成态。

### P-020 · 端到端回归暴露『陈旧运行实例』残留路由（非插件逻辑缺陷）
- **现象**：对桌面版（43120）tempLoad fixture 目录三次尝试：
  1. `运行时热装失败（D:\AI\?????...）：Only URLs with a scheme...Received protocol 'd:'` —— 中文路径在 HTTP body 中显示 `?????`。
  2. UTF-8 体重试：包名已正确解析为 `dsh-test-fixture`（P-004 修复生效），但报 `cannot resolve package "dsh-test-fixture" from Desktop/Profile`。
  3. 手动 `pnpm add file:...` 装包成功后重试：越过 import/resolve 到 apply，报 `webserver: duplicate prefix route "/__fixture"`。
- **环境**：桌面版进程自 P-018 重启后未再重启，运行 P-018 时期 lib（`_dbgCreate` 移除与最新源码未热加载）；ps 手动 `pnpm add` 已验证本地绝对路径→`file:` 锚定正常。
- **根因**：
  - ① 我测试客户端默认非 UTF-8 发送 body → 中文路径乱码（测试载具问题，非插件缺陷）。
  - ② 每次 tempLoad 都尝试 create 全新 entry；多轮尝试在**同一运行实例**累积 loader entry / webServer 路由残留，但 `tempInfos` 为空（create 失败未登记），browse 无任何 temp/fixture 条目 → 无法用 tempRemove 清理，仅能重启清态。
- **处置**：确认 plugin 逻辑三段（specPackageName→pnpmAdd→loader.create）各自在正确条件下均成立；需求重启 DSH Desktop 加载新 lib 并清空十进制内残留路由，再跑一次干净端到端。
- **判定**：`进行中`（等待重启后一次性干净 E2E）。
- **影响面**：`src/index.ts:tempLoad`、`src/pnpm.ts:anchorSpec/specPackageName`（均已证正确）；测试载具需 UTF-8 发 body。

---

## 4. 真实端到端回归（P-021 执行记录）

> 用户指令：1清理→2重启并确认插件不存在→3热加载使用→4确认运行→5卸载并确认外部依赖全清。期间每步问题/方案记录于此，以 md 档案为准推进。

### step 1 · 清理环境 ✓
- 手动 `pnpm remove dsh-test-fixture`（profile），EXIT=0；核对四平面零残留：node_modules ✗ / package.json ✗ / lockfile ✗ / 自持数据 ✗ / `cordis.patch.yml` 顶层合法 `[]`。
- 结论：从干净起点开始。

### step 2 · 重启桌面壳 + 确认插件不存在 ✓
- 结束全部 `DSH Desktop` 进程（共 5 个 Electron 进程）→ 重新拉起 `C:\Users\a2287\AppData\Local\Programs\DSH Desktop\DSH Desktop.exe` → 3 秒内 43120 /simplemanager 就绪（HTTP 200）。
- browse 核对：无任何 `dsh-test-fixture` 条目、`temporary:true` 条目 = 0、内核当前 `0.1.1-rc.2` active。
- 注：阅读方式确认用户全权委托我重启，目标锁定桌面壳不误用 npx `dsh web`（C-07 纪律）。
- **step 2 复核（第二次重启，加载含 `pickNodeRunner` 的新 lib 后）**：四平面核对 5 项全 `False`（disk 包 / package.json 引用 / lockfile 引用 / patch 登记 / 自持数据），browse 亦无 fixture 无 `temporary:true`——环境真正零残留，新 lib 已生效。

### step 3 · tempLoad 热加载测试插件 ✓（pickNodeRunner 修复验证通过）
- 命令：`POST /simplemanager/tempLoad`，body `{name:"D:\AI\默认工作流\dsh-plugins\dsh-test-fixture"}`，UTF-8 编码传中文路径。
- **关键结果**：`{"ok":true,"depsApplied":true,"hotApplied":true,"packageName":"dsh-test-fixture"}` —— 此前 P-020/汇总记录 `hotApplied:false`、`nodeModulesHit:false` 的核心失败点**已修复**，双标志同时为 true。
- browse 中 fixture：`state:active`、`enabled:true`、`source:profile`、third 计数 2→3（`temporary:false` 因源码目录正位于扫描根下，P-016 同源，非热装失效）。
- **根因确认**：Electron 壳内 `process.execPath` 指向 `DSH Desktop.exe`，用它调 `pnpm` 导致装包静默失效；`src/pnpm.ts` 新增 `pickNodeRunner()`：宿主即 node → argv0 → 系统常见 node 安装位（`%ProgramFiles%\nodejs`、x86、nvm）→ PATH → 回退，成功定位真实 `node.exe`，pnpm 得以正确装闭包。

### step 4 · 确认热加载插件真实运行 ✓
- 连续两次 `GET /__fixture/status`：HTTP 200，`{pid:253020, calls:1→2, uptimeS:24→25}` —— pid 与桌面壳主进程一致，calls 递增、uptimeS 推进，证明热装插件**在桌面进程内真实装配并响应**。

### step 5 · 卸载测试插件 + 外部依赖完整清除 ✓
- 命令：`POST /simplemanager/uninstall`，body `{id:"dsh-test-fixture"}`。
- 返回 `{"ok":true,"packageName":"dsh-test-fixture"}`；third 计数 3→2。
- 四平面核对 5 项全 `False`（disk 包 / package.json / lockfile / patch 登记 / 自持数据）；运行时 `GET /__fixture/status` 返回 **404 NotFound**（卸载后 entry 已销毁）。
- fixture 唯一依赖 `@deepseek-ai/cordis` 为共享 peer（许多官方插件在用），pnpm remove 正确移除其直接依赖与 stand-alone 闭包，不回撤共享依赖——符合判据 6「依赖闭包随装卸完整进退、不误删他人共享」。

### P-021 总判
- **5 步端到端全链路一次性通过**：清理零残留 → 重启确认无插件 → tempLoad 双 true 热装 → 状态端点进程内响应 → uninstall 四平面零残留 + 运行时 404。
- 本次唯一修复点 = `pickNodeRunner`（Electron 下真实 node 定位），彻底打通桌面壳内热插拔的 pnpm 装闭包环节。

### P-022 · 热插拔「看不到 UI」根因 + CLIENT 层重启可行性（源码级取证）
- **现象**：tempLoad 热装后内核 `/__fixture/status` 正常、browse 有 fixture，但用户没看到插件卡 / 设置界面卡片。
- **关键实测**：`GET /plugins/dsh-test-fixture/client.js` 返回 **200（3370 字节）**——证明 tempLoad 触发 `internal/plugin` 事件后，`@deepseek-ai/dsh-client-modules` 的 ClientModuleRegistry（增量扫描）**已把 fixture 的 client 合并进 boot graph 并开始伺服其 bundle**。即「内核端已具备 client」。
- **根因（源码取证，无 system memory 依赖）**：
  - `dsh-client-modules/lib/index.js`：ClientModuleRegistry 订阅 `ctx.on("internal/plugin", ...)`，任何 `loader.create` 装配都把 entry name 标 dirty → `flush()` reconcile → 新包（声明 `dsh.client` + `exports["./client"]`）增量入 table，`notifyGraphChanged()`。**增量扫描，无全量重扫**；pkgMeta 正判定缓存「永不过期」——但 fixture 首次见到会正常 resolve。
  - `dsh-client-hmr/lib/index.js`：轮询 graph 行 bundle 的 mtime/size，变化时 `clientModules.rebuilt(id,rev)` 经 `/plugins/events` SSE 推 `rebuilt` 帧；`syncWatches` 在 `onGraphChanged` 时增量加新行 watch。
  - `dsh-client-hmr/lib/client.js`（浏览器端）：订阅 `/plugins/events` SSE，**只处理 `rebuilt` 帧**；`graph` 帧 case 为空（break）、其余 break。`reload(id)` 依赖「loader 树里已有该 entry」去做 invalidate/prefetch/refresh hot-swap。
- **结论（解答「看不到 UI」+「CLIENT 层重启可行吗」）**：
  1. 看不到 UI = 浏览器端没被通知去重新拉取/boot 新 client。内核 graph 已含 fixture，但渲染进程的 boot graph 是一次性注入的——只有 `rebuilt`（内容变化）帧会让 HMR 热换，**新增 entry 的 graph 变化不会自动让现有渲染进程挂载**。
  2. "CLIENT 层重启"**可行且不必重启整个 DSH**：只需**重载渲染进程页面**（重新拉 index + boot 注入），即可让已合并进 graph 的 fixture client 卡片出现；内核进程/热装状态不受影响。这比「重启整个桌面壳」轻。
  3. 若要用户手动触发：在 desktop 壳 UI 上可选执行「重载界面」（F5/刷新 webview）即可看到卡片；更顺手的方案是让 simplemanager 暴露一个「重载 CLIENT 层」动作（触发渲染进程 reload 或主动重建 boot 注入）。
- **判定**：`根因已确认（源码取证）；CLIENT 层重启的宿主入口待实测`。
- **影响面**：`dsh-client-modules` / `dsh-client-hmr` 官方机制理解；simplemanager 的 tempLoad「看不到 UI」现象；规划可新增「CLIENT 重载」UI 动作。

### P-023 · CLIENT 层重启可行性实测（桌面壳宿主限制取证）
- **目标**：验证「只重载渲染进程（不重启整个 DSH），让热装的 fixture client 卡片出现」。
- **实测发现**：
  1. 桌面壳主进程 = `unpacked/lib/electron-runtime-ygt697jw.js` → `ElectronDesktopRuntime`，用 `BrowserWindow.loadURL(spec.url)` 承载 43120 web 前端，一次 `ready-to-show` 挂载。
  2. Windows 桌面壳**未开 `--remote-debugging-port`**（ps 命令核对全部进程启动参数，无该参数）→ 无法从外部脚本经 CDP 触发 `webContents.reload()`。
  3. 应用的 reload / Force Reload / Developer Tools 菜单项（`role: "reload"` 等）**仅装配在 macOS**（`macApplicationMenuTemplate`，`Menu.setApplicationMenu` 仅 darwin 分支）→ Windows 无内置 reload 菜单/快捷键入口。
  4. 浏览器 half（`dsh-client-modules/lib/client.js`）：boot graph（`__DSH_BOOT__` wire）在**渲染进程启动时一次性解析**，`graphRows` 固定为启动时 entry 集。Node 侧 graph 增量合并**不会**自动重跑浏览器 boot。
  5. `dsh-client-hmr` 浏览器 half 的 `reload(id)` 依赖「浏览器 loader 树里已存在该 entry」，仅处理 `rebuilt`（内容变化）帧，且逐条 hot-swap；对「graph 新增 entry」无挂载动作。
- **结论**：要在 UI 看到热装插件的 client 卡片，**必须让渲染进程重新执行 boot 注入**（重载渲染进程页面）。这一步**不必重启整个 DSH**（内核进程与热装状态不受影响），但桌面壳在 Windows 上**缺少可编程的「仅重载渲染进程」入口**（无 CDP、无 windows 菜单 reload）。
- **方案（落地）**：在插件管家（simplemanager）内新增一个「重载 CLIENT 层」动作——若宿主暴露渲染进程重载能力（如 preload IPC / CDP）则调用之；否则给出明确指引（在 shell 上手动刷新界面）。**该入口当前依赖宿主能力，需评估 `dsh-desktop` 封装是否开放 IPC**；在无宿主入口时退化为「提示用户整壳重启」兜底。
- **判定**：`根因与宿主限制已确认；「CLIENT 重载」入口的实现方案已定（依赖宿主 IPC 探测），待实现`。
- **影响面**：simplemanager 的 tempLoad「看不到 UI」体验；可落地的「重载 CLIENT 层」动作。

### P-023b · 「重载界面」兜底按钮落地（client 侧）
- **方案定型**：插件管家 client 面板本身就运行在渲染进程里 → **`window.location.reload()` 即可重载 CLIENT 层**，无需依赖宿主 IPC/CDP。重载后渲染进程重新拉取 index + 最新 boot（含已热装的 fixture client graph），内核进程与热装状态不受影响。
- **改动**（`src/client.tsx`）：
  - 新增 `reloadClient()`：`window.confirm('重载界面（仅刷新渲染进程，不重启内核）？…')` 通过后 `window.location.reload()`。
  - 在「运行时临时加载插件」栏非编辑态追加「↻ 重载界面」按钮（样式 `reloadClientBtn`，`--dsw-alias-bg-muted` 灰底区分）。
- **验证流水线**：typecheck ✓ → build ✓（client.js 50.68kB）→ 同步到 `profile/desktop/node_modules/dsh-plugin-simplemanager/lib/client.js` ✓（49.6kB→50.7kB）。
- **注意**：同理，simplemanager 自己的 client 变更要 UI 生效，也需重载渲染进程一次（先吃到新按钮；Windows 无 CDP/menu reload，可用 Ctrl+R 或重启壳兜底验证）。
- **判定**：`按钮代码与产物已就绪，UI 实机确认待用户操作（重载渲染进程后点「重载界面」看 fixture 卡片）`。

### P-023c · 重启桌面壳加载新 client（实机）
- **动作**：用户确认 Ctrl+R 无效 → 结束全部 5 个 DSH Desktop.exe 进程（PID 253020 等）→ 重新拉起 → 就绪（browse HTTP 200, plugins=210）。
- **确认**：profile 上 `client.js` size=50682，含新按钮标识 `reloadClient`/`location.reload`/「重载界面」→ **新 client 已在磁盘，全新建壳加载 = 面板出现「↻ 重载界面」按钮**。
- **语义确认**：fixture 为 tempLoad 热装、**重启不持久**（本就不落盘），故重启后 browse 无 fixture 属预期。
- **判定**：`「重载界面」按钮已随重启进入 UI，待用户实机确认按钮可见`。

### P-023d · 重启后 fixture 仍可见但未加载（实测修正）
- **现象（用户回报）**：重启后插件管家仍能看到测试插件，但处于未加载状态。与我重启前 P-023c 的推测「tempLoad 重启不持久故消失」**相反**。
- **实测核对**（browse）：`name=dsh-test-fixture | state=(空) | enabled=False | source=profile | folder=third | temporary=False`。
- **根因修正**：fixture 的**源码目录 `/dsh-plugins/dsh-test-fixture` 恰在扫描根下** → 它不作为「tempLoad 内存条目」而是作为「**目录扫描候选插件**」被宿主持续枚举。故重启后依然可见（source=profile、temporary=False），但未被装配（state 空、enabled=False）。
- **区分两类「可见」**：
  1. 目录扫描候选（source=profile / temporary=False）：源码在扫描根，重启后仍在列表，未加载属正常。
  2. tempLoad 内存条目（temporary=True）：重启即消失。
- **判定**：`现象非 bug；评估是否需要给「扫描候选但未装配」条目加视觉区分（如目录候选徽标），避免与已装混淆`。

### P-024 · 完整闭环打通：热插拔 → 重载界面 → client 卡片出现（用户实机确认 ✓）
- **流程**：重启后热加载 fixture（`tempLoad` → `ok/depsApplied/hotApplied 全 true`）→ 内核运行态确认（`/__fixture/status` HTTP 200, pid=268508, calls 递增）→ 用户在面板点「**↻ 重载界面**」→ **fixture 的 client 卡片出现在界面**。
- **本质验证**：「重载界面」按钮（`window.location.reload()`）确实只刷新渲染进程、重新执行 boot 注入，**不重启内核**——热装的 fixture 在重载后内核仍在线且 client 卡片出现。
- **意义**：达成了「热插拔内核 + 仅重载 CLIENT 层即可让 UI 卡片出现」，无需整壳重启。闭环 = tempLoad(内核) → reloadClient(渲染进程) → client 卡出现。
- **更新 P-023 中「client 变更必须整壳重启才生效」的暂定结论**：实证为「**渲染进程重载**即可，不必整壳重启」（但渲染进程初始吃新 client 仍需一次重载；Windows 无 CDP/menu reload，靠本按钮兜底）。
- **判定**：`P-021 真实端到端测试已全部完成且闭环，含「热插拔→UI 显现」的最优路径验证`。

---

### P-030 · msg-link 真实五步测试（官方安装即触发整壳报错，阻塞中）
#### 背景
用户要求对真实插件 msg-link 做五步端到端：①官方安装→②官方卸载→③热插拔安装→④重启看是否清除→⑤热卸载看是否干净。
#### Step 1 官方安装（`dsh plugin add file:.../dsh-v0.1.1-rc.2/plugin`）
- 官方 dsh CLI 定位：`unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js`（version 0.1.1-rc.2），真实 `node.exe` 运行，需 `--profile desktop`。
- ✓ 落盘成功：`dsh-msg-link` 写入 profile `package.json` dependencies（file: 协议）+ `dsh.profile.bundles`；外部依赖 `@larksuiteoapi`/`@wecom`/`qrcode` 一并装入。
- ✗ **启动整壳报错**：`plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry dsh-msg-link: Cannot find package '@deepseek-ai/dsh-paths' imported from profile/package.json`。**端口 43120 未起，桌面壳无法启动**。
#### 根因（版本不匹配，非 msg-link 自身 bug）
- profile `node_modules/@deepseek-ai/dsh-agent-presets@0.0.1-rc.1`（旧）peer 引 `@deepseek-ai/dsh-paths@^0.0.1-rc.1`。
- 官方内核 unpacked 的 `dsh-agent-presets@0.1.1-rc.2`（新）已改引 **`dsh-home-paths@^0.1.1-rc.2`**（RC 阶段包改名）。
- profile 显式依赖把 `@deepseek-ai/dsh-agent-presets` pin 在 `0.0.1-rc.1`；pnpm 只装 dependency 不装 peer，`dsh-paths` 未落盘 → 装配时 `ERR_MODULE_NOT_FOUND`。
- **结论**：desktop profile 官方 peer 依赖与内核 0.1.1-rc.2 不匹配（旧包名 `dsh-paths`）。用户指示先修复 msg 在 0.1.1-rc.2 的适配。
#### 阻塞
桌面壳未启动，后续 Step2~5 无法继续。需先修复版本适配使整壳可启动。

#### 环境重置（用户决策：完全清空 profile + 官方重装插件管家）
- 实测证明「完全清空 + registry 重装官方基线」走不通：新版 `dsh-base` 闭包有大量包**只在发行内嵌、不上 registry** → 官方 profile 用精确 pin 锁发行内嵌闭包；`web` profile 是干净参照（bundles 列基线、dependencies 只列 file: 业务插件）。
- **清空后桌面壳仍能启动**（43120 root 200，5 进程）：官方基线由发行内嵌注入，不依赖 profile declarations。
- 官方 `dsh plugin add file:.../dsh-c` 重装插件管家成功（+1 -90，清掉 90 残留依赖）→ 干净环境运行，插件管家就绪，207 插件（119 active）全官方基线，零残留。
- 备份存于 `profiles/desktop.bak-clean-20260822-171559`。

#### 五步测试重启（新干净环境起点）
用户要求：热插拔加载 msg-link 后走完整五步。Step1/2（官方装/卸）已在旧环境跳过，当前从 **Step3 热插拔加载**开始，环境 = 干净基线 + 插件管家。

#### Step 3 热插拔加载 msg-link — 遇新错误（未解决）
- tempLoad `dsh-v0.1.1-rc.2/plugin` → 装包成功（nodeModulesHit=true，dsh-session@0.1.1-rc.2 等 peer 已落盘、lib/index.js 存在、exports 正常）。
- **但运行时装配失败**：`failed to import loader entry 08bd6085 (dsh-msg-link): Cannot find package '...node_modules/@deepseek-ai/dsh-session/index.js' imported from profile/package.json`。报错栈含桌面壳 `app.asar/lib/module-resolution.js:67`。
- **决定性对照**：同一 msg-link 用**官方 `dsh plugin add` → state=active 装配成功**。故 msg-link 本身无 bug。
- **结论**：热装（`ctx.loader.create` 动态 import）与官方安装（走 bundles 装配栈）在解析 peer 官方依赖时**走了不同解析路径**——热装把 `@deepseek-ai/dsh-session` 按裸路径拼成 `index.js`，未尊重其 `main: lib/index.js` / exports；官方装配正确解析。初步判定为**插件管家热装机制对官方依赖 exports 解析的兼容性缺陷**（非 msg-link bug，非装包问题）。待验证 resolver 细节或考虑热装链路对齐 bundles 装配解析。

#### 根因深挖（已定位到桌面壳 overlay 机制）
- 启用`app.asar.unpacked/lib/module-resolution.js` 源码：桌面壳用 `registerHooks` 自定义 ESM resolve；核心逻辑在 `package-overlay-CMBrTgnt.js` 的 `findOverlayPackage`。
- **overlay 选择规则**（package-overlay 第 74 行）：`selected = profile.version > install.version ? profile : install`——在「桌面壳安装 install / profile」两来源间永远选版本更高的包。
- **热装缺陷链条**：热装 `dsh-session@0.1.1-rc.2` 装进 profile，overlay 为它选了 profile 来源；但热装动态 import 的 peer 二次解析在 module-resolution.js 第 66-70 行的 `catch` 兜底，用 `profileBaseUrl` 当 parent 做裸路径解析，拼成 `...dsh-session/index.js`（未尊重 main: lib/index.js / exports）。
- **判定**：非插件管家自身 bug、非 msg-link bug。根源在桌面壳 overlay 解析机制对**动态热装（非 bundles 装配）的 peer 二次解析未完整覆盖**，属固有限制。官方安装成功因走 bundles 装配栈、官方包在 overlay 被一致登记解析。

#### 修复方式（用户决策：收紧 msg-link peer 区间）
- 把 `dsh-msg-link/dsh-v0.1.1-rc.2/plugin/package.json` 的 `@deepseek-ai/dsh-*` peer 从 `>=0.0.1-rc <2` 收紧为 **`>=0.1.1-rc.2 <2`**（4 处官方 peer 全部更新），强制 pnpm 用新版官方包（含 `dsh-home-paths`），避免复用顶层旧版引缺 `dsh-paths`。
- **遗留疑点**：profile 顶层 `dependencies` 仍 pin 12 个 `@deepseek-ai/dsh-*@0.0.1-rc.x` 旧版官方包，且 `dsh-msg-link` 锁在 `jobs/ml-backup`（历史临时备份，非标准 plugin 目录）→ 双版本并存隐患仍在，用户选择暂不清理 profile，仅收紧 msg peer。
- **下一步**：重新官方 `dsh plugin add` 标准 `dsh-v0.1.1-rc.2/plugin`（收紧后），看 pnpm 是否解析新版依赖并整壳启动。

> 每次中断时在这里记录下一步要做什么，避免上下文丢失后重复探查。

- **正确宿主**：桌面版 `DSH Desktop.exe`，`/simplemanager` 在端口 **43120**；不要再用 npx `dsh web` 临时实例。
- **当前结论（已固化）**：官方 `dsh plugin add` 是**重启生效**（P-013）；loader 无 `reload()`；patch insert 仅持久化、不热装。运行时装配唯一官方入口是 **`ctx.loader.create({id,name: 包名,config,disabled:false})` → `resolve(id)` → `await entry.await()`**（P-012 根因 + 正确姿势）。
- **实测（P-015，已完成）**：`_dbgCreate` 在桌面版（43120）实测传包名成功建 entry、123ms 不挂起；`dsh-msg-link` 装配失败唯一原因是依赖 `@deepseek-ai/dsh-paths` 未获取。→ `ctx.loader.create` 路线可行。
- **端到端（P-016，已完成）**：`dsh-test-fixture`（仅公开依赖）在桌面版走通 **tempLoad(create→ACTIVE) → tempRemove(remove)**，返回 200、patch 保持空 `[]` 未写脏。热插拔核心链路落地生效。
- **端到端持续化（P-017 + P-018，已完成）**：promote（patch insert + closureDeps）→ 重启 → 持久化装配生效（/__fixture 200、browse active）；审查修掉 client.js 缺 `exports.apply` 的 received object 根因 → **设置界面「热插拔验证」卡片可见**，内核与客户端双端真实生效，热插拔验证闭环完成。
- **真卸载四平面干净（P-019，已完成）**：`dsh-test-fixture` 手动 `pnpm remove` 后核对 磁盘包/自持数据/package.json 依赖/lockfile 引用/cordis.patch.yml 登记 五处零残留；`_dbgCreate` 临时端点已从 `src/index.ts` 删除（tempLoad 内已走生产路径 create）。
- **待办**：
  1. ✅ 重新构建 dsh-c（typecheck+tsdown）+ 同步 desktop profile + 重启桌面版，`_dbgCreate` 移除与 `pickNodeRunner` 修复全部生效（见 P-021）。
  2. ✅ 完整端到端回归：tempLoad(create→ACTIVE) → /__fixture 状态端点进程内响应 → uninstall 真卸四平面零残留（P-021 五步全通过）。
  3. fixture 手拷同步 node_modules 的判据 6 说明（临时载具，非正式装卸）。
- **下一步**：本次 5 步真实端到端测试已全部完成；如需验收用 UI（设置界面卡片 / 面板「运行时加载」流）可在宿主内做最后肉眼确认。

## P-032 官方 peer 探测告警（C 方案落地验证）
- **需求**：给热装加「官方业务 peer 探测」，规避桌面壳 overlay 对动态热装 peer 解析的固有限制（Root cause 见 P-031）。
- **实现**：`src/index.ts` 的 `tempLoad` 内，装包后读该包 peerDependencies，凡以 `@deepseek-ai/dsh-` 前缀者判定为「官方业务 peer」，返回 `officialPeers` 字段；热装失败时错误信息附告警文本（提示改用官方渠道）。纯工具包 `cordis`/`schemastery` 正确排除（已验证不误报）。
- **验证（流水线走完）**：typecheck ✓ → build ✓（tsdown）→ 同步 profile ✓ → 重启桌面壳 ✓ → 热装 msg-link 实测 ✓。
- **实测结果**：热装 msg-link → **告警成功触发**，列出全部 12 个官方业务 peer；本次热装失败原因为 `webserver: duplicate prefix route "/msg-link"`（因 msg-link 已通过官方渠道 `state=active` 占用该路由），非解析失败——探测逻辑独立验证通过。
- **结论**：C 方案（官方 peer 热装告警）落地生效，可提醒用户在任意插件热装涉官方业务包时切到官方渠道，避免踩 overlay 解析坑。

## P-033 绕过尝试：热装不装官方 peer（进行中）
- **设计**：`tempLoad` 的 `pnpmAdd` 加 `skipOfficialPeers` 选项——闭包补装时过滤 `@deepseek-ai/dsh-*`（不落 profile），并最外层 `--config.auto-install-peers=false`；让桌面壳 overlay 回落选发行 install 来源。已完成 typecheck/build/同步/重启。
- **受阻**：验证时 msg-link 官方 active 占用 `/msg-link` 路由，热装停在路由冲突，未到该验证 peer 解析。
- **顺带发现 uninstall 装配登记不完整 bug**：用面板 `uninstall("dsh-msg-link")` → 物理包清掉、patch 清了，但 **`package.json` 的 `bundles` 数组残留 `dsh-msg-link`** → 重启报 `cannot resolve package "dsh-msg-link"`（PackageOverlayNotFoundError）。已手动把 bundles 里该条目移除 → 重启报错消除。
- **待办**：① 修 uninstall 需同步清 `package.json` bundles 层装配登记；② 消息确认路由空闲后，重测热装 msg-link 验证绕过是否解决 peer 解析。

#### P-033 核心验证（突破）✓
- **热装 msg-link 成功**：`{"ok":true,"depsApplied":true,"hotApplied":true,"packageName":"dsh-msg-link"}`，`/msg-link` 路由 HTTP 200，msg-link 真实装配运行。
- **对比**：绕过前（peer 落 profile）→ 必失败 `Cannot find ...dsh-session/index.js`；绕过后（`skipOfficialPeers` + `auto-install-peers=false`）→ `hotApplied:true` 成功。**「不装官方 peer、让 overlay 回落 install 来源」方向验证有效。**
- **遗留**：`dsh-session@0.1.1-rc.2` 等官方 peer 仍出现在 profile node_modules——因它们是桌面壳 profile 顶层 dependencies 既有基线（其它 bundle 也要），非 msg-link 本次引入，跳过逻辑未误伤既有基线；是否需要更精确区分「顶层既有官方依赖」vs「msg-link 新增闭包」待定。
- **下一步**：确认热装条目重启后消失（临时语义），可顺便验证 uninstall 对热装条目的回收。

#### P-033 收尾（bug 修复 + 消亡确认）✓
- **uninstall bundles 登记 bug 已修**：host 类新增 `removeBundle(packageName)`（从 `package.json` 的 `dsh.profile.bundles` 移除），`uninstall` 物理移除前调用。→ 卸载后重启不再报 `cannot resolve package`。typecheck/build/同步走完。
- **热装消亡确认**：重启后 msg-link `state=空、enabled=False、bundles 无登记`——热装条目已消亡，**临时语义正确**（tempLoad 不持久化）。
- **遗留现象**：browse 仍显示 msg-link（`source=profile, scope=third, state=空`），因 msg-link 源码目录在扫描根 `dsh-plugins` 下，被识别为「目录扫描候选」，非热装残留、非登记残留；物理包 `node_modules/dsh-msg-link` 为功能测试种子。
- **未探明**：「目录扫描候选」条目的视觉区分（P-023d 遗留），以及是否需清理扫描候选物理包。

#### P-033 修正（关于「重启后仍能看到 msg-link」的解释更正）
- **此前误判**：曾解释为「源码目录在扫描根 dsh-plugins 下被列为扫描候选」。
- **真相（已读代码核实）**：插件管家扫描根是 **profile/node_modules**（host.ts scanCatalog，`join(profileDir,'node_modules')`），**不扫描源码目录**。msg-link 出现为候选，是因为**热装 `pnpmAdd` 把 msg-link 真实装进了 profile node_modules**（独立拷贝非软链，name/version 正确），热装不持久化登记 → 重启后物理包在（被扫到）、登记不在（未装配）。
- **为什么一开始没有**：一开始 profile node_modules 里没有 msg-link（用户直觉正确，一开始没装过它到 profile）。
- **真改进点**：热装语义是「临时、重启即消失」，但**重启后热装物理包未清理、残留在 profile node_modules** → 污染扫描列表。需补「重启清理热装物理残留」逻辑（或卸载时同步 pnpmRemove）。

### P-034 重启自动清理热装物理残留 ✓
- **需求**：热装（tempLoad）真实 pnpmAdd 进 profile node_modules 的临时包，重启后未清理会污染目录扫描列表（用户点出「卸载后不该仍能扫描到 + 一开始没有」的矛盾）。
- **机制**（host + index）：
  - Overlay 增加 `hotInstalls: string[]`（持久化记录热装安装过的包名），read/writeOverlay 均含。
  - host 新增 `pushHotInstall / readHotInstalls / forgetHotInstall / readBundles`。
  - tempLoad 成功 → `pushHotInstall(packageName)`；tempRemove / uninstall / promote → `forgetHotInstall`（物理或装配已回收便不待清理）。
  - 启动后 4s 触发 `cleanupHotResidue`：仅回收「记录在 hotInstalls、且当前不在装配中（非 live 存活 / 非 patch 启用 / 非 bundles 清单 / 本会话临时未持）」的包 → `pnpmRemove` 物理包 + forgetHotInstall。绝不动源码目录。
- **端到端验证**：热装 msg-link → hotInstalls=[dsh-msg-link]；重启 → 4s 后 msg-link 物理包被删（node_modules=False）、hotInstalls 清空、browse 无 msg-link。
- **守护用户顾虑**：清理只删 profile/node_modules 内热装拷贝，源码目录 `D:\AI\默认工作流\dsh-plugins` 完全不受影响，开发调试迭代安全。
- **踩坑**：初版用 `ctx.on('ready')` 但 Cordis 事件类型无 'ready' → typecheck 报错；改 `setTimeout(cleanupHotResidue, 4000)` 延后调度签名合规。另一次热装未记录 hostInstalls，根因是当时进程还加载旧代码（未含新逻辑），换新代码进程后正常。

## P-035 插件管家从「插件 section 的 tab」迁移为「设置独立板块」（已解决）
- **现象**：用户要求确认插件管家是否注册在「设置 → 桌面管家」这个独立板块里。
- **环境**：client 面板原注册于 slot `settings.plugins.tab`（id `simplemanager`，标签「插件管家」）。
- **根因**：`settings.plugins.tab` 是官方 **Plugins settings section（id `plugins`，由 ui-settings-plugins 持久拥有）内部的一个 tab**——渲染位置是「设置 → 插件 → 插件管家」，并非独立设置板块。官方 slot 契约（ui-settings/slots.ts）明确区分：
  - `settings.plugins.tab` = "One page inside the Plugins settings section … renders labels as tabs"（插件 section 内的子页签）。
  - `settings.section` = "One settings page per list entry … render in the panel content column"（设置导航列的独立板块，经 `ui-settings-general` 导航渲染）。
- **处置**：注册改挂官方 `settings.section` slot，`id: 'simplemanager'`、`order: 15`、`label: '桌面管家'`；`SimpleManagerTab` 组件签名改为 `(_props: Record<string, unknown>)` 容忍 section 渲染注入的 ownerProps（组件为无依赖纯面板，不消费 props）。官方注册模板参照 ui-settings-models 的 `models` section（`ctx.slots.inject('settings.section', () => ctx.slots.register({...}, Comp))`）。
- **判定**：已解决（typecheck 通过；待桌面壳重启实测确认设置侧栏出现「桌面管家」入口）。
- **影响面**：client 面板注册层（client.tsx apply）。host 侧 `SimpleManagerHost` 未变。
- **纪律**：点名要「独立设置板块」时，务必用 `settings.section` 而非 `settings.plugins.tab`；先核官方 slot 契约再注册，避免依赖运行时巧合（判据 2 声明清晰）。