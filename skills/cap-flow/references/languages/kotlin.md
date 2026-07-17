---
lang: Kotlin
extensions: ["**/*.kt", "**/*.kts", "android/**"]
---

# Kotlin 语言包

> 供 本技能族的 role 卡（client-dev / server-dev）、verify/logic、build TDD、ai-readiness（LSP 维度）按语言加载。命令以 Gradle wrapper（`./gradlew`）为准——绝大多数 Kotlin / Android 项目都带 wrapper，优先用它而非全局 `gradle`，保证版本一致。

## 语言陷阱（常见 pitfall + 怎么防）

Kotlin 特有易错点，code review / correctness 重点盯这些：

- **`!!` 非空断言**——把可空类型强转非空，运行期直接抛 `NullPointerException`，等于绕过 Kotlin 的空安全。
  - 防：禁止裸 `!!`。用 `?.`（安全调用）、`?:`（Elvis 兜底）、`requireNotNull(x) { "..." }`（带消息显式失败）、或 `let { }` 收窄作用域。detekt 的 `UnsafeCallOnNullableType` 规则可静态拦截。
- **可空性建模随意**——到处 `String?` 又到处 `!!`，把空安全退化成 Java。
  - 防：边界（API/DB/外部输入）才允许可空，内部尽早 `requireNotNull` / 映射成非空领域模型；领域模型（domain layer）字段优先非空。
- **协程作用域泄漏**——用 `GlobalScope.launch` 或裸 `CoroutineScope(...)` 起协程，组件销毁后协程仍在跑，泄漏 + 回调访问已死对象。
  - 防：用结构化并发。Android ViewModel 用 `viewModelScope`，Compose 用 `rememberCoroutineScope` / `LaunchedEffect`，其余用随生命周期取消的 scope。**禁止 `GlobalScope`**。detekt 有 `GlobalCoroutineUsage` 规则。
- **Android 生命周期**——在 `Activity`/`Fragment` 里持有 `Context`/`View` 强引用做异步，配置变更（旋屏）或销毁后泄漏；在错误回调线程更新 UI。
  - 防：状态上提到 ViewModel（`viewModelScope` + `StateFlow`），UI 只观察；用 `repeatOnLifecycle(STARTED)` 收集 Flow，避免后台仍在消费。
- **`runCatching` 吞掉 `CancellationException`**——`runCatching { }` 会捕获包括协程取消在内的所有 `Throwable`，破坏结构化并发的取消传播。
  - 防：catch 后判断并重抛取消：`catch (e: CancellationException) { throw e }`，或只捕获具体业务异常。
- **可变共享状态**——`var` + 共享 `MutableList` 跨协程并发改。
  - 防：优先 `val` + 不可变 `data class`（`copy()` 出新副本），跨协程状态用 `StateFlow`/`MutableStateFlow`（线程安全的 `update { }`）。
- **`data class` equals/hashCode 陷阱**——`data class` 只对主构造参数生成 equals；用作 Map key / Set 元素时，非主构造属性不参与判等。
  - 防：判等所需字段全放主构造；可变字段不要进 `data class` 主构造再当 key。

## 测试（test runner / 写法 / coverage 命令）

供 build TDD 与 verify/logic 用的确切命令（JUnit / Kotest + MockK，coverage 用 Kover）。

**Runner**：Kotest（推荐，spec 风格表达力强）或 JUnit5（kotlin-test）。MockK 做 mock；suspend 函数用 `coEvery`/`coVerify`；协程测试用 `kotlinx-coroutines-test` 的 `runTest` + `advanceTimeBy`（**禁止 `Thread.sleep`**）。

**测试命令**：

```bash
# 跑全部测试（build TDD 的 GREEN/RED 验证命令）
./gradlew test

# 单个测试类
./gradlew test --tests "com.example.UserServiceTest"

# 单个测试用例
./gradlew test --tests "com.example.UserServiceTest.getUser returns user when found"

# 详细输出 / 持续监听
./gradlew test --info
./gradlew test --continuous

# Android：单元测试（JVM，不需要设备）走 testDebugUnitTest
./gradlew testDebugUnitTest
# Android：仪器测试（需要设备/模拟器）
./gradlew connectedDebugAndroidTest
```

> 注：`./gradlew test` 只跑 JVM 单元测试；Android 模块的本地单测任务名是 `testDebugUnitTest`（或 `test{Variant}UnitTest`）。纯 Kotlin/JVM/KMP 模块用 `test`。

**写法要点**：
- Kotest spec 选型：`StringSpec`（最简）、`FunSpec`（JUnit 风格）、`BehaviorSpec`（Given/When/Then BDD）、`DescribeSpec`（RSpec 风格）。一个项目统一一种风格。
- 测行为不测实现；不要 mock `data class`（用真实例）；不测私有函数。
- 纯函数用属性测试（Kotest `forAll` / `checkAll` + `Arb`）。
- 数据驱动用 `withData`。
- mock 在 `beforeTest { clearMocks(...) }` 复位。

