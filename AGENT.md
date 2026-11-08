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

## Status — after AZ-18 (documentation consolidation)

All nineteen tickets in `docs/implementation-plan.md` are complete: every deliverable is present in
the module source, and AZ-18 (this documentation pass) is the last of them. The module registers
**16 services**, **4 models**, **11 GraphQL type files / 11 resolvers**, **5 queues**,
**9 forms** and **10 AI macros**.

There are **zero stubs**: no service definition in this module is a placeholder and no
resolver throws `not implemented`. Verified against `services/index.ts` — 16 exported
definitions, 16 unique `azure.*@1.0.0` FQNs, all `implemented`. `__tests__/contract-shape.test.ts`
asserts the count and the exact FQN set.

**AZ-18 is documentation only.** `docs/implementation-plan.md` §5 ("Definition of done") is a
**human sign-off gate** evaluated after all nineteen tickets merge. Closing AZ-18 does *not*
mean the module is signed off, and it does not make the module live.

The module is **not active** until the owner restarts the express server — the running process
loaded an earlier registry at start-up. The runbook, including the restart requirement and the
live smoke test, is `docs/operations.md`.

Runtime dependencies resolve from the server root as of this pass (see "Runtime dependencies"
below). Re-verify before a restart: `reactory-core` imports the retained shim eagerly, so a
missing `@microsoft/microsoft-graph-client` would fail the restart at core module load with
`MODULE_NOT_FOUND`, not merely leave the Azure module inert.

## Services (16 — one row per exported definition)

| # | FQN | Delivered by | Status |
|---|---|---|---|
| 1 | `azure.AzureAuditService@1.0.0` | AZ-01 | implemented — Graph operation audit trail, credential redaction, never throws |
| 2 | `azure.AzureAuthService@1.0.0` | AZ-01 | implemented — PKCE URL, callback exchange, token vault, refresh, legacy bridge, profile |
| 3 | `azure.AzureGraphClientProvider@1.0.0` | AZ-01 | implemented — the only Graph `Client` factory: retry, pagination, delta, batch |
| 4 | `azure.AzureService@1.0.0` | AZ-01 | implemented — facade exposing every other service plus connection status/disconnect |
| 5 | `azure.AzureMailService@1.0.0` | AZ-04, AZ-05 | implemented — paged/searchable messages, folders (Redis-cached), categories, conversations; send/reply/forward, drafts, inline and resumable attachments |
| 6 | `azure.AzureTodoService@1.0.0` | AZ-06 | implemented — Microsoft To Do lists, tasks, checklist items over v1.0 `/me/todo`; no `assignedTo` (assignment is Planner) |
| 7 | `azure.AzureCalendarService@1.0.0` | AZ-07 | implemented — calendars (5 min cache), `calendarView` ranges, event CRUD, RSVP/cancel, `getSchedule`, `findMeetingTimes`, online meetings |
| 8 | `azure.AzureDriveService@1.0.0` | AZ-08 | implemented — drives, paged children, encoded path/item addressing, redirect-safe download and thumbnail streams, simple/resumable upload, folder/move/copy(monitor)/delete/restore, sharing, versions |
| 9 | `azure.AzureDocumentService@1.0.0` | AZ-09 | implemented — template copy with text substitution, `.docx` text extraction (headers/footnotes/text boxes may be lost), 2 MB-capped PDF conversion, whole-file replace; no body editing (no server-side API) |
| 10 | `azure.AzureWorkbookService@1.0.0` | AZ-10 | implemented — worksheets (2 min cache), used/address ranges, values/formulas/numberFormat writes, append/clear, tables and rows; sessions always closed in a finally |
| 11 | `azure.AzureContactsService@1.0.0` | AZ-11 | implemented — contacts CRUD + folders, people `$search` (nextLink-only paging), `/users` directory behind the User.Read* gate, photos (`null` only on ImageNotFound) |
| 12 | `azure.AzureSyncService@1.0.0` | AZ-12 | implemented — messages/events/drive delta loops with `Prefer: IdType="ImmutableId"`, per-page added/updated/deleted batches, persisted `@odata.deltaLink`; a 410 `resyncRequired` performs and records exactly one full resync (never propagated) |
| 13 | `azure.AzureSubscriptionService@1.0.0` | AZ-12 | implemented — create/resubscribe/renew/delete Graph subscriptions, per-subscription random AES-256-GCM-encrypted `clientState` with constant-time verification, renewal at 80% of the granted lifetime (no hardcoded TTL) |
| 14 | `azure.AzureTeamsService@1.0.0` | AZ-14 | implemented — chats and chat messages, joined teams, channels and channel messages (every id fully percent-encoded), send chat/channel messages, uncached presence |
| 15 | `azure.AzureSharePointService@1.0.0` | AZ-15 | implemented — sites (path/root/search), lists, items (`expand=fields`, no `$`), columns, site drive; createItem rejects non-internal field keys |
| 16 | `azure.AzureBlobStorageService@1.0.0` | AZ-16 | implemented — Blob Storage v12 data plane: containers, blobs (listBlobs = one page, listAllBlobs follows the token), streams, SAS URLs |

**Zero stub rows.** All sixteen definitions are implemented; a failure is always an `ApiError`
carrying the Graph code, never a placeholder `[]`, `null` or truthy non-result. The exact list and
order above is `services/index.ts`; the FQN set is asserted by `__tests__/contract-shape.test.ts`.

## Models

