---
role: client-dev
triggers:
  # Web (TS) —— v1 主战场
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.vue"
  - "**/*.svelte"
  - "**/*.css"
  - "**/*.scss"
  - "components/**"
  - "web/**"
  - "app/**"            # Next.js app router
  - "pages/**"          # Next.js pages router
  # 原生 / 跨端移动切片
  - "**/*.swift"
  - "**/*.kt"
  - "**/*.dart"
  - "ios/**"
  - "android/**"
  - "mobile/**"
---

# client-dev —— 客户端开发视角（Web + 原生移动）

> **语言细节(陷阱/测试/lint/LSP)不在本卡** —— 按改动扩展名加载 `references/languages/<lang>.md`(前端/移动常见 typescript / kotlin / swift,见 role-routing §7)。本卡只管客户端通用视角(bundle/re-render/offline-first/触控/无障碍)。

> 这是一张**职能视角知识卡**（不是流程）。被 `cap-build` / `cap-verify` / `cap-review`
> 在 git diff 命中上面 `triggers` 的 glob 时按需加载。它回答的是
> "**站在客户端开发的专业立场上，这次改动我该盯什么**"。
>
> v1 语言范围 = **Python + Web(TS)**；移动是**切片**（首批 dogfood agentic-config-demo 以 Web 为主），
> 但卡片把原生/跨端的要点一并备好，供命中 `ios/** android/** *.swift *.kt *.dart` 时使用。
> 卡内把 Web 段和"移动切片"段分开标注，路由命中谁就重点看谁。

---

## 关注点

客户端 = **用户能直接看见、点到、等到的那一层**。它的质量信号和后端不同：不是"算得对不对"，
而是"**渲染对不对、响不响、无障碍不、装在真机/真浏览器上崩不崩**"。按重要性：

1. **状态正确性优先于像素** —— 把"加载中 / 成功 / 失败 / 空"建模成**互斥的显式状态**，
   而不是 `isLoading/isError/hasData` 一堆布尔（会表达出不可能的组合）。每个异步操作三态齐全。
2. **渲染性能（最高频翻车）** —— 不必要 re-render、不稳定引用、`build()`/render 里干重活、
   fetch 瀑布（本可并行）、长列表不虚拟化。
3. **包体与加载策略** —— bundle 预算、按需 import 重库、路由级代码分割、图片懒加载/格式。
4. **无障碍 a11y 与语义** —— 语义 HTML / Semantics、键盘可达、对比度、触达尺寸、reduced-motion。
5. **服务端状态 vs 客户端状态分离** —— 服务端状态交给 Query/SWR，别 copy 进客户端 store；
   派生值用 derive，不冗余存。
6. **跨端/响应式一致性** —— 断点、溢出、触摸/hover、平台导航差异（Web 浏览器 / iOS swipe-back / Android back）。
7. **设计意图落地（反模板）** —— token 化、有设计感的 hover/focus/active 态、层级而非均匀强调。
8. **客户端安全边界** —— 不在客户端硬编码密钥/server secret、用户输入前端先验、HTTPS、不裸注入未净化 HTML（XSS）。

> 与 `design` 角色的边界：client-dev 管**"实现层"**（状态机、性能、可达性代码、跨端行为）；
> design 管**"观感与体验层"**（视觉方向、排版、交互编排、UX flow）。两者常一起被加载，
> 关注点互补不重叠——本卡只在第 7 点点到设计落地，深的交给 design.md。

---

## 检查清单

> 路由命中 Web glob 看【Web】，命中移动 glob 看【移动切片】，公共项两边都看。

### 【公共】状态建模
- [ ] 异步状态用 **sealed/union/枚举** 表达互斥态，不是布尔标志汤
- [ ] loading / success / error / empty **四态都被 UI 处理**，没有静默忽略的分支
- [ ] error 态**携带可展示信息**；loading 态不夹带过期数据；不用 nullable 当 loading 信号
- [ ] **服务端状态不被复制进客户端 store**；派生值用计算/选择器，不冗余持久化

