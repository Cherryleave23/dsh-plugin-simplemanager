# pm-manage 编排流程

本文件给出用 `pm_*` 工具完成「插件热装-调试-回收」闭环的最佳编排。工具明细见同目录 `tools.md`。

## 常用工作流（速查）

### 带前端的插件调试
```
pm_verifyPreflight → pm_tempLoad → pm_reloadClient → 调试 → pm_tempRemove
```
> 插件有 UI 板块、改动需要用户在面板上看见时用这条。预检确认安全 → 热装 → 刷新界面让新前端显现 → 调试完热拆回收。

### 不带前端的插件（纯逻辑/后端）
```
pm_tempLoad → 调试 → pm_tempRemove
```
> 纯内核/服务层改动，用户无需在面板查看。跳过预检和前端刷新，最简闭环。

## 闭环总览

```
preflight → tempLoad → (status/diagnose) → tempRemove 或 promote
                                    ↘ 若改动涉及前端 → reloadClient
```

## 标准流程

### 1. 热装前预检（任何一次热装都不应跳过）
对目标插件跑 `pm_verifyPreflight`（specs 传包名/路径/file:）。

- `outcome == pass` 才继续 tempLoad
- `pending`：注入服务不可达，会挂起 → 先修 inject 再装
- `crash`：会真实崩溃 → 先修代码再装
- 多个插件传入数组，一次预检齐

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
| 先确认安全 | `pm_verifyPreflight`（必做先行） |
| 装进运行时调试 | `pm_tempLoad` |
| 看现状/残留 | `pm_status` |
| 卸载临时 | `pm_tempRemove` |
| 保留为持久 | `pm_promote` |
| 彻底删除（含数据可选） | `pm_uninstall` |
| 刷新前端、让新 UI 可见 | `pm_reloadClient` |