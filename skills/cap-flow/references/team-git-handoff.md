# 同项目团队 Git 交接

推荐项目把活动态 `.cap/STATE.md`、task-context、spec、plan、verify、review、context 检查点留在本机。代码交付仍要给新克隆留下能定位工作的摘要：只跟踪 `.cap/HANDOFF.md`。根目录 `.gitignore` 不得使它继续被忽略；若已有 `.cap/` 整目录忽略规则，项目需显式调整该规则，并检查 `git check-ignore .cap/HANDOFF.md` 的结果。局部 `.cap/.gitignore` 无法重新包含被父目录整体忽略的文件。

摘要只保留目标、审阅过的决定、下一步、验证线索和失效条件，不复制原始 STATE、检查点、凭据、完整测试输出或个人资料。它是待核验线索，不传递 Task、Session、授权、Gate、Delivery、Outbox 或 PASS。`summarySha256` 只检测内容漂移；Commit 与 tree 哈希只证明 Git 对象绑定，均不是签名或授权。接收者必须从当前仓库、平台和原始用户决定重新核实。

## 交付顺序

1. 先完成代码和定向验证，提交代码，得到精确代码 Commit。原始活动态继续留本机。
2. 写一份仅含 `intent`、`decisions`、`nextActions`、`verification`、`invalidatesOn` 五个字符串字段的本地 draft JSON，审阅脱敏。`verification` 要写证据位置及“待接收者复核”，不写继承式 PASS。
3. 用当前包 `scripts/cap-team-handoff.mjs create <repo> --base <任务基线 Commit> --input <repo 内本地 draft JSON>` 生成 `.cap/HANDOFF.md`。生成器从 Git 读取 `sourceCommit`、`sourceTree`、`changedFiles`，拒绝未提交代码、空改动和敏感值。
4. 审阅生成文件，单独提交 `.cap/HANDOFF.md`；不要把被忽略的 draft 或原始状态一并暂存。若旧摘要已存在，先审阅并另存，再生成新摘要，生成器不会覆盖它。推送前运行 `scripts/cap-team-handoff.mjs verify <repo> --ref <待推送完整 Commit> --branch <本地分支>`。已安装的 pre-push Hook 会对未跟踪原始 STATE 且本次实际交付代码的开发分支执行同一验证，读取待推送 Git 对象而非本机工作文件。仅 PROFILE/历史索引等 `.cap/` 元数据变更不需要伪造代码摘要。若之后又改了代码，重新生成并提交摘要。
5. 新克隆先验证并读取摘要，再建立自己的 Task/Session、任务调查、授权边界和测试证据；摘要失效、缺失或校验失败时以代码与原始可信来源重新调查，不把旧结论升级为当前 Gate。

`baseCommit` 是本任务代码范围的共同基线，`changedFiles` 必须与基线到代码 Commit 的 Git diff 完全一致。摘要提交后仅允许 `.cap/` 收尾变动；代码树再变会使旧摘要过期。历史 `.cap/history/index/*.json` 可能包含指向本地未跟踪快照的 `artifactRoot`，只可用于检索线索，不能声称新克隆有原始验证证据。

已有项目若明确跟踪原始活动态，可继续原策略；不要在新 Task 切换时静默迁移，也不要把旧跟踪文件藏进 ignore。迁移需另行审阅文件归属和敏感内容。
