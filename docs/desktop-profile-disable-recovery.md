# DSH Desktop 对 bundle 的「禁用」落点：startup-recovery 与 plugin-management

> 结论先行：在 DSH Desktop 里「禁用某个插件（bundle）」并不会写进 profile 的
> `cordis.patch.yml` / `package.json` 装配层，而是写进 DSH Desktop **自己的应用层状态**
> 里。装配时按 `profileName` **精确匹配**应用这条禁用，导致「同名 profile 装不上、
> 换个名字就能装」的假象。排查插件在桌面端「装了却看不到」时必须先查这一层。

## 一、现象

插件已按标准方式装配（在 `bundles` 里、`file:` 依赖指向版本子目录、node_modules 就位），
但 DSH Desktop（active profile 为精确名，例如 `desktop`）里：
- 插件列表搜索不到该插件；
- loader 无它的装配 entry，也无它自己的报错；
- 把该 profile **改名 / 复制成另一个名字**后，却能看到插件管家并正常装载。

## 二、根因：DSH Desktop 两层「禁用 bundle」应用层状态

DSH Desktop 用两个 `profileName -> disabledBundles[]` 的映射来持久化「禁用」，
装配 profile 时按 profileName 精确套用：

| 文件 | 作用 |
| --- | --- |
| `%APPDATA%\DSH Desktop\startup-recovery\state.json` | **启动恢复层**。装配前 `loadRecoveryFilteredProfile` 读取，把命中的 bundle 从装配清单过滤掉。**这是最隐蔽、最常被忽略的一层。** |
| `%APPDATA%\DSH Desktop\plugin-management\state.json` | 插件管理层。同样是 `disabledBundles` 映射，独立生效。 |

结构（两者一致）：

```json
{
  "version": 1,
  "profiles": [
    { "profileName": "desktop", "disabledBundles": ["<bundle-name>"] }
  ]
}
```

### 精确名匹配是关键陷阱

DSH Desktop 只对 `profileName` **完全相等**的 profile 应用这条禁用。因此：
- 当前 active 是精确名 `desktop` → 装配时读取 `disabledBundles`，命中项被跳过 → 装不上；
- 同一份内容,只要 profile 目录更名为 `desktop.clear-backup-...` / `desktop2` 等不在映射里的名字 → 不套用禁用 → 能正常装载。

这解释了「复制出来就能用、原名就是不行」的所有困惑。

## 三、与 profile 装配层的关系（重要区分）

- **`cordis.patch.yml`**：profile 装配的 patch 层（insert / disable / override）。bundle 已在包内 patch 声明 `- insert: id: <plugin>` 时,这是“要装配”的声明,用例正常。
- **`cordis.yml`**：桌面壳装配清单,本例中通常为 `[]`,不决定禁用。
- **`startup-recovery / plugin-management`**：DSH Desktop 应用自己的「禁用」持久化,**独立于上述装配层**,优先级效果上相当于在组合后把这些 bundle 排除。排查顺序必须涵盖它们。

> 结论：**「禁用」不经 profile patch；桌面端查找禁用,要先看这两层 userData 状态。**
> 在 web / 普通 dsh 里这两个文件不存在,因此同样的插件在 web 端可用、桌面端不可用,
> 往往就是这里加了禁用。

## 四、完整排查 / 修复步骤

1. **先确认 active profile 名**：`%APPDATA%\DSH Desktop\profile-selection\state.json`
   的 `active` 是否为精确名。
2. **查两层禁用**：
   ```powershell
   Get-Content "$env:APPDATA\DSH Desktop\startup-recovery\state.json"
   Get-Content "$env:APPDATA\DSH Desktop\plugin-management\state.json"
   ```
3. **定位 entry**：找 `profileName == active` 的那一项,看 `disabledBundles` 是否含目标插件。
4. **清除禁用**：把该插件的名字从 `disabledBundles` 移除（或置空数组）。**改前务必备份原文件。**
5. **完整重启** DSH Desktop（不是 reload）,等它重新 `prepareDesktopProfile` 组装。
6. 若仍不行,再看 `%APPDATA%\DSH Desktop\logs\dsh-<date>.error.log`
   是否被 `PackageOverlayNotFoundError: cannot resolve package "<pkg>" ...` 之类的
   装配层错误提前中断（那是另一类问题——悬空 overlay 引用）。

## 五、历史踩坑记录（2026-08-26）

- `@anysearch/anysearch-dsh`：`plugin-management\state.json` 里 desktop 禁用了一个
  **已不存在**的包,`prepareDesktopProfile` 在 `resolveOverlayPackage` 抛
  `PackageOverlayNotFoundError`,导致整个 desktop 装配中断(`errors shown only once`)。
  修复：清空该悬空禁用。
- 真正的「禁用插件管家」藏在 **`startup-recovery\state.json`** 里：
  `profileName:"desktop", disabledBundles:["dsh-plugin-simplemanager"]`。
  这是「同名 profile 不能用、复制即能用」的直接原因。
  修复：置空该 desktop 的 `disabledBundles`。
- 排查中投入在 `file:` vs `link:` 依赖协议差异的调查、desktop 套多次重建——
  最终都被证明为次要/有效操作，真正的开关在 startup-recovery 的应用层禁用。

## 六、重构建议（软件侧）

理想情况下,DSH Desktop 应用不应把「禁用一个已不在装配清单里的包」当作致命错误，
也不应在 profile 只改名绕过时表现不一致。建议：
- `loadRecoveryFilteredProfile` 对 `disabledBundles` 命中的包做「存在性校验」,
  包已消失时静默忽略（而不是 `PackageOverlayNotFoundError` 中断装配）；
- 禁用状态的 UI 与落点统一（当前分散在 startup-recovery / plugin-management 两层,
  容易误判）。