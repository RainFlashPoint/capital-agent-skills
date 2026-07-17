---
id: user.auth.login
title: 账号密码登录与会话
domain_path: user/auth
cross_link: []
old_system_ref: legacy/LoginAction
new_domain_path: user/auth
status: shipped
priority: P0
depends_on: []
risk_level: medium
updated: 2026-06-16
---

## 需求描述
邮箱+密码登录，签发 httpOnly 会话，错误凭据返回统一错误。

## 验收线索
有效凭据 200+cookie；无效 401 不泄露是账号还是密码错。

## 老系统行为参照
LoginAction 明文比对密码；新系统用 bcrypt。
