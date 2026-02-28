# reactory-azure -- Server Module Agent Context

## What Is This Module

An integration module that wraps Microsoft Graph API operations (user profile, email, calendar, tasks) and provides scaffolding for Azure Blob Storage. Serves as a reference implementation for connecting Azure/Microsoft services into the Reactory ecosystem.

- **Module ID**: `reactory-azure`
- **Namespace**: `core`
- **FQN**: `core.ReactoryAzure@1.0.0`
- **Version**: `1.0.0`
- **Priority**: `0`
- **License**: MIT
- **Package**: `@reactory/azure` v1.1.0
- **Dependencies**: `core.ReactoryServer@1.0.0`

## Directory Structure

```
reactory-azure/
  index.ts              # ReactoryModuleDefinition entry point
  services/
    graph.ts            # Microsoft Graph API wrapper
    index.ts            # Service exports (currently empty array)
  storage/
    AzureBlobStorage.ts # Azure Blob/File Share storage (scaffolded, WIP)
  workflows/
    index.ts            # Workflow definitions
```

## Microsoft Graph API Operations

| Operation | Endpoint | Description |
|---|---|---|
| `getProfileImage()` | `/me/photo/$value` | Fetch user profile photo |
| `getUserDetails()` | `/me` | Get authenticated user info |
| `getEvents()` | `/me/events` | Calendar events |
| `getEmails()` | `/me/messages` | Email messages with search |
| `getTasks()` | `/me/outlook/tasks` | Outlook tasks (beta API) |
| `getTask()` | `/me/outlook/tasks/{id}` | Single task by ID |
| `createTask()` | `/me/outlook/tasks` | Create new task |
| `deleteTask()` | `/me/outlook/tasks/{id}` | Delete task |
| `sendEmail()` | `/me/sendMail` | Send email via Graph |

## Azure Storage (Scaffolded)

The `AzureBlobStorage` class provides scaffolding for Azure Blob and File Share storage but is largely commented out / work-in-progress.

## Dependencies (package.json)

- `@azure/storage-blob` -- Azure Blob Storage SDK
- `@azure/storage-file-share` -- Azure File Share SDK
- `@azure/msal-browser` -- Microsoft Authentication Library

## Notes

- This is an example/reference module showing how to integrate external cloud services
- The Graph API calls use the user's OAuth token for authenticated requests
- Service exports are currently an empty array -- Graph operations are used internally