| Collection | Model | Fields of note |
|---|---|---|
| `azure_tokens` | `AzureToken` | `userId` (unique), `accessTokenEncrypted`, `refreshTokenEncrypted`, `accessTokenExpiry`, `grantedScopes[]`, `azureUserId` (oid), `tenantId` (tid), `upn`, `encryptionSalt`, `connectedAt`, `lastRefreshedAt?`, `revokedAt?` |
| `azure_audit_logs` | `AzureAuditLog` | `userId`, `operation`, `resource`, `outcome`, `durationMs`, `graphCode?`, `correlationId?`, `metadata?` |
| `azure_sync_states` | `AzureSyncState` | `userId`, `resource` (`messages` \| `events` \| `drive`), `deltaLink?`, `lastSyncedAt?`, `cursor?`, `status` (`idle` \| `syncing` \| `synced` \| `resync` \| `error`), `lastError?`, `fullResyncCount`, `lastFullResyncAt?`, `lastSyncWasFullResync`; one row per user and resource |
| `azure_subscriptions` | `AzureSubscription` | `userId`, `subscriptionId` (unique), `resource`, `graphResource`, `changeType`, `notificationUrl`, `expirationDateTime`, `clientState` (encrypted), `clientStateSalt`, `renewedAt`, `nextRenewAt`, `active` |

All four are exported from `models/index.ts` as `ModelDefinitions` (exactly 4 entries) and
re-exported as named models. `AzureToken`, `AzureAuditLog` come from AZ-01; `AzureSyncState`
and `AzureSubscription` were appended by AZ-12, the only permitted edit to that barrel.

## Microsoft Graph coverage

| Capability | Endpoints | Ticket | State |
|---|---|---|---|
| Identity / profile | `/me`, `/me/photos/{size}/$value` | AZ-01 | implemented |
| Mail read | `/me/messages`, `/me/mailFolders`, `/me/outlook/masterCategories` | AZ-04 | implemented |
| Mail write | `/me/sendMail`, `/messages/{id}/reply`, drafts, attachments | AZ-04, AZ-05 | implemented |
| Tasks | `/me/todo/lists`, `/me/todo/lists/{id}/tasks`, `…/checklistItems` | AZ-06 | implemented — v1.0 only |
| Calendar | `/me/calendars`, `/me/calendarView`, `/me/calendar/getSchedule`, `/me/findMeetingTimes` | AZ-07 | implemented |
| Files | `/me/drive`, `/items/{id}/children`, `/content`, upload sessions, permissions | AZ-08 | implemented |
| Documents | `/items/{id}/content?format=pdf`, template copy | AZ-09 | implemented — PDF capped at 2 MB |
| Workbooks | `/workbook/worksheets`, `…/range`, `…/tables`, `createSession` | AZ-10 | implemented |
| Contacts / directory | `/me/contacts`, `/me/people`, `/users` | AZ-11 | implemented |
| Sync | `/me/messages/delta`, `/me/events/delta`, `/me/drive/root/delta`, `/subscriptions` | AZ-12 | implemented |
| Teams | `/me/chats`, `/teams/{id}/channels/{id}/messages`, `/communications/getPresencesByUserId` | AZ-14 | implemented |
| SharePoint | `/sites/{host}:/{path}`, `/sites/{id}/lists`, `/lists/{id}/items` | AZ-15 | implemented — `expand=fields` |
| Blob Storage | `BlobServiceClient` (no Graph) | AZ-16 | implemented |

The **only beta endpoint this module calls** is the legacy shim's `/me/outlook/tasks` surface
(`services/graph.ts`, `LEGACY_TASKS_VERSION = 'beta'`, used by its four task methods), which
documents why AZ-06 replaces it. Everything new uses `v1.0`. (The string `beta` also occurs once
in a design note at `AzureDocumentService.ts:694`, which names the preview
`documentProcessingJob` pipeline as a rejected extraction option — a comment, not a request.)

### Microsoft To Do (AZ-06)

`AzureTodoService` addresses only `/me/todo/...` on **v1.0**. The legacy shim's
`/me/outlook/tasks` calls are untouched (AZ-19 retires them), and nothing in the new
surface can reach that path - it stopped returning data on 20 August 2022.

- **No task assignment.** A Microsoft To Do task has no assignee: To Do shares whole
  *lists*. Per-task assignment is a **Planner** concept, expressed as `/planner/tasks`
  with an `assignments` collection. No service method, input type or GraphQL field
  exposes `assignedTo`, and a payload that carries `assignedTo`, `assignee` or
  `assignments` is **rejected** with `UnsupportedTodoTaskAssignment` rather than
  silently dropped - a caller must never believe a task was handed to someone.
