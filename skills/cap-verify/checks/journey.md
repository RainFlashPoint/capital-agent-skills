---
check: journey                   # 用户视角的端到端验证者,跨 Web / OpenAPI / App
triggers: [ "*.tsx", "*.vue", "*.css", "components/**", "**/api/**", "**/handlers/**", "*.server.*", "**/*.swift", "*.kt", "mobile/**", "ios/**", "android/**", "e2e/**", "*.spec.*" ]
produces: .cap/verify/journey-<scope>-report.md
---

# 验证项:journey（用户旅程端到端）

> 站在**真实用户**的视角,沿用户旅程把改动跑一遍:Web 用 Playwright MCP 点真页面,OpenAPI 用真实端点
> 正向跑用例(只读),App 用移动自动化(默认 Maestro,排最后)。失败不是终点——回 cap-build 定位源码、
> 改、重测,每个修复留 before/target/after 三联证据。产物:`.cap/verify/journey-<scope>-report.md`,
> 截图齐全、每条断言都标了证据等级。

本文是 cap-verify 的**验证项 playbook**(照做,不重抄进 SKILL)。引擎 = 一个能 Read/Edit/Bash/Grep 的模型
+ Playwright MCP。被 cap-verify 路由命中 journey 时加载,也可独立跑现状审计
(`/cap verify --check=journey --scope=full-chain`,兼作 cap-map 的 baseline 健康检查)。

---

## 这个验证项在乎什么

- **用户能不能完成任务**,不是"代码有没有跑通单测"。journey 验证的是旅程,不是 function。
- **第一眼与首动作**:页面 / 接口 / App 启动后,用户前几步有没有摩擦、有没有报错、有没有明确的
  "成功 / 失败 / 下一步"反馈。
- **真实条件**:真 auth、真错误处理、真网络往返、真空态 / 边界态——不验 demo path。
- **改了什么就验什么**:从 `git diff` 推导受影响的旅程,不盲跑全站。
- **证据,不是感觉**:每条结论必须挂可观察证据(截图 / 网络记录 / 控制台 / 断言输出),并标注获取方式
  (TESTED / PARTIAL / INFERRED)。
- **失败要能回到源码**:把"用例失败"翻译成"哪个文件哪行的问题",回 cap-build 修,而不是只报一句"页面崩了"。

## 检查清单

- [ ] 已 `git diff` 并据 surface-map 推出本轮要验的**模态**(Web / OpenAPI / App)与**旅程清单**。
- [ ] 已选定 scope(feature / iteration / full-chain),并据此圈定旅程范围。
- [ ] 工作树干净(脏树先按"修复闭环"前置处理,保证每个修复能原子提交)。
- [ ] 起好被测目标(dev server / API base URL / 模拟器),记下访问入口。
- [ ] 每条旅程都跑到**终态**(成功页 / 错误页 / 空态),不是停在中间。
- [ ] 每步留证据:Web=snapshot+screenshot+console+network;OpenAPI=request/response 对;App=screenshot+日志。
- [ ] 失败用例已回 cap-build 定位源码并修复,留 before/target/after 三联。
- [ ] 不能测的维度已**显式声明**(Scope Declaration),标 INFERRED,绝不猜成 TESTED。
- [ ] 报告写到 `.cap/verify/journey-<scope>-report.md`,证据 schema 完整。

## 好的样子

- 报告读起来像一份"我替用户走了一遍"的日记:每条旅程有步骤、有截图、有结论、有证据等级。
- 每个失败都配了"源码位置 + 最小修复 + 修复后截图",不是一句空泛的 bug 描述。
- "能测的"与"不能测的"分得清清楚楚;INFERRED 的项老老实实标 INFERRED,没有假装跑过。
- OpenAPI 模态是**只读**的:journey 阶段不创建 / 删除真实数据,破坏性端点只在隔离环境或被显式 mock。
- 截图三联(before/target/after)让"修了什么"一眼可见,不用读 diff 也能信。

## 常见翻车

| 翻车 | 后果 | 正确做法 |
|---|---|---|
| 只跑 happy path | 上线后空态 / 错误态炸 | 每条旅程必须覆盖成功 + 失败 + 空态三个终态 |
| 把"页面加载出来了"当通过 | 漏掉交互断裂 | 断言必须落到**用户目标达成**(数据出现 / 跳转正确 / 提示正确),不是 DOM 存在 |
| 失败只报现象不回源码 | build 阶段无从下手 | 用 console/network/snapshot 三件套定位到文件,回 cap-build 修 |
| OpenAPI 模态跑了写操作 | 污染 / 删除真实数据 | journey 只读铁律;写 / 删用例放隔离环境或 mock |
| App 模态没工具就硬编结论 | 报告造假 | 无移动自动化工具时,按 Scope Declaration 显式降级,标 INFERRED + 列人工验证步骤 |
| 修复时顺手重构周边 | 引入新回归、修复不可信 | 最小修复,CSS / 配置优先;一修一提交,绝不打包 |
| 截图覆盖旧文件 | 证据丢失、无法对比 | before/after 分文件命名 `finding-NNN-{before,target,after}.png` |

