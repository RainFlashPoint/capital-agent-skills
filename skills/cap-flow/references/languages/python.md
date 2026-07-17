---
lang: python
extensions: ["**/*.py"]
---

# Python 语言包

供 本技能族的 role 卡（server-dev / client-dev）、verify/logic、build TDD、ai-readiness（LSP 维度）按语言加载。命令均已在本机用 `uvx` 验证过 flag，可直接照抄。

> 工具基线：`test=pytest`（+`pytest-cov`，覆盖率门用 `--cov-fail-under`）；`lint=ruff`（兼容 flake8 规则）+ 格式化 `ruff format`（或 `black`）；`typecheck=mypy`；`lsp=pyright`（或 `pylsp`）。
> 推荐用 `uv` 管理：`uv run pytest …` / `uvx ruff …`，免污染全局环境。

## 语言陷阱（常见 pitfall + 怎么防）

Python 特有的、靠人眼最容易漏、靠工具能挡住的坑：

| Pitfall | 现象 | 防法 |
|---------|------|------|
| **可变默认参数** `def f(x, items=[])` | 默认 list/dict 在多次调用间**共享**，累积污染 | 用 `items=None`，函数内 `if items is None: items = []`。ruff 规则 `B006`（flake8-bugbear）直接报。 |
| **bare except** `except:` 或 `except Exception:` 吞一切 | 连 `KeyboardInterrupt`/`SystemExit` 都吃掉，错误被静默 | 捕获**最窄**的异常类型；必须宽捕时 `except Exception as e:` 并**记录/重抛**，绝不空 `pass`。ruff `E722`（bare except）、`BLE001`（blind except）。 |
| **文件/资源不用 with** 手动 `f = open(...)` | 异常路径下句柄泄漏 | 一律 `with open(...) as f:`；多个资源用 `with a() as x, b() as y:`。ruff `SIM115`。 |
| **late binding 闭包** 循环里 `lambda: i` | 所有闭包都拿到循环结束后的 `i` | 用默认参绑定 `lambda i=i: i`，或 `functools.partial`。ruff `B023`。 |
| **`==` 比 None/True/False** | `x == None` 在重载 `__eq__` 时行为诡异 | 用 `is None` / `is True`。ruff `E711`/`E712`。 |
| **可变类属性当实例状态** | 类体里 `tags = []` 被所有实例共享 | 在 `__init__` 里初始化实例属性，或用 `dataclasses.field(default_factory=list)`。 |
| **f-string 漏前缀** `"{x}"` 没写 `f` | 占位符不替换，静默输出字面量 | ruff `F541`（f-string 无占位符）/审查。 |
| **裸 assert 做运行时校验** | `python -O` 下 assert 被剥离，校验失效 | 业务校验用显式 `if ...: raise ValueError`；assert 只用于测试与不可达分支。 |
| **循环 import / 模块级副作用** | import 顺序敏感、import 时执行重活 | 重逻辑放函数内；必要时函数内延迟 import。 |
| **`except` 后丢失原始 traceback** | `raise NewError()` 抹掉根因 | `raise NewError(...) from e` 保留链。 |

## 测试（test runner / 写法 / coverage 命令）

供 **build TDD** 与 **verify/logic** 使用的确切命令。

**Runner：** `pytest`。TDD 循环 RED→GREEN→REFACTOR。

写法要点：
- 直接用 `assert`（pytest 会重写出可读 diff），不用 `unittest` 的 `assertEqual`。
- 异常断言：`with pytest.raises(ValueError, match="invalid"):`。
- 复用用 `@pytest.fixture`（`yield` 做 setup/teardown，`scope=` 控生命周期，`autouse=True` 自动注入）；跨文件共享放 `tests/conftest.py`。
- 多输入用 `@pytest.mark.parametrize("a,b,expected", [...], ids=[...])`。
- 外部依赖用 `unittest.mock.patch` / `Mock`（`autospec=True` 防误用 API）；异步用 `pytest-asyncio` 的 `@pytest.mark.asyncio` + `assert_awaited_once()`。
- 临时文件用内置 `tmp_path` fixture（自动清理），别手动建删。
- 目录：`tests/{unit,integration,e2e}/`，`test_*.py`，类 `Test*`，函数 `test_*`。

确切命令：

```bash
# 跑全部
pytest
uv run pytest                          # uv 项目

# 快速反馈（首个失败即停 / 只重跑上次失败）
pytest -x
pytest --lf
pytest -k "user"                       # 按名字筛
pytest -m "not slow"                   # 按 marker 筛

# 覆盖率（term-missing 列出未覆盖行号）
pytest --cov=<pkg> --cov-report=term-missing
uvx --with pytest-cov pytest --cov=<pkg> --cov-report=term-missing   # 临时环境

# 覆盖率门（CI / verify/logic 用 —— 低于阈值 exit 非 0）
pytest --cov=<pkg> --cov-branch --cov-fail-under=80
```

