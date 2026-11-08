# reactory-azure — Operations Runbook

Everything an operator needs to take `reactory-azure` from "merged" to "working against a real
Microsoft 365 tenant". Written from the module's source, not from intent: every permission,
variable and route below is what the code actually uses.

- **Module**: `reactory-azure`, FQN `core.ReactoryAzure@1.0.0`
- **Mounted routes**: `/azure/*` (auth, webhooks, file proxy)
- **Delegated-only**: the module never performs a client-credentials (app-only) flow
- **Module code is inert until the express server restarts** — see §7

> **Read this first if you are doing the app registration today.** §1 collects the four values
> the registration must produce; §2 is the exact delegated-permission list per service; §5 is
> the public-webhook requirement that has no equivalent in the Google module; §6 explains who
> keeps subscriptions alive (and what breaks if nobody does); §9 is the smoke test that proves
> it all works. No automated test in this repository makes a live Graph call.

---

## 1. Azure app registration checklist

Do this in **Entra ID → App registrations → New registration**, in the tenant the users will
sign in to.

### 1.1 Decide the tenant model first

`AZURE_TENANT_ID` is interpolated into the v2.0 authorize and token endpoints:

| Tenant model | `AZURE_TENANT_ID` | Use when |
|---|---|---|
| Single tenant | the tenant GUID (`00000000-0000-0000-0000-000000000000`) | one organisation, the normal case |
| Multi-tenant / any work-or-school account | `organizations` | the app is offered to other tenants |
| Any Microsoft account including personal | `common` | not supported by any test in this module — prefer `organizations` |

Pick this **before** the first consent: changing tenants later invalidates every vaulted token
and every subscription, and each user must reconnect.

### 1.2 Values to collect

| Value | Where it comes from | Goes into |
|---|---|---|
| **Tenant id** | Overview → Directory (tenant) ID | `AZURE_TENANT_ID` |
| **Client id** | Overview → Application (client) ID | `AZURE_CLIENT_ID` |
| **Client secret** | Certificates & secrets → New client secret → **Value** (not Secret ID) | `AZURE_CLIENT_SECRET` |
| **Redirect URI** | Authentication → Add a platform → Web → Redirect URI | `AZURE_REDIRECT_URI` |

The secret **Value** is shown once, at creation. Copy it then; the portal only shows the Secret
ID afterwards. The module uses the secret in the authorization-code exchange and in refresh
requests only — there is no `client_credentials` grant anywhere in the source.

### 1.3 Redirect URI — exact value

The callback route is `GET /azure/auth/callback` (`routes/auth.ts`). Register **exactly** the
same string you put in `AZURE_REDIRECT_URI`, scheme and host included:

```
https://<your-host>/azure/auth/callback
```

- Graph/Entra compares this string byte-for-byte. `http` vs `https`, a trailing slash, `www.`
  or a different port all produce `AADSTS50011 reply address does not match`.
- For local development, add a second redirect URI (`http://localhost:<port>/azure/auth/callback`)
  and point `AZURE_REDIRECT_URI` at whichever one you are using. Entra allows multiple.
- Pick **Web** as the platform. A SPA registration cannot keep a client secret, and this module
  is a confidential client (the secret is required by `AZURE_CLIENT_SECRET`).

### 1.4 Secret lifetime and rotation

- Note the expiry date in the team calendar when you create it. An expired secret surfaces as
  `invalid_client` on refresh: every connection flips to `TOKEN_EXPIRED` and no read succeeds
  until it is rotated and users reconnect.
- Rotate by adding a **new** secret, deploying it as `AZURE_CLIENT_SECRET`, restarting (§7), then
  removing the old one after the new one is proven by the §9 smoke test.
- Rotating the secret invalidates nothing that is already vaulted — refresh tokens stay valid.
  Rotating `AZURE_TOKEN_ENCRYPTION_KEY` **does** invalidate every vaulted token (see §4.3).

---

## 2. Delegated permissions, per service

The module's scope registry is `utils/scopes.ts`. It is the authority for this table: the
`scope` parameter sent to `/authorize` is the union of the capability keys passed to
`azureAuthUrl(services: [...])` / `GET /azure/auth/url?services=...`, always plus the base set.

