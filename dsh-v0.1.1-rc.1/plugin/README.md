# dsh-plugin-simplemanager（插件管家）

> DSH-desktop 插件统一管理面板：内核版本看板 + 第三方插件管控，默认拆分「官方内置 / 第三方插件」，
> 支持自定义文件夹分类、拖拽移动、内联备注、一键启停（写入全局层补丁并实时热生效）、内核更新检测（仅提示，不自动更新）。

## 挂载点
- 进入 DSH-desktop **设置 → 插件**，新增独立标签页 **「插件管家」**（slot：`settings.plugins.tab`，id：`simplemanager`）。

## 架构（Host 数据层 + Client UI 层）
```
src/index.ts      Host 入口：webServer 装配 `/simplemanager` 数据/操作 API + loader 状态合并
src/host.ts       宿主数据层：内核版本读取、插件扫描、补丁启停、分类/备注 overlay 持久化
src/client.tsx    Client Panel：注册标签页 + 文件夹列 + 卡片网格 + 拖拽 + 内联备注（注册到 settings.plugins.tab）
src/shims.d.ts    client 侧宿主类型最小面（host tsc 不编译 client，由 tsdown/esbuild 打包）
```

## 数据来源
- 内核当前版本：`require.resolve('@deepseek-ai/dsh/package.json')`；失败降级扫描 Desktop 运行时
  `resources/app.asar.unpacked/node_modules`。
- 内核最新版本：npm registry 检测（`registry.npmjs.org` → `registry.npmmirror.com` 降级），TTL 缓存。
- 插件清单：官方内置来自运行时 `@deepseek-ai/dsh-*` / `@dsh/*`；第三方来自当前 profile
  `node_modules` 中声明了 `dsh.bundle.patch` 的 bundle（按 `desktopProfiles.current.dir` 定位 profile）。
- 启用状态：优先读 loader 实时 `entries()`（`moduleName → !disabled`），缺失时回落到全局补丁中是否加入。

## 自持数据
- 分类/备注 overlay：`~/.dsh/simplemanager/data.json`，原子写 + 备份。
- 字段：`folders`（自定义文件夹映射）、`assignments`（插件 → 文件夹覆盖）、`notes`（插件 → 备注）。
- 内置文件夹 `official`（官方内置）/ `third`（第三方插件）不落盘，分类规则见 `isOfficialName()`。

## API（webServer prefix `/simplemanager`）
| 端点 | 方法 | 说明 |
|---|---|---|
| `/kernel` | GET | 内核当前 + 最新 + 是否可更新（仅提示） |
| `/browse` `/refresh` | GET/POST | 完整状态：内核 + 文件夹 + 插件 + 备注 |
| `/toggle` | POST `{id}` | 启停：写入全局补丁 + 尽力热生效（loader.reload） |
| `/folders` | POST `{action, id?, name?}` | create / rename / delete 自定义文件夹（内置不可删） |
| `/move` | POST `{id, folder}` | 把插件移动到某文件夹 |
| `/note` | POST `{id, note}` | 读写备注（空值清除） |

## 启停设计说明（重点⚠）
- 按需求，启停**写入全局层补丁**：编辑当前 profile 的 `cordis.patch.yml` 的 `insert:` 数组（加入/移除 `- id:` 条目）。
  写前自动备份 `cordis.patch.yml.bak-<时间戳>`，采用临时文件 + rename 原子写，异常时保持原文件不变。
- **实时热生效**为尽力而为：优先调用 loader 的 `reload()`（重读装配后热加载）；若宿主持久层不配合，
  则保守返回 `hotApplied=false`，UI 提示「将在重启后生效」（落盘已生效，重启即生效）。
- 官方（`@deepseek-ai/dsh-*` / `@dsh/*`）插件默认只读展示为「已启用」，`toggleable=false`，不提供停用入口。

## 构建
```bash
pnpm install          # 含 unrun（tsdown 配置加载所需 peer）
pnpm build            # tsc（host 编译到 lib/）+ tsdown（client 打包到 lib/client.js）
pnpm typecheck        # 仅 host 类型检查
```
产物目标：`./lib/index.js`（入口）、`./lib/client.js`（浏览器 Bundle）、`./cordis.patch.yml`（bundle patch）。

## 安装
```bash
dsh plugin add ./dsh-c        # 以本地 bundle 安装（file: 协议，运行时依赖一并安装）
```
首次运行后进入 **设置 → 插件 → 插件管家** 即可使用。