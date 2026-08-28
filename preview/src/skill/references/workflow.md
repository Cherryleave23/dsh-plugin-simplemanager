# pm-manage 编排流程

本文件给出用 `pm_*` 工具完成「插件热装-调试-回收」闭环的最佳编排。工具明细见同目录 `tools.md`。

## 常用工作流（速查）

### 带前端的插件调试
```
pm_probe(判定) → pm_tempLoad → pm_reloadClient → 调试 → pm_tempRemove
```
> 插件有 UI 板块、改动需要用户在面板上看见时用这条。拿不准能否干净启动时先 `pm_probe`（独立隔离实例实测）→ 热装 → 刷新界面让新前端显现 → 调试完热拆回收。

### 不带前端的插件（纯逻辑/后端）
```
pm_tempLoad → 调试 → pm_tempRemove
```
> 纯内核/服务层改动，用户无需在面板查看。直接最简闭环，无需判定与前端刷新。

## 闭环总览

```
(probe 判定,可选) → tempLoad → (status) → tempRemove 或 promote
                                    ↘ 若改动涉及前端 → reloadClient
```

## 标准流程

### 1. 判定插件能否干净启动（可选，用于拿不准时）
对目标插件跑 `pm_probe`（specs 传包名/路径/file:），用外置隔离实例真实实测「能否干净启动、是否渲染」，返回逐步报告与归因。

- `outcome == pass` 再继续 tempLoad
- `crash`/`hang`/`render-crash`：会真实崩溃/挂起 → 先修代码再装
- `keep` 模式判定通过后可保留隔离实例（返回 keptUrl 供人工检查）
- 多个候选传入数组，一次共存探针
- 纯逻辑常规改动可信赖 tempLoad 自带的门禁，不必每次 probe

### 2. 临时热装
`pm_tempLoad`，成功后**用返回的 packageName 作为后续一切操作的输入**（同名二次热装时可能带 `-hotN` 后缀，属正常，是换键机制的预期产物）。

### 3. 调试
`pm_status` 看运行态；改完代码重复「tempLoad」取新码：

- 同名热装会自动复制临时副本换键（新 realpath + 新 specifier），返回名可能变 `-hotN`，新代码必然加载
- 每次都用**最近一次返回的 packageName** 接续

### 4. 收尾二选一
- **转正**（要保留）：`pm_promote` → 写 patch，重启后仍生效
- **回收**（不要了）：`pm_tempRemove` → 拆 entry + 回收依赖，目标 = 残留为零

### 5. 前端可见（仅改动涉及前端板块时）
若插件带前端板块且改动需要用户在面板肉眼查看，`pm_reloadClient` 触发渲染进程刷新；纯内核改动跳过。

## 判断表：何时用什么工具

| 意图 | 工具 |
|---|---|
| 拿不准能否干净启动 | `pm_probe`（外置实例实测，可选） |
| 装进运行时调试 | `pm_tempLoad` |
| 看现状/残留 | `pm_status` |
| 卸载临时 | `pm_tempRemove` |
| 保留为持久 | `pm_promote` |
| 彻底删除（含数据可选） | `pm_uninstall` |
| 刷新前端、让新 UI 可见 | `pm_reloadClient` |