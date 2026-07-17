---
lang: TypeScript / JavaScript
extensions: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
---

# TypeScript / JavaScript 语言包

适用 `.ts` `.tsx` `.js` `.jsx`。所有命令默认用 `npx`（走仓库本地依赖），避免依赖全局安装。

## 语言陷阱（常见 pitfall + 怎么防）

| Pitfall | 现象 | 怎么防 |
|---|---|---|
| `==` / `!=` 松散比较 | `0 == ""`、`null == undefined` 为真，隐式类型转换出 bug | 一律用 `===` / `!==`；用 eslint `eqeqeq` 规则强制 |
| `as any` / `as unknown as T` | 绕过类型系统，运行时炸 | 禁用为主；必须断言时优先类型守卫（`typeof`/`in`/自定义 `is` 谓词）。eslint `@typescript-eslint/no-explicit-any` |
| 漏 `await` | async 函数返回 Promise 未等待，错误顺序/丢异常 | `tsc` 配 `noImplicitAny` 不够；用 eslint `@typescript-eslint/no-floating-promises` + `require-await` |
| 未处理的 promise rejection | 进程级 `unhandledRejection`，CI 静默漏掉 | 所有 async 入口加 `.catch` 或 `try/catch`；eslint `no-floating-promises` |
| `.length` 在可能为 null/undefined 的值上 | `Cannot read properties of undefined (reading 'length')` | 先判空：`arr?.length`、`if (!arr) return`；开 `strictNullChecks`（`strict` 已含） |
| `any` 从 JSON.parse / fetch().json() 渗入 | 外部数据未校验，下游全是 `any` | 系统边界用 schema 校验（zod / valibot）后再用，不裸信任 |
| `==` 与 `Number()` / 隐式数字转换 | `[] + {}`、`"1" - 1` 等怪异结果 | 显式 `Number()` / `parseInt(x, 10)`；写明进制 |
| 浮点相等 | `0.1 + 0.2 !== 0.3` | 用 `Math.abs(a - b) < EPSILON` 比较 |
| 可选链后仍解构 | `const { x } = obj?.foo` 当 `foo` 为空时报错 | 解构前确保非空，或用默认值 `?? {}` |

核心三连：**开 `strict`、禁 `any`、所有 Promise 不许 floating。**

## 测试（test runner / 写法 / coverage 命令）

### Runner：vitest（首选）或 jest

单元/集成测试（build TDD 用这条跑测）：

```bash
# vitest —— CI/一次性运行（关 watch）
npx vitest run

# jest —— 一次性运行
npx jest
```

写法（AAA 结构）：

```typescript
import { describe, it, expect } from 'vitest' // 或 from '@jest/globals'

describe('calculateTotal', () => {
  it('returns 0 for empty cart', () => {
    // Arrange
    const cart: Item[] = []
    // Act
    const total = calculateTotal(cart)
    // Assert
    expect(total).toBe(0)
  })
})
```

### Coverage（verify/logic 覆盖率门用这条）

```bash
# vitest（需装 @vitest/coverage-v8，配置里设 coverage.thresholds）
npx vitest run --coverage

# jest（内置 coverage）
npx jest --coverage

# 已有非 vitest/jest 工具链时用 nyc 包裹
npx nyc <test-command>
```

门槛设在配置文件里更稳（避免 CLI flag 漂移）：vitest 在 `vitest.config.ts` 的
`test.coverage.thresholds`（`lines/functions/branches/statements`）；jest 在
`jest.config` 的 `coverageThreshold.global`。门槛达不到时进程非零退出，可直接当 gate。

### E2E：Playwright（client-dev / 关键用户流）

```bash
# 首次装浏览器
npx playwright install --with-deps
# 跑全部 e2e
npx playwright test
# 排查 flaky
npx playwright test path/to.spec.ts --repeat-each=10 --retries=3
```

E2E 关键约定（来自 e2e-testing skill）：
- 用 **auto-wait locator**：`page.locator(sel).click()`，不要 `page.click(sel)`。
- **禁止 `waitForTimeout(ms)`**；用 `waitForResponse` / `waitForLoadState('networkidle')` / `locator.waitFor({ state })` 做确定性等待。
- 用 **Page Object Model** 隔离选择器；选择器优先 `[data-testid="..."]`。
- 配置：`retries: CI?2:0`、`trace:'on-first-retry'`、`screenshot:'only-on-failure'`、`video:'retain-on-failure'`。
- flaky 用 `test.fixme()` / `test.skip(process.env.CI, ...)` 隔离并挂 issue，别留在主路径。

## Lint（linter + 确切命令）

```bash
# 检查
npx eslint .
# 自动修
npx eslint . --fix
```

配合 `@typescript-eslint`，必开规则：`eqeqeq`、`@typescript-eslint/no-explicit-any`、
`@typescript-eslint/no-floating-promises`、`@typescript-eslint/no-misused-promises`、
`require-await`。`no-floating-promises` 需要 `parserOptions.project` 指向 tsconfig（类型感知）。

## 类型检查（typecheck —— 独立于 lint 的 gate）

```bash
npx tsc --noEmit
```

`tsconfig.json` 必开 `"strict": true`（含 `strictNullChecks`/`noImplicitAny`）。这是 TS 项目最强的
correctness 门，build/validate 都应把它当硬关卡。

## LSP（language server，供 ai-readiness 的"LSP 就绪"维度）

- **language server**：`tsserver`（随 `typescript` 包提供，路径 `node_modules/typescript/lib/tsserver.js`）；编辑器侧常用 `typescript-language-server`（封装 tsserver 为标准 LSP）。
- **就绪判据**：
  1. 仓库本地装了 `typescript`（`node_modules/.bin/tsc` 存在）。
  2. 根目录有 `tsconfig.json` 且 `compilerOptions.strict` 为 true。
  3. `npx tsc --noEmit` 能干净跑完（无配置错误）。
- 满足以上 = LSP 能给出准确的跳转/补全/诊断，AI 可靠地理解类型。`.js` 纯 JS 项目用 `jsconfig.json` + `// @ts-check` 也可达到弱就绪。

## 框架（额外 pitfall / 测试约定）

- **React / Next.js（client-dev）**：组件测试用 `@testing-library/react` + vitest/jest（`environment: 'jsdom'`）；查询优先 `getByRole`/`getByText`，避免测 DOM 结构细节。hooks 的依赖数组漏项是高频 bug，开 `eslint-plugin-react-hooks` 的 `exhaustive-deps`。Server Components 不要在客户端组件里 `await` 服务端逻辑。
- **Node/Express（server-dev）**：路由 handler 必须 `try/catch` 或包 async wrapper，否则 reject 丢进 unhandledRejection。集成测试用 `supertest` 打真实 app 实例。
- **zod / 校验**：所有外部输入（req.body、query、env、fetch 响应）边界处 `schema.parse()`，把 `any` 挡在系统外。

## 接入 cap

| 用途 | 命令 | 归属 role 卡 |
|---|---|---|
| build TDD 跑测 | `npx vitest run`（或 `npx jest`） | — |
| verify/logic 覆盖率门 | `npx vitest run --coverage`（或 `npx jest --coverage` / `npx nyc <cmd>`），门槛配在 config 里 | — |
| 类型门（correctness 硬关） | `npx tsc --noEmit` | — |
| lint 门 | `npx eslint .` | — |
| E2E（关键流验证） | `npx playwright test` | **client-dev** |
| role 归属 | 后端 Node/Express/API → **server-dev**；前端 React/Next/浏览器 → **client-dev**（同仓两端则两张卡都加载本包） |
