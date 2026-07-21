# 合并 main → feat/workspace-team:方法论 + 当前状态

worktree:`/Users/elian/Documents/od-merge-wsteam-0722`,分支 `merge/main-into-ws-team`
2026-07-22。落后 main 120 个提交、领先 236、初始 **61 个冲突文件**。

> **compact 后先读这里,不要凭直觉推翻下面的裁决。** 很多裁决是查过规模/历史/符号后定的,
> 表面看反直觉(例如某些文件"取 main"、某些"取我们的",方向相反)。

---

## ⭐ 最重要的一条:用三方合并,不要整份取一边

我前期在几个大文件上"整份取一边",是错的。正确做法:

```bash
B=$(git merge-base HEAD origin/main)
git show "${B}:<path>" > /tmp/b.x     # 注意 ${B} 要大括号,$B:a 会被当成变量名 $Ba
git show "HEAD:<path>"  > /tmp/o.x
git show "origin/main:<path>" > /tmp/t.x
cp /tmp/o.x /tmp/m.x
git merge-file -L ours -L base -L main /tmp/m.x /tmp/b.x /tmp/t.x
```

效果对比(同一批文件):

| 文件 | 整份取一边的差异 | **三方合并的真冲突** |
| --- | --- | --- |
| `ChatPane.tsx` | 70 | **3** |
| `EntryView.tsx` | 一堆 prop 不匹配 | **0** |
| `FileWorkspace.tsx` | 语法全断 | **4** |
| `EntryShell.tsx` / `ProjectView.tsx` | — | **3 / 3** |

**大部分"冲突"其实是 git 没拿到 base 造成的假象。** 三方合并后剩下的才需要人判断。

---

## 每个真冲突问两遍

### 第一遍 —— 编译得过吗(符号还在不在)

- `FileOpsSummary.tsx`:我们那侧用的 `setUserToggled`/`setOpen` 全文**零处定义**(被 main 重构掉),取我们的直接编译失败。
- `InlineModelSwitcher.tsx`:反过来 —— main 只加一行 `chipRef` 声明,而**我们有 3 处引用**,只取我们的会少声明。→ 两侧都留。

### 第二遍 —— 我们的意图丢了吗(**静默,最容易漏**)

```bash
git diff $B HEAD -- <file>    # 我们到底改过什么
```

判断这些改动在对方的新结构上**还成不成立**:成立 → 重新应用;不成立 → 说明已被覆盖。

**真实案例**:`FileOpsSummary.tsx` 我们只改了两处图标尺寸(13→14、11→14)。main 重写了组件,那两行 JSX 不复存在。取 main **git 不冲突、typecheck 不报错**,只是图标悄悄小一号。已把尺寸重新应用到 main 的新结构上。

### 判断"取谁"的最有效信号:改动规模 + 提交历史

```bash
git diff $B HEAD -- <f> | grep -cE '^[-+]'          # 我们改了多少
git diff $B origin/main -- <f> | grep -cE '^[-+]'   # main 改了多少
git log --oneline $B..origin/main -- <f>
```

**方向可以相反,必须逐个量**:

| 文件 | 我们 | main | 裁决 |
| --- | --- | --- | --- |
| `OdCard.tsx` | **14** | **336** | 取 main 的重构,重新应用我们 5 处图标 13→14 |
| `AvatarMenu.tsx` | **574** | **10** | 取我们的重构,应用 main 的 #5379 修复 |
| `FileWorkspace.tsx` | 405 | 141 | 三方合并 |

---

## 已定裁决(不要推翻)