## 介入哪些阶段

- **shape**:(间接)journey 关心的"关键用户旅程"应在 spec 的验收标准里有迹可循;本验证项据此对齐旅程清单。
- **verify**:主战场——本 playbook 在此执行。
- **build**:失败回流目标——用例失败时回 cap-build 定位 + 修复,再回 verify 重测。
- **review**:把 journey 报告作为"用户视角已验证"的证据交给 review,避免 review 重复手测。

---

## 何时触发

由 cap-verify 的改动路由(见 `cap-flow/references/role-routing.md` / PROFILE surface-map)命中即触发;典型条件:

| 改动模式 | 触发的 journey 模态 |
|---|---|
| `*.tsx *.vue *.css components/** web/**` | **Web**(Playwright MCP) |
| `**/api/** **/handlers/** *.server.* services/api/**` | **OpenAPI**(端点用例,只读) |
| `**/*.swift *.kt mobile/** ios/** android/**` | **App**(移动自动化,默认 Maestro,排最后) |
| `e2e/** *.spec.*` | 对应已有 e2e 套件的模态 |

也可**独立运行**:`/cap verify --check=journey --scope=full-chain` 做全链路现状审计(兼作 cap-map baseline)。

> 多模态可并存:一次改动同时碰前端 + API,就同时跑 Web + OpenAPI 两个模态,各自出旅程、各自留证据,
> 最后汇到同一份报告。

---

## 步骤流程

### Step 0 — 选 scope + 推旅程（共用）

1. **选 scope**(决定旅程范围;用纯文本编号列表,不硬依赖结构化提问控件):
   ```
   选择 journey 验证范围(回复编号):
     1) feature      —— 只验本次改动直接触达的旅程(最快,默认)
     2) iteration    —— 验本迭代累积改动的旅程集合
     3) full-chain   —— 全链路现状审计(最全,兼作 baseline)
   ```
2. **跑 diff,定模态**:
   ```bash
   git diff --name-only <base>...HEAD
   ```
   把改动路径对照 surface-map / 上方触发表,得出本轮模态集合(Web / OpenAPI / App 的子集)。
3. **启发式推导用户旅程**(不依赖人写好的用例)。证据来源优先级:
   1. **spec.md 验收标准** —— 若有"关键旅程"直接采用。
   2. **路由 / OpenAPI paths** —— Web 读路由表(`pages/`、router 配置);OpenAPI 读 `openapi.yaml` /
      `swagger.json` 的 paths。
   3. **diff 触达的入口** —— 改了哪个组件 / 端点,就推它所在的最小可用旅程(file → route → journey)。
   4. **PRD / README** —— 补"这个产品用户来干嘛"的高层意图。
   产出一张**旅程清单**:每条含 `名称 / 入口 / 步骤 / 期望终态`。
4. **环境前置**:
   - 工作树干净检查 `git status --porcelain`;脏则先提交或 stash(保证修复能原子提交)。
   - 起被测目标:dev server / API base URL / 模拟器;记录访问入口写入报告头。

---

### Step 1 — Web 模态（Playwright MCP）

对每条 Web 旅程,按"走一遍 + 留证据"执行。核心工具(全部为 `mcp__plugin_playwright_playwright__browser_*`):

| 动作 | 工具 | 用途 |
|---|---|---|
| 导航 | `browser_navigate` | 打开旅程入口 URL |
| 看结构 | `browser_snapshot` | 取无障碍树(比截图更可断言;定位 element ref) |
| 截图 | `browser_take_screenshot` | 视觉证据(命名见证据 schema) |
| 交互 | `browser_click` / `browser_fill_form` / `browser_type` / `browser_select_option` | 模拟用户操作 |
| 等待 | `browser_wait_for` | 等文本 / 元素出现,**用确定性等待,不用裸 sleep** |
| 网络 | `browser_network_requests` | 看 XHR/fetch;顺带为 OpenAPI 模态抓真实端点 |
| 错误 | `browser_console_messages` | 抓 JS 报错,是定位源码的关键线索 |

每条旅程流程:

