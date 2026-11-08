# reactory-azure

Microsoft Graph and Azure Blob Storage integration for the [Reactory](https://github.com/reactorynet)
server.

This is a **production module**, not a sample. It authenticates a user against Microsoft
identity (authorization-code flow with PKCE), vaults the access and refresh tokens encrypted
(AES-256-GCM, per-user salt), and exposes Microsoft 365 capabilities as Reactory services,
GraphQL fields and Reactor AI macros.

## What it provides

| Capability | Ticket | State |
|---|---|---|
| Microsoft identity, token vault, legacy token bridge, `/me` profile | AZ-01 | implemented |
| Graph client provider — retry, pagination, delta, batching | AZ-01 | implemented |
| Audit log with credential redaction | AZ-01 | implemented |
| Mail read / write | AZ-04, AZ-05 | stubs |
| Microsoft To Do | AZ-06 | stub |
| Calendar, availability, online meetings | AZ-07 | stub |
| OneDrive files | AZ-08 | stub |
| Word documents, Excel workbooks | AZ-09, AZ-10 | stubs |
| Contacts and the organisation directory | AZ-11 | stub |
| Delta sync and change-notification subscriptions | AZ-12 | stubs |
| Teams, SharePoint | AZ-14, AZ-15 | stubs |
| Azure Blob Storage | AZ-16 | stub |
| Forms, Reactor macros and the workspace assistant | AZ-13, AZ-17 | not started |

The module registers **16 services** and **2 models** today. Every stub throws
`ApiError('not implemented', { ticket })` — no capability returns an empty result it cannot
justify.

## Installation

The module is consumed as a Reactory server module at
`src/modules/reactory-azure`. It contributes the module FQN `core.ReactoryAzure@1.0.0` and
the `azure` component namespace.

```bash
npm install            # @azure/msal-node, @microsoft/microsoft-graph-client, @microsoft/microsoft-graph-types
```

## Configuration

A Microsoft Entra app registration (web platform, confidential client) and these
environment variables are required before authentication works:

```
AZURE_CLIENT_ID
AZURE_CLIENT_SECRET
AZURE_TENANT_ID            # tenant id, or "organizations"
AZURE_REDIRECT_URI         # must match the registered redirect
AZURE_TOKEN_ENCRYPTION_KEY # master key for token encryption
AZURE_API_RATE_LIMIT       # optional, per-user requests/minute
```

The module fails loudly (`AzureConfigurationMissing`) rather than starting a half-configured
client. See `AGENT.md` for the full contract, the legacy shim's retirement gate and the test
recipe.

## Before you restart the server (blocking)

`@microsoft/microsoft-graph-client` is a **new runtime dependency and it is not installed in
the host server**. `services/graph.ts` — retained for `reactory-core`, which imports it
eagerly — imports the provider, which imports that package, so a merge followed by a restart
fails at **core module load** with `MODULE_NOT_FOUND`: the server does not boot.

Install it so that it resolves from `src/modules/reactory-azure`, either

1. in the module (`cd src/modules/reactory-azure && npm install`), or
2. at the server root (add it to `reactory-express-server/package.json`, as is already done
   for `googleapis` used by `reactory-google`).

A worktree-local install is only visible to the test harness, not to the server.

## Enabling the module

Registering new services and models requires a **restart of the express server** (after the
install above). Until then the code is present but inert, and `services/graph.ts` remains the
shim that keeps the existing Microsoft sign-in path working.

## Tests

```bash
node /Users/wernerw/Projects/reactory/reactory-express-server/src/modules/reactory-reactor/scripts/ai/run-worktree-tests.js \
  --module-root <worktree> __tests__
```

The suite mocks the Graph layer end to end; no tenant and no live Graph call are involved.

## Documentation

- `docs/audit.md` — the defects this rebuild fixes
- `docs/implementation-plan.md` — the AZ-01…AZ-19 delivery plan
- `AGENT.md` — agent-facing module context

## License

MIT
