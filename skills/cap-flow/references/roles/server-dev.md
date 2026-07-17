---
role: server-dev
triggers:
  - "**/api/**"
  - "**/handlers/**"
  - "**/services/**"
  - "*.server.*"
  - "**/routes/**"
  - "**/middleware/**"
  - "**/models/**"        # 与 big-data 共触发；本卡管 ORM/持久层视角
  - "**/migrations/**"
  - "**/*.sql"
---

# 角色卡：server-dev（服务端开发视角）

> 这是一张**知识卡**，不是流程。它只回答"从服务端工程的专业视角看，这次改动应该关注什么"。
> **语言细节(陷阱/测试/lint/LSP 命令)不在本卡** —— 按改动文件扩展名加载 `references/languages/<lang>.md`(后端常见 python/go/rust/java-spring,见 role-routing §7)。本卡只管服务端通用视角(API 契约 / 性能 N+1·index / security / 事务边界)。
> 流程（跑测试、扫安全、写报告）由 `cap-build` / `cap-verify` / `cap-review` 这些 skill 执行，
> 它们在路由命中本卡时把这里的关注点/清单当作透镜加载。

## 关注点

服务端代码的核心是**在信任边界上做对的事**，并且**在规模与时间维度上不退化**。按重要性排序：

1. **正确性与契约稳定**
   - API 是对外承诺。改 response 字段、类型、状态码、必填参数、鉴权要求 = 可能悄悄毁掉调用方。
   - 数据 schema / 迁移是单向门：先看向后兼容、回滚路径、是否有人还在读旧字段。

2. **信任边界上的安全**（所有外部输入皆敌意）
   - 输入在 controller/handler 层就要被校验（schema/类型/大小/内容），不要信任到达业务层的数据。
   - 鉴权默认拒绝（whitelist 而非 blacklist）；授权检查不能"默认 allow"。
   - 对象级授权：用户能不能通过改 ID 访问别人的资源（IDOR / BOLA）。

3. **规模维度的性能**
   - 数据访问是第一性能瓶颈：N+1、缺索引、无界查询（无 LIMIT/分页）。
   - 算法复杂度：循环里查库、嵌套循环、循环内字符串拼接。
   - 异步上下文里的同步阻塞（time.sleep / 同步 I/O / CPU 密集占满事件循环）。

4. **可靠性与可观测**
   - 错误显式处理、不静默吞；错误响应不泄露栈/SQL/内部路径。
   - 失败要优雅：断路器、降级、超时、幂等键（重复请求不重复扣款）。
   - 关键路径有审计日志（写日志，不写进返回给用户的响应体）。

5. **密钥与配置**
   - 没有硬编码密钥（含注释里、URL query 里、客户端可见处）。
   - 启动时校验必需密钥存在；可被泄露的一律走环境变量/密钥管理器。

## 检查清单

逐条核对。每条命中即是一个 finding（按 §证据 schema 记录）。

### A. API 契约
- [ ] 是否删除/改名/改类型了已存在的 response 字段？（调用方可能依赖）
- [ ] 是否给已有端点加了新的必填参数？是否改了 HTTP 方法 / 状态码？
- [ ] 破坏性变更是否伴随版本号提升（v1→v2）或旧路径 alias？
- [ ] 鉴权要求是否从 public 变 authenticated（或反之）而未声明？
- [ ] 新端点的错误格式是否与既有端点一致（error code/message/details 标准字段齐全）？
- [ ] 状态码是否匹配语义（不要 200 返回错误、不要 500 返回校验失败）？
- [ ] 列表端点是否有分页/LIMIT？分页方式变更（offset→cursor）是否向后兼容？
- [ ] OpenAPI/Swagger/README 是否同步更新（无文档漂移）？

### B. 安全（信任边界 / authz / 注入 / 加密 / 密钥）
- [ ] 用户输入是否在 handler 层做了 schema/类型/大小校验？文件上传是否校验类型/大小/magic byte？
- [ ] 是否存在鉴权缺失的路由？授权是否"默认拒绝"？
- [ ] 是否有 IDOR/BOLA：换个 ID 就能读/写他人资源？是否有越权改自己角色/权限的路径？
- [ ] SQL 是否参数化（无字符串拼接）？是否有命令注入（subprocess 带用户参数）？
- [ ] 是否有 SSRF（用户可控 URL 的 fetch/redirect/webhook）、路径遍历（`../`）、模板注入（Jinja2/Handlebars）？
- [ ] 加密误用：弱哈希（MD5/SHA1 用于安全场景）、可预测随机（`Math.random`/`rand()` 做 token）、非常量时间比较密钥、硬编码 key/IV、密码无 salt？
- [ ] 是否反序列化不可信数据（Python `yaml.load`、Ruby Marshal、二进制对象反序列化等）而未做 schema 校验？
- [ ] 密钥是否出现在源码/日志/错误响应/URL？错误响应是否泄露栈/SQL/版本/内部路径？

### C. 性能
- [ ] ORM 关联是否在循环里被遍历而未 eager load（`.includes`/`joinedload`/`include`）？
- [ ] 循环内是否有数据库查询（可批处理）？嵌套序列化器是否触发懒加载？
- [ ] 新 WHERE/ORDER BY/外键列是否缺索引？复合查询是否缺复合索引？
- [ ] 是否有 O(n²)：嵌套循环、`Array.find` 套在 `map` 里、可用 hash/set 替代的线性查找？
- [ ] 列表/查询是否无界（缺 LIMIT、缺分页参数）？
- [ ] async 函数里是否有同步 I/O / `time.sleep` / 阻塞主线程的 CPU 计算？