### 【Web】渲染性能（蒸馏自 performance specialist 前端段）
- [ ] 没有 **fetch 瀑布**：可并行的请求用 `Promise.all`，避免父子请求串行
- [ ] 没有不稳定引用导致的 re-render（render 里新建对象/数组/内联函数当 prop）
- [ ] 昂贵计算有 `useMemo`/`useCallback`/`memo`（或对应框架的 selector/computed），但**不过度**
- [ ] 长列表**虚拟化**（react-virtual 等），不一次性渲染全部
- [ ] 没有 layout thrashing（循环里读后写 DOM 属性）

### 【Web】包体 / 加载（CWV：LCP<2.5s / INP<200ms / CLS<0.1）
- [ ] 没有引入已知重库（moment/lodash 全量/jquery）；用 deep import 而非 barrel import
- [ ] 路由级**代码分割**；重库**动态 import**
- [ ] 图片有显式宽高（防 CLS）、`loading="lazy"`（首屏外）、WebP/AVIF
- [ ] 字体 `font-display: swap`，只预加载真正关键的一种字重
- [ ] 动画**只动 compositor 友好属性**（transform/opacity/clip-path），不动 width/height/top/left/font-size
- [ ] 满足 bundle 预算（landing<150kb / app<300kb gzipped JS）

### 【Web】无障碍 & 语义
- [ ] 用**语义 HTML**（header/nav/main/section/footer），不是 div 堆叠
- [ ] 交互元素键盘可达、焦点顺序合理、有可见 focus 态
- [ ] 文本对比度 ≥ 4.5:1；色彩不是状态的唯一指示；尊重 `prefers-reduced-motion`
- [ ] 表单客户端 + 服务端双侧校验；错误字段给纠正提示

### 【Web】设计落地（反模板，蒸馏自 design-quality）
- [ ] 颜色/间距/字号走 **CSS 自定义属性 token**，不到处硬编码调色板
- [ ] hover/focus/active **是设计过的**，不是库默认
- [ ] 用**尺度对比建立层级**，不是处处均匀 padding
- [ ] 双主题时 light/dark 都显得有意图（不自动默认 dark）

### 【Web】安全边界
- [ ] 不把未净化内容注入 DOM（避免 `innerHTML` 类原始注入；必要时先经净化库）
- [ ] 不在前端硬编码 API key / server secret（用代理或编译期注入）
- [ ] 生产 CSP 配置存在；第三方脚本 async/defer + 必要时 SRI

### 【移动切片】Flutter / Dart（蒸馏自 flutter-dart-code-review）
- [ ] `build()` 里**无网络/IO/重计算/`.listen()`**；`setState` 局部化到最小子树
- [ ] `const` 构造尽量用（阻断重建）；list/grid 用 `ListView.builder` 而非一次性 children
- [ ] 状态对象**不可变**，`copyWith` 而非就地改；正确实现 `==`/`hashCode`
- [ ] 订阅/Stream/Timer 在 `dispose`/`close` 清理；async 回调后 `setState`/用 context 前查 `mounted`
- [ ] 避免滥用 `!`（bang）、滥用 `late`、宽 `catch`（无 `on` 子句）、漏 `await`（用 `unawaited` 表意）

### 【移动切片】原生 iOS/Android & 跨端（蒸馏自 mobile-app-builder）
- [ ] 遵循平台规范（HIG / Material）；用平台原生导航与返回行为
- [ ] **offline-first**：弱网/离线优雅降级 + 有意义的数据同步策略（默认要求）
- [ ] 敏感数据用平台安全存储（Keychain / EncryptedSharedPreferences），不明文
- [ ] 触达目标 ≥ 48×48；`SafeArea`/安全区处理；文本随系统字号缩放
- [ ] 冷启动、内存、电量在移动约束内（性能 profiling 用平台工具）

---

