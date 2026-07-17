---
lang: Go
extensions: ["**/*.go"]
---

# Go 语言包

> 给 本技能族的 role 卡 / verify-logic / build-TDD / ai-readiness 按 `**/*.go` 加载。
> 命令均在 go1.26.3 上验证过 flag；`golangci-lint` / `gopls` 用各自官方标准调用形式（属外部工具，按需安装）。

## 语言陷阱（常见 pitfall + 怎么防）

Go 特有易错点，code review 与 correctness 门都应逐条核查：

| Pitfall | 表现 | 怎么防 |
|---------|------|--------|
| **未检查 error** | `f, _ := os.Open(...)` 吞错；`json.Unmarshal` 返回值丢弃 | 每个返回 error 的调用都必须显式处理或 `return`；用 `errcheck`（含于 golangci-lint）扫。禁止 `_ =` 吞错除非有注释说明 |
| **goroutine 泄漏** | 启动的 goroutine 因 channel 永不关闭 / 无退出条件而挂死 | goroutine 必须有明确退出路径：监听 `ctx.Done()` 或可关闭的 channel；测试里用 `go test -race` + `goleak`（uber-go/goleak）在 `TestMain` 兜底检测 |
| **defer 在循环里** | `for { f, _ := os.Open(); defer f.Close() }` —— defer 累积到函数返回才执行，循环中句柄/锁堆积 | 循环体抽成独立函数（让 defer 随每次迭代返回触发），或在循环内显式 `Close()` 不用 defer |
| **context 不传递** | 跨 API/DB/HTTP 调用没传 `ctx context.Context`，无法取消/超时/追踪 | 公开函数首参恒为 `ctx context.Context`；向下游调用透传，绝不存进 struct 字段，绝不传 `nil`（用 `context.TODO()`） |
| **data race** | 多 goroutine 共享变量无锁/无 channel 同步 | 必跑 `go test -race`；共享状态用 `sync.Mutex` 或 channel 传递所有权 |
| **range 变量捕获（Go ≤1.21）** | 闭包/goroutine 里直接用 `tt`/`v` 循环变量，全部捕获最后一次值 | Go 1.22+ 每次迭代新变量已修复；≤1.21 须在循环体首行写 `tt := tt`。**先确认 go.mod 的 go 版本** |
| **nil map 写入** | 对未 `make` 的 map 赋值 → panic | 写前 `m = make(map[K]V)`；只读 nil map 安全 |
| **nil interface 陷阱** | `var err error = (*MyErr)(nil)`，`err != nil` 为 true | 返回 error 时返回裸 `nil`，别返回带 nil 指针的具体类型 |
| **切片别名/共享底层数组** | `append` 到子切片改写父切片数据 | 需独立副本时 `s2 := slices.Clone(s1)` 或 `make+copy` |
| **整数除零 / 越界** | 运行时 panic | 边界与除数在系统边界处校验 |

## 测试（build TDD + verify/logic 用的确切命令）

Runner 是内置 `go test`，写法以**表驱动 + 子测试**为主（ECC golang-testing 主线）：

- 表驱动：`tests := []struct{name string; ...}{...}` + `for _, tt := range tests { t.Run(tt.name, func(t *testing.T){...}) }`
- 错误用例：表里加 `wantErr bool`，断言 `(err != nil) == tt.wantErr`
- 辅助函数首行 `t.Helper()`；资源清理用 `t.Cleanup(...)`；临时目录用 `t.TempDir()`
- 独立子测试可加 `t.Parallel()`
- HTTP handler 用 `httptest.NewRequest` + `httptest.NewRecorder`
- 表驱动覆盖正常路径与错误路径，不要只测 happy path

**确切命令：**

```bash
# 全量测试（基线）
go test ./...

# 单测 + race（build TDD 的主门，强烈建议默认带 -race）
go test -race ./...

# 单测 + race + 覆盖率（一条命令同时给 build 与 correctness 用）
go test -race -cover ./...

# 跑某个测试 / 某个子测试
go test -run TestAdd ./...
go test -run 'TestUser/Create' ./...

# flaky 检测：重复跑
go test -count=10 ./...

# 超时保护
go test -timeout 30s ./...

# 基准 / 模糊
go test -bench=. -benchmem ./...
go test -fuzz=FuzzParse -fuzztime=30s ./...
```

## Lint

主 linter：**golangci-lint**（聚合 errcheck / govet / staticcheck / ineffassign / gosimple 等，正好覆盖上面的「未检 error」等 pitfall）。外加内置 `go vet`、`gofmt`。

```bash
# 格式：检查有无未格式化文件（CI 门，-l 只列差异文件，输出非空即失败）
gofmt -l .
# 自动修复格式 + 简化
gofmt -s -w .

# 内置静态检查（无需安装，随 go 工具链）
go vet ./...

# 聚合 linter（需安装 golangci-lint；官方标准调用就是 run）
golangci-lint run ./...
# 自动修复可修项
golangci-lint run --fix ./...
```

> 安装：`go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest`（或 brew）。本机当前未装；`go vet` + `gofmt` 始终可用，可作为无 golangci-lint 时的降级 lint 门。

## LSP（供 ai-readiness 的「LSP 就绪」维度）

- Language server：**gopls**（官方）。
- 安装：`go install golang.org/x/tools/gopls@latest`，二进制落在 `$(go env GOPATH)/bin`。
- 就绪判定：`gopls version` 能返回版本即视为就绪；编辑器/agent 通过 stdio 启 `gopls`（无需子命令，裸 `gopls` 即 LSP 服务模式）。
- 健康前提：仓库有 `go.mod`、`go build ./...` 能通过模块解析；否则 gopls 诊断会大面积失真。

> 本机当前未装 gopls → ai-readiness 该维度应判「未就绪」，给出上面 `go install` 修复建议。

## 框架（额外 pitfall / 测试约定）

- **net/http（标准库）**：handler 测试统一 `httptest`（见上）。中间件链、`context` 透传随 `*http.Request.Context()` 走，不要自建全局。
- **database/sql**：`rows.Close()` 必须 defer；`rows.Err()` 在循环后必检；查询用占位符参数化（防 SQL 注入），绝不字符串拼接。
- **gRPC / context**：所有 RPC 方法首参 `ctx`，透传截止时间；服务端尊重 `ctx.Done()`。
- **接口 mock**：依赖定义成 interface，测试用手写 mock struct（字段持 func，方法转调）—— 不强依赖代码生成框架，符合 ECC「prefer 接口 mock」。

## 接入 cap

| 钩子 | 用哪条命令 |
|------|-----------|
| **build（TDD 绿灯）** | `go test -race ./...`（编译 + 测试 + 竞态一把过；race 是 Go 的强信号，默认开） |
| **verify / logic（覆盖率门）** | `go test -race -coverprofile=coverage.out ./...` 后 `go tool cover -func=coverage.out`；取 `total` 行百分比做门（general 80% / public API 90% / 关键逻辑 100%，见 ECC 覆盖表）。门脚本：`go tool cover -func=coverage.out \| grep total \| awk '{print $3}'` 解析比较 |
| **lint 门** | `gofmt -l .`（非空即失败）+ `go vet ./...` + `golangci-lint run ./...`（装了则强制，未装则降级到前两条） |
| **ai-readiness（LSP）** | `gopls version` 可用 ⇒ 就绪 |
| **role 卡归属** | **server-dev**。Go 在本族主要承载后端/CLI/服务（net/http、gRPC、database/sql、并发服务）。无前端浏览器渲染面，不归 client-dev |