### D. 可靠性与数据
- [ ] 外部调用/下游依赖是否有超时、重试、断路器、优雅降级？
- [ ] 写操作是否幂等（幂等键/唯一约束），重复请求不会造成双重副作用？
- [ ] 迁移是否可回滚、是否向后兼容（先加列后切流量，不是直接 drop）？
- [ ] 关键业务事件是否有审计日志？错误是否被显式处理而非静默吞？

## 好的样子

- **端点 = 契约 + 校验 + 限流 + 鉴权**：鉴权由依赖注入在 handler 运行前完成；输入由 schema（Pydantic/zod）在边界拒绝畸形数据；敏感端点有 rate limit；返回最小化数据。
- **数据访问可预测**：查询有索引、有 LIMIT、批量加载；慢查询有上界；schema 变更带迁移 + 回滚 + 向后兼容窗口。
- **失败是安全且优雅的**：错误响应是通用的（不漏内部细节），下游故障被断路器隔离，重试幂等。
- **安全是默认而非补丁**：默认拒绝、最小权限、参数化查询、输出编码；密钥走密钥管理器；每个安全发现都配可直接粘贴的修复代码。
- **改动可追溯**：API 变更同步了 OpenAPI/文档；破坏性变更有版本与迁移指引。

## 常见翻车

| 翻车 | 后果 | 正确做法 |
|---|---|---|
| 悄悄删/改 response 字段 | 线上调用方崩溃 | 加版本或保留旧字段过渡，文档同步 |
| 授权默认 allow / 漏挂鉴权中间件 | 越权访问、数据泄露 | 默认拒绝；路由层统一鉴权 |
| 用 ID 直接取资源不校验归属 | IDOR，任意用户读他人数据 | 服务端校验资源 owner |
| 字符串拼 SQL / subprocess 拼用户输入 | 注入、RCE | 参数化查询 / 参数数组 |
| 循环里查库、缺索引、无界 list | N+1、慢查询、OOM | eager load、加索引、强制分页 |
| async 里 `time.sleep` / 同步 I/O | 事件循环卡死，吞吐塌方 | 用 async 等价物 / 线程池 offload |
| 弱哈希 / `Math.random` 做 token / `==` 比密钥 | 可被爆破/伪造/时序攻击 | bcrypt/argon2、CSPRNG、常量时间比较 |
| 硬编码密钥 / 密钥进日志 / 错误漏栈 | 凭据泄露、攻击面暴露 | 密钥管理器；通用错误响应 |
| 迁移直接 drop 列 / 不可回滚 | 部署不可逆、数据丢失 | 扩展-收缩两段迁移，留回滚 |
| 下游无超时/断路器 | 级联故障、雪崩 | 超时 + 断路器 + 降级 + 幂等重试 |
| "我修了"但没验证缓解真存在 | 安全门形同虚设 | verify-mitigation-exists：要看到对应防护代码/测试 |

## 介入哪些阶段

server-dev 透镜在 cap 主线的以下阶段被路由加载（`role-routing.md` 命中 `api/**`、`handlers/**`、`*.server.*`、`models/**`、`*.sql` 等）：

| 阶段 | server-dev 做什么 |
|---|---|
| **shape**（cap-shape） | 评审 API 契约设计、数据 schema、信任边界；对"改 AI/策略"的端点提示需要在此处定 eval 标准（交给 model 模式执行）。 |
| **plan**（cap-plan） | 把"迁移可回滚""端点向后兼容""加索引""加鉴权/限流"拆成带可验证 acceptance_criteria 的任务。 |
| **build**（cap-build） | TDD 时优先为信任边界、authz、错误路径写测试（红）；实现绿。 |
| **verify**（cap-verify） | 主要触发 **logic**（单测/集成 + 覆盖率门）与 **journey:OpenAPI**（端点用例 + 只读安全约束）；当改动涉及模型/策略时叠加 **model**。 |
| **review**（cap-review） | 本卡的检查清单 A/B/C/D 即 server-dev 的 review 维度；安全部分遵循 `gsd-secure-phase` 的 **verify-mitigation-exists + disposition(mitigate/accept/transfer) + open=0 硬门**。 |

### 证据 schema（review/verify 阶段每条 finding 落盘）

写入 `.cap/review/server-dev.md`（单写者，避免并发竞争），每行一个 finding：

```json
{
  "severity": "CRITICAL | HIGH | MEDIUM | LOW | INFO",
  "confidence": 1-10,
  "path": "services/api/users.py",
  "line": 142,
  "category": "api-contract | security | performance | reliability | data",
  "summary": "换 ID 即可读他人 documents（IDOR）",
  "fix": "在 handler 内校验 resource.owner == auth.sub",
  "disposition": "mitigate | accept | transfer",
  "fingerprint": "path:line:category"
}
```

severity 与门控约定：
- **CRITICAL**：可被利用的鉴权绕过 / 注入 / 数据丢失风险 → **BLOCK**（合并前必须修，安全类 open 必须归零）。
- **HIGH**：破坏性 API 变更未版本化、IDOR、N+1 导致明显退化 → 合并前应修。
- **MEDIUM/LOW/INFO**：可维护性/防御纵深建议 → 记录、择机修。
- 安全发现一律配可直接粘贴的修复代码，并标 `disposition`；选 `accept`/`transfer` 必须写明理由。
