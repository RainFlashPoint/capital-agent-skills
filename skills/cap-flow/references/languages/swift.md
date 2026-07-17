---
lang: Swift
extensions: ["**/*.swift", "ios/**"]
---

# Swift 语言包

面向 iOS / Apple 平台。归 **client-dev**（移动端面）。
本包蒸馏方法论、检查清单、真实可跑命令；所有命令已在 Swift 6.3.2 + SwiftLint + sourcekit-lsp 上验证 flag 真实存在。

## 语言陷阱（常见 pitfall + 怎么防）

Swift 特有易错点，按"出现频率 × 危害"排序：

### 1. 强引用循环（retain cycle）—— 内存泄漏头号杀手
闭包默认强捕获 `self`；`Task {}`、`@escaping` 回调、`Combine` sink、`NotificationCenter` 闭包都会把 `self` 钉死。
- **怎么防**：闭包里访问 `self` 时用捕获列表 `[weak self]`，进入后 `guard let self else { return }`。
- **特例**：结构化并发（`async let` / `withTaskGroup`）作用域退出即结束，**不需要** `[weak self]`；只有长生命周期的 `Task { }` / 存储型 Task 才需要。
- **验证**：长生命周期对象写 deinit 断点 / 单测里断言 deinit 被调用（leak check）。

### 2. 可选解包（optional unwrapping）—— 崩溃头号来源
强制解包 `!` 在 nil 时直接 crash。
- **怎么防**：用 `guard let` / `if let` / `??` 默认值 / 可选链 `?.`。生产代码禁止 `!`（除非是编译期保证的字面量，如 `URL(string: "https://...")!` 且有测试覆盖）。
- **SwiftLint 兜底**：`force_unwrapping` / `force_cast` / `force_try` 规则（默认 opt-in，需在 `.swiftlint.yml` 的 `opt_in_rules` 开启）。

### 3. Actor 隔离 / Sendable（Swift 6 严格并发）—— 编译期数据竞争
Swift 6 默认开启完全数据竞争检查。跨隔离边界传非 `Sendable` 值 = 编译错误。
- **典型诊断**：
  - `Main actor-isolated ... cannot be used from a nonisolated context` → 调用方是否真的 UI-bound？是则隔离到 `@MainActor`，否则 `await MainActor.run { }`（仅当 main-actor 所有权正确）。
  - `Sending value of non-Sendable type ... risks data races` → 把跨界值改成不可变 value type，或整段留在同一 actor 内。
- **怎么防**：共享可变状态放进 `actor`；UI 状态用 `@MainActor`；优先 value type / 不可变。**避免** `@unchecked Sendable` / `nonisolated(unsafe)` —— 必须用时要写明安全不变量 + 后续移除计划。
- **不要**把 `@MainActor` 当万能补丁；要论证代码确实 UI-bound。

### 4. 主线程 UI（main-thread）—— 渲染崩溃 / 卡顿
所有 UIKit/SwiftUI 视图更新必须在主线程。后台拿数据回来直接改 UI = 未定义行为。
- **怎么防**：网络/计算用 `Task { @concurrent in ... }` 起在主 actor 外，拿到结果后 `await MainActor.run { self.updateUI() }` 回主线程。
- **Task 入口隔离规则**：匹配 Task 的"同步前缀"（`{` 到第一个 `await`）。前缀有 `@MainActor` 工作 → 保留继承的 `@MainActor` 起点；前缀无主 actor 工作 → 用 `Task { @concurrent in ... }`，只在 UI 写回时 hop 回主线程。延迟重试/退避的 `sleep` 通常该放在主 actor 外。
- **不要**在 async 上下文里用 semaphore / 手写锁；用 actor 隔离或 `Mutex` 表达所有权。

### 5. SwiftUI 数据流陷阱
- view body 里写 `Binding(get:set:)` 很脆弱 → 改用 `@State` + `.onChange(of:)`。
- 副作用别写在 body（body 会被反复求值）。
- 弃用 API：`foregroundColor()` → `foregroundStyle()`（见 swiftui-pro `references/api.md`）。

### 6. 可测试性靠协议注入（DI）
碰文件系统 / 网络 / 外部 API 的代码直接写死 = 无法确定性测试。
- **怎么防**：把每个外部关注点抽成**小而专的协议**（`FileAccessorProviding` 等，单一职责，别造 god protocol），生产实现做默认参数，测试注入 Mock。
- 跨 actor 边界的协议要 `Sendable`。只 mock 边界（文件/网络/API），不 mock 内部类型。没有外部依赖的类型不需要协议（别过度工程）。

## 测试（test runner / 写法 / coverage 命令）

两种框架：**Swift Testing**（新，`import Testing` + `@Test` + `#expect`，首选）和 **XCTest**（旧，`XCTestCase`）。两者可共存。

### SwiftPM 包（`Package.swift`）
```bash
# 跑全部测试
swift test

# 带 coverage
swift test --enable-code-coverage

# 拿到 coverage profdata 路径（喂给 llvm-cov 出报告 / 算门槛）
swift test --show-code-coverage-path

# 单测过滤（正则匹配测试名）
swift test --filter "SyncManagerTests"

# 并行跑
swift test --parallel
```
coverage 报告：`swift test --enable-code-coverage` 后用
`xcrun llvm-cov report <可执行/xctest 二进制> -instr-profile=<上面 --show-code-coverage-path 的 default.profdata>`。