- **Task filtering is client-side.** `GET /me/todo/lists/{id}/tasks` documents only
  that it *"supports some of the OData query parameters"* and names no filterable
  property, so `dueDateTime` cannot be relied on server-side. `listTasks` reads every
  page (to the provider's page bound) and applies `status`, `importance`,
  `includeCompleted`, `dueAfter`, `dueBefore`, `skip` and `top` itself.
- **Checklist items** are full CRUD under `…/tasks/{taskId}/checklistItems`.
- Suites: `__tests__/todo.request-shape.test.ts` (all five list operations, all task
  operations and all five checklist operations) and `__tests__/todo-service.test.ts`
  (client-side selection, pagination, error contract, schema/resolver alignment).

## What this module cannot do — quoting `docs/audit.md` §7

These are permanent capability gaps, not defects and not backlog. They are recorded so an agent
does not promise them. Every quotation below is from `docs/audit.md` §7, "Honest capability gaps —
where Azure cannot match Google".

### No server-side Word body editing (G1)

> **Microsoft has no equivalent.** The Word/Office JS API runs **in the browser as an Office
> Add-in** and requires the document to be open in Word on the web or desktop.

> **Consequence for the plan:** `AzureDocumentService` will deliver *create from template*,
> *read text*, *convert to PDF* and *replace file*. It will **not** deliver addressable
> paragraph editing. Achieving that requires either `docx`-library manipulation server-side
> (slow, lossy for complex documents, no layout awareness) or an Office Add-in on the client.

The delivered service is exactly that: template copy with text substitution, `.docx` text
extraction, PDF conversion and whole-file replacement. There is no `batchUpdate` and no
paragraph/range styling API.

### PDF conversion is capped at 2 MB per file (G1)

> **The conversion endpoint is capped at 2 MB per file** and only supports documented format
> pairs. A Word document above 2 MB cannot be converted this way at all. The service must
> check `size` and reject with a typed error naming the limit — never return a truncated or
> empty stream.

### To Do has no assignee; assignment lives in Planner (G2)

> `reactory-google`'s `createTask` takes an `assignedTo`. The Azure equivalent must not pretend
> the same parameter exists. To Do tasks have no assignee. Assignment is a **Planner** concern
> (`/planner/tasks` with `assignments` keyed by user id), with a different object model and
> different permission scopes.

`AzureTodoService` rejects a payload carrying `assignedTo`, `assignee` or `assignments` with
`UnsupportedTodoTaskAssignment` rather than dropping it. **This module does not implement a
Planner service** — a caller that needs per-task assignment needs a new service and the Planner
permission set.

### Search is OData, not a Gmail query language (G3)

> Gmail accepts a query language (`from:`, `has:attachment`, `newer_than:`). Graph accepts
> OData `$filter`, plus `$search` with a narrower KQL-like grammar that varies per resource.
> `$search` requires `ConsistencyLevel: eventual` and behaves differently per resource.

> **Consequence:** the mail search API must expose Graph's real contract, not a Gmail-shaped one.
> Do not name a parameter `query` and imply Gmail semantics.

### `expand=fields` takes no dollar prefix (G3a)

> SharePoint list items expand their column data through `expand=fields`, **without** the OData
> dollar prefix ... sending the OData form is reported to return no `fields` rather than an
> error, which is a silent empty result.

`AzureSharePointService` sends `expand=fields`. Do not "correct" it to `$expand=fields`.

### Threading, attachments and recurrence are not Google's models (G4, G5, G7)

> Gmail has a first-class `thread` resource. Graph has `conversationId` on messages and no
> thread endpoint. Reconstructing a thread means filtering by `conversationId`, which is not
> guaranteed to be a complete conversation across folders. The plan exposes
> `listByConversation`, not `getThread`.

Graph's attachment model and calendar recurrence shapes also differ from Google's (§7 G5, G7),
and subscription lifetimes are not uniform (§7 G6) — which is why renewal is derived from the
lifetime Graph actually grants rather than from a constant. Large `.docx` extraction may lose
headers, footnotes and text boxes; that is documented on the method, not worked around.

## GraphQL surface

Eleven `.graphql` files, all loaded by `graphql/types/index.ts`, each with a resolver class in
`graphql/resolvers/`. **All are implemented** — no root field below throws `not implemented`.

| File | Query fields | Mutation fields |
|---|---|---|
| `Auth.graphql` | `azureConnectionStatus` | `azureAuthUrl`, `azureDisconnect` |
| `Mail.graphql` | `azureMailMessages`, `azureMailMessage`, `azureMailFolders`, `azureMailCategories`, `azureMailConversation`, `azureMailAttachments`, `azureMailAttachment` | `azureSetMailCategories`, `azureSendMail`, `azureReplyMail`, `azureReplyAllMail`, `azureForwardMail`, `azureCreateMailDraft`, `azureUpdateMailDraft`, `azureSendMailDraft`, `azureDeleteMailDraft` |
| `Tasks.graphql` | `azureTodoLists`, `azureTodoTasks`, `azureTodoTask`, `azureTodoChecklistItems` | `azureCreateTodoList`, `azureUpdateTodoList`, `azureDeleteTodoList`, `azureCreateTodoTask`, `azureUpdateTodoTask`, `azureCompleteTodoTask`, `azureDeleteTodoTask`, `azureCreateTodoChecklistItem`, `azureUpdateTodoChecklistItem`, `azureDeleteTodoChecklistItem` |
| `Calendar.graphql` | `azureCalendars`, `azureCalendarEvents`, `azureCalendarView`, `azureCalendarEvent`, `azureCalendarSchedule`, `azureFindMeetingTimes` | `azureCreateEvent`, `azureUpdateEvent`, `azureDeleteEvent`, `azureCancelEvent`, `azureRespondToEvent` |
| `Drive.graphql` | `azureDrive`, `azureDrives`, `azureDriveItems`, `azureDriveItem`, `azureDriveSearch`, `azureDrivePermissions`, `azureDriveVersions` | `azureCreateDriveFolder`, `azureUploadDriveItem`, `azureMoveDriveItem`, `azureCopyDriveItem`, `azureDeleteDriveItem`, `azureRestoreDriveItem`, `azureShareDriveItem`, `azureInviteDriveCollaborators`, `azureDeleteDrivePermission`, `azureRestoreDriveVersion` |
| `Documents.graphql` | `azureDocumentMetadata`, `azureDocumentText`, `azureDocumentPdf` | `azureCreateDocumentFromTemplate`, `azureReplaceDocument` |
| `Workbook.graphql` | `azureWorkbookWorksheets`, `azureWorkbookRange`, `azureWorkbookTables` | `azureUpdateWorkbookRange`, `azureAppendWorkbookRows` |
| `Contacts.graphql` | `azureContacts`, `azureContact`, `azureContactFolders`, `azureContactsInFolder`, `azurePeople`, `azureDirectoryUsers`, `azureContactPhoto` | `azureCreateContact`, `azureUpdateContact`, `azureDeleteContact` |
| `Teams.graphql` | `azureChats`, `azureChatMessages`, `azureTeams`, `azureChannels`, `azureChannelMessages`, `azurePresence` | `azureSendChatMessage`, `azureSendChannelMessage` |
| `SharePoint.graphql` | `azureSites`, `azureRootSite`, `azureSiteByPath`, `azureSharePointLists`, `azureSharePointItems`, `azureSharePointItem`, `azureSharePointColumns`, `azureSharePointDrive` | `azureCreateSharePointItem`, `azureUpdateSharePointItem`, `azureDeleteSharePointItem` |
| `Sync.graphql` | `azureSyncState`, `azureSubscriptions` | `azureSync`, `azureRenewSubscriptions` |

**`userId` is an optional argument on the Mail, Contacts and SharePoint fields** — 37 of the
module's 104 root fields (16 in `Mail.graphql`, 10 in `Contacts.graphql`, 11 in
`SharePoint.graphql`). It is
**self-or-admin**: omitted, `null` or empty resolves to the caller; naming the caller resolves to
the caller; naming **anyone else** throws `InsufficientPermissions` unless
`context.hasRole('ADMIN') === true`. So an ADMIN can deliberately read another user's mailbox,
contacts or SharePoint site through these fields — that is the designed behaviour, implemented
identically in `MailResolver`, `ContactsResolver` and `SharePointResolver`, and stated in each
`.graphql` file's header and each resolver's JSDoc. Any test or capability audit of cross-user
access must exercise that ADMIN gate.