**Coverage（Kover）命令**——verify/logic 的覆盖率门：

```bash
# 生成 HTML 报告（顺带跑测试）
./gradlew koverHtmlReport

# 覆盖率门：低于阈值则 build 失败（correctness 门用这条）
./gradlew koverVerify

# CI 用 XML 报告
./gradlew koverXmlReport
```

Kover 阈值在 `build.gradle.kts` 配置（`kover { reports { verify { rule { minBound(80) } } } }`），默认门 80%。也可用 JaCoCo（任务名 `jacocoTestReport` / `jacocoTestCoverageVerification`），但新项目优先 Kover（原生支持 Kotlin、KMP）。

覆盖率目标：关键业务逻辑 100%，公开 API 90%+，一般代码 80%+，生成/配置代码排除。

## Lint（linter + 确切命令）

两套互补，建议都接：ktlint 管格式，detekt 管静态分析/复杂度/反模式。

```bash
# ktlint：格式检查（CI 门）
./gradlew ktlintCheck
# ktlint：自动修复格式
./gradlew ktlintFormat

# detekt：静态分析（含 !! / GlobalScope 等规则）
./gradlew detekt
# detekt：自动修复可修复项
./gradlew detekt --auto-correct
```

> ktlint 也有独立 CLI（`ktlint` 命令），但项目内优先用 Gradle 任务，保证规则版本与项目一致。detekt 规则集在 `detekt.yml` 配置——空安全相关重点开启 `UnsafeCallOnNullableType`、`UnsafeCast`；协程相关 `GlobalCoroutineUsage`。

## LSP（供 ai-readiness 的「LSP 就绪」维度判断）

- **Language server**：`kotlin-language-server`（fwcd/kotlin-language-server，官方社区实现）。提供补全、跳转、诊断、悬停。
- **就绪判据**（ai-readiness 检查）：
  - 项目是标准 Gradle（`build.gradle.kts` + `settings.gradle.kts` + `gradlew`）或 Maven 结构，LSP 能解析 classpath。
  - `kotlin-language-server` 可在 PATH 找到（`which kotlin-language-server`）或编辑器已配置。
  - 首次需先 `./gradlew build`（或至少 `./gradlew dependencies`）让依赖解析完成，LSP 才有完整符号索引。
- **Android 注意**：纯 `kotlin-language-server` 对 Android 框架符号支持有限；Android 工程的「IDE 级」语义实际靠 IntelliJ/Android Studio 的内置分析。ai-readiness 评估 Android 模块的 LSP 就绪时，以「Gradle 能 sync + 单测能跑」作为可用代理信号，而非强依赖独立 LSP 二进制。

## 框架（额外 pitfall / 测试约定）

**Android（Clean Architecture）**：
- 分层与依赖方向：`app → presentation, domain, data, core`；`presentation → domain`；`data → domain`；**`domain` 绝不依赖 `data`/`presentation`/任何框架**（纯 Kotlin）。
- pitfall：在 `domain` import Android 框架类；把 DB entity / DTO 直接暴露给 UI（必须 mapper 映射成 domain model）；业务逻辑塞 ViewModel（应抽到 UseCase）；循环模块依赖。
- UseCase 用 `operator fun invoke` 调用点干净；Repository 接口定义在 domain、实现在 data。
- 测试约定：UseCase / Repository / ViewModel 走 JVM 单测（`testDebugUnitTest`，MockK + `runTest`）；UI/集成走仪器测试（`connectedDebugAndroidTest`，需设备）。错误用 `Result<T>` 或自定义 sealed `Try<T>` 传播，ViewModel 里 `when` 映射成 UI state。

**Ktor（server 面，若该模块是后端）**：
- 用 `testApplication { }` 起内存测试服务，`client.get/post` 直接发请求断言 `response.status` / `response.body()`。
- 归 server-dev（见下）。

**KMP（Kotlin Multiplatform）**：
- `commonTest` 用 `kotlin("test")` + Kotest multiplatform；DB 用 SQLDelight，网络用 Ktor client。
- 用 convention plugin（`build-logic/`）收敛各模块 build 脚本重复。

## 接入 cap

- **build / TDD 用的 test 命令**：纯 Kotlin/JVM/KMP 模块 `./gradlew test`；Android 模块 `./gradlew testDebugUnitTest`。RED/GREEN 循环以此为准；`--tests "<FQN>"` 跑单测，`--continuous` 监听。
- **verify/logic 的 coverage 门命令**：`./gradlew koverVerify`（阈值在 `build.gradle.kts`，默认 80%）；报告产出用 `./gradlew koverXmlReport`（CI）/ `koverHtmlReport`（本地）。lint 门：`./gradlew ktlintCheck detekt`。
- **归哪个 role 卡**：主归 **client-dev**（Android 移动面：UI/ViewModel/Compose/生命周期）。当模块是 Ktor / KMP 共享后端逻辑时，对应部分归 **server-dev**（用 Ktor `testApplication` 测试约定 + 同样的 `./gradlew test` / `koverVerify` 门）。
