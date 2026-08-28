# pm-manage — 插件热装调试操作指南

> 使用时机：你需要用 `pm_*` 工具对第三方插件做「热装 → 调试 → 热卸/转正」闭环，或判断一个插件当前的装配/残留状态时，才读取本技能。不涉及插件管理时无需加载。

## 一句话
`pm_*` 是插件管家暴露给你的插件热装调试工具。按其名称可猜作用：`pm_status` 查现状、`pm_tempLoad` 临时热装、`pm_tempRemove` 热卸、`pm_promote` 转正、`pm_uninstall` 彻底卸载、`pm_verifyPreflight` 预检、`pm_reloadClient` 刷新前端。

## 核心流程（务必遵循）
1. **预检先行**：任何热装前先 `pm_verifyPreflight`（传目标 spec），`outcome == 'pass'` 才继续。
2. **热装**：`pm_tempLoad`。成功后**用返回的 packageName 接续**后续所有操作。
3. **改名不慌**：同名二次热装返回名可能带 `-hotN` 后缀，是换键机制（复制临时副本绕开模块缓存）的预期产物，**不是错误**。继续用返回的新名。
4. **收尾二选一**：`pm_promote` 转正保留 / `pm_tempRemove` 热卸回收（目标残留为零）。
5. **前端可见**：仅当插件带前端板块、改动需用户在面板肉眼查看时，才 `pm_reloadClient`；纯内核改动跳过。

## 详参与易错点
本文件只给流程骨架；每个工具的完整语义、参数说明、换键细节、clearData 边界，按需读取同目录 `references/tools.md`。判定「何时用哪个工具」见 `references/workflow.md` 的速查表，按需读取。

> 原则：工具描述只给一句作用；细节在这里按需取，避免每个工具都全量灌给 model。