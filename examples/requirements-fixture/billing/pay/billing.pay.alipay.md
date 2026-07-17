---
id: billing.pay.alipay
title: 支付宝下单与回调对账
domain_path: billing/pay
cross_link: [order/checkout]
old_system_ref: legacy/AlipayNotify
new_domain_path: billing/pay
status: shaped
priority: P1
depends_on: [order.checkout.place-order]
risk_level: high
updated: 2026-06-16
---

## 需求描述
订单创建后发起支付宝支付，异步回调验签后置订单为已支付，幂等处理重复回调。

## 验收线索
重复回调只置一次已支付；验签失败拒绝；超时未支付自动关单。

## 老系统行为参照
AlipayNotify 未做幂等，重复回调导致重复发货。