**Base — requested by every connection, no admin consent**

```
openid  profile  email  offline_access  User.Read
```

`offline_access` is not optional: without it Graph issues no refresh token and the connection
dies with the first access token.

**Per-service matrix**

| Service (FQN suffix) | Capability key | Delegated scopes requested | Admin consent |
|---|---|---|---|
| `AzureAuthService`, `AzureService` | *(base only)* | `openid`, `profile`, `email`, `offline_access`, `User.Read` | No |
| `AzureGraphClientProvider` | *(none — uses the caller's token)* | — | — |
| `AzureAuditService` | *(none — writes to Mongo)* | — | — |
| *(caller-supplied)* | `profile` | `User.Read`, `User.ReadBasic.All` | No |
| `AzureMailService` | `mail` | `Mail.ReadWrite`, `Mail.Send` | No |
| | `mail_read` | `Mail.Read` | No |
| | `mail_send` | `Mail.Send` | No |
| `AzureTodoService` | `tasks` | `Tasks.ReadWrite` | No |
| `AzureCalendarService` | `calendar` | `Calendars.ReadWrite` | No |
| | `calendar_read` | `Calendars.Read` | No |
| `AzureDriveService` | `drive` | `Files.ReadWrite` | No |
| | `drive_read` | `Files.Read` | No |
| `AzureDocumentService` | `documents` | `Files.ReadWrite` | No |
| `AzureWorkbookService` | `workbook` | `Files.ReadWrite` | No |
| `AzureContactsService` | `contacts` | `Contacts.ReadWrite`, `People.Read` | No |
| | `contacts_read` | `Contacts.Read`, `People.Read` | No |
| | `directory` | `User.ReadBasic.All` | No |
| `AzureTeamsService` | `teams` | `Chat.ReadWrite`, `ChannelMessage.Read.All`, `Team.ReadBasic.All`, `Channel.ReadBasic.All` | **Yes — `ChannelMessage.Read.All`** |
| | `presence` | `Presence.Read` | No |
| `AzureSharePointService` | `sharepoint` | `Sites.ReadWrite.All` | **Yes — `Sites.ReadWrite.All`** |
| `AzureSyncService` | *(reuses the resource's key)* | `Mail.Read` for messages, `Calendars.Read` for events, `Files.Read` for drive | No |
| `AzureSubscriptionService` | *(reuses the resource's key)* | the same read scope the subscribed resource needs | No |

All 17 capability keys declared in the scope registry are accounted for above. Two of them are
**caller-facing only** — `profile` and `directory` add `User.ReadBasic.All` but no service
implies them:

- `directory` is documented on `AzureContactsService` because `/users` is that service's call.
- `profile` is not implied by any service, but it is reachable: a caller that sends
  `?services=profile` (or `services=profile,mail_read`) gets `User.ReadBasic.All` on top of the
  base `User.Read`. That is enough to satisfy `AzureContactsService#listDirectoryUsers`, which
  requires `User.ReadBasic.All` or `User.Read.All`. Request it when you want display names and
  UPNs resolved without granting contacts or mail.

Notes that matter when you click through the portal:

- **Two delegated permissions are admin-restricted**: `Sites.ReadWrite.All` and
  `ChannelMessage.Read.All`. Add them, then press **Grant admin consent for \<tenant\>**;
  otherwise `AzureSharePointService` and channel-message reads fail with a 403 and the consent
  prompt never appears for a normal user.
- `ChannelMessage.Read.All` is additionally a **protected API** in some tenants: use of it may
  require Microsoft approval before it can be consented to. If the portal refuses the consent,
  that is the cause — not a module defect.
- `Channel.ReadBasic.All` may also show as admin-restricted in stricter tenants. If the portal
  marks any additional scope in the list above as requiring consent, grant it; the table states
  the normal case, and the portal is authoritative for your tenant's consent policy.
- `Files.ReadWrite` covers OneDrive **and** the document/workbook services — they share the same
  permission. There is no separate "Word" or "Excel" permission.
- Request the **minimum** set for the workflows you actually run. `services` is per-connection:
  a user who only needs mail can be sent `services=mail_read` and gets `Mail.Read` only. If you
  later need a capability the user never consented to, Graph answers 403 — re-run the
  authorization flow with the wider key set; the module does not silently escalate.
- `AzureContactsService`'s `/users` directory read is gated on `User.ReadBasic.All`. Without the
  `directory` key, `azureDirectoryUsers` fails the scope gate rather than returning an empty list.

### 2.1 What to add, in one pass (typical deployment)

If the deployment uses every service, add these **delegated** permissions in
API permissions → Add a permission → Microsoft Graph → Delegated permissions:

```
openid
profile
email
offline_access
User.Read
User.ReadBasic.All
Mail.ReadWrite
Mail.Send
Calendars.ReadWrite
Tasks.ReadWrite
Files.ReadWrite
Contacts.ReadWrite
People.Read
Chat.ReadWrite
ChannelMessage.Read.All      <- admin consent
Team.ReadBasic.All
Channel.ReadBasic.All
Sites.ReadWrite.All          <- admin consent
Presence.Read
```

Then **Grant admin consent**. Read-only deployments can substitute `Mail.Read`,
`Calendars.Read` and `Files.Read`, but a capability the user did not consent to cannot be used
later without re-consent.

---

## 3. Application permissions — none

**Do not add any application (app-only) permission to this registration.**

- The module authenticates with the authorization-code + PKCE flow and calls Graph as the
  signed-in user (`AzureAuthService`), or through the legacy User-document token bridge. There is
  no `client_credentials` grant and no `ClientSecretCredential` in the source.
- `AZURE_CLIENT_SECRET` is required, but only as the confidential-client credential for the code
  exchange and refresh — not for app-only access.
- `userId` **is** an optional argument on the Mail, Contacts and SharePoint fields (37 fields). It
  is self-or-admin: omitted it resolves to the caller, and naming another user is rejected with
  `InsufficientPermissions` unless the caller holds `ADMIN`. An ADMIN can therefore read another
  user's mailbox, contacts or SharePoint site by design. Every other root field (Auth, Calendar,
  Tasks, Drive, Documents, Workbook, Teams, Sync) takes no `userId` and always acts as the caller.
  Review this gate before granting `ADMIN` to a service account.
- Adding application permissions would grant tenant-wide data access that no code path uses.
  It widens the blast radius of a leaked secret for zero functional gain.

The one exception is Blob Storage: `AzureBlobStorageService` authenticates with an account key /
connection string (the storage variables in §4.2), not with an Entra app permission. If you choose the
`DefaultAzureCredential` path, that is a **storage-account RBAC role** (e.g. Storage Blob Data
Contributor) on the identity running the server — still not a Graph application permission.

---

## 4. Environment variables

These are **all** the environment variables the module reads, and there are no others. Two
access patterns exist in the source: direct `process.env.X` and
`resolveBlobServiceClient(env: IAzureBlobStorageEnvironment = process.env)` in
`AzureBlobStorageService`.

### 4.1 Required for a working connection

| Variable | Required | Read by | Purpose |
|---|---|---|---|
| `AZURE_CLIENT_ID` | **yes** | `AzureAuthService` | Application (client) id |
| `AZURE_CLIENT_SECRET` | **yes** | `AzureAuthService` | Confidential-client secret (code exchange + refresh) |
| `AZURE_TENANT_ID` | **yes** | `AzureAuthService` | Tenant GUID, or `organizations` for multi-tenant |
| `AZURE_REDIRECT_URI` | **yes** | `AzureAuthService` | Must equal the registered redirect URI exactly |
| `AZURE_TOKEN_ENCRYPTION_KEY` | **yes** | `AzureAuthService`, `AzureSubscriptionService` | Master key for AES-256-GCM encryption of access/refresh tokens and subscription `clientState` |

### 4.2 Recommended / conditional

| Variable | Required | Read by | Purpose |
|---|---|---|---|
| `REACTORY_APPLICATION_URL` | **recommended** | `routes/auth.ts`, `AzureSubscriptionService` | Base URL for the default success/failure redirects and for the webhook URL fallback |
| `AZURE_WEBHOOK_NOTIFICATION_URL` | **for change notifications** | `AzureSubscriptionService` | Exact public URL Graph posts notifications to. Falls back to `${REACTORY_APPLICATION_URL}/azure/webhooks/graph` |
| `AZURE_AUTH_SUCCESS_REDIRECT` | no | `routes/auth.ts` | Where the callback sends a successful connection. Default `${REACTORY_APPLICATION_URL}/?azure=connected` |
| `AZURE_AUTH_FAILURE_REDIRECT` | no | `routes/auth.ts` | Where the callback sends a failure. Default `${REACTORY_APPLICATION_URL}/?azure=error` |
| `AZURE_API_RATE_LIMIT` | no | `AzureAuthService` | Per-user requests/minute budget. Unset or `0` disables the gate |
| `AZURE_STORAGE_CONNECTION_STRING` | one of the storage options | `AzureBlobStorageService` | Blob Storage via connection string (checked first) |
| `AZURE_STORAGE_ACCOUNT` | one of the storage options | `AzureBlobStorageService` | Storage account name; with `AZURE_STORAGE_KEY`, or alone for `DefaultAzureCredential` |
| `AZURE_STORAGE_KEY` | no | `AzureBlobStorageService` | Shared account key; also the fallback signer for SAS URLs |
| `AZURE_STORAGE_ACCOUNT_URL` | no | `AzureBlobStorageService` | Explicit blob endpoint; the account name is derived from it when `AZURE_STORAGE_ACCOUNT` is unset |

**There is no separate webhook-domain variable.** That address is configured only with
`AZURE_WEBHOOK_NOTIFICATION_URL`, or derived as
`${REACTORY_APPLICATION_URL}/azure/webhooks/graph` when it is unset. A variable that is not in
the two tables above is not read by this module; setting it has no effect.

Blob Storage resolution order is: `AZURE_STORAGE_CONNECTION_STRING` → `AZURE_STORAGE_ACCOUNT_URL`
or `AZURE_STORAGE_ACCOUNT` + `AZURE_STORAGE_KEY` → `DefaultAzureCredential`. If no account is
configured at all, the service raises `AzureStorageConfigurationMissing`; Graph capabilities are
unaffected.

### 4.3 Generating the values

```bash
# 48 bytes of entropy, base64 — suitable for AZURE_TOKEN_ENCRYPTION_KEY
openssl rand -base64 48
```

- Treat `AZURE_TOKEN_ENCRYPTION_KEY` as a **data-loss key**: tokens are encrypted with a key
  derived from it (scrypt) plus a per-user salt. Change it and every vaulted token becomes
  undecryptable — all users must reconnect. Store it in the secret manager, not in git.
- Never log it. The module redacts `authorization`, `access_token`, `refresh_token`, `token` and
  `bearer` in the audit trail, but that is not a licence to echo configuration at start-up.
- Changing **any** variable requires a restart (§7); the values are read at process start or per
  request from `process.env`, and the running process does not reload them from a file.

### 4.4 Reproducing the sweep

```bash
# direct reads
grep -rnoE "process\.env(\.[A-Z0-9_]+|\[['\"][A-Z0-9_]+['\"]\])" --include=*.ts \
  src/modules/reactory-azure | grep -v __tests__ | sort -u

# the Blob Storage indirection
grep -oE "env\.AZURE_[A-Z0-9_]+" src/modules/reactory-azure/services/AzureBlobStorageService.ts | sort -u
```

The union of those two outputs is the two tables above. No other environment variable is read.

---

## 5. Public webhook requirement

Change notifications are delivered by Microsoft to **`POST /azure/webhooks/graph`**. This route
must be reachable **from the internet**; Graph will not call a private address.

### 5.1 What to configure

1. Give the endpoint a public HTTPS URL, e.g. `https://app.example.com/azure/webhooks/graph`.
2. Set `AZURE_WEBHOOK_NOTIFICATION_URL` to that **exact** URL. If it is unset, the module derives
   `${REACTORY_APPLICATION_URL}/azure/webhooks/graph`; if neither is set, creating a subscription
   fails with a configuration error naming both variables.
3. Ensure the reverse proxy forwards `POST` with a JSON body to the node process, with no
   authentication challenge in front of `/azure/webhooks/graph`. Graph sends no Reactory session
   cookie; authentication is the per-subscription `clientState` inside the payload.
4. Do not require a client certificate or IP allow-list on that path — Graph's source addresses
   are not a stable contract.

### 5.2 Behaviour you will see in the logs

| Situation | Response | Why |
|---|---|---|
| `?validationToken=...` handshake | `200 text/plain` with the URL-decoded token | Answered before any parsing or service lookup, so it succeeds even if Mongo/Redis are down |
| Verified notifications | `202 { accepted, rejected }` | Accepted notifications are enqueued on `azure-webhook-process` |
| `clientState` mismatch | `202`, counted in `rejected`, audited | 202 stops Graph retrying a notification we deliberately refused |
| `AzureSubscriptionService` unavailable | `503` | Accepting unverifiable notifications would be worse than a retry |

The handshake must be answered within ~10 seconds of Graph's request; keep the endpoint free of
slow middleware.

### 5.3 Tunnels and URL stability

- For a laptop/staging deployment, a tunnel (ngrok, cloudflared, Tailscale Funnel) is acceptable
  — but the URL must be **stable for the life of the subscription**.
- Existing subscriptions store the `notificationUrl` they were created with. Change the public
  URL and they keep pointing at the old one: notifications silently stop. Re-create the
  subscriptions after any URL change, then confirm the new URL in `azure_subscriptions`.
- The URL must be HTTPS in a production tenant. `http://localhost` works only for a tenant that
  explicitly allows it; do not plan around it.

---

## 6. Subscription renewal — ownership and schedule

Graph expires change-notification subscriptions. If renewal stops, **reads keep working but
nothing new is pushed**: no webhook, no delta trigger, no queue job.

### 6.1 How the module renews

- `AzureSubscriptionService` stores `renewedAt`, `expirationDateTime` and `nextRenewAt` per
  subscription.
- `nextRenewAt = renewedAt + RENEWAL_FRACTION × grantedLifetime`, with
  `RENEWAL_FRACTION = 0.8` — i.e. **80% of the lifetime Graph actually granted**, read from the
  response, never a hardcoded TTL. Graph's limits differ per resource, so a constant would be
  wrong for at least one of them.
- The queue `azure-subscription-renew` (`queues/subscription-renew.ts`) calls
  `renewSubscriptions()`; without a `userId` it sweeps **every** active subscription. Only rows
  that are due (`nextRenewAt <= now`) are renewed, so running the sweep more often than
  necessary is harmless.
- A single failed renewal is logged and audited but does not abort the sweep.
- `AzureSyncService.onStartup` registers the five queues and their processors with
  `reactory.QueueProvider@1.0.0`. Without a queue provider, registration is a logged no-op and
  the module keeps serving reads ("degraded").

### 6.2 Who owns the schedule — the honest answer

**The module defines the queue and the 80% rule, but it does not self-schedule.** There is no
cron expression, `setInterval` or timer in the module, and nothing enqueues
`azure-subscription-renew` on its own. A recurring trigger must exist **outside** the module.

Ownership therefore sits with whoever runs the server/host scheduler:

1. **Preferred** — schedule a recurring enqueue of `azure-subscription-renew` on the host's
   queue provider, **every 15–30 minutes**, with no `userId` (sweep all due rows). The 80%
   threshold makes a short interval safe.
2. **Acceptable** — an external cron/k8s CronJob that invokes the GraphQL mutation
   `azureRenewSubscriptions(force: false)` as a service account.
3. **Manual only** — call `azureRenewSubscriptions` (or the service method) as an operator
   repair. This is not a substitute for a schedule; subscriptions will expire between runs.

**If no scheduler is configured, subscriptions expire.** Symptoms: the webhook stops arriving,
`azure_subscriptions` rows stay `active: true` past `expirationDateTime`, and Graph answers 404
`ResourceNotFound` if a stale subscription id is used. Repair: re-create or renew the
subscriptions and fix the schedule.

### 6.3 Verifying renewal

- Check `azure_subscriptions` for rows where `nextRenewAt < now` and `active: true` — those are
  overdue and mean the scheduler is not running.
- `azureRenewSubscriptions(force: true)` bypasses the due check and re-extends everything; use it
  after an outage, not as a routine.
- The audit trail (`azure_audit_logs`) records failures per subscription with the Graph code.

---

## 7. Restart requirement

**The module does nothing until the express server restarts.** Services, models, GraphQL
definitions, routes, forms, queues and macros are registered at process start-up. Merging a pull
request changes files on disk; the running process keeps the registry it loaded.

### 7.1 Before restarting — pre-flight

1. **Dependencies resolve.** The retained `services/graph.ts` shim is imported eagerly by
   `reactory-core`, which imports the Graph SDK. If the SDK is missing, the server fails at core
   module load with `MODULE_NOT_FOUND` — it does not boot at all, so this is not a "module is
   inert" situation.
   ```bash
   cd src/modules/reactory-azure && \
   node -e "require.resolve('@microsoft/microsoft-graph-client')"
   ```
   It must print a path. `@microsoft/microsoft-graph-types` is types-only and has no runtime
   entry, so its `require.resolve` failure is expected and harmless.
2. **Environment is complete.** §4.1 variables are present in the process environment, not just
   in a `.env` the server does not read.
3. **Datastores are reachable.** Mongo (four `azure_*` collections) and Redis (OAuth state,
   token and folder caches).
4. **No migration is needed.** All four models are additive; there is no migration step.

### 7.2 Restart and confirm

1. Restart the express server.
2. In the start-up log, confirm the 16 services are registered and look for the queue line:
   `Azure queues: registered 5 processors` (or the explicit `degraded` warning).
3. Run §9. A restart that logs cleanly but fails §9 is not a successful deployment.

A restart is also required after changing any `AZURE_*` variable, because the process reads them
at start-up.

---

## 8. Pre-flight checklist (one page)

- [ ] Tenant model decided; `AZURE_TENANT_ID` recorded
- [ ] App registration created; client id and secret **Value** recorded
- [ ] Redirect URI registered as **Web** and byte-identical to `AZURE_REDIRECT_URI`
- [ ] Delegated permissions added (§2.1); **admin consent granted** for `Sites.ReadWrite.All` and `ChannelMessage.Read.All`
- [ ] No application permissions added
- [ ] `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `AZURE_REDIRECT_URI`, `AZURE_TOKEN_ENCRYPTION_KEY` set
- [ ] `REACTORY_APPLICATION_URL` set to the public base URL
- [ ] Public HTTPS route to `/azure/webhooks/graph` live; `AZURE_WEBHOOK_NOTIFICATION_URL` set
- [ ] Queue provider available, and a 15–30 minute enqueue of `azure-subscription-renew` scheduled
- [ ] Dependencies resolve; server restarted
- [ ] §9 smoke test passed

---

## 9. Live smoke test

No automated test in this repository makes a live Graph call — every suite mocks the Graph layer.
This is the run that proves a real tenant, a real consent and a real token work. Run it after
every restart that changes configuration.

Use a signed-in Reactory user with a Microsoft 365 mailbox and a OneDrive.

### Step 1 — Start the authorization flow

```bash
curl -s -X GET "https://<host>/azure/auth/url?services=mail_read,tasks,drive_read" \
  -H "Cookie: <your-session-cookie>"
# {"url":"https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize?..."}
```

Expect HTTP `401 {"error":"Authentication required"}` if the session cookie is missing, and
`503` if the Azure module is not registered — that distinction alone tells you whether the
restart worked.

Open the returned `url` in a browser. Consent for `Mail.Read`, `Tasks.ReadWrite`, `Files.Read`,
`User.Read`, `offline_access`.

- A missing consent prompt for a read scope usually means consent was already granted at tenant
  level.
- `AADSTS50011` → redirect URI mismatch (§1.3). `AADSTS65001` → consent not granted (§2).

### Step 2 — Confirm the callback and the vault

After the callback you are redirected to `AZURE_AUTH_SUCCESS_REDIRECT`
(`${REACTORY_APPLICATION_URL}/?azure=connected` by default). Then:

```graphql
query {
  azureConnectionStatus {
    status email upn tenantId tokenSource grantedScopes expiresAt
  }
}
```

Expect:

- `status: CONNECTED`
- `tokenSource: "vault"`
- `grantedScopes` containing the scopes you requested plus the base set
- `expiresAt` roughly an hour out

`tokenSource: "legacy"` means the user is being served by the old User-document token (no vault
row was written) — the connection works but never refreshes; re-run step 1.
`grantedScopes: ["legacy:unverified"]` is the same condition seen through the scope API.

Confirm the row exists:

```js
db.azure_tokens.findOne({ userId: ObjectId("<user id>") },
  { accessTokenEncrypted: 1, refreshTokenEncrypted: 1, grantedScopes: 1, upn: 1, tenantId: 1 })
```

`accessTokenEncrypted` must look like `iv:authTag:ciphertext` — if the plaintext token is
visible, stop and check `AZURE_TOKEN_ENCRYPTION_KEY` immediately.

### Step 3 — List mail

```graphql
query {
  azureMailMessages(options: { top: 5, select: "subject,from,receivedDateTime,isRead" }) {
    items { id subject receivedDateTime isRead from { address } }
    nextLink
  }
}
```

Expect up to five messages and `nextLink: null` on the last page. Then the folder listing:

```graphql
query { azureMailFolders { id displayName wellKnownName totalItemCount unreadItemCount } }
```

Expect the well-known folders (`inbox`, `sentitems`, `drafts`, …). This is the **"list a
folder"** check — if it returns an empty array the mailbox is empty or the user consented to a
different account than you think.

### Step 4 — Create a task

```graphql
query { azureTodoLists { id displayName } }
```

Take the default list's `id`, then:

```graphql
mutation {
  azureCreateTodoTask(
    listId: "<list id>"
    input: { title: "Reactory smoke test", importance: normal }
  ) { id title status createdDateTime }
}
```

Expect `status: notStarted` and a real `id`. **There is no `assignedTo`** — the schema has no
such field and the service rejects `assignedTo`, `assignee` or `assignments` with
`UnsupportedTodoTaskAssignment`. Delete the task afterwards with
`azureDeleteTodoTask(listId, taskId)`.

### Step 5 — List a folder in the drive

```graphql
query DriveSmokeRoot {
  azureDrive {
    id
    name
    driveType
    owner { displayName email }
    quota { total remaining }
  }
}
```

```graphql
query DriveSmokeItems {
  azureDriveItems(top: 10) {
    items {
      id
      name
      size
      kind
      isFolder
      folder { childCount }
      file { mimeType }
    }
    nextLink
  }
}
```

Expect the drive root's children. This exercises `/me/drive/root/children` through the same
token; a 401 here with mail working means the consent was mail-only (the `drive_read` key was
not granted).

### Step 6 — Prove the AI surface (optional but recommended)

In a chat with the **Azure Workspace Assistant**, ask: *"What is my Microsoft connection
status?"* It should call `azure_connection_status` and answer from the vault **without a Graph
call**. Then ask it to summarise the last three emails — that exercises
`azure_search_email` → `AzureMailService` end to end.

A `connected: false` payload with `status: DISCONNECTED` means the macro caught
`NotConnected` — the macro contract working as designed, not a crash. Re-check step 1.

### Step 7 — Verify the audit trail

```js
db.azure_audit_logs.find({ userId: ObjectId("<user id>") })
  .sort({ timestamp: -1 }).limit(20)
```

Expect one row per operation with `outcome`, `durationMs` and — on failure — `graphCode`. No
token value may appear anywhere in `metadata`.

### Step 8 — Verify the webhook (only if change notifications are in scope)

1. Create a subscription (or let the sync path create one) and read the row:
   `db.azure_subscriptions.findOne({ userId: ..., active: true })`.
2. Confirm `notificationUrl` equals the public URL from §5 and `nextRenewAt` is populated.
3. Send a test POST with the subscription's `clientState`, or trigger a real change, and confirm
   a `202` with `accepted: 1`.
4. Confirm `202` with `rejected: 1` when the `clientState` is deliberately wrong — that is
   verification working, and the rejection should be audited.

---

## 10. Troubleshooting map

| Symptom | Likely cause | Check |
|---|---|---|
| Every `/azure/*` route returns 404 | module not registered / server not restarted | start-up log, §7 |
| `AADSTS50011` | redirect URI mismatch | §1.3, byte-for-byte |
| `AADSTS65001`, or 403 on one service | consent missing for that scope | `azureConnectionStatus.grantedScopes`, §2 |
| `AzureConfigurationMissing` | a required `AZURE_*` variable is unset | §4.1 |
| `NotConnected` from a macro or service | no vault row and no legacy token | step 1 of §9 |
| `TOKEN_EXPIRED` for everyone at once | client secret expired | §1.4 |
| One user `TOKEN_EXPIRED` | refresh token revoked/expired | user reconnects |
| Reads work, no webhook arrives | URL not public, or subscription expired | §5, §6 |
| Webhook returns 503 | `AzureSubscriptionService` not registered | restart, service list |
| `PaginationLimitExceeded` | provider page bound (default 10) reached | pass `maxPages`, or narrow the query |
| `BatchSizeExceeded` | more than 20 requests in one `$batch` | split the batch |
| PDF conversion rejected | `.docx` over 2 MB | §11 — a hard Graph limit |
| SharePoint item has no column data | `$expand=fields` was sent instead of `expand=fields` | §11 |
| `AzureStorageConfigurationMissing` | no storage account configured | §4.2 (Graph is unaffected) |

---

## 11. What this module cannot do

Permanent capability gaps, quoted from `docs/audit.md` §7. These are not outages and not
backlog — do not raise them as defects.

- **No server-side Word body editing.** "The Word/Office JS API runs **in the browser as an
  Office Add-in** and requires the document to be open in Word on the web or desktop." The
  module delivers template copy with text substitution, `.docx` text extraction, PDF conversion
  and whole-file replacement — no paragraph editing.
- **PDF conversion is capped at 2 MB per file.** "A Word document above 2 MB cannot be converted
  this way at all." The service rejects with a typed error naming the limit rather than returning
  a truncated stream.
- **To Do has no assignee.** "Assignment is a **Planner** concern (`/planner/tasks` with
  `assignments` keyed by user id), with a different object model and different permission
  scopes." There is no Planner service in this module.
- **Search is OData, not Gmail syntax.** Graph exposes `$filter` plus a narrower, per-resource
  `$search`; `$search` requires `ConsistencyLevel: eventual`. The API exposes Graph's contract,
  not a Gmail-shaped `query` parameter.
- **`expand=fields` takes no dollar prefix.** "Sending the OData form is reported to return no
  `fields` rather than an error, which is a silent empty result."
- **No thread resource.** Graph has `conversationId` and no thread endpoint; the module exposes
  `listByConversation`, not `getThread`. Attachment, recurrence and subscription-lifetime models
  also differ from Google's (§7 G5–G7).

---

## 12. Security notes

- **Tokens are encrypted at rest** with AES-256-GCM, a key derived by scrypt from
  `AZURE_TOKEN_ENCRYPTION_KEY` plus a per-user random salt. A tampered ciphertext fails
  authentication rather than decrypting to garbage.
- **A revoked vault row is terminal.** `getToken` consults the `AzureToken` row first: no row
  enables the legacy bridge, but an existing revoked row returns no token and never falls through
  to the User-document token. `azureDisconnect` therefore actually disconnects.
- **`debugLogging` is off** on every Graph `Client`. The SDK's debug output logs request URLs and
  headers, which is a credential-leak path. There is exactly one construction site
  (`services/graph/AzureGraphClientProvider.ts`).
- **Audit redaction** covers `authorization`, `access_token`, `refresh_token`, `token` and
  `bearer`, case- and separator-insensitive.
- **Least privilege per connection**: request only the capability keys a user needs
  (`?services=mail_read`), not the full set.
- **Rotation**: rotate the client secret on a schedule (§1.4). Do not rotate
  `AZURE_TOKEN_ENCRYPTION_KEY` without planning a mass reconnect.
