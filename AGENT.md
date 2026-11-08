# reactory-azure — Server Module Agent Context

## What this module is

`reactory-azure` integrates Microsoft 365 / Microsoft Graph and Azure Blob Storage into
the Reactory server. It authenticates a user against Microsoft identity (authorization-code
flow with PKCE), vaults the resulting tokens encrypted, and exposes Microsoft Graph
capabilities — mail, calendar, Microsoft To Do, OneDrive, Word/Excel, contacts, Teams,
SharePoint and delta sync — as Reactory services, GraphQL fields and Reactor macros.

- **Module ID**: `reactory-azure`
- **Module FQN**: `core.ReactoryAzure@1.0.0` (deliberately *not* `azure.*` — see
  `docs/audit.md` §9.4; changing it would orphan the module's registry entry)
- **Component namespace**: `azure` — every contributed service/component uses
  `azure.<Name>@1.0.0`
- **Priority**: 0
- **License**: MIT
- **Package**: `@reactory/azure` v1.0.0
- **Module dependency**: `core.ReactoryServer@1.0.0`
- **Base documentation**: `docs/audit.md` (defects), `docs/implementation-plan.md` (AZ-01…AZ-19)

## Status after AZ-01

AZ-01 replaces a non-executing stub with a walking skeleton: every barrel, service,
resolver and stub file exists, the Graph client can actually be constructed and
authenticated, `azureConnectionStatus` is wired end to end, and the module registers
16 services and 2 models. Domain behaviour (mail bodies, calendar events, files,
workbooks, …) arrives in the tickets listed in the services table.

The module is **not active** until the owner restarts the express server — the running
process loaded the old, empty service list at start-up.

**Pre-restart owner action (blocking):** `@microsoft/microsoft-graph-client` must be installed
somewhere that resolves from `src/modules/reactory-azure` **before** that restart. It is absent
today, and because `reactory-core` imports the retained shim eagerly the restart would fail at
core module load with `MODULE_NOT_FOUND` — see "Runtime dependencies" below. This ticket could
not fix it: it may not modify the host `package.json` and may not restart the server.

## Services (16 — one row per exported definition)

| # | FQN | Delivered by | Status |
|---|---|---|---|
| 1 | `azure.AzureAuditService@1.0.0` | AZ-01 | implemented — Graph operation audit trail, credential redaction, never throws |
| 2 | `azure.AzureAuthService@1.0.0` | AZ-01 | implemented — PKCE URL, callback exchange, token vault, refresh, legacy bridge, profile |
| 3 | `azure.AzureGraphClientProvider@1.0.0` | AZ-01 | implemented — the only Graph `Client` factory: retry, pagination, delta, batch |
| 4 | `azure.AzureService@1.0.0` | AZ-01 | implemented — facade exposing every other service plus connection status/disconnect |
| 5 | `azure.AzureMailService@1.0.0` | AZ-04 | stub — mail read, folders, categories, `$search` |
| 6 | `azure.AzureTodoService@1.0.0` | AZ-06 | stub — Microsoft To Do lists, tasks, checklist items |
| 7 | `azure.AzureCalendarService@1.0.0` | AZ-07 | stub — calendars, `calendarView`, event CRUD, availability |
| 8 | `azure.AzureDriveService@1.0.0` | AZ-08 | implemented — drives, paged children, encoded path/item addressing, redirect-safe download and thumbnail streams, simple/resumable upload, folder/move/copy(monitor)/delete/restore, sharing, versions |
| 9 | `azure.AzureDocumentService@1.0.0` | AZ-09 | stub — templates, text extraction, PDF conversion (2 MB cap) |
| 10 | `azure.AzureWorkbookService@1.0.0` | AZ-10 | stub — worksheets, ranges, tables, sessions |
| 11 | `azure.AzureContactsService@1.0.0` | AZ-11 | stub — contacts, folders, people search, directory |
| 12 | `azure.AzureSyncService@1.0.0` | AZ-12 | stub — delta loops and sync state |
| 13 | `azure.AzureSubscriptionService@1.0.0` | AZ-12 | stub — change-notification subscriptions and renewal |
| 14 | `azure.AzureTeamsService@1.0.0` | AZ-14 | stub — chats, channels, messages, presence |
| 15 | `azure.AzureSharePointService@1.0.0` | AZ-15 | stub — sites, lists, items, columns |
| 16 | `azure.AzureBlobStorageService@1.0.0` | AZ-16 | stub — Blob Storage v12 data plane |

Every stub throws `ApiError('not implemented', { ticket })`. No method returns `[]`,
`null` or any other placeholder on failure.

## Models

| Collection | Model | Fields of note |
|---|---|---|
| `azure_tokens` | `AzureToken` | `userId` (unique), `accessTokenEncrypted`, `refreshTokenEncrypted`, `accessTokenExpiry`, `grantedScopes[]`, `azureUserId` (oid), `tenantId` (tid), `upn`, `encryptionSalt`, `connectedAt`, `lastRefreshedAt?`, `revokedAt?` |
| `azure_audit_logs` | `AzureAuditLog` | `userId`, `operation`, `resource`, `outcome`, `durationMs`, `graphCode?`, `correlationId?`, `metadata?` |

AZ-12 appends `AzureSyncState` and `AzureSubscription` to `models/index.ts`; no other ticket
may edit that barrel.

## Microsoft Graph coverage

| Capability | Endpoints | Ticket | State |
|---|---|---|---|
| Identity / profile | `/me`, `/me/photos/{size}/$value` | AZ-01 | implemented |
| Mail read | `/me/messages`, `/me/mailFolders`, `/me/outlook/masterCategories` | AZ-04 | stub |
| Mail write | `/me/sendMail`, `/messages/{id}/reply`, drafts, attachments | AZ-05 | not started |
| Tasks | `/me/todo/lists`, `/me/todo/lists/{id}/tasks`, `…/checklistItems` | AZ-06 | stub |
| Calendar | `/me/calendars`, `/me/calendarView`, `/me/calendar/getSchedule`, `/me/findMeetingTimes` | AZ-07 | stub |
| Files | `/me/drive`, `/items/{id}/children`, `/content`, upload sessions, permissions | AZ-08 | implemented |
| Documents | `/items/{id}/content?format=pdf`, template copy | AZ-09 | stub |
| Workbooks | `/workbook/worksheets`, `…/range`, `…/tables`, `createSession` | AZ-10 | stub |
| Contacts / directory | `/me/contacts`, `/me/people`, `/users` | AZ-11 | stub |
| Sync | `/me/messages/delta`, `/me/events/delta`, `/me/drive/root/delta`, `/subscriptions` | AZ-12 | stub |
| Teams | `/me/chats`, `/teams/{id}/channels/{id}/messages`, `/communications/getPresencesByUserId` | AZ-14 | stub |
| SharePoint | `/sites/{host}:/{path}`, `/sites/{id}/lists`, `/lists/{id}/items` | AZ-15 | stub |
| Blob Storage | `BlobServiceClient` (no Graph) | AZ-16 | stub |

`beta` appears in exactly one place: the legacy shim's `/me/outlook/tasks` block, which
documents why AZ-06 replaces it. Everything new uses `v1.0`.

## GraphQL surface (AZ-01)

```graphql
query  { azureConnectionStatus { status email upn tenantId grantedScopes tokenSource expiresAt } }
mutation { azureAuthUrl(services: ["mail", "calendar"]) { url } }
mutation { azureDisconnect }
```

`Auth.graphql` + `AuthResolver` are implemented. The other ten `.graphql` files and their
resolvers exist as stubs that throw `not implemented`, so later tickets never edit
`graphql/types/index.ts` or `graphql/resolvers/index.ts`.

### Drive (AZ-08)

```graphql
query  { azureDrive { id name driveType quota { used remaining } } }
query  { azureDriveItems(itemId: "…", top: 50) { nextLink items { id name kind mimeType isFolder childCount } } }
query  { azureDriveItem(path: "Reports/a b#c?.txt") { id name webUrl } }
query  { azureDriveSearch(query: "budget report") { items { id name } nextLink } }
query  { azureDrivePermissions(itemId: "…") { id roles link { webUrl scope } } }
query  { azureDriveVersions(itemId: "…") { id lastModifiedDateTime size } }

mutation { azureCreateDriveFolder(name: "Reports", parentId: "…") { id name } }
mutation { azureUploadDriveItem(parentId: "…", name: "a.pdf", contentBase64: "…") { id size } }
mutation { azureMoveDriveItem(itemId: "…", parentId: "…", name: "renamed.pdf") { id } }
mutation { azureCopyDriveItem(itemId: "…", parentId: "…") { status itemId monitorUrl } }
mutation { azureDeleteDriveItem(itemId: "…") }
mutation { azureShareDriveItem(itemId: "…", type: "view", scope: "organization") { id link { webUrl } } }
```

`azureDrives`, `azureRestoreDriveItem`, `azureRestoreDriveVersion`,
`azureInviteDriveCollaborators` and `azureDeleteDrivePermission` complete the surface. There is
deliberately **no** `downloadUrl` field: content and thumbnails are streamed by the HTTP proxy
above so a pre-authenticated storage URL never reaches a client. `azureUploadDriveItem` takes
base64 because GraphQL has no binary scalar.

## HTTP surface

Mounted at `/azure` (`index.ts` → `routes: { '/azure': routes }`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/azure/auth/url?services=mail,calendar` | issue a PKCE authorization URL |
| GET | `/azure/auth/callback?code=&state=` | exchange the code, vault the tokens |
| GET | `/azure/auth/status` | connection status for the caller |
| POST | `/azure/auth/disconnect` | mark the vaulted token revoked |
| POST | `/azure/webhooks/graph` | reserved for AZ-12 (empty router) |
| GET | `/azure/files/:itemId` | stream a file; sets `Content-Type` and `Content-Disposition`, never returns the pre-authenticated URL |
| GET | `/azure/files/:itemId/thumbnail?size=small\|medium\|large` | stream a thumbnail rendition inline |

## Authentication and the token model

1. `getAuthorizationUrl(userId, services)` builds
   `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` with
   `response_type=code`, `code_challenge_method=S256`, `offline_access` and a random
   `state`. The PKCE verifier is generated by `msal.CryptoProvider.generatePkceCodes()`
   and stored in Redis for **600 s** under `azure:oauth:state:{state}`.
2. `handleAuthCallback(code, state)` redeems the state, exchanges the code, encrypts the
   access and refresh tokens with **AES-256-GCM** (`AZURE_TOKEN_ENCRYPTION_KEY` +
   a stable per-user salt) and upserts the `AzureToken` row with the `oid`, `tid` and `upn`.
3. `getToken(userId)` returns `{ token, source: 'vault' | 'legacy' }`:
   - **vault** — decrypted from `AzureToken`, refreshed when it is within 60 s of expiry,
     cached in Redis to `expiry − 60 s`;
   - **legacy** — read from the User document's `getAuthentication('microsoft').props.accessToken`
     through `core.UserService@1.0.0`. This bridge **never writes** to `AzureToken`,
     **never caches** (a legacy token carries no scope and no expiry, so any TTL is a guess
     and a revoked token would keep being served), and **never refreshes**.

Five rules govern that bridge, and none of them may be relaxed:

- **a revoked vault row is terminal.** `getToken` and `getGrantedScopes` consult the
  `AzureToken` row first: no row at all enables the legacy bridge, but a row that exists and is
  revoked returns no token (`ApiError('NotConnected')`, `revoked: true`) and no scopes ( `[]` ),
  and never falls through to the User-document token. Without this, `azureDisconnect` would
  report `REVOKED` while every Graph call kept authenticating. `hasValidToken` and
  `getConnectionStatus` apply the same rule, so all four agree;
- a 401 on a legacy-sourced request raises `ApiError('LegacyTokenExpired')` — a code
  distinct from `InvalidAuthenticationToken` — so callers prompt a reconnect instead of
  treating the grant as revoked;
- `getGrantedScopes(userId)` returns `['legacy:unverified']` for a legacy user. A scope
  gate must read that value as *attempt the call and surface the real Graph error*, never
  as *insufficient scope*, or every legacy user is locked out. That rule is encoded in
  `utils/scopes.ts`: use `isScopeVerificationDeferred(granted)` to branch, and note that
  `hasRequiredScopes` returns `true` and `getMissingScopes` returns `[]` for the sentinel;
- the token value is never logged and `AzureAuditService` redacts `authorization`,
  `access_token`, `refresh_token`, `token` and `bearer` (case- and separator-insensitive);
- legacy tokens must not be used for any new capability that needs a refresh token.

## Graph client provider

`services/graph/AzureGraphClientProvider.ts` is the only place a Graph `Client` is
constructed (`Client.init`, `debugLogging: false`).

| Method | Behaviour |
|---|---|
| `request<T>(userId, path, options)` | one GET; query/headers from `$select`/`$filter`/`$search`/`$orderby`/`$top`/`$expand` |
| `requestAll<T>(userId, path, opts)` | follows `@odata.nextLink` up to `maxPages` (default 10) and **throws** `PaginationLimitExceeded` at the bound |
| `delta<T>(userId, path, opts)` | same pagination, returns `{ items, deltaLink }` |
| `batch(userId, requests)` | `POST /$batch`; refuses more than **20** requests with `BatchSizeExceeded` |
| `requestRaw(userId, path, opts)` | `ResponseType.RAW` for `/photo/$value` and file content |
| `getClientWithToken(token)` | **deprecated**, legacy shim only (AZ-19) |

Retry policy: `429` and `503` honour `Retry-After`; other `5xx` use exponential backoff
with jitter; **3 attempts total**; other `4xx` are never retried. Every failure becomes an
`ApiError` whose `code` is the Graph error code.

## Legacy shim (retirement gate)

`services/graph.ts` is a **deprecated** compatibility shim and must not be deleted. Three
live importers in `reactory-core` (a different repository) depend on it:
`resolvers/Emails/UserEmails.ts`, `resolvers/User/ProfileResolver.ts` and
`services/EmailService.ts`. The nine method names and their success shapes are preserved;
`sendEmail` and `getEmails` now **reject** instead of swallowing the error.

`resolvers/User/ProfileResolver.ts` is a live **sign-in** path whose token comes from the
User document. It cannot be migrated until the owner restarts the server, signs in through
the Microsoft provider and confirms the migrated path works (plan §6.6). Only then may
`services/graph.ts` and `types.d.ts` be deleted — **AZ-19** owns that change.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `AZURE_CLIENT_ID` | yes | application (client) id of the app registration |
| `AZURE_CLIENT_SECRET` | yes | client secret for the confidential client |
| `AZURE_TENANT_ID` | yes | tenant id, or `organizations` for multi-tenant |
| `AZURE_REDIRECT_URI` | yes | must match the registered redirect (`…/azure/auth/callback`) |
| `AZURE_TOKEN_ENCRYPTION_KEY` | yes | master key for AES-256-GCM token encryption |
| `AZURE_API_RATE_LIMIT` | no | per-user requests/minute budget; `0` disables the gate |

Optional, used by the HTTP routes: `AZURE_AUTH_SUCCESS_REDIRECT`,
`AZURE_AUTH_FAILURE_REDIRECT`, `REACTORY_APPLICATION_URL`.
`AZURE_STORAGE_CONNECTION_STRING` / `AZURE_STORAGE_ACCOUNT` / `AZURE_STORAGE_KEY` are
introduced by AZ-16.

Without a tenant, every failure path is typed: `AzureConfigurationMissing` rather than a
half-built client.

## Runtime dependencies — install BEFORE restarting the server

The module needs these packages resolvable from `src/modules/reactory-azure`:

```
@microsoft/microsoft-graph-client   # ^3.0.7   required by services/graph/AzureGraphClientProvider.ts
@microsoft/microsoft-graph-types    # ^2.40.0  types only, same install
@azure/msal-node                    # ^2.16.2  resolves today transitively - install it explicitly
```

**They are not installed in this repository, and the host server does not supply
`@microsoft/microsoft-graph-client`** (nothing in the module's or any ancestor `node_modules`
has it). `googleapis` is hoisted into the server root for `reactory-google`; the Graph client
is not. Verified from the natural mount:

```bash
cd src/modules/reactory-azure && node -e "require.resolve('@microsoft/microsoft-graph-client')"
# Error: Cannot find module '@microsoft/microsoft-graph-client'
```

**Why this blocks the restart, not just the tests.** `services/graph.ts` (the retained shim)
imports `./graph/AzureGraphClientProvider`, which imports the SDK. `reactory-core` imports the
shim eagerly (`index.ts` → `services/index` → `EmailService.ts:9`), and the generated
`src/modules/__index.ts` imports `reactory-core` at start-up. After a merge, until the package
is installed, **the server fails at core module load with `MODULE_NOT_FOUND`** — it does not
boot at all; this is not "the Azure module is inert".

Install it in one of the two locations that resolve from the module:

1. the module's own `node_modules` — `cd src/modules/reactory-azure && npm install`
   (uses this module's `dependencies`); or
2. the server root — add it to `reactory-express-server/package.json` and install there,
   matching how `googleapis` is handled for `reactory-google`.

A worktree install (`src/modules/reactory-worktrees/<id>/node_modules`) satisfies the test
harness but is **not** visible from the natural mount, so it does not satisfy the server.

## Tests

Run from the module worktree. This repository has **no jest config of its own** — the host
server supplies the configuration, the transformer and Jest. It supplies `node_modules` only
for packages the server already has, which is why the three packages above must be installed
locally first:

```bash
node /Users/wernerw/Projects/reactory/reactory-express-server/src/modules/reactory-reactor/scripts/ai/run-worktree-tests.js \
  --module-root <worktree> __tests__
```

Exit `0` means every suite loaded and every test passed. Do **not** add a jest config and
do **not** run a bare `npx jest`.

Coverage (measured with the same harness; the server's global thresholds do not apply to a
single-module run, so pass an empty threshold set):

```bash
node …/run-worktree-tests.js --module-root <worktree> __tests__ \
  --coverage --coverageReporters=text --coverageThreshold='{}'
```

Current line/branch figures for the implemented files: `AzureAuthService` 99.11/85.80,
`AzureService` 100/85.71, `AzureAuditService` 100/85.29, `services/graph.ts` 97.05/90.62,
`AzureGraphClientProvider` 96.07/88.88, `routes/auth.ts` 100/82.60, `AzureDriveService`
100/84.61, `routes/proxy.ts` 97.50/86.53, `DriveResolver` 100/100 (measured over the two drive
suites; the 80% branch floor applies per file, not per module).

`DriveResolver` declares its own `DriveResolverContext` interface instead of annotating
`Reactory.Server.IReactoryContext`. That is not cosmetic: `emitDecoratorMetadata` rewrites the
ambient-namespace type into `typeof Reactory !== "undefined" && Reactory.Server` in
`design:paramtypes`, a guard that is always false at runtime (`Reactory` is a type-only global),
so istanbul reports two unreachable branches on each of the seventeen decorated methods. An
interface emits `Object`, and no decorator here reads `design:paramtypes`.

| Suite | Covers |
|---|---|
| `__tests__/utils.test.ts` | encryption round-trip and tampering, OData building, cache keys, Graph error mapping, audit redaction, scopes |
| `__tests__/graph-provider.test.ts` | `Client.init` + `debugLogging: false`, 401 → `InvalidAuthenticationToken`, legacy 401 → `LegacyTokenExpired`, three-page `requestAll`, page-bound throw, 429 `Retry-After` retry, 4xx no-retry, batch limit |
| `__tests__/auth-service.test.ts` | PKCE URL + Redis state, code exchange without plaintext, vault caching, legacy bridge (never cached), `legacy:unverified`, status transitions, profile mapping |
| `__tests__/contract-shape.test.ts` | exactly 16 services/FQNs, AGENT.md rows, the shim's nine methods, a single `Client.init` site, root wiring |
| `__tests__/audit-service.test.ts` | `logOperation` never throws (model save rejects, core audit rejects), persisted metadata is redacted, `logAuthEvent`, `getAuditTrail` |
| `__tests__/facade.test.ts` | every `AzureService` getter (bound property and context paths), `getConnectionStatus`/`disconnectAccount` including the no-auth-service fallbacks |
| `__tests__/graph-shim.test.ts` | the shim's success shapes: `getUserDetails` raw `/me` + `avatar` only when `profileImage`, `getProfileImage`, `getEmails` search, `sendEmail` body, and the three beta task methods |
| `__tests__/routes-auth.test.ts` | `/azure/auth/url|callback|status|disconnect`: success, 401/503/500, redirect defaults, missing params |
| `__tests__/drive-service.test.ts` (84) | `downloadItem` two-hop redirect with no `Authorization` on the storage host, 404 `itemNotFound` → `ApiError`, copy monitor (completed/inProgress/302/failure/drain), upload-session 202 and unreadable-body fallbacks, every `toNodeStream` body shape, error-body parsing and its 1 MiB cap, item scrubbing (including a null thumbnail set), `/azure/files` proxy headers, 401/404/500/502/503, stream error before/after headers, client disconnect, all resolver mutations and identity unwrapping |
| `__tests__/drive.request-shape.test.ts` (40) | segment/query encoding (`a b#c?.txt`, search quoting), item/parent/drive paths, write bodies, simple upload at 4 MiB, resumable fragments at 320 KiB multiples with no bearer token, 416 resume, thumbnail path, and the **production `fetch` transport** (`redirect: 'manual'`, header normalisation, typed no-fetch failure) |

All tests mock the Graph layer: **no live Graph call is made** in this repository. The drive
suites replace the byte transport via `setDriveHttpClient` and mock the SDK, so the redirect and
fragment assertions run without a tenant or a network.

## File ownership

| Owned by AZ-01, frozen afterwards | Filled in by |
|---|---|
| `index.ts`, `services/index.ts`, `graphql/types/index.ts`, `graphql/resolvers/index.ts`, `routes/index.ts`, `middleware/index.ts`, `ai/macros/index.ts`, `types/index.ts` | nobody — a later ticket that needs a change here must stop and raise |
| `ai/macros/<domain>.macros.ts` | AZ-13 (status/mail/calendar/drive/workbook/contacts/tasks), AZ-14 (teams) |
| `models/index.ts` | AZ-12 appends two models (the only permitted edit) |
| `forms/index.ts` | AZ-17 |
| `queues/index.ts`, `routes/webhooks.ts`, `middleware/webhook-verification.ts` | AZ-12 |
| `routes/proxy.ts` | AZ-08 |

## Conventions

- Services use `@service({ id, name, nameSpace: 'azure', version, serviceType, lifeCycle:
  'singleton', dependencies })` and export `XServiceDefinition`; follow
  `reactory-google/services/GmailService.ts`.
- Errors are `ApiError` (`@reactory/server-core/exceptions`) with the Graph `code`.
- Types live in `types/*.ts`, are re-exported from `types/index.ts`, and every public
  method has a named return type — no `Promise<any>` in new code.
- Import aliases: `@reactorynet/reactory-core`, `@reactory/server-core/*`.
- `tsconfig.json` extends `../../../tsconfig.json`, which is the server root's config **from the
  module's natural mount** (`src/modules/reactory-azure`). A worktree sits one level deeper and
  needs `../../../../tsconfig.json`; the test harness does not read `tsconfig.json`, so this only
  matters for an explicit `tsc -p`.
- Type-checking the module surfaces one *pre-existing, repo-wide* finding: `TS1329 'resolver'
  accepts too few arguments...` on every `@resolver` class. `resolver` is declared
  `export function resolver()` in `src/models/graphql/decorators/`, and `@resolver()` would call
  the void function and install `undefined` as the class, so the bare form is the only one that
  works at runtime. `reactory-google`'s eight resolvers report the same error. Fixing it is a
  framework change, not a module change.
- `types.d.ts` augments the **global** `Reactory` namespace inside `declare global`, because
  `@reactorynet/reactory-core` publishes `export as namespace Reactory`. A bare
  `declare module Reactory { ... }` declares an unrelated ambient module and is silently ignored.
