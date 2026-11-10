# Agent Note: A deep task path is a document-relative entry

Status: implemented

English | [中文](2026-11-09-web-deep-path-task-route.zh.md)

## Problem

The issue view wants a shareable, cold-loadable path (`/task/<ref>`) for an issue. The shipped document-relative model freezes the base to the entry directory and says deep direct loads are not entry points, so a naive deep path would either 404 or, if served as the shell, resolve every `plugins/…` and `api/…` reference under the wrong directory.

## Decision

The route is `task/<ref>` (optionally one trailing slash): one fixed segment plus one ref segment. A trailing slash uses `<base href="../../">`. It is served as the same document as `/` and `/index.html`, but with a per-entry base:

- `/` and `/index.html` inject `<base href="./">`.
- `/task/<ref>` injects `<base href="../">`, which resolves app-owned routes back to the mount.

The base is chosen by the route the harness itself defines; nothing infers a prefix, and no mount is recovered from the transport. The ref is read by the client from `location.pathname` (decoded with `decodeURIComponent`) and is never used as a request target. `verify-client-route-resolution` is unchanged: `task` is a client route, not an app-owned request route, and a `location.pathname` read is not a relative app route.

Proxy: a prefix-stripping proxy forwards `/mount/task/<ref>` as `/task/<ref>`, which the harness now answers itself, so no proxy change is expected beyond the existing bare-mount slash normalization. If the real lane shows otherwise, that is a deployment change and stops at `wait_for_decision`.

## Alternatives considered

- **A true server route** outside the document base: reopens the closed decision and breaks relative fetches. Rejected.
- **Full SPA fallback** for any unknown path: masks genuine 404s and widens blast radius. Rejected; fallback is scoped to `^/task/[^/]+/?$` only.

## Consequences

One bundle still serves the origin root and any mount. Deep cold loads and reloads land on the app; `document.baseURI` stays at the mount because of the per-entry base. The cost remains explicit: only `/`, `/index.html`, and `/task/<ref>` are entries; everything else is 404.

## Testing

`packages/host/frontend-static/tests/frontend-static.spec.ts` serves `/task/<ref>` as the shell with exactly one `<base href="../">` that precedes injected rows. `apps/web/tests/public-mount.e2e.ts` cold-loads `/mount/task/<ref>` through the proxy and asserts shell, base, bundles, and a relative fetch. The route gate stays green with one new spec case showing a `location.pathname` ref read passes.
