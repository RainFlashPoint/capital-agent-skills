# DESIGN.md — capital-agent-skills 视觉/交互设计契约

> 本文件是本技能族产出的**网页类产物**的设计宪法。`design` 角色卡评审时以本文件为判定基准
> （没有则退回通用原则——本文件即那个"有"）。当前唯一消费者：`intake board`（需求树看板）。
> 未来其它可视化页（web-review 渲染页等）应继承同一套 token。

---

## 1. 风格方向（明确，非"clean minimal"）

**暖色编辑感 + neo-brutalist 硬投影**：奶油纸面、鼠尾草绿主色、墨绿文字、硬边 `0 2px 0` 投影（非弥散阴影）、8px 圆角。气质偏纸感档案、不偏科技 SaaS。**不做深色模式自动切换**（看板是阅读/标注场景，暖色浅底更合适）。

## 2. 色板 token（CSS 变量，单一事实源）

```css
:root {
  --bg:         #f6f1e6;  /* 页面底：暖奶油 */
  --panel:      #fffaf0;  /* 卡片/面板：奶油纸 */
  --ink:        #1f2d24;  /* 主文字：墨绿 */
  --muted:      #66776c;  /* 次要文字 */
  --line:       #d8cfbd;  /* 边线/分隔 */
  --green:      #6f925f;  /* 主色：鼠尾草绿（强调、选中、链接） */
  --green-soft: #d9e5cf;  /* 主色浅：选中底、verified 状态 */
  --radius:     8px;
  --shadow:     0 2px 0 rgba(31, 45, 36, 0.18);  /* 硬投影 */
}
```

### 2.1 status 语义色（叶状态机 captured→…→shipped）

| status | 色 token | 含义 |
|--------|----------|------|
| captured | `--muted` 灰底 | 刚收集，未细化 |
| shaped | `--blue #cddce2` | 已定形 |
| planned | `--yellow #f3d77a` | 已拆任务 |
| built | `--orange #df8a54` | 已实现 |
| verified | `--green-soft` | 已验证 |
| shipped | `--green` 实底白字 | 已交付 |

### 2.2 priority 色

`P0 → --danger #c75f5f` ·  `P1 → --orange` ·  `P2 → --yellow` ·  `P3 → --muted`。
`risk_level` 用小圆点：high=danger / medium=orange / low=muted。

## 3. 字体 / 间距

- **字体栈**：`-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`（系统 + CJK，零网络字体，可离线）。
- **字号**：标题 18px / 子域 15px / 叶 title 14px / 元信息 12px。最多两级强对比。
- **间距标尺**：8px 网格（4/8/16/24）。层级缩进每级 +16px。

## 4. 组件约定

| 组件 | 实现 | 规范 |
|------|------|------|
| 整体布局 | flex 左右分栏 | 左树（可滚动）+ 右侧常驻聊天栏；<768 右栏收为底部抽屉 |
| 树节点（三级折叠） | 原生 `<details>/<summary>` | domain→subdomain→leaf；零 JS 框架；键盘可达 |
| 叶卡（可选中） | `<article>` clickable | 显示 id / title / status 徽章 / priority pill / risk 点 / depends_on；点击=选中 |
| status 徽章 | `<span>` | §2.1 语义色，圆角 4px |
| coverage 条 | 顶部每 domain 一条 | **升级为进度分布条**（见 §8.1）：旧 shipped/total 单填充 → 按 STATUS_ORDER 全状态分段 |
| 右侧聊天面板（chatbot） | 自建 `chat.css`/`chat.js`（内联） | 头部=选中叶 id+title；消息区你/agent 气泡；底部输入框+发送；per-leaf 会话 |
| 消息气泡 | `.msg.user` / `.msg.agent` | user 右对齐 `--green-soft` 底；agent 左对齐 `--panel` 底+`--line` 边 |

## 5. 交互态（必须设计，不留默认）