### Xcode 工程（`.xcodeproj` / `.xcworkspace`）
```bash
# 跑测试 + 开 coverage + 落 result bundle
xcodebuild test \
  -scheme MyApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -enableCodeCoverage YES \
  -resultBundlePath ./TestResults.xcresult

# 用 workspace 时把 -project/-scheme 换成 -workspace MyApp.xcworkspace -scheme MyApp
```
coverage 从 result bundle 读：`xcrun xccov view --report --json ./TestResults.xcresult`
（`xccov view --report` 给人读，加 `--json` 给脚本算门槛）。

### Swift Testing 写法（首选）
```swift
import Testing

@Test("Sync manager handles missing container")
func missingContainer() async {
    let mock = MockFileSystemProvider(containerURL: nil)
    let manager = SyncManager(fileSystem: mock)
    await #expect(throws: SyncError.containerNotAvailable) {
        try await manager.sync()
    }
}
```
- 异步等待用 `await fulfillment(of:)`（XCTest）或 Swift Testing 等价物；**不要**在 async 上下文用旧 `wait(...)`（`wait is unavailable from asynchronous contexts`）。
- 重点测 actor 隔离、生命周期/deinit、取消（`Task.isCancelled`）相关路径。

## Lint（linter + 确切命令）

工具：**SwiftLint**（配置文件 `.swiftlint.yml`）。

```bash
# lint 整个目录（lint 是默认子命令）
swiftlint

# 显式
swiftlint lint

# CI 门槛：把 warning 升级为 error（任何违规即非零退出）
swiftlint lint --strict

# 自动修正可修的违规
swiftlint --fix

# 机器可读输出（CI 用）
swiftlint lint --reporter json --quiet
```
- 并发相关：`async_without_await`（`async` 未实际被协议/override/`@concurrent` 要求时报警）——**移除 `async` 或写明理由的窄抑制，绝不加假 await**。
- 安全相关 opt-in 规则建议开：`force_unwrapping`、`force_cast`、`force_try`、`weak_delegate`。
- 进阶：`swiftlint analyze`（需编译日志，跑分析型规则如 `unused_declaration`）。

## LSP（language server）

**sourcekit-lsp**（随 Swift 工具链分发，路径 `/usr/bin/sourcekit-lsp` 或 `$(xcrun --find sourcekit-lsp)`）。

ai-readiness 的 "LSP 就绪" 维度判断要点：
- **SwiftPM 包**：开箱即用，sourcekit-lsp 直接读 `Package.swift`，无需额外配置。
- **Xcode 工程**：sourcekit-lsp 需要 compile commands。优先用支持 `.xcodeproj` 的 build server，或生成 `compile_commands.json`（如 `xcode-build-server`）让 LSP 能解析非 SPM 工程。
- 就绪信号：`xcrun --find sourcekit-lsp` 成功 + 包能 `swift build` 通过（LSP 索引依赖可成功构建）。
- 不就绪信号：纯 `.xcodeproj` 且无 build server 配置 → 跨文件跳转/补全会退化。

## 框架（SwiftUI / Swift 6 并发额外约定）

### SwiftUI（swiftui-pro 蒸馏）
- 目标 iOS 26 / Swift 6.2+，现代并发；默认不引入 UIKit、不擅自加第三方框架。
- 一个类型一个文件（struct/class/enum 别堆一个文件）；按 feature 组织目录。
- 审查维度：弃用 API、view/modifier/animation 写法、数据流、导航（`NavigationStack`/`NavigationSplitView`）、可访问性（Dynamic Type / VoiceOver / Reduce Motion）、性能。
- 可访问性硬规则：纯图标按钮要给文本标签（`Button("Add", systemImage: "plus", action:)`），否则 VoiceOver 不可见。

### Swift 6 迁移循环（每次改动一轮）
1. `swift build`（或 Xcode build）暴露新诊断
2. 一次只修一类错误（如先全清 Sendable）
3. 重新构建，确认干净再往下
4. `swift test` 跑测试防回归
5. 该文件/模块全清后再进下一个；不批量混合无关修复

## 接入 cap

| 环节 | SwiftPM 包 | Xcode 工程 |
|------|-----------|-----------|
| **build（TDD 跑测试）** | `swift test`（迭代）/ `swift test --filter <name>`（聚焦） | `xcodebuild test -scheme <S> -destination '<dest>'` |
| **verify/logic（coverage 门）** | `swift test --enable-code-coverage` → `swift test --show-code-coverage-path` 取 profdata → `xcrun llvm-cov report` 算覆盖率 | `xcodebuild test ... -enableCodeCoverage YES -resultBundlePath <p>` → `xcrun xccov view --report --json <p>` 算覆盖率 |
| **lint 门** | `swiftlint lint --strict`（违规即非零退出） | 同左 |
| **role 卡** | **client-dev**（iOS / 移动端面） | **client-dev** |

build 阶段默认用 `swift test`（SPM）或 `xcodebuild test`（Xcode 工程，需 scheme + destination）。
verify/logic 的覆盖率门：SPM 走 `llvm-cov`，Xcode 走 `xccov --json`。
lint 门统一用 `swiftlint lint --strict`。
