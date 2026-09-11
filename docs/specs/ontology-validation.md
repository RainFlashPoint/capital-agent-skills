# Ontology 底座验证记录

本报告只保留匿名结构信息。两套实际支付项目任务及运行脚本、所选 Git 版本、本地导入产物和原始测试日志保留在本机 `docs/dogfood/ontology-foundation/`，不进入公共仓库。

## 真实 .cap 验证

| 样本 | 读取方式 | 产物 | 观察到的声明 | 运行结果 |
|---|---|---|---|---|
| payment-a | 当前工作区，只读 | 11 | done 游标、非标准完成状态、PASS 与 ENV_BLOCKED 并存 | 无完成证明；保留未知状态、候选 Commit 缺失、版本不匹配和环境阻塞 |
| payment-b | 明确指定的另一支付分支，Git blob 导出到临时目录 | 13 | test 游标、PASS/FAIL/ENV_BLOCKED 并存 | 不沿用旧验证；保留缺候选 Commit、上下文版本不一致和验证阻塞 |

两组 canAdvance=false、completed=false、allowedActions 为空。不是因为统一写死不允许，而是因为输入分别未满足身份、证据、权限和有效性条件；单元测试另以完整的独立 receipt/grant 证明全部合法路径可以推进。每次导入前后结构 hash 一致，业务仓 Git 状态前后一致，未运行支付代码、未修改业务 `.cap`、未接触外部支付环境。

## 真实知识拆解与隔离

从两套 spec 中分别提取“交易最终状态如何认定”的原子命题，绑定各自真实源文件 hash、任务身份和渠道 scope。两条均通过 draft 来源绑定；没有猜测缺失的 source Commit。随后在纯本地测试中模拟独立知识准入，验证：

- 指定渠道时只返回该渠道的命题；另一渠道的同名命题不会覆盖或混入。
- 渠道未知时两条均为适用条件未知，不合并、不默认选一条。
- 将两条不同值故意放进同一 scope 时产生 conflict，停止相关动作。
- 测试准入不是在线知识发布，未产生任何 Server 知识或 Gate。

## 可重复测试

`node --test scripts/test-ontology*.mjs` 覆盖 O01–O14：Schema/重复 key/身份、隔离、同义与矛盾、显式替代/环、时效、来源绑定、完整交付身份、独立 issuer、local/server 权威区别、deny 优先、L1–L4、安全文件读取、旧版本迁移、来源漂移、CLI cwd 和类型化图关系。O15 由上面的两套真实任务补充。

`bash scripts/validate-skills` 同时检查原有 Skills 结构和 Ontology 来源/Schema/字典/执行策略。全量 Node 回归仍需与最终 Commit 的本地 verify 报告一起读取，不能把此静态文档当 Server Gate。

## 结论边界

已证明本地语义内核能够消费真实产物并发现不可放行条件；已证明完整模拟授权和独立证据时可以沿既有流程推进。未据此声称真实 Agent 的代码生成质量提高、支付链路重新联调通过、Server 权限适配器上线或生产 CI/CD 完成。后续接入必须提供经宿主认证的 authority，并沿用同一反例矩阵。