- `summary` hover：底色 `--green-soft` 淡入。
- `summary` `:focus-visible`：2px `--green` 外框（键盘焦点可见）。
- **选中叶**（右侧聊天聚焦的那片）：左侧 3px `--green` 边 + 卡底 `--green-soft` + `aria-current="true"`；叶卡 hover 微亮、`:focus-visible` 2px green 框（键盘可选）。
- **聊天输入框** `:focus`：边框转 `--green`；发送按钮 hover/active 态明确。
- 折叠展开：`<details>` 原生；`prefers-reduced-motion: reduce` 时不加任何过渡动画。

## 6. a11y / 响应式

- 对比：墨绿 `--ink` on 奶油 `--bg` ≥ WCAG AA；徽章文字与底色同样达 AA。
- 键盘：原生 `<details>` summary 可 Tab/Enter；右侧意见层沿用 annotate.js 既有键盘行为。
- `aria`：树用 `role` 默认语义即可（details/summary 自带）；选中叶加 `aria-current`。
- **响应式**：≥768px 左右分栏（树 + 聊天栏）；<768px 单列，聊天栏收为底部抽屉/切换按钮（选中叶时弹出）。
- 动效：仅用 `opacity`/`background`，不动 layout 属性；`reduced-motion` 一律关。

## 7. 复用边界

- 看板 CSS/JS（token + 树/叶/徽章/coverage + 聊天面板）**全部内联**在 `board` 命令生成的 HTML 里（自包含、离线可开）。
- 仅运行时依赖 web-review 的 `server.py`（同目录托管 + `/feedback`/`/wait`/`/rev`/`/replies.json` 静态服务）——**不依赖** annotate.css/js（聊天面板自建，不复用批注层 UI）。
- 不引第三方 UI 库 / 模板引擎 / 网络字体（守可移植铁律：纯标准库生成、离线可开）。

## 8. 本特性新增（0.16.0 生命周期同步 + 看板重构）

> 复用 §2.1 状态语义色 + §2 token；以下是本期新增/收紧的组件规范，供 design 评审与 build 校准。

### 8.1 进度分布条（升级旧 coverage 条）
- 每 domain 一条 + 顶部一条全树总览。**按 STATUS_ORDER 分段着色**（captured→shipped 从左到右），段宽 = 该状态叶数占比，用 §2.1 各 status 色。
- 段悬停 tooltip 显示「状态名 · N 片」。整体 8px 高、圆角 4px、`--line` 描边。
- 旁注文字保留 `shipped/total`（最右段=已交付占比）。

### 8.2 live badge（在飞态叠加，惰性派生）
- 当看板读到 `STATE.source-leaf` 命中某叶 → 该叶 status 徽章旁叠加一枚 **live badge**：文案「⏳ <stage>中」（如"⏳ build 中"），底色用该 stage 映射 status 的 §2.1 色 + 1px `--green` 描边表"实时"。
- 动效仅 `opacity` 脉冲（`prefers-reduced-motion` 关）；**不动 layout**。
- 无 STATE / 无 source-leaf → 不渲染 badge（向后兼容纯文件 status）。

### 8.3 叶详情字段分组（§4 叶卡详情面板细化）
10+ 字段分 **4 组**，每组小标题（`--muted` 12px）：
- **身份**：id / title / status / priority
- **定位**：domain_path / old_system_ref / new_domain_path
- **关系**：depends_on（**渲染成可点链接**，点击选中并滚动到目标叶；仅在已知叶 id 集合内跳转）/ cross_link
- **交叉**：actor / failure_class / contract_refs / data_owner / risk_level
- 每个字段名带 `title` tooltip 说明含义（如 failure_class="该需求做坏会伤哪类：资金/一致性/合规/体验"）。

### 8.4 树导航增强
- **搜索框**（顶部）：即时按 id/title 过滤可见叶；空查询=全展开。
- **折叠记忆**：`<details>` 开合态存 localStorage，刷新/重渲染不丢。
- **面包屑**：选中叶时显示 `domain › subdomain › leaf`，各级可点回跳。
- **状态过滤**：点 §1 图例某状态 → 高亮/筛出该状态叶。

### 8.5 聊天面板状态提示（§4 chatbot 头部）
- 头部加**监听状态指示**：🟢「Live 监听中」/ ⚪「未监听 — 需 agent 切 live 才能实时对话」。
- 空消息态**引导文案**：说明何时能用、如何让 agent 切 live（占会话监听 `/wait`）。
