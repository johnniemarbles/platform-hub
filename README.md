# platform-hub

The integration hub: the only code that talks to outside providers or holds their keys.

Part of the shared platform described in **Platform Architecture Plan: Hub, Platform and Apps (V3.1)**, the source of truth for this repo. Four repo kinds: `platform-hub`, `platform-core`, `spoke-template`, and one repo per industry app. Dependencies run one way: apps use the platform and the hub; the platform uses the hub; the hub depends on neither.

## Layout

```text
platform-hub/             pnpm workspaces + turbo.json
  packages/               libraries (never deployed on their own)
    contracts/            OpenAPI spec, webhook and event schemas, typed refusal codes
    sdk/                  generated client with mock mode, used by platform and apps
    credential-custody/   browser wrapping, fingerprints, probes, request signing, vault port
    enforcement/          the 16 gates, two-plane budgets, throttle windows, spend caps, traces
    adapters/             one folder per provider: ses, sendgrid, twilio, stripe, razorpay, anthropic, openai, gemini, ...
  apps/                   deployed per regional cell
    hub-api/              /v1 command API and control plane (database, no vault decrypt)
    custody/              wrapping keys, intake, probes, vault writes (vault, no database)
    workers/              transactional queue, bulk queue, outbox and webhook retries
    ingress/              public provider webhooks, signature check, endpoint-to-tenant lookup
    mcp/                  runtime and admin MCP servers for AI agents
    connect-widget/       embeddable browser UI for key entry and OAuth consent
```

Packages are named `@platform-hub/<name>`. Packages are added when they are needed, never ahead of demand.

## Rules enforced here

1. The hub knows providers, never business domains. If swapping a provider would change the code, it belongs here.
2. Provider SDKs are imported only in `packages/adapters` (and `apps/custody` for key probes). CI fails anywhere else.
3. The hub depends on neither `@platform-core/*` nor any app. CI fails on either.
4. No caller-supplied tenant ID or owner path is trusted: every request carries a short-lived signed token from the platform, verified here.
5. Three credential classes (platform operational, tenant BYOK, platform-provisioned for a tenant), never mixed. No silent fallback to an ungranted or unrelated key.
6. Every write takes an idempotency key; refusals are typed results with a reason and trace ID, never exceptions.
7. Identity SDKs are banned here: sign-in codes never depend on the hub.

The rules live in `architecture.config.json` and are checked by `scripts/architecture/check.ts` on every pull request.

## Commands

```bash
corepack enable
pnpm install
pnpm run check                 # architecture rules, their tests, typecheck, tests
pnpm run check:architecture    # layer rules only
pnpm turbo dev --filter=<package>
```

Requires Node 22 or later and pnpm 10.15 (pinned through `packageManager`).

## Environments

Development and staging run on Railway with **test data only**. Production regional cells (India, Canada, US, UK, Australia) follow the plan's residency rules and are opened when a country's first customer signs.