Every other root field — `Auth`, `Calendar`, `Tasks`, `Drive`, `Documents`, `Workbook`, `Teams`
and `Sync` — declares **no `userId` argument** and always acts as the caller. `TeamsResolver`
returns `String(context.user._id)`; `Sync.graphql` says the same in its header comment.

A `.graphql` file that is not listed in `graphql/types/index.ts` is never loaded, and
the barrel is deliberately explicit (11 names, 11 files on disk).

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

## Forms (AZ-17)

`forms/index.ts` was created empty by AZ-01 and is filled by AZ-17. The root `index.ts` is
untouched: it already wires `forms: Forms`, so the barrel is the only file that changed.

**Nine forms — and that is a deliberate superset of `reactory-google`'s eight, not parity.**
The ninth is `AzureWorkbookViewForm`; `azureWorkbook*` is a first-class Graph surface here
(worksheets, ranges, tables, append/update with workbook-session control) and folding it into
the Drive explorer would hide it. It is an addition, not a mirror of a Google form.

| Form | Read | Writes |
|---|---|---|
| `AzureAccountConnectionForm` | `azureConnectionStatus` | `azureAuthUrl`, `azureDisconnect` |
| `AzureMailInboxForm` | `azureMailMessages` | — |
| `AzureMailComposeForm` | — | `azureSendMail` |
| `AzureCalendarViewForm` | `azureCalendarView` | — |
| `AzureCalendarEventForm` | `azureCalendarEvent` | `azureCreateEvent`, `azureUpdateEvent`, `azureDeleteEvent` |
| `AzureDriveExplorerForm` | `azureDriveItems` | `azureCreateDriveFolder`, `azureDeleteDriveItem` |
| `AzureWorkbookViewForm` | `azureWorkbookRange` | `azureAppendWorkbookRows`, `azureUpdateWorkbookRange` |
| `AzureContactsManagerForm` | `azureContacts` | `azureCreateContact`, `azureUpdateContact`, `azureDeleteContact` |
| `AzureTodoManagerForm` | `azureTodoTasks` | `azureCreateTodoTask`, `azureUpdateTodoTask`, `azureDeleteTodoTask` |

Every form is a `Reactory.Forms.IReactoryForm` in the `azure` namespace, id
`azure.<Name>@1.0.0`, with `schema.type === 'object'` and `roles: ['USER']`.

### The two client read paths

A form can display a read payload in two ways, and **one** definition decides which
applies:

**Path A — the form-level data manager.** `useGraphQLDataManager.transformData` shapes
`data.data[query.name]` by `schema.type` (object: spread, array: copy; anything else: the
whole `data`) and then applies `resultMap`. It never reads `resultType` — the only code
that does, `ReactoryFormDataManager.fromGraphResult`, has no callers — so no form declares
`resultType`. For this path the payload must land on a **declared property**.

**Path B — the grid's own fetch.** `MaterialTableWidget` with
`ui:options.remoteData: true` runs its *own* query on mount, maps its variables from
`{ formContext, query, props }`, wraps an **array** root field as
`{ data: rawResultData }` and renders `data.data`. It never calls `transformData`, so
`schema.type` does not constrain it. This is the only way a list-returning root can be
shown while every form stays `type: 'object'`, and two shipped client forms use it
(`myCommentsForm`, `content-management`).

`graphql.queries` therefore is **not** dead: it is exactly what a Path B grid names
through `ui:options.query`, and the form-level manager ignores it (it needs a `queryKey`
that `useDataManager` never passes). The suite asserts reference integrity in both
directions — every `queries` entry is named by some widget, and every `ui:options.query`
names an existing entry. An earlier revision banned the block outright, which was wrong.

### Read reachability

| Form | Read | Path | Reached |
|---|---|---|---|
| `AzureAccountConnectionForm` | `azureConnectionStatus` | A | full `resultMap` onto declared fields |
| `AzureMailInboxForm` | `azureMailMessages` | A | page object → `resultMap` `{items, nextLink, count}`; `items` grid |
| `AzureCalendarViewForm` | `azureCalendarView` (`queries.calendarView`) | **B** | `remoteData` grid → `{data: [...]}` → `events`; variables from `formContext.formData` |
| `AzureCalendarEventForm` | `azureCalendarEvent` | A | `resultMap` with dotted keys (`body.content`, `start.dateTime`, …) |
| `AzureDriveExplorerForm` | `azureDriveItems` | A | page object → `resultMap` `{items, nextLink, count}`; `items` grid |
| `AzureWorkbookViewForm` | `azureWorkbookRange` | A | range object → `resultMap` `{address, values}` |
| `AzureContactsManagerForm` | `azureContacts` | A | page object → `resultMap` `{items, nextLink, count}`; `items` grid |
| `AzureTodoManagerForm` | `azureTodoTasks` (`queries.tasks`) | **B** | `remoteData` grid → `{data: [...]}` → `items`; variables from `formContext.formData` |
| `AzureMailComposeForm` | none | — | write-only |

