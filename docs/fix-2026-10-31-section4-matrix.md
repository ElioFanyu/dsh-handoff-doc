# §4 验证映射：标题承诺了数据模型里不存在的字段

> 记录：2026-10-31
> 来源：人工预览 `tests/manual/preview.ts` 后由接手会话报告的观察
> 状态：**已修复（2026-10-31）** —— 按「从根本上解决」的要求改了渲染，不是改措辞

## 零、结论先说

原判断「需要给 `ProjectCommand` 增加路径维度」是错的：**目录维度本来就在 `origin` 里**，`readScriptsIn()` 构造命令时已经写成 `<dir>/package.json#scripts.<name>`。真正的问题只是渲染层把它丢了。

因此修复不碰数据模型，只改 `verificationMatrix()`：

- **子项目工作区**：按 `origin` 里的目录分组，左列是包名，直接回答「改了哪个包，跑哪个检查」。
- **单包工作区**（根 manifest，无子项目）：保持扁平，标题改为「改动后必跑」，不制造只有一组的伪分组。
- 两种形态的方向统一为 `命令 → 证明什么`，与 §0 的 `命令 — 预期：` 一致。

## 一、原来的现象

交接文档 §4 的小标题与它下面的每一行对不上：

```markdown
- 改动范围 → 必跑：
  - 全部检查通过（通常是类型 + 测试的组合） → `cd dsh-desktop-bridge && npm run check`
  - 全部检查通过（通常是类型 + 测试的组合） → `cd dsh-handoff-doc && npm run check`
```

标题说这一列是**改动范围**（「我改了什么」），但每行左边实际是 `proves`——「跑通了证明什么」。三个包各列一行，左列内容却完全相同，读者从中读不出「改了 A 就跑 B」。

## 二、根因在数据模型，不在渲染

`ProjectCommand`（`src/handoff-doc.ts:211`）只有四个字段：

| 字段 | 含义 |
| --- | --- |
| `command` | 精确命令行 |
| `origin` | 来源，如 `package.json#scripts.check` |
| `proves` | 跑通能证明什么，优先取源码原文 |
| `definition` | 脚本自身的定义 |

**但目录维度并非不存在**：`readScriptsIn()`（`src/project-facts.ts:203-210`）把来源写成 `${directory}/package.json#scripts.${name}`，`origin` 里已经带着包名，只是渲染层没读它。改前的 `verificationMatrix()` 只能把 `proves` 放在箭头左边：

```ts
lines.push(`  - ${entry.proves} → \`${entry.command}\``)
```

`describeScript()`（`src/project-facts.ts:309-317`）产出的是「脚本名推断」语义（`check` → `全部检查通过`），本来就适合放在右边。

## 三、为什么不只是「把箭头翻过来」

翻转箭头会得到 `命令 → 证明什么`，**和 §0 完全重复**：

- §0：`` - 命令：`npm run check` — 预期：全部检查通过 ``
- 翻转后的 §4：`` - `npm run check` → 全部检查通过 ``

同一份文档里两节说同一件事，§4 就失去存在意义。§4 的独立价值在于**「改了哪个包，就跑哪个包的命令」**。

## 四、实际修复（2026-10-31）

只改渲染层，**没有动数据模型**：

| 文件 | 改动 |
| --- | --- |
| `src/handoff-doc.ts` | 新增 `scopeOf()` 从 `origin` 提取目录；`verificationMatrix()` 按 scope 分组；抽出 `trailingRules()` 供两种形态共用 |
| `tests/unit/summary.spec.ts` | 原断言 `'全部检查通过 → …'` 改为新方向；新增 `groups the matrix by package when the workspace has sub-projects` |
| `tests/manual/preview-matrix.ts` | 新增，三种形态肉眼预览 |

子项目形态现在的输出：

```markdown
- 改动范围 → 必跑：
  - **dsh-desktop-bridge**
    - `cd dsh-desktop-bridge && npm run check` → 全部检查通过（通常是类型 + 测试的组合）
  - **dsh-handoff-doc**
    - `cd dsh-handoff-doc && npm run check` → 全部检查通过（通常是类型 + 测试的组合）
```

单包形态保持扁平，标题为「改动后必跑」，不制造只有一组的伪分组；两种形态方向统一为 `命令 → 证明什么`，与 §0 一致。

## 五、验证

- `vitest run` → **20 个测试文件 / 378 用例全绿**（原 377，新增 1 条分组用例）
- `tsc -p tsconfig.json --noEmit` 与 `tsc -p tsconfig.client.json --noEmit` → 无输出
- `tsdown` → `Build complete`，`lib/index.js` 176.99 kB
- `diff -q lib/index.js ~/.dsh/profiles/desktop/node_modules/dsh-handoff-doc/lib/index.js` → 一致（link 安装，无需重装）
- `preview-matrix.ts` 三种形态肉眼确认：子项目按包分组、单包扁平、无命令走兜底

## 六、一个坑，留给下次改渲染的人

`verificationMatrix` 这个符号在测试里**没有直接引用**，断言写在 `summary.spec.ts` 的 `renders the verification matrix in §4 from the discovered commands` 里，按字符串匹配。改渲染不会给出编译错误，只会静默改变输出——必须手动同步那条断言。本次已同步。

## 七、遗留

- 当前 `docs/handoff/deepseek-harness/HANDOFF.md` 仍是修复前的产物（§4 为旧格式）。**下次交接重写时会自动带上新格式**，无需手工回填；按 §0 的有效期规则，也不应该为了这处渲染改动去重写它。
- 宿主进程不热重载宿主半：若要让运行中的 DSH 用上新渲染，需重启宿主。
