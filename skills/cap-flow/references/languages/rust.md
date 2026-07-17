---
lang: rust
extensions: ["**/*.rs"]
---

# Rust 语言包

供 本技能族的 role 卡（server-dev/client-dev）、verify/logic、build TDD、ai-readiness（LSP 维度）按语言加载。下面的命令均已在 `cargo 1.95 / rustc 1.95` 环境实测。

## 语言陷阱（常见 pitfall + 怎么防）

| 陷阱 | 后果 | 怎么防 |
|------|------|--------|
| **`unwrap()` / `expect()` 滥用** | 生产环境 panic、崩溃、丢失错误上下文 | 业务/库代码一律返回 `Result<T, E>`，用 `?` 传播；`unwrap`/`expect` 只允许出现在测试与 `main`/原型里。库错误用 `thiserror`，二进制顶层才用 `anyhow`。可加 `#![deny(clippy::unwrap_used, clippy::expect_used)]`（或在 `Cargo.toml` 的 `[lints.clippy]` 里 `unwrap_used = "deny"`）卡死。 |
| **生命周期标注错误 / 借用冲突** | 编译不过（`borrow of moved value`、`does not live long enough`） | 函数参数优先 `&str`/`&[T]` 而非 `String`/`Vec<T>`；返回引用时让编译器推断，必要才显式 `'a`；同时需要可变又只读时拆分作用域而不是硬标 `'static`；所有权模糊用 `Cow<'_, T>`。 |
| **不必要的 `.clone()`** | 性能退化、隐藏所有权设计问题 | 默认借用 `&T`；只在确实要转移所有权时 clone。`cargo clippy -- -D clippy::redundant_clone` 抓冗余克隆，`clippy::perf` 抓循环内克隆。小 `Copy` 类型（≤24B）可按值传。 |
| **`Send`/`Sync` 不满足** | `tokio::spawn` / 跨线程编译报错 `future cannot be sent between threads safely` | 跨 `.await` 不要持有 `Rc`/`RefCell`/裸指针；共享状态用 `Arc<...>`，可变共享用 `Arc<Mutex<T>>` 或 `Arc<RwLock<T>>`（tokio 版）。spawn 的 future 必须 `Send + 'static`。 |
| **async 取消（cancellation safety）** | `select!` 分支被取消时丢数据 / 状态不一致 | 在 `tokio::select!` 中只放可安全取消的 future；需要清理用 `CancellationToken` 显式响应 `cancelled()`；不要把"读了一半的状态"放进 select 分支。 |
| **跨 `.await` 持有锁** | 死锁、吞吐塌陷 | 锁的 guard 不要跨越 `await` 点；先 `let v = lock.read().await.clone(); drop(guard);` 再 await。 |
| **async 里阻塞** | 饿死 runtime 的 worker 线程 | 禁用 `std::thread::sleep`，用 `tokio::time::sleep`；CPU 密集/阻塞 IO 放 `tokio::task::spawn_blocking`。 |
| **无界 spawn** | 内存/连接耗尽 | 用 `Semaphore` 或 `buffer_unordered(limit)` 限并发；批量任务用 `JoinSet` 管理。 |
| **`large_enum_variant`** | 整个 enum 按最大变体占内存 | clippy 会警告；超大变体用 `Box<...>` 包起来。 |

## 测试（test runner / 写法 / coverage 命令）

测试 runner：内置 `cargo test`（也可选 `cargo nextest`，本机已装 0.9.133，并行更快、输出更清晰）。

```bash
cargo test                        # 全部测试（单元 + 集成 + doc）
cargo test -- --nocapture         # 显示 println! 输出
cargo test <pattern>              # 跑名字匹配的测试
cargo test --lib                  # 仅单元测试
cargo test --test <file>          # 仅某个集成测试 binary（tests/<file>.rs）
cargo test --doc                  # 仅 doc tests
cargo test --no-fail-fast         # 首个失败后继续跑完
cargo nextest run                 # （可选）更快的并行 runner；注意它不跑 doc tests
```

写法要点：
- 单元测试放同文件 `#[cfg(test)] mod tests { use super::*; ... }`；集成测试放 `tests/*.rs`（每个文件是独立 test binary），共享工具放 `tests/common/mod.rs`。
- 测试名描述场景：`process_should_return_error_when_input_empty()`。优先 `assert_eq!`（错误信息更好）。
- 测错误路径用 `assert!(result.is_err())` + `matches!(err, MyError::Variant(_))`，**别**用 `#[should_panic]` 代替。
- 返回 `Result` 的测试用 `?`：`fn t() -> Result<(), Box<dyn std::error::Error>>`。
- async 测试用 `#[tokio::test]`；超时断言用 `tokio::time::timeout(...)`；**别**用 `sleep()` 等状态，用 channel/`tokio::time::pause()`。
- 参数化测试用 `rstest`（`#[case(...)]`），属性测试用 `proptest!`，trait mock 用 `mockall` 的 `#[automock]`。