All nine reads are displayable. `DOCUMENTED_UNREACHABLE_READS` in the suite is **empty**;
the map and its check are kept so a future exception must be written down deliberately
and mirrored here.

**Correction worth keeping:** revisions 1–3 claimed the two list-returning roots could not
be displayed and needed "client support". That was false — the support is
`ui:options.remoteData`, which the client already ships. A list payload is displayable
through a `remoteData` grid, and only through one: a client that renders these forms
without `MaterialTableWidget` (the v5 engine, see the constraint below) will not show the
rows.

### Constraint: i18n keys are resolved by the default form engine only

Every label here is a dotted `azure.forms.*` key. The legacy ("fork") form engine's
title/field components call `reactory.i18n.t`, so labels resolve once the bundle is
shipped. The **v5** engine's `TitleFieldTemplate`/`FieldTemplate` contain no i18n call at
all, so flipping `forms.useV5Engine` would render the raw keys as visible headings. That is
a ticket-independent platform constraint, recorded for whoever flips it — this module keeps
using keys because the ticket requires externalised strings.

### The two maps, and why their orientation matters

* `variables` is **source → variable**. The client builds
  `kwargs = { form, formData, formContext, reactory, api, props }` and calls
  `objectMapper(kwargs, parseObjectMap(map))`, so the object KEY is the form path and the
  VALUE is the GraphQL variable name — `{ 'formData.itemId': 'itemId' }`, as
  `reactory-product` and `reactory-classroom` write it. The inverse spelling resolves no
  source and `objectMapper` returns `undefined`, which becomes `variables = {}`: every
  request then goes out with no variables and every non-null-variable operation fails at
  Graph with "Variable $x of required type ... was not provided".
* `resultMap` is keyed by the properties of the object **under** the root field, because the
  data manager applies it to `data.data[query.name]`. A key prefixed with the root field
  name (`'azureConnectionStatus.status'`) resolves nothing and the form's data becomes
  `undefined`.

Nested targets carry the input-object shapes: `'formData.startDateTime': 'start.dateTime'`,
`'formData.status': 'filter.status'`, `'formData.values': 'input.values'`. Where a bare
array has to become Graph's `[{ address }]`, `forms/transforms.ts` supplies a function
transform — `toAddressList`, `toAttendees`, `toTextBodyContentType` — which
`parseObjectMapper` passes through untouched. Those adapt value shapes only; they never
name a field the input type does not declare.

### How the suite proves it

`__tests__/forms.test.ts` compiles the module's own `graphql/types/*.graphql` with
`buildSchema` (prepending only `scalar Any`, `scalar DateTime`, `scalar JSON`,
`scalar BigInt` and the two base operation types, because the eleven files
`extend type Query`/`extend type Mutation`), then:

1. validates every document with the real `graphql-js` validator — unknown root field,
   unknown argument, unknown variable type, and a nullable variable in a non-null position
   all fail;
2. requires every `variables` key to be rooted at `formData`/`formContext`/`query` and
   (for `formData`) to name a declared schema property;
3. requires every variable the document declares to be produced by the map, and nothing else;
4. rejects a bare `{ 'formData': <variable> }` in either orientation;
5. **executes every map with the real `object-mapper`** against form data sampled from the
   form's own schema, and validates the resulting `variables` recursively against the
   GraphQL variable types — unknown input-object fields, wrong scalars, wrong enum members
   and missing non-null fields all fail;
6. checks every `resultMap` key against the root field's return type (walking dotted
   paths such as `body.content`), and every `resultMap` value against the declared form
   properties;
7. requires **every declared source -> target pair** to produce a value that is present
   *and* non-null from populated form data — the assertion that catches a transform
   silently discarding its input, which "the variable is type-valid" cannot, because a
   missing nullable field is type-valid;
8. models **both** client read paths for every read: Path A by simulating
   `transformData`, Path B by validating the `remoteData` grid (declared array property,
   non-empty `ui:options.columns` whose `field`s resolve in the item schema, and
   `ui:options.variables` rooted at `formContext`/`query`/`props` that produces every
   variable the document declares and type-checks against it). A read fails only when
   **neither** path reaches it;
9. keeps `graphql.queries` honest in both directions: every entry is named by a widget's
   `ui:options.query`, and every `ui:options.query` names an existing entry.

Probes run against the suite (each fails as intended, each restored): inverting one map entry
is reported as "source is not rooted at formData/formContext/query"; mapping
`'formData.top'` to `'input.top'` is reported as "$input.top is not a field of
AzureContactInput"; forwarding the whole `formData` is reported in both orientations;
re-prefixing one `resultMap` key is reported as "not a field of AzureConnection".

Two `object-mapper` builds ship in this estate and they differ in ways that change
the request: **5.x** omits a target key whose source is absent and flattens an
array-of-arrays; **6.x** emits `null` instead and preserves the nested array. Arrays of
objects survive in both. This repository's root resolves 5.0.0, the PWA client pins
6.2.0 — so the suite loads **both** and runs every mapping assertion against each,
naming the builds it exercised in any failure. Checking "the key is present" is not
enough: the assertion requires the target to be present **and** non-null, which is what
catches a transform that silently discards its input under either build.

The workbook matrix target is `Any`, so a 5.x-flattened payload is still a type-valid
request; the client sends it intact under 6.x.

### Strings live in `i18n/en.json`

No label is hardcoded. Form `title`/`description`, `schema.title`, every property `title`,
every `enumNames` entry (including array-item enums) and every `ui:placeholder`/`ui:help`
is a dotted key built by `forms/i18n.ts` under `azure.forms.*`, resolved from
`i18n/en.json` — the same externalisation `reactory-google` uses. The suite walks all of
these strings and fails on a key that does not resolve, on a label that does not start with
`azure.forms.`, on an enum with fewer labels than values, and on any **orphaned** key left
in `i18n/en.json` that no form references.

