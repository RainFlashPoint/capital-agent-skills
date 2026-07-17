# 示例:cap-map 的产出长什么样(脱敏通用样例)

> 这是 `cap-map` 跑在一个**虚构** web+API 项目 `acme-shop` 上后写出的 `.cap/PROFILE.md` 样子。
> 仅供理解产出形态;**真实项目的 dogfood 产物不入库**(`docs/dogfood/` 已 gitignore,只在本地跑)。

```markdown
# Project Profile: acme-shop

tech-stack: [next.js(TS), fastapi(python), postgres]
test-commands: { unit: "pytest -q", e2e: "playwright test", typecheck: "tsc --noEmit", coverage: "pytest --cov=app --cov-fail-under=80", build: "pnpm build" }

## Surface map        # 模块 → globs → 默认角色 → verify checks
- web-frontend:  globs[ web/**, components/** ]      roles[client-dev, design]   checks[logic, journey:Web]
- api:           globs[ services/api/** ]             roles[server-dev]           checks[logic, journey:OpenAPI]
- domain-model:  globs[ services/api/models/**, migrations/** ]  roles[server-dev, architect]  checks[logic]
- (跨 web+api 改动时 R8 自动叠加 architect:看前端类型↔API schema↔DB model 端到端是否对齐)

## Tech stack（带"原因"）
- Next.js(TS):团队前端栈;SSR + 类型安全。
- FastAPI:Python 后端,自动 OpenAPI(journey:OpenAPI check 可直接用)。
- Postgres:关系型 + 迁移可控。

## Conventions
- 前端走 CSS token(见 DESIGN.md);后端 handler 薄、逻辑入 service 层。

## Entry points
- 前端:web/app/layout.tsx;后端:services/api/main.py(uvicorn);迁移:alembic upgrade head。

## Known risks
- services/api/legacy/ 无测试覆盖(覆盖率缺口,建 baseline 优先)。
```

> 要点:产出是**单一聚合 PROFILE.md**,核心是 `## Surface map`(改动代码路由的可追踪输入)。
> 跑法:对目标项目 `/cap` → 无 PROFILE 自动进 map;或独立 `/cap verify --check=journey --scope=full-chain` 做现状体检。
