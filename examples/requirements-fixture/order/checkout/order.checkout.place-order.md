---
id: order.checkout.place-order
title: 提交订单与库存扣减
domain_path: order/checkout
cross_link: []
old_system_ref: legacy/OrderServlet#submit
new_domain_path: order/checkout
status: built
priority: P0
depends_on: [order.checkout.cart]
risk_level: high
updated: 2026-06-16
---

## 需求描述
结算页提交订单：校验购物车、扣减库存、生成订单号，失败回滚。

## 验收线索
两笔并发下单同一最后库存，仅一笔成功；失败不留半成品订单。

## 老系统行为参照
OrderServlet 无事务，超卖频发；新系统要求原子扣减。
