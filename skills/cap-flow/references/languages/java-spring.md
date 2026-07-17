---
lang: Java / Spring Boot
extensions: ["**/*.java"]
---

# Java / Spring Boot 语言包

服务端语言。归 **server-dev** role 卡。

## 语言陷阱（常见 pitfall + 怎么防）

| 陷阱 | 表现 | 怎么防 |
|------|------|--------|
| **NPE（空指针）** | `getX().getY()` 链式调用炸 | 返回 `Optional<T>` 而非 null；用 `Objects.requireNonNull(arg, "msg")` 在边界做断言；`@Nullable`/`@NonNull` 注解 + 静态分析（SpotBugs 能查）。 |
| **可变共享状态** | `@Component`/`@Service`/`@Controller` 默认单例 → 实例字段并发不安全 | Bean 字段保持无状态或不可变（`final` + 构造注入）；可变状态放方法局部变量、`ThreadLocal` 或外部存储；用 `record` 做不可变 DTO。 |
| **事务边界错位** | `@Transactional` 同类内部 self-invocation 不生效（代理绕过）；`readOnly` 漏标 | `@Transactional` 只对外部调用的 public 方法生效；跨方法事务用注入自身代理或拆类；查询方法标 `@Transactional(readOnly = true)`；检查传播级别（`REQUIRED` vs `REQUIRES_NEW`）。 |
| **JPA N+1 查询** | 列表里每个实体懒加载关联各发一条 SQL | 用 `@EntityGraph` 或 `JOIN FETCH` 的 JPQL 一次拉取；`spring.jpa.properties.hibernate.default_batch_fetch_size` 批量；测试时开 `spring.jpa.show-sql=true` 数 SQL 条数。 |
| **资源未关闭** | `InputStream`/`Connection`/`ResultSet` 泄漏 | 一律 try-with-resources（`try (var in = ...)`）；JDBC 优先用 `JdbcTemplate`/Spring Data 让框架管生命周期。 |
| **SQL 注入（拼接 native query）** | `"... WHERE name = '" + name + "'"` | 永远用 `:param` 绑定 + `@Param`；优先 Spring Data 派生查询（自动参数化）。 |
| **配置/密钥硬编码** | `application.yml` 写死密码 | 用 `${DB_PASSWORD}` 占位 + 环境变量/Vault；启动时校验必需配置存在。 |
| **equals/hashCode 与 JPA** | 用 `@Id` 自增主键写 equals → 持久化前后 hash 变化 | 用业务键或固定值实现，或用 `record` DTO 与实体分离。 |

## 测试（test runner / 写法 / coverage 命令）

Runner：**JUnit 5（Jupiter）+ Mockito**，断言用 **AssertJ**（`assertThat`）。

分层写法：
- **单元**：`@ExtendWith(MockitoExtension.class)` + `@Mock`/`@InjectMocks`，纯 mock，AAA 结构，变体用 `@ParameterizedTest`。
- **Web 层**：`@WebMvcTest(XxxController.class)` + `MockMvc` + `@MockBean`，断言 `status()`、`jsonPath("$.field")`。
- **集成**：`@SpringBootTest @AutoConfigureMockMvc @ActiveProfiles("test")`，走完整上下文。
- **持久层**：`@DataJpaTest`（+ Testcontainers via `@DynamicPropertySource` 注入真实 Postgres/Redis JDBC URL，镜像生产）。
- 异常断言 `assertThatThrownBy(...)`；测试数据用 builder。

**测试命令（build TDD 跑这条）：**
```bash
# Maven
mvn test                 # 仅跑单测
mvn -T 4 test            # 并行
# Gradle
./gradlew test
```

**Coverage 门（verify/logic 跑这条）：** JaCoCo，绑定到 verify 阶段。
```bash
# Maven —— verify 触发 jacoco prepare-agent + report，报告在 target/site/jacoco/
mvn verify
# Gradle
./gradlew test jacocoTestReport
```
报告位置：Maven `target/site/jacoco/index.html`；Gradle `build/reports/jacoco/test/html/index.html`。
门禁阈值用 JaCoCo 的 `jacocoTestCoverageVerification`（Gradle）或 maven 插件 `check` goal 强制 80%+。

