# web-review —— 划词批注式文档复核(可选 gate 机制)

> 这份 playbook 是 **数据,不是 skill**(与 `evolve-loop.md` / `divergence-frames.md` 并列)。
> 任何引擎(Claude + Read/Edit/Bash,或 Codex)都能照着跑;批注层/服务器是同目录的 **工具资产**(命令即交付物,保留)。
> 由 `cap-shape` / `cap-plan` 的**用户复核 gate** 作为**可选**升级形态引用——文档长/结构复杂、聊天里逐条批太累时用;简单文档直接 text_mode 聊天批更快。

---

## 0. 它解决什么

spec/plan 的复核 gate 默认在对话里逐条过。文档一长,这种方式低效、易漏。
web-review 把任意 markdown 渲染成**可在浏览器划词加批注**的页:用户选中任意文字→写评论→高亮+面板累积→选「通过/要改」→一键提交;本地服务器把批注回收成 `feedback.json`,**agent 读取后把所有批注统一改回源文档**。

**不替代** gate 的判定权——它只是把"用户怎么把意见喂回来"从手敲升级为划词批注。approve/要改的最终前进与否,仍由对应 stage skill 的 gate 决定。

## 1. 何时用(门控,默认不用)

- 文档长 / 结构复杂(多节、多表、跨域契约),聊天逐条对太累 → 提议 web-review。
- 用户明确要"网页上标注 / 生成网页我看看 / 划词批注"。
- 否则:**默认走 text_mode 聊天批**(更快、零进程)。

## 2. 工具资产(同目录)

| 文件 | 职责 |
|------|------|
| `build.py` | `md → 可批注审阅页`(零依赖 md 子集渲染 + 注入批注层 + 复制 server)|
| `annotate.js` `annotate.css` | 通用划词批注层(选词→评论→高亮→右侧面板→POST 提交);注入任意 HTML 通用 |
| `server.py` | 零依赖 localhost 回收服务器:托管页面 + `POST /feedback` 写 `feedback.json` |

> 也可不用 `build.py` 的通用渲染,而手工写更精美的可视化页——只要 `</head>` 前注入 `annotate.css`、`</body>` 前注入 `annotate.js`,并和 `server.py` 同目录托管即可。批注层对任意页面通用。

## 3. 流程(原则,非命令手册)

1. **定源**:默认 `<repo>/.cap/spec.md`(shape gate)或 `plan.md`(plan gate);或用户指定 md / 已有可视化 HTML。
2. **生成到 tmp**:产物落临时目录(约定 `${TMPDIR:-/tmp}/cap-web-review-<slug>/`),**不污染目标仓**。
3. **构建**:跑 `build.py <源.md> <outdir> --title "<标题>"`(它会渲染 + 注入批注层 + 把 `server.py` 复制进 outdir)。手工可视化页则改名 index.html、注入两行、把 `server.py` 拷进去。
4. **起服开页**:在 outdir 起 `server.py`(后台常驻,绑 `127.0.0.1`),浏览器开 `http://127.0.0.1:<port>/`。起服前先清占用端口。
5. **告诉用户怎么标**:选中文字→「💬 添加评论」→写评论→保存;右侧面板可删可定位;选「通过/要改」→「提交反馈给 agent」。**提交即自动回收**——Live mode(§6)下 agent 前台 `/wait` 当场拿到,文件式下 agent 读 `feedback.json`;改完会在**每条批注下回复**(replies.json 回灌页面)。用户**不必回对话手动转述或贴回**意见。
6. **回收 + 统一改**:读 `<outdir>/feedback.json`——
   - 结构:`{ verdict:"approve"|"changes", count, annotations:[{id, section, quote, comment}] }`。
   - 对每条 annotation:按 `section` 缩小范围、在源 md 里定位 `quote`,按 `comment` 意图改;**一次性 consolidated pass** 改完再向用户汇总改了哪些。匹配不到的 quote → 回报该条请用户澄清,**不臆改**。
   - **逐条回复(UI 闭环)**:改完把每条处理结果写成 `<outdir>/replies.json` = `{ "<批注id>": "回复文本", ... }`(id 取 feedback.json 每条的 `id`)。页面每 3s 轮询 `/replies.json`,在对应批注下显示「↩ agent」回复块,用户能看到每条意见被怎么处理。**与重跑 build 同一轮做**。
   - 必要时重跑 build 让用户再看一轮(批注 + 回复随 localStorage / replies.json 自动恢复)。