把 `<pkg>` 换成被测包/`apps` 目录名。建议在 `pyproject.toml` 的 `[tool.pytest.ini_options].addopts` 固化 `--strict-markers --cov=<pkg> --cov-report=term-missing`。

## Lint（linter + 确切命令）

`ruff` 一把梭（覆盖 flake8 + isort + 大量 bugbear 规则，本机实测 ruff 0.15）：

```bash
# 检查（CI 门：有问题 exit 非 0）
ruff check .
uvx ruff check .

# 只看统计 / 指定规则集
ruff check --statistics .
ruff check --select E,F,B,SIM .        # 含上面 pitfall 的 B006/E722/SIM115 等

# 自动修
ruff check --fix .                     # 安全修复
ruff check --fix --unsafe-fixes .      # 含不安全修复（人工复核）

# 格式化（等价 black）
ruff format .                          # 写入
ruff format --check --diff .           # CI 只校验、不改文件
```

若项目坚持用 flake8 + black：`flake8 .` 做 lint，`black --check --diff .` 做格式门。**别混用** ruff format 与 black 同时改同一文件。

类型检查（lint 门的一部分，建议接入 validate）：

```bash
mypy <pkg>                             # 基础
mypy --strict <pkg>                    # 严格（含 --disallow-untyped-defs 等）
uvx mypy --strict <pkg>
```

## LSP（供 ai-readiness 的"LSP 就绪"维度）

- **首选 `pyright`**（微软，速度快、类型推断强，与 mypy 互补）：
  ```bash
  pyright                              # 全量检查
  pyright --outputjson                 # 机器可读，给 agent 消费
  pyright --warnings                   # 有 warning 也 exit 1
  uvx pyright .
  ```
  编辑器侧对应 `pyright-langserver --stdio`（VS Code Pylance 同源）。
- **备选 `python-lsp-server`（pylsp）**：纯 Python LSP，可插 ruff/mypy 插件，启动 `pylsp`。

ai-readiness「LSP 就绪」判定：仓库能用 `pyright`（或 `pylsp`）跑出诊断、有 `pyproject.toml`/`pyrightconfig.json` 声明 Python 版本与 src 路径，即视为就绪。

## 框架（Django）

仅当检测到 Django（`manage.py` / `settings.py` / `INSTALLED_APPS`）时附加：

- **Runner：** 仍用 `pytest` + `pytest-django`（比 `manage.py test` 反馈更好）。需在 `pytest.ini`/`pyproject.toml` 设 `DJANGO_SETTINGS_MODULE = config.settings.test`。
- **数据库访问：** 测试需 DB 时加 `@pytest.mark.django_db`，或注入 `db` fixture。提速：`addopts = --reuse-db --nomigrations`，测试 settings 用 SQLite `:memory:` + `MD5PasswordHasher`。
- **建模数据用 factory_boy**（`factory.django.DjangoModelFactory`），别手搓对象；`Factory.create_batch(n)` 批量；`SubFactory` 处理外键。
- **测试客户端：** 普通视图用 `client`（`client.force_login(user)` 跳登录）；DRF 用 `rest_framework.test.APIClient`（`force_authenticate(user=...)`）。URL 一律 `reverse('ns:name')`，别硬编码路径。
- **外部服务（Stripe/邮件等）必 mock：** `@patch('apps.payments.services.stripe')`；邮件断言用 `django.core.mail.outbox`（配 `locmem` backend 或 `@override_settings`）。
- **必测权限/授权**：未登录应 302 跳登录或 401。
- 覆盖率门同样用 `pytest --cov=apps --cov-fail-under=80`；分层目标参考 models 90%+ / views 80%+。
- Django pitfall 补充：测试别打生产库；别测 Django/三方内部；`full_clean()` 才触发 model 字段校验（`save()` 默认不校验）。

## 接入 cap

- **归属 role 卡：** 主要是 **server-dev**（后端服务、API、数据层、CLI、脚本、数据/AI 管线）。客户端形态（如 Python 桌面/工具 GUI）才落 client-dev；绝大多数 Python 任务走 server-dev。
- **build（TDD 绿灯）用这条 test 命令：**
  ```bash
  pytest -x            # 或 uv run pytest -x ；Django: pytest -x（已配 DJANGO_SETTINGS_MODULE）
  ```
- **verify / logic 用这条 coverage 门命令（低于阈值即判负）：**
  ```bash
  pytest --cov=<pkg> --cov-branch --cov-fail-under=80
  # Django: pytest --cov=apps --cov-branch --cov-fail-under=80
  ```
  并行接 lint+type 门：`ruff check . && ruff format --check . && mypy <pkg>`。
- **ai-readiness LSP 维度：** `pyright`（或 `pylsp`）可跑 + 有 `pyproject.toml`/`pyrightconfig.json` → 判就绪。