## Lint（linter + 确切命令）

两件套：**Checkstyle**（风格/约定）+ **SpotBugs**（字节码缺陷，含 NPE/资源泄漏/并发）。

```bash
# Maven
mvn checkstyle:check          # 风格违规则失败
mvn com.github.spotbugs:spotbugs-maven-plugin:check   # 缺陷门禁
# 或绑定到 verify 后：mvn verify 一并跑

# Gradle（apply checkstyle / spotbugs 插件后）
./gradlew checkstyleMain checkstyleTest
./gradlew spotbugsMain
./gradlew check              # 聚合 test + checkstyle + spotbugs
```
（可选：Spotless/google-java-format 做自动格式化 `mvn spotless:apply` / `./gradlew spotlessApply`。）

## LSP（language server，供 ai-readiness "LSP 就绪"维度）

Language server：**jdtls** = Eclipse JDT Language Server（`eclipse.jdt.ls`），VS Code Java 扩展、nvim、Emacs lsp 后端均用它。

"LSP 就绪"判据：
- 存在构建描述符（`pom.xml` 或 `build.gradle`/`settings.gradle`）让 jdtls 能解析 classpath。
- `.java` 文件 package 声明与目录结构一致（jdtls 靠此建符号索引）。
- JDK 版本可被发现（`JAVA_HOME` 或 `.sdkmanrc`/`java.configuration.runtimes`）。
- 首次打开后 jdtls 会生成 workspace 缓存；CI/agent 环境需允许其下载依赖以建立全量索引。

## 框架（Spring Boot 额外约定）

- **DI**：一律构造器注入 + `final` 字段（不可变、可测、避免循环依赖）；不用字段 `@Autowired`。
- **配置**：`application.yml` 用 `${ENV}` 占位，禁提交密钥；profile 隔离（`@ActiveProfiles("test")`）。
- **安全（Spring Security）**：
  - 方法级授权 `@EnableMethodSecurity` + `@PreAuthorize("hasRole('ADMIN')")`，默认拒绝、最小权限。
  - 输入校验：DTO 上 Bean Validation（`@NotBlank`/`@Email`/`@Size`/`@Min`/`@Max`），controller 参数 `@Valid`。
  - 密码：`PasswordEncoder` bean（`BCryptPasswordEncoder(12)`），绝不明文/手搓哈希。
  - CSRF：浏览器 session 应用保持开启；纯 Bearer token API 才 `csrf.disable()` + `SessionCreationPolicy.STATELESS`。
  - CORS 在 security filter 层配，生产禁 `*` 源。
  - 安全头（CSP/frameOptions/referrerPolicy）、限流（Bucket4j，超限返 429）、依赖 CVE 扫描（OWASP Dependency-Check/Snyk，构建失败于已知 CVE）。
  - 日志禁打 secret/token/password/PII。
- **JPA 测试约定**：`@DataJpaTest` 默认会替换为内存库，要测真实库须 `@AutoConfigureTestDatabase(replace = NONE)` + Testcontainers。

## 接入 cap

| 用途 | 命令 / 归属 |
|------|-------------|
| **build TDD 的 test 命令** | Maven `mvn test`（或 `mvn -T 4 test`）；Gradle `./gradlew test` |
| **verify/logic 的 coverage 门命令** | Maven `mvn verify`（JaCoCo 绑 verify，门禁用插件 `check` goal 卡 80%+）；Gradle `./gradlew test jacocoTestReport`（+ `jacocoTestCoverageVerification`） |
| **lint 门** | `mvn checkstyle:check` + spotbugs `check`；Gradle `./gradlew check` |
| **role 卡** | **server-dev** |
| **ai-readiness LSP 维度** | jdtls（eclipse.jdt.ls），需 `pom.xml`/`build.gradle` + 一致的 package 结构 + 可发现 JDK |
