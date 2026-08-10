# @mergifyio/ci-core

> **Actively maintained — the source moved.** `@mergifyio/ci-core` is still
> developed and published to npm, now from the
> [Mergifyio/mergify-ci-integrations](https://github.com/Mergifyio/mergify-ci-integrations)
> monorepo (see
> [`clients/ts/`](https://github.com/Mergifyio/mergify-ci-integrations/tree/main/clients/ts)).
> Please open issues and pull requests on the monorepo.

Internal shared core for Mergify's test-framework reporters.

This package is not intended for direct consumption. It is consumed by the
published framework reporters:

- [`@mergifyio/vitest`](../vitest) — Vitest reporter.
- [`@mergifyio/playwright`](../playwright) — Playwright reporter.

It provides reporter-agnostic helpers for OpenTelemetry span emission, CI
provider / repository / Git resource detection, quarantine and flaky-detection
API clients, and the shared `TestCaseResult` / `TestRunSession` types.

API stability is **not** guaranteed across minor versions — breaking changes
land without deprecation cycles. Pin the consuming package (`@mergifyio/vitest`
or `@mergifyio/playwright`) instead.
