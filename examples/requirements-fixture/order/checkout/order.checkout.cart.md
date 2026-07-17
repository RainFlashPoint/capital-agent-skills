---
id: order.checkout.cart
title: 购物车增删改与小计
domain_path: order/checkout
cross_link: []
old_system_ref: legacy/CartServlet
new_domain_path: order/checkout
status: shipped
priority: P1
depends_on: []
risk_level: medium
updated: 2026-06-16
---

## 需求描述
用户可向购物车添加/移除商品、调整数量，实时显示小计与库存校验。

## 验收线索
加 3 件商品小计正确；移除后重算；超库存数量被拒。

## 老系统行为参照
CartServlet 用 session 存购物车，刷新易丢；新系统改持久化。