The module defines `translations: []` (AZ-01, frozen), so `i18n/en.json` is a shipped
asset rather than something the module definition registers — identical to
`reactory-google`, which also carries `i18n/en.json` with `translations: []`. The server's
i18n init loads `APP_DATA_ROOT/i18n/<locale>/<namespace>.json` plus i18next resource
bundles; it does not merge a module's own file. Until this bundle is shipped to
`reactory-data/i18n/en/azure.json`, rjsf will render the raw dotted keys.

### Constraints the forms encode rather than paper over

- **No assignee on a To Do task.** `AzureTodoTaskCreateInput`/…`UpdateInput` have no
  `assignedTo`; assignment is Planner (`/planner/tasks`). A form field would be rejected by
  the service (`UnsupportedTodoTaskAssignment`), so there is none.
- **Date/time is always `{ dateTime, timeZone }`.** `AzureCalendarDateTimeTimeZoneInput`
  and `AzureDateTimeTimeZoneInput` make `timeZone` non-null. Each form carries the zone
  beside the wall clock, and `azureCalendarView` is used for a ranged read because
  `/me/events` returns recurrence masters.
- **Workbook values are `Any`, never `[String]`.** `null` is an empty cell and `'#DIV/0!'` is
  an error; a String matrix would stringify numbers and erase that distinction.
- **No `downloadUrl`.** The Drive explorer has no such field because the schema has none;
  bytes go through `GET /azure/files/:itemId`.

## HTTP surface