| 冲突 | 裁决 | 依据 |
| --- | --- | --- |
| **`tools/pack/package.json` vela-cli 版本** | **保留 `0.0.22-test.1`**,不要 main 的 `0.0.26` | **实测**:装了两个版本跑 `vela resource --help`,`0.0.22-test.1` ✅ 有、`0.0.26` ❌ 没有。取 main 会让打包出的客户端**整个协作面失效**(unknown command),且报错不像版本问题。根因:resource hub 从没进过 vela 的 main |
| `FileViewer.tsx` 工具栏「更多」菜单 | **两侧都留** | main 那块是 `@container (max-width:720px)` 的**窄屏兜底**,和 #5517 平铺**互补**。同 `@container` 里还有配套适配。菜单内「截图」项按产品决定去掉(`handleCopyScreenshot` 已随之删除) |
| `EntryShell.tsx` topbar | **取我们的**(#5517 无 topbar) | 产品选 C。核实过 `GithubStarBadge` 在侧栏账号菜单已有对应实现(`useGithubStars`),`WhatsNewPopup` 在 `EntryHelpMenu` 已有「更新说明」外链。`MessageCenter`/`AmrBalanceDialog` 产品说要,在 `ProjectView` 有挂载点 |
| 失败分类正则 ×3 | **合并正则** | 两边各有独有分支:我们 `request_too_large`、`no data received within configured window`;main `(?:stream\|upstream) idle timeout` |
| `state/config.ts` | **取我们的** | 迁移版本 3(#5517 accent)不能退回 main 的 2 |
| `App.tsx` | 取我们的重构 **+ 补 prop** | 26 个 prop 逐一比对,发现漏了 `onSilentUpdatePreferenceChange` |
| `EntryShell` provider 字段 | `model` → `preferredModels[0]` | main 把 `KnownProvider.model` 改成了 `preferredModels: string[]` |
| `FileViewer` 缺失声明 | 补回 `isDeckPreview` + `toolbarMoreOpen`/`toolbarMoreRef` | 版本面板改造时删了声明却留了引用;溢出菜单 JSX 保留了但缺 state |
| 19 个 i18n locale + `types.ts` | key 合并 | 合完校验零重复(唯一告警是正则把葡语文案 `'ex.: ...'` 误判为 key) |
| CSS(chat/composio/tools/routines/theater) | 两侧都留 | 样式规则可叠加 |
| e2e 用例 | 按**合并后的实现**判,不按"谁的测试" | 例:首页标题合并后是 main 的「今天想和你的 Agent 一起设计什么?」,断言要跟着改 |

---

## 坑

1. **"两侧都留"不能用在 JSX / `test()` 块上** —— 拼接会让标签或括号失配。这类必须择一或三方合并。踩中过:`AvatarMenu`、`OdCard`、`visual.ts`、3 个 e2e 测试。
2. **`${B}` 要大括号**,`$B:path` 会被 shell 当成变量 `$Bpath`。
3. **contracts 改完要 `pnpm --filter @open-design/contracts build`**,web/daemon 吃的是 dist,不重建会报"没有导出该成员"。
4. **daemon 测试要 Node 24**,Node 22 下 `better-sqlite3` 加载失败会产生数百个假失败。
5. 我的 JSX 深度统计脚本对跨行开标签(`<Button\n ... >`)会误判,**以 tsc 报错为准**。

---

## 收尾期新增裁决(2026-07-22 凌晨)

| 冲突 | 裁决 | 依据 |
| --- | --- | --- |
| **问答表单:侧栏 vs 内联** | **跟随 main(内联)**,删除 `QuestionsPanel.tsx` + 它的 2 个测试 + Questions tab | main 的 **#5496**「make Studio discovery visual and inline」是刻意的产品演进,不是重构副作用。判据:main 的 `FileWorkspace` **完全不接** `questionForm` 系列 props(0 处),继续传等于传给没人接的洞;我们分支在 question-form 上 **零改动**(base→HEAD 只有 14 行,全在 fileOps/displayLabel)。保留侧栏 = 合回 main 时回退别人已合并的功能 |
| `FileWorkspace` tab 栏:设计文件 tab vs Pages 下拉 | **取我们的(设计文件 tab)** | **我一开始判反了**。`isProjectPageFile`/`pageFileNames`/`pagesMenuNode` 的计数 **base == main**(3/6/8/2)、**ours 全 0** —— 说明 Pages 下拉是 base 就有、**我们为对齐 #5517 有意删的**,main 在这块零改动。#5517 也是 design-files-tab(4 处)+ 无 pages menu(0 处) |
| `ChatPane` `activePluginSnapshot`+`activeDesignSystem` vs `appliedContextItems` | **取 main + 保留我们的 `highlighted`** | main 的 `AppliedContextItem` 是 plugin/skill/design-system 的**统一上位替代**;`highlighted`(chat-rail 高亮)是我们新加、main 无对应,两者正交 |
| `ProjectView` `questionForm` props vs `headerActions` | 取 main | 同问答内联;`MessageCenter`/`HandoffButton`/`EntrySettingsMenu` 是产品要的 |
| `AssistantMessage` `FileOpsSummary` 那一行 | **取我们的 `fileOps`**,但去掉 `streaming` prop | 我们的 #5517 意图(产出文件独立成块、Download 不藏在折叠里)成立;`streaming` 是 base 时代的 prop,main 重构后组件不再接 |
| `state/config.ts` 迁移 | **v1(protocol)+ main 的 v2(退役模型)+ 我们的 accent = 版本 3** | 合并一度只剩 v1+accent,**main 的 v2 整段丢了**(退役模型 id 替换)。补回后把 main 测试里 6 处 `toBe(2)` 改成 `toBe(3)` |
| `DEFAULT_ACCENT_COLOR` | **`#353535`**(我们的) | base/main 都是 `#c96442`,我们改成中性灰是对齐 #5517(`od-ui-5517/apps/web/src/state/appearance.ts:11` 同值),`#c96442` 已随之进 `LEGACY_DEFAULT_ACCENT_COLORS` |
| `cli.ts` `od collab` vs `od message-center` | **两套命令并存** | 互不相干的两个子命令;共同的 `const rest/let flags/try {` 骨架与收尾 `}` **各复制一份** |
| `NextStepActions.module.css` | 取我们的 + 补 #5517 的 `.toolboxRowDescription` | 距 #5517 只差 9 行,main 差 107 行 |
| `ChatComposer.onProjectMetadataChange` | 跟随 main:回调参数 `ProjectMetadata` → `Project` | base→HEAD **零改动**、base→main 10 处。测试断言相应多包一层 `metadata:` |

## 当前状态(2026-07-22 凌晨)

- **`pnpm typecheck` 全仓 0 错误**
- **`pnpm guard` 71/71**
- **web 测试基线(合并前 HEAD):10 文件 / 26 失败** —— 存在 `/tmp/baseline.txt`
  - 基线既有:App.previewKeepAlive 3、FileViewer.srcdoc-reload-races 2、
    FileWorkspace.design-system 3、App.project-create-race 4、SketchEditor.save 9、
    NextStepActions 1、use-project-collab 1、collab-session 1、settings-access 1
- 合并后一度 31 文件 / 120 失败 → 现已修掉 config(6)、ChatComposer(7)、
  SketchEditor(9,顺手清掉的基线失败:Toast 用 `useT`,测试 i18n mock 没有它)
- 三个 agent 正在并行修剩余的 12 个新失败文件
- daemon 测试运行中

### 还没做

1. 等 agent + daemon 测试回来,确认无新增失败
2. **建合并提交** —— 注意 `.git/MERGE_HEAD` 已不在(之前被 reset 过),
   要手工 `git rev-parse origin/main > .git/MERGE_HEAD` 再 commit,
   否则 git 不认为 main 已合并,下次还要重解一遍
3. 推 `feat/workspace-team`
4. 端到端验证 workspace 功能
5. 打包 mac + win(`publish=false`,`amr_profile=feature-test`)→ R2

### 别忘了

- `tools/pack/package.json` 的 `@powerformer/vela-cli` 保持 `0.0.22-test.1`(实测过 `vela resource`)
- vela CLI test 包 `0.0.27-test.0` 若要采用,**必须重新实测 `vela resource --help`**
