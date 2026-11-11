---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-07-session-external-owner

English | [中文](2026-11-07-session-external-owner.zh.md)

## Summary

Add optional externalOwner metadata to persisted session headers.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

New readers accept old headers with externalOwner absent. Older readers reject the unknown header key during validation before opening or mutating a session, leaving the persisted log intact; this is a safe fail-closed result for an unsupported optional label. The value is presentation metadata only and does not grant write authority.

<a id="verification"></a>
## Verification

Focused session external-follow, composer, lease, and observation tests passed: 58 tests across 4 files. Reviewed the older header validator: it rejects unknown keys before session recovery or mutation.

<a id="dev-note"></a>
## Dev Note

None.