7. **回判 gate**:`verdict=approve` 且无阻断批注 → 该 stage 的 gate 通过(spec → `Status: approved` 并写回 STATE;plan → 定稿)。`changes` → 改完重跑该 stage 的自检,再回 gate。
8. **收尾**:停服务器;tmp 产物可留可清。

## 4. 约束

- **localhost-only**:服务器绑 `127.0.0.1`,不出网;批注全在本地。
- **可移植**:仅 `python3` 标准库;无 Task / 无 AskUserQuestion 依赖。无浏览器的环境(纯 Codex)→ 降级:把 `feedback.json` 让用户手填,或直接 text_mode 聊天批。
- **md 子集**:`build.py` 支持标题/段落/有序无序列表/GFM 表格/围栏代码/引用/行内 code/**粗体**/链接,足够 spec/plan;复杂排版走手工可视化页。
- **不改 gate 语义**:web-review 是复核**机制**的可选项,不改"批准前不前进"的纪律。
- **定位健壮**:统一改时按 `section`+`quote` 精确匹配;匹配不到不臆改,回报澄清。

## 5. feedback.json 示例

```json
{
  "doc": "骨架 Spec 审阅",
  "verdict": "changes",
  "count": 2,
  "annotations": [
    {"id":"a1","section":"5. 设计","quote":"18 个实体","comment":"漏了营销券实体,补一个 Coupon"},
    {"id":"a2","section":"6. 怎么算 done","quote":"两笔并发 hold","comment":"再加一个 consent 撤销的验收场景"}
  ]
}
```

## 6. Live mode —— 实时双向(可选升级,跨引擎)

> 在 §3 文件式回收之上的**可选实时化**:把"用户提交后回对话手动说一声"换成 agent **前台阻塞 `curl /wait`**,提交瞬间自动拿回批注。机制只用"前台阻塞 shell + HTTP 长轮询"这个**通用原语**——CC / Codex 等任意有 shell 的引擎都实时,**不依赖任何 harness 特性**。默认 §3 文件式仍可用;long-poll 是它的实时形态,不改 gate 语义。

### 6.1 原理
`server.py`(已支持)把 `GET /wait` **挂起不回**(`threading.Event.wait`,零 CPU),直到 `POST /feedback` 唤醒、把批注 JSON 回给那条挂起的请求。agent 前台跑一次阻塞 `curl /wait`:用户提交瞬间返回 `{verdict,annotations[]}`;无人提交则约 540s 回 204,agent **再 curl 一次(re-arm)**。`feedback.json` 仍写盘,作 durable 记录与 file 兜底。

### 6.2 循环纪律(present → await → revise)
1. `build.py` 渲染 → 起 `server.py`(常驻,`ThreadingHTTPServer`,绑 `127.0.0.1`)→ 开页。
2. **await**:agent 前台阻塞等用户提交(原则:用引擎的"前台阻塞 shell 调用"等 `/wait` 返回;超时则 re-arm)。
3. **apply**:`verdict=changes` → 按 §3.6 的 `section`+`quote` 精确定位逐条改源,匹配不到不臆改、回报澄清;`approve` 且无阻断 → 回判对应 stage 的 gate、停服。
4. **re-present**:改完触发页面自动刷新(写新 `rev` 戳,`build.py` 注入的 poller 轮询 `/rev`,值变即 reload)→ 回到 2。

### 6.3 单渠道纪律
await 期间 agent 正前台阻塞,物理上发不出别的交互。若需结构化追问(如"全改还是只改某几条"),只在 `/wait` 返回后的 **revise seam** 进行(有 AskUserQuestion 用它;无则 text_mode 编号问)。铁律一条:**同一时刻只允许一个活跃渠道**——浏览器 round ⟂ 终端 revise,不重叠。

### 6.4 兜底降级(可移植)
无 `curl` / 无浏览器 → 退回 §3 文件式(读 `feedback.json`,提交后手动 signal);再不行回 text_mode 聊天批。`/wait` 必须配 `ThreadingHTTPServer`(挂起请求否则堵死 `POST` → 死锁),这是 `server.py` 的硬约束;回归测试见同目录 `test_live.py`(`python3 test_live.py`:释放/不死锁/超时204/submit-before-wait)。
