---
id: billing.pay.refund
title: 原路退款
domain_path: billing/pay
cross_link: []
old_system_ref: legacy/RefundBatch
new_domain_path: billing/pay
status: captured
priority: P3
depends_on: [billing.pay.alipay]
risk_level: medium
updated: 2026-06-16
---

## 需求描述
已支付订单发起原路退款，记录退款流水，部分退款累计不超过原额。

## 验收线索
累计退款 ≤ 原额；重复退款请求幂等；退款状态可查。

## 老系统行为参照
RefundBatch 为隔夜批处理，退款到账慢；新系统要求实时发起。