Mounted at `/azure` (`index.ts` → `routes: { '/azure': routes }`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/azure/auth/url?services=mail,calendar` | issue a PKCE authorization URL |
| GET | `/azure/auth/callback?code=&state=` | exchange the code, vault the tokens |
| GET | `/azure/auth/status` | connection status for the caller |
| POST | `/azure/auth/disconnect` | mark the vaulted token revoked |
| POST | `/azure/webhooks/graph` | Graph change notifications: `?validationToken=` handshake, then `clientState`-verified notifications |
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

`services/graph.ts` is a **deprecated** compatibility shim and must not be deleted. After AZ-19
the only live importer left in `reactory-core` (a different repository) is
`src/modules/reactory-core/resolvers/User/ProfileResolver.ts:6`:

```ts
import MSGraph from '@reactory/server-modules/reactory-azure/services/graph';
```

AZ-19 migrated the other two call sites away from the shim:

- `resolvers/Emails/UserEmails.ts` now resolves
  `context.getService('azure.AzureMailService@1.0.0')` (exposed as `AZURE_MAIL_SERVICE_ID`) and
  declares local interfaces for the subset of the mail types it consumes — it imports nothing
  from this module's `services/graph`.
- `services/EmailService.ts` no longer imports the shim at all. (Its line 9 is
  `import SendGrid from '@sendgrid/mail'` — SendGrid, not Microsoft Graph.)

The nine method names and their success shapes are preserved; `sendEmail` and `getEmails` now
**reject** instead of swallowing the error.

`resolvers/User/ProfileResolver.ts` is a live **sign-in** path whose token comes from the
User document. **The shim therefore must not be deleted yet**, even though it has only one
importer left: that importer is on the sign-in path. It cannot be migrated until the owner
restarts the server, signs in through the Microsoft provider and confirms the migrated path
works (plan §6.6). Only then may `services/graph.ts` and `types.d.ts` be deleted — **AZ-19**
owns that change.

## Environment variables

Every variable below is read by this module's source, and these are the **only** environment
variables it reads (verified by sweeping `process.env` across the module, including the
`env: IAzureBlobStorageEnvironment = process.env` default parameter in
`AzureBlobStorageService`). The operator checklist is `docs/operations.md`.

| Variable | Required | Purpose |
|---|---|---|
| `AZURE_CLIENT_ID` | yes | application (client) id of the app registration |
| `AZURE_CLIENT_SECRET` | yes | client secret for the confidential client |
| `AZURE_TENANT_ID` | yes | tenant id, or `organizations` for multi-tenant |
| `AZURE_REDIRECT_URI` | yes | must match the registered redirect (`…/azure/auth/callback`) |
| `AZURE_TOKEN_ENCRYPTION_KEY` | yes | master key for AES-256-GCM token and `clientState` encryption |
| `AZURE_API_RATE_LIMIT` | no | per-user requests/minute budget; `0` or unset disables the gate |
| `AZURE_AUTH_SUCCESS_REDIRECT` | no | post-callback redirect; defaults to `${REACTORY_APPLICATION_URL}/?azure=connected` |
| `AZURE_AUTH_FAILURE_REDIRECT` | no | failure redirect; defaults to `${REACTORY_APPLICATION_URL}/?azure=error` |
| `REACTORY_APPLICATION_URL` | recommended | base URL for the redirect defaults and for the webhook fallback |
| `AZURE_WEBHOOK_NOTIFICATION_URL` | for subscriptions | public URL Graph calls; defaults to `${REACTORY_APPLICATION_URL}/azure/webhooks/graph` |
| `AZURE_STORAGE_CONNECTION_STRING` | one of these | Blob Storage via connection string (preferred) |
| `AZURE_STORAGE_ACCOUNT` | one of these | storage account name; with `AZURE_STORAGE_KEY`, or alone for `DefaultAzureCredential` |
| `AZURE_STORAGE_ACCOUNT_URL` | no | explicit blob endpoint; account name is derived from it when not set |
| `AZURE_STORAGE_KEY` | no | shared account key; enables SAS generation fallback |

There is **no `AZURE_WEBHOOK_DOMAIN` variable.** The public webhook address is configured with
`AZURE_WEBHOOK_NOTIFICATION_URL` (explicit) or `REACTORY_APPLICATION_URL` (prefix). A name not
listed above is not read by this module — adding one has no effect.

Without a tenant, every failure path is typed: `AzureConfigurationMissing` rather than a
half-built client.

## Runtime dependencies — verify BEFORE restarting the server

The module needs these packages resolvable from `src/modules/reactory-azure`:

```
@microsoft/microsoft-graph-client   # ^3.0.7   required by services/graph/AzureGraphClientProvider.ts
@microsoft/microsoft-graph-types    # ^2.40.0  types only (no runtime entry); same install
@azure/msal-node                    # ^2.16.2  PKCE generation and token exchange
@azure/storage-blob                 # 12.23.0  the Blob Storage data plane
@azure/identity                     # ^3.4.2   DefaultAzureCredential fallback
@azure/storage-file-share           # 12.23.0  declared dependency
```

All runtime packages resolve from the host server root as of this pass. Verified from the
natural mount:

```bash
cd src/modules/reactory-azure && node -e "require.resolve('@microsoft/microsoft-graph-client')"
# /…/reactory-express-server/node_modules/@microsoft/microsoft-graph-client/lib/src/index.js
```

(`@microsoft/microsoft-graph-types` is types-only and publishes no `main`; `require.resolve`
failing for it is expected — `tsc` resolves its `types` field. `@azure/storage-file-share` is
declared but not imported by this module's source.)

Re-run that resolution check **before** a restart: see docs/operations.md §7.1.

**Why a missing SDK blocks the restart, not just the tests.** `services/graph.ts` (the retained shim)
imports `./graph/AzureGraphClientProvider` (line 52), which imports the SDK. The generated
`src/modules/__index.ts:11` imports `reactory-core` at start-up, and the chain from there is
eager — no lazy boundary anywhere in it:

```
src/modules/__index.ts:11
  -> @reactory/server-modules/reactory-core/index
     -> reactory-core/index.ts:2        import coreResolvers from './resolvers'
        -> resolvers/index.ts:11        ProfileResolver,   (inside the './User' import block)
           -> resolvers/User/ProfileResolver.ts:6
              import MSGraph from '@reactory/server-modules/reactory-azure/services/graph'
              -> services/graph.ts:52   import { createTokenGraphClient } from './graph/AzureGraphClientProvider'
                 -> @microsoft/microsoft-graph-client
```

Re-verified against the installed trees. Until the package resolves, **the server fails at core
module load with `MODULE_NOT_FOUND`** — it does not boot at all; this is not "the Azure module
is inert".

If it ever does not resolve, install it in one of the two locations that resolve from the module
(this is a remedy, not a current step — the package resolves today):

1. the module's own `node_modules` — `cd src/modules/reactory-azure && npm install`
   (uses this module's `dependencies`); or
2. the server root — add it to `reactory-express-server/package.json` and install there,
   matching how `googleapis` is handled for `reactory-google`.

A worktree install (`src/modules/reactory-worktrees/<id>/node_modules`) satisfies the test
harness but is **not** visible from the natural mount, so it does not satisfy the server.

## AI macros and the Azure Workspace Assistant (AZ-13)

`ai/macros/index.ts` (owned by AZ-01) assembles `AZURE_MACROS` from one array per
`ai/macros/<domain>.macros.ts` file. AZ-13 filled seven of those files; AZ-14 filled
`teams.macros.ts`. **No domain ticket edits the barrel** - spreading the array is what
makes the macro appear. The delivered surface is **ten macros** across eight files.

| Macro | File | Service resolved via `context.getService` |
|---|---|---|
| `azure_connection_status` | `status.macros.ts` | `azure.AzureService@1.0.0` (facade; reads the token record, no Graph call) |
| `azure_send_email` | `mail.macros.ts` | `azure.AzureMailService@1.0.0` |
| `azure_search_email` | `mail.macros.ts` | `azure.AzureMailService@1.0.0` |
| `azure_create_event` | `calendar.macros.ts` | `azure.AzureCalendarService@1.0.0` |
| `azure_list_events` | `calendar.macros.ts` | `azure.AzureCalendarService@1.0.0` |
| `azure_search_drive` | `drive.macros.ts` | `azure.AzureDriveService@1.0.0` |
| `azure_read_workbook` | `workbook.macros.ts` | `azure.AzureWorkbookService@1.0.0` |
| `azure_list_contacts` | `contacts.macros.ts` | `azure.AzureContactsService@1.0.0` |
| `azure_create_task` | `tasks.macros.ts` | `azure.AzureTodoService@1.0.0` |
| `azure_send_teams_message` | `teams.macros.ts` | `azure.AzureTeamsService@1.0.0` |

Ten macros in total: nine from AZ-13 plus the AZ-14 Teams macro. `AZURE_TOOLS` is empty — the
tools live on each macro definition.

**Contract.** Each entry is a `MacroComponentDefinition` whose single `tools` entry is the
`MacroToolDefinition` the model calls. Every parameter carries a `description` and a
`required` flag; the flag is compiled into `parameters.required` by
`ai/macros/macro-support.ts` (which is not a `*.macros.ts` file, so the barrel and the
contract test are untouched by it). Every macro returns a plain object - never a stream or
a service instance.

**No connection, no exception.** A service with no vaulted Microsoft token throws
`ApiError { code: 'NotConnected' }`. Every macro catches that and returns
`{ success: false, connected: false, status: 'DISCONNECTED', instructions }`, so the
assistant can tell the user to connect instead of failing the chat turn. A missing
service registration returns the same shape. No macro is allowed to throw.

**Persona.** `ai/persona/AzureWorkspaceAssistant/agent.yaml` (id
`AzureWorkspaceAssistant`, name "Azure Workspace Assistant", namespace `azure`) lists
exactly the **nine AZ-13 macros** in both `tools.includes` and `macros.includes`:
`azure_connection_status`, `azure_send_email`, `azure_search_email`, `azure_create_event`,
`azure_list_events`, `azure_search_drive`, `azure_read_workbook`, `azure_list_contacts`,
`azure_create_task`.

**`azure_send_teams_message` is registered but not offered to the assistant.** The Teams macro
is in `AZURE_MACROS` (`ai/macros/index.ts` spreads `TEAMS_MACROS`, so the array holds ten), but
it is **absent from the persona's `tools.includes` and `macros.includes`** — so the assistant
cannot send Teams messages today, even though the capability is registered and reachable through
GraphQL and the service. This is not a defect in `agent.yaml` being papered over: AZ-13's
acceptance criterion requires only that the persona's tool list is a *subset* of the registered
macros, which nine satisfies, and `__tests__/macros.test.ts` asserts that subset. Whether the
persona **should** offer the Teams tool is an AZ-14/owner decision; the persona file is not
changed here (documentation-only ticket).

**Test rule.** `__tests__/macros.test.ts` asserts each of the nine AZ-13 names is *present* in
`AZURE_MACROS` (a subset assertion) and never asserts a whole-array length: AZ-14 added its
teams macro to the same array independently, so a length is only correct on one merge order.
A ten-entry count is a statement about `AZURE_MACROS`, not about what the persona is offered —
those are two different numbers (ten registered, nine offered). The plan's definition of done is
the only place the ten-entry registry count belongs.

## Tests

Run the host's worktree harness against this checkout. This repository has **no jest config of
its own** — the host server supplies the configuration, the transformer and Jest. The
`--module-root` flag is what makes the run exercise *this* tree rather than
`src/modules/reactory-azure`:

```bash
node /Users/wernerw/Projects/reactory/reactory-express-server/src/modules/reactory-reactor/scripts/ai/run-worktree-tests.js \
  --module-root <worktree> __tests__/contract-shape.test.ts
```

Use `__tests__` instead of a single path for the whole suite (33 files, 1284 tests). Exit `0` means every
suite loaded and every test passed. Do **not** add a jest config and do **not** run a bare
`npx jest`.

**Known pre-existing failure — one test, not caused by AZ-18.** `__tests__/contract-shape.test.ts:173`
still asserts `expect(forms).toEqual([])`, the AZ-01-era state of the barrel. AZ-17 delivered nine
forms, so the assertion is false about the module and the suite exits `1` with
`1283 passed, 1 failed` of 1284. Everything else passes, including the same file's assertion that
`AGENT.md` documents every exported FQN. The fix is `expect(forms).toHaveLength(9)` plus renaming
the test; it is tracked as **REACTORY-302016408/20261108/4179753370** and was deliberately left
outside AZ-18's documentation-only scope. Do not treat this failure as a regression.

Coverage over the same harness (the server's global thresholds do not apply to a single-module
run, so pass an empty threshold set):

```bash
node …/run-worktree-tests.js --module-root <worktree> __tests__ \
  --coverage --coverageReporters=text --coverageThreshold='{}'
```

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
| `__tests__/macros.test.ts` (107) | the nine AZ-13 macros are present in `AZURE_MACROS` (subset assertions, no array length), no other macro file declares the Teams macro, every parameter has a description and its required flag lands in `schema.required`, each macro resolves its service from a fake context and imports no service singleton, a `NotConnected` rejection becomes a `connected: false` payload instead of a throw, and `AzureWorkspaceAssistant/agent.yaml` parses with a tool list that is a subset of the registered macro names |
| `__tests__/drive.request-shape.test.ts` (40) | segment/query encoding (`a b#c?.txt`, search quoting), item/parent/drive paths, write bodies, simple upload at 4 MiB, resumable fragments at 320 KiB multiples with no bearer token, 416 resume, thumbnail path, and the **production `fetch` transport** (`redirect: 'manual'`, header normalisation, typed no-fetch failure) |
| `__tests__/forms.test.ts` (20) | the nine forms and their names; ids unique, `azure`-namespaced and normalised; `schema.type === 'object'` with a non-empty `properties`; `required` ⊆ declared properties; every `uiSchema` key ⊆ declared properties; per-form document counts; every GraphQL document validated with `graphql-js` against `graphql/types/*.graphql` with `name` == the root field in the matching operation; every `graphql.queries` entry is named by some widget's `ui:options.query`, and every `ui:options.query` names an existing entry (both directions, so neither a dead entry nor a dangling reference can pass); every `variables` source rooted at formData/formContext/query and naming a declared property; every declared variable produced by the map and nothing else; no whole-`formData` forwarding in either orientation; every map executed with **both** object-mapper builds (5.x and 6.x) and the variables validated against the GraphQL types; **every declared source -> target pair present and non-null under both builds**; **every read payload tied to a declared property or a documented list-payload exception**; every `resultMap` key (dotted paths included) on the return type with every target a declared property; a resultMap run over a full sample; the workbook matrix characterisation; every label an `azure.forms.*` key that resolves (grid column titles included); enum members fully labelled; no orphaned i18n key |

All tests mock the Graph layer: **no live Graph call is made** in this repository. The drive
suites replace the byte transport via `setDriveHttpClient` and mock the SDK, so the redirect and
fragment assertions run without a tenant or a network.

## File ownership

| Owned by AZ-01, frozen afterwards | Filled in by |
|---|---|
| `index.ts`, `services/index.ts`, `graphql/types/index.ts`, `graphql/resolvers/index.ts`, `routes/index.ts`, `middleware/index.ts`, `ai/macros/index.ts`, `types/index.ts` | nobody — a later ticket that needs a change here must stop and raise |
| `ai/macros/<domain>.macros.ts` | AZ-13 (status/mail/calendar/drive/workbook/contacts/tasks), AZ-14 (teams) |
| `models/index.ts` | AZ-12 appends two models (the only permitted edit) |
| `forms/index.ts` | AZ-17 — the barrel AZ-01 created is filled with nine forms; no root `index.ts` edit |
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