## 好的样子

- **不可能态不可表达**：看一眼状态类型就知道 UI 不会出现 "正在加载 + 已出错" 这种组合。
- **快得无感**：首屏不抖（CLS 低），交互即时响应（INP 达标），列表滑动不掉帧；
  打开 devtools/Lighthouse 没有红字，network 面板没有可并行却串行的瀑布。
- **键盘能走完整个流程**，开屏幕阅读器能听懂每个交互元素在干嘛。
- **token 一改全局生效**：换主题/调间距不是全局 find-replace 硬编码值。
- **真机/真浏览器跑得稳**：移动切片在真机不同 OS 版本不崩（crash-free 高），冷启动可接受，
  离线进去不白屏。
- **客户端不持有它不该持有的东西**：没有 server secret，没有把服务端状态抄进本地 store。
- 改动**只动它该动的那层**：业务逻辑不塞进 widget/组件，组件保持表现层纯净。

---

## 常见翻车

| 翻车 | 信号 | 正确做法 |
|---|---|---|
| 布尔标志汤 | `isLoading && isError` 可同时为真 | sealed/union/枚举建模互斥态 |
| fetch 瀑布 | 父组件请求完才发子请求 | 独立请求 `Promise.all` 并行；预取下一路由 |
| re-render 风暴 | render 里 `style={{...}}`/内联箭头函数当 prop | 提稳定引用 / memo / 窄化 selector |
| 包体失控 | 引入 lodash 全量 / barrel import / 不分割 | deep import + 动态 import + 路由分割 |
| CLS 抖动 | 图片无宽高 / 动态内容挤压布局 | 显式尺寸 + 占位；动画只用 transform/opacity |
| div 汤 + 无 a11y | 全是 `<div onClick>`、无 focus 态、对比度不够 | 语义元素 + 键盘可达 + 对比度 ≥4.5:1 |
| 把 server 态抄进 store | Redux/Zustand 里塞接口数据并手动同步 | 交给 Query/SWR；派生不冗余存 |
| 客户端藏密钥 | 源码里 API key / server secret | 后端代理 / 编译期注入；前端永不持服务端密钥 |
| 模板感 UI | 库默认 hover、均匀 padding、灰底白卡无层级 | token + 设计过的交互态 + 尺度对比层级 |
| **【移动】`build()` 干重活** | build 里发请求/排序/`.listen()` | 移到状态层；用 builder 列表；`RepaintBoundary` |
| **【移动】生命周期泄漏** | 订阅/Timer 不 dispose；await 后用过期 context | `dispose`/`close` 清理；用前查 `mounted` |
| **【移动】无视平台与离线** | 一套交互硬塞两端；断网白屏 | 平台原生导航/返回；offline-first 降级 |

---

## 介入哪些阶段

| 阶段 | client-dev 视角做什么 |
|---|---|
| **cap-shape** | 对前端/移动需求把"状态态、a11y、性能预算（CWV/bundle）、离线行为"写进 spec 的验收点；点出跨端差异 |
| **cap-plan** | 提醒任务拆出"状态建模 / 性能 / a11y / 跨端"独立验收项，而非笼统"做个页面" |
| **cap-build** | diff 命中前端/移动 glob → 加载本卡作为 TDD/实现时的自查镜（按上面清单写测试 + 实现） |
| **cap-verify** | 触发 **logic**（组件/widget 单测 + 覆盖率）；前端面改动触发 **journey（Web/App）模式**；用本卡判断 journey 旅程该覆盖哪些状态/断点 |
| **cap-review** | 命中即并行加载本卡 → 输出 `review/client-dev.md`：按"常见翻车"表逐条核，标 severity+confidence |

> 路由对照（见 `role-routing.md`）：`*.tsx/*.vue/*.css/components/**` → client-dev + design + e2e:Web；
> `*.swift/*.kt/*.dart/ios/**/android/**/mobile/**` → client-dev + design + e2e:App。
