---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-07-session-external-owner

[English](2026-11-07-session-external-owner.md) | 中文

## 概述

为持久化的会话头部添加可选的 externalOwner 元数据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-session-external-owner
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-11-initial"
    after: "c17a7b53909769701c8310a88721927acc100e6ec6fac06b202c1ad6efd12b5e"
    decision: same-version
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "6ed57fde2cb35c28b89d4d400b6ca3a86bd94843217935decf2cb8c317c65fab"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取器接受缺少 externalOwner 的旧头部。旧读取器会在打开或修改会话前验证并拒绝未知头部键，持久化日志保持完整；对于不支持的可选标签，这是安全的拒绝处理。该值仅用于展示，不授予写入权限。

<a id="verification"></a>
## 验证

会话外部跟随、编辑器、租约和观察相关的定向测试通过：4 个文件共 58 项测试。已检查旧头部验证器：它会在会话恢复或修改前拒绝未知键。

<a id="dev-note"></a>
## 开发备注

无。
