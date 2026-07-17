---
id: user.auth.reset-pwd
title: 找回密码（邮件链接）
domain_path: user/auth
cross_link: []
old_system_ref: legacy/ForgotPwdAction
new_domain_path: user/auth
status: captured
priority: P2
depends_on: [user.auth.login]
risk_level: low
updated: 2026-06-16
---

## 需求描述
用户提交邮箱，收到带时效令牌的重置链接，设置新密码后令牌失效。

## 验收线索
链接 30 分钟过期；用过即失效；新密码满足强度策略。

## 老系统行为参照
旧系统直接邮寄明文临时密码，安全隐患大。