1. `browser_navigate` 到入口 → `browser_take_screenshot` 存 `finding-NNN-before.png`(或旅程起始态)。
2. 按旅程步骤 `browser_click` / `browser_fill_form` 等推进;每步关键节点 `browser_snapshot` 定位、必要时截图。
3. 推进到**终态**,断言用户目标是否达成(数据出现 / 跳转正确 / 提示正确)。
4. 收尾取 `browser_console_messages`(有无报错)+ `browser_network_requests`(关键请求是否 2xx)。
5. **三个终态都要覆盖**:成功路径 / 触发错误路径(错误提示是否清晰)/ 空态。

记录每步:动作 → 期望 → 实际 → 证据文件 → 证据等级。

---

### Step 2 — OpenAPI 模态（端点正向用例，只读）

> 方向是**正向**(读 spec 生成用例 + 断言),不是逆向抓包。但可复用协议 / 认证识别表来读懂真实流量。

1. **读 spec 生成端点用例**:
   - 有 `openapi.yaml` / `swagger.json`:逐 path × method,按 schema 生成请求(合法参数 + 边界 + 缺字段)
     与断言(状态码、响应 schema、关键字段)。
   - 无 spec:用 `browser_network_requests`(filter `/api/`)从真实交互抓出端点,对照下表识别协议与认证,
     再反推用例。

   | 特征 | 协议 | 认证特征 | 应对 |
   |---|---|---|---|
   | `POST /graphql`,body 有 `query`/`variables` | GraphQL | `Authorization: Bearer` | 带 token 重放 |
   | `POST /api/*`,`application/json` | REST JSON | `Cookie: session_id` / `X-API-Key` | 复用浏览器 storage_state |
   | 响应以 `)]}'` 开头 | anti-XSSI 前缀 | Cookie auth + CSRF | 剥前缀;先 GET 取 token |

2. **只读铁律**:journey 阶段**只跑只读端点**(GET / list / read)。创建 / 更新 / 删除端点必须:
   - 放隔离测试环境,或
   - 被显式 mock,或
   - 标记为 `SKIPPED — write op, not run in journey`(写进报告,不静默跳过)。
3. **认证**:复用 Web 模态的 storage_state / cookie;token 过期则按协议表刷新(GET 首页取 CSRF / 重登)。
4. **断言**:状态码 + 响应 schema + 关键业务字段;每条用例留 request/response 对作证据。
5. (可选,沉淀)为长期回归生成 health-check 用例:对核心只读端点跑存活检查,可挂 CI 定时。

---

### Step 3 — App 模态（移动自动化，默认 Maestro，排最后）

> **现状:环境常无移动自动化 MCP 工具。** App 模态是已知最大缺口,排在最后。

1. **探测工具**(先探测能力,没有就降级):
   ```bash
   command -v maestro 2>/dev/null && echo "MAESTRO_OK" || echo "MAESTRO_MISSING"
   command -v xcrun 2>/dev/null && echo "SIMCTL_OK" || true
   ```
2. **有 Maestro**:写 / 跑 `.maestro/*.yaml` flow(launchApp → tapOn → assertVisible),每步 `takeScreenshot`。
   断言落到"用户目标达成",证据 = 截图序列 + flow 日志。
3. **无工具(默认情形)—— 绝不猜,显式降级**:
   - 在报告写 **Scope Declaration**:声明 App 模态**未执行**,原因 = 无移动自动化工具。
   - 列出**人工验证步骤清单**(每条旅程:启动 → 操作 → 期望终态),供人工跑。
   - 该模态所有结论标 **INFERRED**,并注明"基于代码静态阅读,未在设备上验证"。
   - 在报告标记 App journey 为 `BLOCKED — tooling missing`,作为 build-time research spike 待办。

---

### Step 4 — 失败修复闭环

任一模态用例失败时,进入修复闭环(按失败影响排序,逐条处理)。**注意:源码修复在 cap-build,
不在 verify 偷改实现——本闭环用于 journey 独立运行 / 现状审计时的就地修 UI 摩擦,
主线场景下把失败 escalate 回 cap-build**:

- **8a 定位源码**:用 console 报错 / network 失败请求 / snapshot 结构,Grep/Glob 到责任文件。只动与该失败
  直接相关的文件。
- **8a.5 目标态(target)**:截一张 / 描述一张"修好后应该长什么样"的目标,存 `finding-NNN-target.png`
  (视觉类)或写明期望断言(功能类)。让 before↔target 的差距可见。
- **8b 修复**:读懂上下文做**最小修复**。CSS / 配置优先(更可逆);不重构、不加无关功能。
- **8c 提交**:一修一提交,绝不打包:`git commit -m "fix(journey): FINDING-NNN — <短描述>"`。
- **8d 重测**:回到该旅程重跑(Web 重新 navigate+操作 / OpenAPI 重发用例 / App 重跑 flow),截
  `finding-NNN-after.png`,再查 console/network 无新错。