coverage（实测 `cargo-llvm-cov 0.8.7`，优先；`cargo-tarpaulin` 为备选，需先 `cargo install cargo-tarpaulin`）：

```bash
# 首选：cargo-llvm-cov（精度高，原生 LLVM 插桩）
cargo install cargo-llvm-cov          # 一次性安装
cargo llvm-cov                        # 摘要
cargo llvm-cov --html                 # HTML 报告
cargo llvm-cov --lcov --output-path lcov.info   # 给 CI 的 LCOV
cargo llvm-cov --fail-under-lines 80  # 行覆盖率 < 80% 退出码 1（门）

# 备选：cargo-tarpaulin（纯 Linux x86_64 最稳）
cargo tarpaulin --out Lcov --fail-under 80
```

覆盖率目标：核心业务逻辑 100%，公开 API 90%+，一般代码 80%+，生成代码/FFI 绑定排除。

## Lint（linter + 确切命令）

```bash
cargo clippy --all-targets --all-features --locked -- -D warnings   # 标准门：所有警告当错误
cargo clippy -- -D clippy::perf                                     # 性能向 lint
cargo fmt --check                                                   # 格式检查（CI 用，不改文件）
cargo fmt                                                           # 本地格式化
```

重点 lint：`redundant_clone`、`large_enum_variant`、`needless_collect`、`unwrap_used`/`expect_used`。
抑制要带理由：优先 `#[expect(clippy::xxx)]`（未触发会报警，比 `#[allow]` 安全），并加注释说明。

## LSP（供 ai-readiness 的"LSP 就绪"维度判断）

- Language server：**rust-analyzer**（rustup 官方组件，不是 cargo 子命令）。
- 安装：`rustup component add rust-analyzer`，调用 `rustup run stable rust-analyzer`（或编辑器扩展自带）。
- 就绪判据（ai-readiness 应检查）：
  1. 工作区根有 `Cargo.toml`（rust-analyzer 靠它解析 crate 图）。
  2. `cargo metadata` 能成功跑（依赖可解析）。
  3. `rustup component add rust-analyzer` 存在；`cargo clippy` / `cargo fmt` 组件已装（`rustup component add clippy rustfmt`）。
  4. 项目能 `cargo check` 通过——rust-analyzer 的诊断质量依赖能编译。
- 提供的能力：跳转定义、悬停类型、补全、`cargo check`/clippy 实时诊断、重命名、`Cargo.toml` 依赖感知。

## 框架（额外 pitfall / 测试约定）

- **Tokio（async runtime）**：入口 `#[tokio::main]`；测试 `#[tokio::test]`。`Cargo.toml` 用 `tokio = { version = "1", features = ["full"] }`（生产按需裁剪 feature）。优雅退出用 `CancellationToken` + `signal::ctrl_c()`。调试用 `tokio-console`（`RUSTFLAGS="--cfg tokio_unstable"` + feature `tracing`）。
- **async-trait**：trait 里写 `async fn` 用 `#[async_trait]`（除非已用足够新的原生 async-in-trait）。trait 对象 `&dyn Repository` 跨线程时实现需 `Send + Sync`。
- **sqlx**：`query!`/`query_as!` 是编译期校验 SQL 的宏，需要 `DATABASE_URL` 或 `cargo sqlx prepare` 生成的离线缓存（`.sqlx/`），否则 CI 编译失败——这是常见坑。
- **axum / actix-web（server-dev）**：handler 必须 `Send`；共享状态走 `State<Arc<...>>`，别把非 `Send` 类型放进 handler 闭包。
- **criterion（benchmark）**：`Cargo.toml` 里 `[[bench]] harness = false`，跑 `cargo bench`；benchmark 必须 `--release`。

## 接入 cap

- **build / TDD（RED-GREEN-REFACTOR）用的 test 命令**：
  `cargo test`（含 doc tests）；并行加速可选 `cargo nextest run`（注意补一条 `cargo test --doc` 跑 doc tests）。
- **verify/logic 的 coverage 门命令**：
  `cargo llvm-cov --fail-under-lines 80`（默认 80% 行覆盖门，按 role 调整阈值；备选 `cargo tarpaulin --fail-under 80`）。
- **lint/format 门**：`cargo clippy --all-targets --all-features --locked -- -D warnings` + `cargo fmt --check`。
- **归属 role 卡**：Rust 同时服务 **server-dev**（axum/actix/tokio 服务、sqlx）与 **client-dev**（CLI 工具、Tauri/WASM、嵌入式）。判定看 crate 类型——网络服务/守护进程 → server-dev；本地 CLI/桌面/库 → client-dev。两类共用上面同一套 test/coverage/lint 命令。