- **8e 分类**:`verified`(重测通过无新错)/ `best-effort`(已修但无法完全验证,注明原因)/
  `reverted`(引入回归 → `git revert HEAD` → 标 deferred)。
- **8f 自我熔断(每 5 个修复或任一 revert 后计算风险)**:
  ```
  JOURNEY-FIX RISK:
    起始 0%
    每次 revert:              +15%
    每改一个 CSS/配置文件:     +0%
    每改一个组件/逻辑文件:     +5% /文件
    第 10 个修复后:           +1% /额外修复
    碰了无关文件:            +20%
  ```
  **风险 > 20%:立即 STOP**,向用户展示已做的,问是否继续(无交互能力时 = 输出现状并停,等人确认)。
  **硬上限 30 个修复**,到顶无论是否还有失败都停。

> 修复后若该失败属于 spec 验收标准的旅程,回 verify 重跑该旅程确认 gate 翻绿。

---

### Step 5 — 出报告

写 `.cap/verify/journey-<scope>-report.md`(schema 见下),供 cap-verify 调度层汇总:gate 结果、报告路径、
deferred / blocked 项。

---

## 产物

| 文件 | 内容 |
|---|---|
| `.cap/verify/journey-<scope>-report.md` | 主报告:旅程结果 + 证据 + 修复记录 + Scope Declaration |
| `.cap/verify/screenshots/finding-NNN-{before,target,after}.png` | 修复三联截图 |
| `.cap/verify/screenshots/journey-<name>-step-N.png` | 旅程过程截图 |
| `.cap/verify/openapi-cases-<scope>.md`(OpenAPI 模态) | 端点用例 + request/response 对 |
| `.maestro/*.yaml`(App 模态,若有工具) | 移动 flow 脚本 |

---

## 门控

**PASS 条件(全部满足):**
- scope 内每条推导出的旅程都跑到终态,且成功路径断言通过。
- 错误态 / 空态有覆盖且行为符合预期(错误提示清晰、空态不崩)。
- 失败用例已修复并 `verified`,或被显式 `deferred` / `SKIPPED` 并记录原因。
- 不能测的维度已 Scope Declaration 声明,未伪装成已测。

**FAIL / 回流条件:**
- 任一 scope 内核心旅程终态断言不通过且未修复 → escalate 回 cap-build,报告标 `blocked`。
- 修复闭环触发熔断(风险 > 20% 或到 30 上限)→ STOP,交人决策。

**降级(无并行 / 无 App 工具):**
- 多旅程默认串行执行(无并行能力时不强求并行)。
- 交互点一律用纯文本编号列表。
- App 无工具 → 按 Step 3 显式 INFERRED 降级,不阻塞其他模态出报告。

---

## 证据 schema

每条旅程 / 用例 / 修复,按统一结构记录。**Method 三级是硬约束**:

```markdown
### Journey: <旅程名>  | Modality: Web | OpenAPI | App
- Scope: feature | iteration | full-chain
- Entry: <URL / endpoint / app screen>
- Steps:
  1. <动作> → 期望 <终态> → 实际 <观察> → Evidence: screenshots/journey-x-step-1.png → Method: TESTED
  2. ...
- Result: PASS | FAIL | PARTIAL | SKIPPED
- Method: TESTED | PARTIAL | INFERRED      # 见下表
- Evidence: [screenshot 路径, network 记录, console 摘要, request/response 对]

### Fix (若有失败):
- FINDING-NNN: <失败现象>
- Source: <file:line>(定位依据:console/network/snapshot)
- Before: screenshots/finding-NNN-before.png
- Target: screenshots/finding-NNN-target.png
- After:  screenshots/finding-NNN-after.png
- Classify: verified | best-effort | reverted
- Commit: <sha> fix(journey): FINDING-NNN — <短描述>

### Scope Declaration（每份报告必含）:
- 能测(已 TESTED): <列表>
- 部分测(PARTIAL,注明限制): <列表>
- 不能测(INFERRED / 未执行 + 原因): <列表,如 "App 模态:无移动自动化工具,未在设备验证">
```

| Method | 含义 | 何时用 |
|---|---|---|
| **TESTED** | 真在被测目标上跑过并观察到结果 | Web 真点过、OpenAPI 真发过、App 真在设备 / 模拟器跑过 |
| **PARTIAL** | 跑了但无法完全验证(缺特定状态 / 数据 / 凭证) | 例:需真实支付凭证无法完成的步骤 |
| **INFERRED** | 未实跑,基于代码 / spec 静态推断 | App 无工具时、或环境无法起被测目标时——**必须显式标注,绝不当 TESTED** |

> 铁律:**绝不猜**。任何没有真实跑过的结论一律 INFERRED 并给出人工验证步骤,宁可标弱也不造假。
