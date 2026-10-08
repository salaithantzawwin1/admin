# AMS — Administration Management System
# Development Guide

> **Version:** 1.2  
> **Status:** Development Standard  
> **Last Updated:** 2026-10-08 (housekeeping: header version aligned, OS/Decimal notes match the live codebase)

---

## 1. Overview

AMS (Administration Management System) is a web-based administration platform designed to manage organizational assets, expenses, purchases, vendors, maintenance, petty cash, invoices, and related administrative records.

The system should treat **Accounting Transactions** and **Assets** as related but separate concepts.

For example:

- A Copier is an **Asset**.
- Color Toner is normally a **Consumable / Expense**.
- The purchase of Color Toner is an **Accounting Transaction**.
- The transaction may reference the specific Copier that consumed the toner.
- This allows the system to show both financial reports and asset-level cost history.

### Core principle

```text
Accounting asks:
    "What was the money spent on?"

Asset Management asks:
    "Which asset was this transaction related to?"
```

A transaction may therefore contain:

```text
account_id  -> What type of financial transaction is this?
asset_id    -> Which asset is it related to? (optional)
```

---

# 2. Technology Stack

| Layer | Technology |
|---|---|
| Operating System | Ubuntu Server 22.04 LTS (current VM: 22.04.5) |
| Containerization | Docker + Docker Compose |
| Reverse Proxy | Nginx |
| Frontend | React + Vite |
| UI | Tailwind CSS |
| Backend | NestJS / REST API |
| Database | PostgreSQL |
| ORM | Prisma |
| Source Control | Git + GitHub / Git repository |
| CI/CD | GitHub Actions |
| Deployment | Docker image / release artifact |

---

# 3. High-Level Architecture

```text
                         Internet
                            |
                            v
                    +---------------+
                    |     Nginx     |
                    | Reverse Proxy |
                    +-------+-------+
                            |
              +-------------+-------------+
              |                           |
              v                           v
       +-------------+              +-------------+
       | React/Vite  |              |  NestJS API |
       | Frontend    |              | Backend     |
       +-------------+              +------+------+
                                          |
                                          v
                                  +---------------+
                                  |  PostgreSQL   |
                                  |   Database    |
                                  +---------------+
                                          |
                                          v
                                  +---------------+
                                  | Prisma ORM    |
                                  +---------------+
```

Production should run services through Docker Compose.

Recommended logical services:

```text
nginx
frontend
backend
postgres
```

---

# 4. Architecture Principles

## 4.1 Separation of Responsibilities

### Frontend

Responsible for:

- UI
- Form validation for user experience
- Routing
- Authentication state
- API calls
- Tables
- Filters
- Dashboards
- User interactions

The frontend must not directly access PostgreSQL.

### Backend

Responsible for:

- Business logic
- Authentication
- Authorization
- Validation
- Database access
- Transaction processing
- Audit logging
- API responses

### Database

Responsible for:

- Persistent data
- Relationships
- Constraints
- Unique rules
- Indexes
- Referential integrity

### Nginx

Responsible for:

- HTTPS termination
- Reverse proxy
- Static frontend delivery if applicable
- API routing
- Security headers
- Request limits where appropriate

---

# 5. Repository Structure

Recommended monorepo:

```text
ams/
├── apps/
│   ├── frontend/
│   │   ├── src/
│   │   │   ├── components/
│   │   │   ├── layouts/
│   │   │   ├── pages/
│   │   │   ├── features/
│   │   │   ├── hooks/
│   │   │   ├── services/
│   │   │   ├── types/
│   │   │   ├── utils/
│   │   │   └── main.tsx
│   │   ├── public/
│   │   ├── package.json
│   │   └── vite.config.ts
│   │
│   └── backend/
│       ├── src/
│       │   ├── auth/
│       │   ├── users/
│       │   ├── assets/
│       │   ├── vendors/
│       │   ├── accounting/
│       │   ├── invoices/
│       │   ├── petty-cash/
│       │   ├── maintenance/
│       │   ├── attachments/
│       │   ├── audit/
│       │   ├── common/
│       │   ├── app.module.ts
│       │   └── main.ts
│       ├── prisma/
│       │   ├── schema.prisma
│       │   └── migrations/
│       └── package.json
│
├── infra/
│   ├── nginx/
│   │   ├── nginx.conf
│   │   └── conf.d/
│   └── docker/
│
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── deploy.yml
│
├── docker-compose.yml
├── docker-compose.prod.yml
├── .env.example
├── .gitignore
├── README.md
└── DEVELOPMENT_GUIDE.md
```

The exact folder structure may evolve, but responsibilities should remain separated.

---

# 6. Development Environments

Use at least three environments:

```text
Development
     |
     v
Staging
     |
     v
Production
```

## Development

Used by developers.

Typical setup:

```text
React/Vite      localhost:5173
NestJS          localhost:3000
PostgreSQL      localhost:5432
```

## Staging

Used for integration and acceptance testing.

Should be as close as practical to production.

## Production

Runs on Ubuntu Server 24.04 LTS.

All production services should be deployed through controlled release processes.

---

# 7. Environment Variables

Never commit secrets to Git.

Use:

```text
.env
.env.local
.env.production
```

where appropriate, and keep actual secret values outside the repository.

Provide:

```text
.env.example
```

Example:

```env
NODE_ENV=development

PORT=3000

DATABASE_URL=postgresql://ams:password@postgres:5432/ams

JWT_SECRET=change-me

CORS_ORIGIN=http://localhost:5173
```

Production secrets should be managed securely through the deployment environment / CI/CD secret store.

Never hard-code:

- Database passwords
- JWT secrets
- API keys
- SMTP passwords
- Cloud credentials
- Encryption keys

---

# 8. Git Workflow

Recommended branch structure:

```text
main
  |
  +-- develop
        |
        +-- feature/*
        +-- fix/*
        +-- refactor/*
```

For smaller teams, a simplified workflow may be:

```text
main
  |
  +-- feature/*
  +-- fix/*
```

## Branch Naming

Examples:

```text
feature/asset-management
feature/petty-cash
feature/invoice-module
fix/asset-history-filter
fix/login-validation
refactor/accounting-service
```

## Commit Messages

Use clear commit messages:

```text
feat: add asset registration
feat: add petty cash transaction
fix: prevent duplicate asset codes
refactor: simplify invoice service
docs: update deployment guide
test: add invoice service tests
chore: update dependencies
```

Avoid:

```text
update
changes
fix stuff
final
final2
latest
```

---

# 9. Backend — NestJS

NestJS should be organized by business domain.

Example:

```text
src/
├── auth/
├── users/
├── assets/
├── asset-categories/
├── locations/
├── vendors/
├── accounting/
├── chart-of-accounts/
├── invoices/
├── petty-cash/
├── maintenance/
├── attachments/
├── audit/
└── common/
```

Each module should normally contain:

```text
module
controller
service
dto
```

Example:

```text
assets/
├── assets.module.ts
├── assets.controller.ts
├── assets.service.ts
├── dto/
│   ├── create-asset.dto.ts
│   └── update-asset.dto.ts
└── entities/
```

Prisma should be used by services or a dedicated database layer rather than directly from controllers.

---

# 10. REST API Standards

Base URL:

```text
/api
```

Example endpoints:

```text
GET    /api/assets
GET    /api/assets/:id
POST   /api/assets
PATCH  /api/assets/:id
DELETE /api/assets/:id
```

Invoices:

```text
GET    /api/invoices
GET    /api/invoices/:id
POST   /api/invoices
PATCH  /api/invoices/:id
```

Petty Cash:

```text
GET    /api/petty-cash
POST   /api/petty-cash
GET    /api/petty-cash/:id
```

Asset history:

```text
GET /api/assets/:id/transactions
GET /api/assets/:id/maintenance
```

---

# 11. API Response Standards

Use predictable response formats.

Example:

```json
{
  "data": {
    "id": 101,
    "assetCode": "AST-COP-001",
    "name": "Canon Copier"
  }
}
```

List response:

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 125
  }
}
```

Error response:

```json
{
  "statusCode": 400,
  "message": "Asset code already exists",
  "error": "Bad Request"
}
```

Do not expose database errors directly to users.

---

# 12. Validation

All incoming API data must be validated.

NestJS should use DTOs and validation.

Example rules:

```text
assetCode
    required
    unique

name
    required
    max length

purchaseCost
    >= 0

purchaseDate
    valid date
```

Validation must exist on the backend even if frontend validation exists.

Frontend validation improves UX.

Backend validation protects the system.

---

# 13. Database Design

PostgreSQL is the primary database.

Prisma is used as the ORM.

The database should enforce important business constraints where practical.

---

# 14. Core Business Entities

Recommended initial entities:

```text
User
Role
Permission

Asset
AssetCategory
Location

Vendor

Account
AccountCategory

Invoice
InvoiceItem

PettyCashTransaction
PettyCashItem

MaintenanceRecord

Attachment

AuditLog
```

Optional later:

```text
Department
Employee
PurchaseRequest
PurchaseOrder
Approval
Budget
Payment
StockItem
Consumable
AssetAssignment
AssetTransfer
Depreciation
```

---

# 15. Asset Model

An Asset represents a physical or controlled organizational resource.

Examples:

```text
Copier
Aircon
Laptop
Desktop PC
Printer
Projector
UPS
Vehicle
```

Recommended fields:

```text
id
assetCode
name
categoryId
brand
model
serialNumber
locationId
purchaseDate
purchaseCost
status
description
createdAt
updatedAt
```

Example:

```text
AST-COP-001
Canon Copier
Canon
IR-ADV...
SN123456
Finance Room
12,500,000 MMK
Active
```

---

# 16. Asset Categories

Examples:

```text
Office Equipment
IT Equipment
Furniture
Vehicle
Electrical Equipment
Air Conditioning
Printer / Copier
Other
```

The category should be stored as a foreign key rather than repeatedly storing plain text.

---

# 17. Accounting Concept

The system should distinguish:

```text
Asset
Expense
Consumable
Liability
Income
```

For the AMS use case, common accounts may include:

```text
Office Supplies
Copier Consumables
Repair & Maintenance
Aircon Maintenance
IT Maintenance
Office Equipment
Furniture
Utilities
Travel
Telephone & Internet
Petty Cash
Bank
Accounts Payable
```

The exact Chart of Accounts should be configurable.

---

# 18. Important Accounting Rule

A purchase does not automatically mean a new Asset.

Example:

### Copier purchase

```text
Canon Copier
12,500,000 MMK
```

This may be recorded as:

```text
Fixed Asset
    Office Equipment
        Copier
```

and linked to:

```text
AST-COP-001
```

### Toner purchase

```text
Color Toner
150,000 MMK
```

Normally:

```text
Expense
    Copier Consumables
```

and optionally linked to:

```text
AST-COP-001
```

### Repair

```text
Copier repair
500,000 MMK
```

Normally:

```text
Expense
    Repair & Maintenance
```

and linked to:

```text
AST-COP-001
```

Accounting treatment can vary according to the organization's accounting policy, so the system should allow configurable account classification rather than hard-coding assumptions.

---

# 19. Transaction + Asset Relationship

This is one of the most important AMS design rules.

A financial transaction should be able to reference an Asset.

Conceptually:

```text
Transaction
├── accountId
├── vendorId
├── amount
├── transactionDate
└── assetId (nullable)
```

`assetId` should generally be optional.

Example:

```text
A4 Paper
50,000 MMK
assetId = NULL
```

because paper is not necessarily associated with one specific asset.

But:

```text
Canon Toner
150,000 MMK
assetId = AST-COP-001
```

means the expense is associated with that Copier.

---

# 20. Invoice Design

Do not put only one Asset ID on an Invoice header.

Use the Asset relationship at **Invoice Item** level.

Example:

```text
Invoice
└── Invoice Items
      ├── Toner
      │     └── assetId = AST-COP-001
      │
      ├── A4 Paper
      │     └── assetId = NULL
      │
      └── Aircon Service
            └── assetId = AST-AC-001
```

This allows one invoice to contain multiple items related to different assets.

Recommended:

```text
Invoice
    id
    invoiceNumber
    vendorId
    invoiceDate
    status
    subtotal
    tax
    total
    notes
    createdAt
    updatedAt
```

Invoice Item:

```text
InvoiceItem
    id
    invoiceId
    description
    quantity
    unitPrice
    amount
    accountId
    assetId nullable
```

---

# 21. Petty Cash Design

Petty Cash should use the same accounting concept.

Example:

```text
Petty Cash Transaction
--------------------------------
Date: 24-Sep-2026
Description: Color Refill
Amount: 80,000
Account: Copier Consumables
Asset: AST-COP-001
```

The user should be able to select:

```text
Expense Account
    Copier Consumables

Related Asset
    AST-COP-001 - Canon Copier
```

The transaction then contributes to:

```text
Expense Report
```

and:

```text
Asset Cost History
```

---

# 22. Asset History

Each asset should have a history page.

Example:

```text
Canon Copier
AST-COP-001
```

History:

```text
Date          Type              Amount
------------------------------------------------
10-Jan-2026   Purchase          12,500,000
15-Feb-2026   Toner               150,000
20-Mar-2026   Repair               80,000
10-Apr-2026   Toner               150,000
05-Jun-2026   Repair              250,000
24-Sep-2026   Color Refill         80,000
```

This history should be generated from actual transactions, not manually duplicated into the Asset record.

---

# 23. Avoid Duplicate Data

Bad design:

```text
Asset
    tonerCost = 150000
    repairCost = 500000
    totalCost = 650000
```

This creates synchronization problems.

Better:

```text
Asset
    id = 101

Transactions
    assetId = 101
```

Calculate:

```text
SUM(transaction.amount)
WHERE assetId = 101
```

when required, or maintain carefully controlled derived summaries if performance later requires it.

The transaction is the source of truth.

---

# 24. Prisma Schema Concept

Illustrative structure:

```prisma
model Asset {
  id            Int      @id @default(autoincrement())
  assetCode     String   @unique
  name          String
  categoryId    Int?
  brand         String?
  model         String?
  serialNumber  String?
  locationId    Int?
  purchaseDate  DateTime?
  purchaseCost  Decimal? @db.Decimal(18, 2)
  status        AssetStatus @default(ACTIVE)

  category      AssetCategory? @relation(fields: [categoryId], references: [id])
  location      Location?      @relation(fields: [locationId], references: [id])

  invoiceItems  InvoiceItem[]
  transactions  Transaction[]
  maintenance   MaintenanceRecord[]

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}

model Invoice {
  id            Int           @id @default(autoincrement())
  invoiceNumber String
  vendorId      Int
  invoiceDate   DateTime
  status        InvoiceStatus @default(DRAFT)

  items         InvoiceItem[]

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}

model InvoiceItem {
  id          Int      @id @default(autoincrement())
  invoiceId   Int
  description String
  quantity    Decimal  @db.Decimal(18, 2)
  unitPrice   Decimal  @db.Decimal(18, 2)
  amount      Decimal  @db.Decimal(18, 2)

  accountId   Int
  assetId     Int?

  invoice     Invoice @relation(fields: [invoiceId], references: [id])
  asset       Asset?  @relation(fields: [assetId], references: [id])
}

model Transaction {
  id              Int      @id @default(autoincrement())
  transactionDate DateTime
  description     String
  amount          Decimal  @db.Decimal(18, 2)

  accountId       Int
  assetId         Int?

  asset           Asset?   @relation(fields: [assetId], references: [id])
}
```

This is an architectural example. The final schema should be adapted to the organization's accounting requirements.

---

# 25. Money / Decimal Handling

Do not use JavaScript floating-point numbers as the source of truth for money.

Prefer:

```text
PostgreSQL NUMERIC / DECIMAL
```

and Prisma:

```prisma
Decimal @db.Decimal(18, 2)
```

Currency should be explicit.

Recommended:

```text
currencyCode
```

Example:

```text
MMK
USD
THB
```

If the system will support multiple currencies, do not assume all transactions are MMK.

> **Convention note (2026-10-08):** The live codebase standardizes on `Decimal(12, 2)`
> (sufficient for MMK amounts up to ~9.9 billion). Use `Decimal(12, 2)` in AMS entities;
> the `18, 2` width above remains only as a generic illustration.

---

# 26. Dates and Time

Use UTC for backend timestamps where practical.

Example:

```text
createdAt
updatedAt
```

For business dates such as:

```text
invoiceDate
purchaseDate
transactionDate
```

carefully distinguish a date-only business value from a timestamp.

The frontend should display dates according to the organization's configured timezone.

---

# 27. Authentication

Recommended architecture:

```text
Login
  |
  v
Authentication
  |
  v
Access Token
  |
  v
Authorization
  |
  +---- Role
  |
  +---- Permission
```

Potential roles:

```text
ADMIN
FINANCE
ADMINISTRATION
MANAGER
VIEWER
```

Do not rely only on frontend route protection.

Every protected backend endpoint must verify authorization.

---

# 28. Role-Based Access Control

Example:

| Permission | Admin | Finance | Admin Staff | Viewer |
|---|---:|---:|---:|---:|
| View Assets | Yes | Yes | Yes | Yes |
| Create Asset | Yes | Yes | Yes | No |
| Edit Asset | Yes | Yes | Yes | No |
| Delete Asset | Yes | No | No | No |
| View Invoice | Yes | Yes | Yes | Yes |
| Create Invoice | Yes | Yes | Yes | No |
| Petty Cash | Yes | Yes | Yes | No |
| View Reports | Yes | Yes | Yes | Yes |
| Manage Users | Yes | No | No | No |

Actual permissions should be configurable.

---

# 29. Audit Log

Administrative and accounting systems should maintain audit records.

Examples:

```text
User created asset
User updated asset
User deleted asset
Invoice created
Invoice approved
Petty cash submitted
Petty cash approved
Transaction edited
Transaction voided
User role changed
```

Audit log example:

```text
AuditLog
-----------------------------------------
User: admin
Action: UPDATE
Entity: Asset
Entity ID: 101
Before: ...
After: ...
Timestamp: ...
IP: ...
```

Avoid silently deleting important financial records.

Prefer status changes such as:

```text
VOID
CANCELLED
REVERSED
```

where appropriate.

---

# 30. Accounting Transaction Status

Do not immediately treat every draft as final.

Recommended lifecycle:

```text
DRAFT
  |
  v
SUBMITTED
  |
  v
APPROVED
  |
  v
POSTED
```

Possible cancellation:

```text
DRAFT -> CANCELLED
SUBMITTED -> REJECTED
POSTED -> REVERSED
```

This is especially useful for invoices and petty cash.

---

# 31. Frontend Architecture

React + Vite.

Recommended structure:

```text
src/
├── components/
├── layouts/
├── pages/
├── features/
│   ├── assets/
│   ├── invoices/
│   ├── petty-cash/
│   ├── maintenance/
│   └── reports/
├── services/
│   └── api/
├── hooks/
├── types/
├── utils/
├── routes/
└── main.tsx
```

Prefer feature-based organization for large modules.

---

# 32. Frontend API Layer

Do not scatter raw `fetch()` calls throughout components.

Instead:

```text
services/
└── api/
    ├── client.ts
    ├── assets.ts
    ├── invoices.ts
    ├── pettyCash.ts
    └── maintenance.ts
```

Example conceptual usage:

```ts
assetService.getAssets()
assetService.getAsset(id)
assetService.createAsset(data)
```

This keeps UI components focused on presentation and interaction.

---

# 33. UI Design Principles

Use Tailwind CSS consistently.

The UI should prioritize:

- Clear navigation
- Consistent forms
- Consistent buttons
- Consistent tables
- Search
- Filters
- Pagination
- Loading states
- Empty states
- Error states
- Confirmation dialogs
- Responsive layout

Avoid making every page visually different.

Create reusable components:

```text
Button
Input
Select
DatePicker
Modal
Table
Pagination
Badge
Card
Form
Alert
ConfirmDialog
```

---

# 34. Asset UI

Asset list:

```text
Search
Category Filter
Location Filter
Status Filter
Vendor Filter
```

Columns:

```text
Asset Code
Asset Name
Category
Brand
Location
Status
Purchase Date
Purchase Cost
Actions
```

Asset detail:

```text
Overview
Financial Summary
Transaction History
Maintenance
Documents
Audit History
```

---

# 35. Invoice UI

Invoice form:

```text
Vendor
Invoice Number
Invoice Date

Items
------------------------------------------
Description
Quantity
Unit Price
Account
Related Asset
Amount
------------------------------------------

Subtotal
Tax
Total

Attachments

Save Draft
Submit
```

When selecting an item:

```text
Account:
[ Copier Consumables ]

Related Asset:
[ AST-COP-001 - Canon Copier ]
```

---

# 36. Petty Cash UI

```text
Date
Description
Amount
Expense Account
Related Asset
Vendor
Receipt
Notes
```

Example:

```text
Expense Account:
[ Copier Consumables ]

Related Asset:
[ AST-COP-001 - Canon Copier ]
```

---

# 37. File Attachments

Invoices and petty cash transactions may have supporting documents.

Examples:

```text
Invoice PDF
Receipt image
Quotation
Maintenance report
Warranty document
Asset photo
```

Recommended approach:

```text
Database
    stores metadata

File Storage
    stores actual file
```

Do not store large files directly in normal relational table fields unless there is a specific reason.

Attachment metadata:

```text
id
fileName
mimeType
size
storageKey
entityType
entityId
uploadedBy
createdAt
```

---

# 38. Maintenance Module

Maintenance should be linked to Assets.

Example:

```text
Maintenance Record
--------------------------------
Asset:
AST-COP-001

Date:
24-Sep-2026

Type:
Repair

Description:
Replace color drum

Vendor:
ABC Service

Cost:
500,000 MMK

Status:
Completed
```

A maintenance record may also create or reference a financial transaction.

Avoid duplicating the same amount manually in multiple unrelated places.

---

# 39. Asset Lifecycle

Recommended lifecycle:

```text
REGISTERED
    |
    v
ACTIVE
    |
    +----> UNDER_MAINTENANCE
    |
    +----> TRANSFERRED
    |
    +----> LOST
    |
    +----> DISPOSED
```

Additional states can be introduced based on business requirements.

---

# 40. Asset Transfer

When an asset moves:

```text
Copier
Finance Room
     |
     v
Administration Room
```

Do not simply overwrite the location if historical tracking is required.

Create an Asset Transfer record:

```text
AssetTransfer
    assetId
    fromLocationId
    toLocationId
    transferDate
    reason
    approvedBy
```

This allows historical location reporting.

---

# 41. Reporting

Initial reports should include:

## Asset Register

```text
Asset Code
Name
Category
Location
Status
Purchase Date
Purchase Cost
```

## Asset Cost History

```text
Asset
Purchase Cost
Maintenance Cost
Repair Cost
Consumable Cost
Total Related Cost
```

## Expense Report

```text
Date
Account
Vendor
Amount
Related Asset
```

## Petty Cash Report

```text
Date
Description
Account
Amount
Status
```

## Vendor Report

```text
Vendor
Invoice Count
Total Purchases
Outstanding Amount
```

---

# 42. Dashboard

Initial dashboard:

```text
Total Assets
Active Assets
Assets Under Maintenance
Monthly Expenses
Pending Invoices
Pending Petty Cash
Outstanding Payments
```

Avoid adding many charts before the underlying data model is stable.

Correct data is more important than visual complexity.

---

# 43. Pagination

Large tables must use pagination.

API:

```text
GET /api/assets?page=1&limit=20
```

Support:

```text
page
limit
search
sort
order
filters
```

Example:

```text
GET /api/assets
    ?page=1
    &limit=20
    &search=canon
    &status=ACTIVE
    &categoryId=3
```

---

# 44. Search and Filtering

Search should be server-side for large datasets.

Recommended asset search:

```text
assetCode
name
brand
model
serialNumber
```

Invoice search:

```text
invoiceNumber
vendor
description
```

---

# 45. Database Indexing

Index fields frequently used for:

```text
search
filter
join
unique lookup
```

Examples:

```text
Asset.assetCode
Asset.serialNumber
Asset.categoryId
Asset.locationId

Invoice.invoiceNumber
Invoice.vendorId
Invoice.invoiceDate

Transaction.accountId
Transaction.assetId
Transaction.transactionDate
```

Do not blindly index every field.

---

# 46. Database Migration

Prisma migrations should be committed to Git.

Typical workflow:

```bash
npx prisma migrate dev --name add_asset_transaction
```

Production:

```bash
npx prisma migrate deploy
```

Never manually change production schema without recording the corresponding migration strategy.

---

# 47. Seed Data

Provide development seed data.

Example:

```text
Roles
Users
Asset Categories
Locations
Chart of Accounts
Sample Vendors
Sample Assets
```

Example command:

```bash
npx prisma db seed
```

Do not use production credentials in seed files.

---

# 48. Docker

Each deployable service should have a Dockerfile.

Example conceptual services:

```text
frontend
backend
postgres
nginx
```

Development:

```bash
docker compose up -d
```

View logs:

```bash
docker compose logs -f
```

Stop:

```bash
docker compose down
```

Production should use a dedicated production Compose configuration where appropriate.

---

# 49. Docker Networking

Services communicate using Docker service names.

Example:

```text
backend -> postgres:5432
nginx   -> backend:3000
```

Do not hard-code container IP addresses.

Use service names:

```text
postgres
backend
frontend
```

---

# 50. PostgreSQL Backup

Production database backups are mandatory.

At minimum:

```text
Daily backup
Retention policy
Off-server backup
Periodic restore test
```

Example conceptual backup:

```bash
pg_dump ...
```

Do not consider a backup successful until restoration has been tested.

---

# 51. Nginx

Recommended production routing:

```text
https://ams.example.com/
        |
        v
      Nginx
        |
        +---- /       -> Frontend
        |
        +---- /api/   -> Backend
```

Nginx should handle:

- HTTPS
- Reverse proxy
- Security headers
- Request size limits
- Static assets where appropriate

---

# 52. HTTPS

Production must use HTTPS.

Do not expose authentication credentials or session tokens over plain HTTP.

Recommended:

```text
Internet
   |
 HTTPS
   |
 Nginx
```

---

# 53. CI/CD

GitHub Actions pipeline:

```text
Developer
    |
    v
Git Push / Pull Request
    |
    v
GitHub Actions
    |
    +---- Install
    |
    +---- Lint
    |
    +---- Unit Test
    |
    +---- Build
    |
    +---- Docker Build
    |
    +---- Security / Dependency Checks
    |
    v
Push Image / Release Artifact
    |
    v
Deploy
    |
    v
Production
```

---

# 54. CI Pipeline

Recommended checks:

```text
Install dependencies
Lint
Type check
Unit tests
Build frontend
Build backend
Build Docker images
```

Pull requests should pass CI before merging.

---

# 55. Release Versioning

Use semantic versioning where practical:

```text
MAJOR.MINOR.PATCH
```

Example:

```text
v1.0.0
v1.2.0
v1.2.1
v2.0.0
```

Possible interpretation:

```text
MAJOR = breaking changes
MINOR = new backward-compatible features
PATCH = bug fixes
```

---

# 56. Deployment Strategy

Recommended release flow:

```text
Developer
    |
    v
Pull Request
    |
    v
CI
    |
    v
Merge
    |
    v
Build Release
    |
    v
Push Docker Image
    |
    v
Deploy
    |
    v
Health Check
```

Never deploy untested local changes directly to production.

---

# 57. Docker Image Tagging

Avoid using only:

```text
latest
```

Prefer immutable release tags:

```text
ams-backend:v1.4.0
ams-frontend:v1.4.0
```

Optionally also maintain:

```text
ams-backend:latest
```

but production deployment should preferably reference a known release version or immutable image digest.

---

# 58. Deployment Rollback

Every release should have a rollback path.

Example:

```text
v1.4.0
   |
   v
Production
   |
problem
   |
   v
rollback
   |
   v
v1.3.2
```

Database migrations must be designed carefully because application rollback does not automatically mean database rollback is safe.

Prefer backward-compatible migration strategies when possible.

---

# 59. Health Checks

Backend should expose:

```text
GET /api/health
```

Example response:

```json
{
  "status": "ok",
  "database": "ok"
}
```

Docker / deployment infrastructure can use this to detect unhealthy services.

---

# 60. Logging

Backend logs should contain useful operational information.

Example:

```text
INFO  Request completed
INFO  Invoice created
WARN  Failed login attempt
ERROR Database connection failed
```

Do not log:

```text
Passwords
JWT secrets
API keys
Credit card data
Sensitive personal information
```

---

# 61. Error Handling

Backend should use centralized exception handling.

Frontend should show user-friendly messages.

Bad:

```text
PrismaClientKnownRequestError...
```

Good:

```text
Unable to save the invoice.
Please check the required fields and try again.
```

Technical details should remain in server logs.

---

# 62. Testing Strategy

At minimum:

```text
Unit Tests
Integration Tests
API Tests
Frontend Component Tests
End-to-End Tests
```

Priority areas:

```text
Authentication
Authorization
Asset creation
Invoice creation
Petty cash
Accounting transactions
Asset linking
Approval workflow
Reports
```

---

# 63. Critical Business Test Case

The following scenario should always be tested.

### Scenario

User purchases Color Toner for Copier AST-COP-001.

Input:

```text
Description:
Color Toner

Amount:
150,000 MMK

Account:
Copier Consumables

Asset:
AST-COP-001
```

Expected:

```text
1. Financial transaction is created.
2. Expense account = Copier Consumables.
3. Asset reference = AST-COP-001.
4. Asset history displays the transaction.
5. Expense report includes 150,000 MMK.
6. No duplicate transaction is created.
7. Audit log records the operation.
```

---

# 64. Important Transaction Integrity Rule

When creating related records, use a database transaction.

Conceptually:

```text
BEGIN

Create Invoice
Create Invoice Items
Create Accounting Transaction
Create Asset Link
Create Audit Log

COMMIT
```

If something fails:

```text
ROLLBACK
```

Do not leave the system in a partially saved state.

Prisma transaction APIs should be used for multi-step operations.

---

# 65. Data Integrity Rules

Examples:

```text
Asset Code must be unique.

Invoice Number should be unique according to the organization's numbering policy.

Invoice Item must belong to an existing Invoice.

Asset reference must point to an existing Asset.

Account reference must point to an existing Account.

Deleted records should not break historical transactions.
```

For financial records, prefer:

```text
VOID
CANCELLED
REVERSED
```

over physical deletion where appropriate.

---

# 66. Soft Delete

Use soft delete selectively.

Example:

```text
deletedAt
```

Good candidates:

```text
Users
Vendors
Asset Categories
Locations
```

Be careful with financial transactions.

Historical financial records generally should not simply disappear.

---

# 67. Security Checklist

Before production:

```text
[ ] HTTPS enabled
[ ] Strong passwords
[ ] Password hashing
[ ] JWT/session security implemented
[ ] Role-based authorization
[ ] DTO validation
[ ] SQL injection protection
[ ] XSS protection
[ ] CSRF strategy where applicable
[ ] CORS configured
[ ] Rate limiting for sensitive endpoints
[ ] Secrets removed from Git
[ ] Dependency vulnerabilities checked
[ ] Database access restricted
[ ] Production database not publicly exposed
[ ] Backups configured
[ ] Audit logging enabled
```

---

# 68. PostgreSQL Security

PostgreSQL should not normally be exposed directly to the public Internet.

Recommended:

```text
Internet
   |
   v
Nginx
   |
   v
Backend
   |
   v
PostgreSQL
```

Not:

```text
Internet
   |
   v
PostgreSQL
```

---

# 69. Dependency Management

Keep dependencies updated.

Before upgrading major dependencies:

```text
Review changelog
Run tests
Build application
Test staging
Deploy
```

Do not update many major dependencies simultaneously without a reason.

---

# 70. Documentation

Repository should contain:

```text
README.md
DEVELOPMENT_GUIDE.md
```

README should explain:

```text
What is AMS?
How to install
How to run
Environment variables
How to run migrations
How to run tests
How to build
How to deploy
```

Development Guide should explain:

```text
Architecture
Coding conventions
Database rules
Business concepts
Git workflow
CI/CD
Deployment
Security
```

---

# 71. Local Development Setup

Prerequisites:

```text
Git
Node.js
npm / pnpm
Docker
Docker Compose
```

Clone:

```bash
git clone <repository-url>
cd ams
```

Create environment:

```bash
cp .env.example .env
```

Start infrastructure:

```bash
docker compose up -d postgres
```

Install dependencies:

```bash
npm install
```

Run Prisma:

```bash
npx prisma generate
npx prisma migrate dev
```

Start backend:

```bash
npm run start:dev
```

Start frontend:

```bash
npm run dev
```

---

# 72. Recommended Developer Workflow

For every feature:

```text
1. Understand requirement
2. Define business rule
3. Design database changes
4. Create Prisma migration
5. Implement backend service
6. Implement API endpoint
7. Add tests
8. Implement frontend UI
9. Test integration
10. Run lint/type checks
11. Create pull request
12. Review
13. Merge
14. Deploy to staging
15. Acceptance test
16. Release
```

Do not start by immediately writing UI code for complex business features.

Define the business rules and data model first.

---

# 73. Feature Development Example

Feature:

```text
Link Copier Expense to Asset
```

### Step 1 — Business Rule

```text
An expense may optionally reference an Asset.
```

### Step 2 — Database

```text
Transaction.assetId nullable
InvoiceItem.assetId nullable
```

### Step 3 — Backend

Create DTO:

```text
assetId?: number
```

Validate that the Asset exists.

### Step 4 — Frontend

Add:

```text
Related Asset
```

select field.

### Step 5 — Save

```text
POST /api/invoices
```

### Step 6 — Asset History

```text
GET /api/assets/:id/transactions
```

### Step 7 — Reports

Include the transaction in:

```text
Expense Report
Asset Cost History
```

---

# 74. Recommended Development Order

Build the system in this order:

## Phase 1 — Foundation

```text
Authentication
Users
Roles
Permissions
Locations
Departments
```

## Phase 2 — Asset Management

```text
Asset Categories
Assets
Asset Documents
Asset Transfer
Asset Status
```

## Phase 3 — Vendors

```text
Vendors
Vendor Contacts
Vendor Documents
```

## Phase 4 — Accounting Foundation

```text
Chart of Accounts
Accounting Categories
Transaction
```

## Phase 5 — Purchasing / Invoice

```text
Invoice
Invoice Items
Vendor
Account
Related Asset
Approval
```

## Phase 6 — Petty Cash

```text
Petty Cash
Receipt
Expense Account
Related Asset
Approval
```

## Phase 7 — Maintenance

```text
Maintenance Request
Maintenance Record
Maintenance Cost
Related Asset
```

## Phase 8 — Reporting

```text
Asset Register
Expense Reports
Petty Cash Reports
Asset Cost History
Vendor Reports
Dashboard
```

## Phase 9 — CI/CD + Production

```text
Docker
Nginx
GitHub Actions
Release
Deployment
Backup
Monitoring
```

---

# 75. MVP Scope

The first production-ready MVP should focus on:

```text
Authentication
Users / Roles
Assets
Asset Categories
Locations
Vendors
Chart of Accounts
Invoices
Invoice Items
Petty Cash
Asset-linked Transactions
Basic Reports
Audit Logs
```

Avoid implementing everything at once.

---

# 76. Future Modules

Possible future modules:

```text
Purchase Request
Purchase Order
Approval Workflow
Budget Management
Inventory
Consumable Stock
Depreciation
Asset Disposal
Asset Warranty
Employee Assignment
Document Management
Notifications
Email
Multi-company
Multi-currency
Advanced Accounting
```

These should be added after the core architecture is stable.

---

# 77. Architecture Decision: Asset vs Consumable

This distinction must remain clear.

### Asset

```text
Copier
Aircon
Laptop
Printer
Projector
```

Usually has:

```text
Asset Code
Serial Number
Location
Custodian
Purchase Date
Status
```

### Consumable

```text
Toner
Paper
Cleaning Supplies
Stationery
```

Usually does not need an Asset Code.

It may still have:

```text
Related Asset
```

when the organization wants to know which asset consumed the expense.

---

# 78. Example End-to-End Scenario

## Step 1 — Register Copier

```text
Asset Code: AST-COP-001
Name: Canon Copier
Purchase Cost: 12,500,000
Location: Finance Room
Status: Active
```

## Step 2 — Buy Toner

```text
Invoice:
INV-2026-00125

Item:
Color Toner

Amount:
150,000

Account:
Copier Consumables

Related Asset:
AST-COP-001
```

## Step 3 — Save

System creates:

```text
Invoice
    |
    +-- Invoice Item
           |
           +-- Account: Copier Consumables
           |
           +-- Asset: AST-COP-001
```

## Step 4 — Asset Page

User opens:

```text
AST-COP-001
```

and sees:

```text
Purchase: 12,500,000
Toner:       150,000
```

## Step 5 — Expense Report

The same 150,000 appears under:

```text
Copier Consumables
```

## Result

One transaction supports both:

```text
Accounting Reporting
+
Asset Cost History
```

without duplicating the transaction.

---

# 79. Definition of Done

A feature is considered complete when:

```text
[ ] Requirement understood
[ ] Business rules documented
[ ] Database design completed
[ ] Migration created
[ ] Backend API implemented
[ ] Backend validation implemented
[ ] Authorization implemented
[ ] Unit/integration tests added
[ ] Frontend implemented
[ ] Loading state implemented
[ ] Error state implemented
[ ] Empty state implemented
[ ] Audit behavior implemented where required
[ ] Documentation updated
[ ] CI passes
[ ] Staging tested
```

---

# 80. Production Checklist

Before production release:

```text
Infrastructure
[ ] Ubuntu server configured
[ ] Docker installed
[ ] Docker Compose configured
[ ] Nginx configured
[ ] HTTPS configured

Application
[ ] Frontend production build tested
[ ] Backend production build tested
[ ] Environment variables configured
[ ] Database migration tested

Security
[ ] Secrets secured
[ ] Database not publicly exposed
[ ] Authorization tested
[ ] HTTPS verified

Database
[ ] Backup configured
[ ] Restore tested
[ ] Migration reviewed

CI/CD
[ ] GitHub Actions passing
[ ] Docker image created
[ ] Release version created
[ ] Deployment tested
[ ] Rollback plan verified

Monitoring
[ ] Health endpoint available
[ ] Application logs available
[ ] Container logs available
[ ] Disk space monitored
```

---

# 81. Recommended Coding Rules

## General

- Prefer readable code over clever code.
- Keep business logic out of controllers.
- Keep database access out of React components.
- Reuse common UI components.
- Validate data at API boundaries.
- Use explicit types.
- Avoid unnecessary global state.
- Keep modules focused.

## Backend

```text
Controller
    -> receives request

DTO
    -> validates input

Service
    -> business logic

Prisma
    -> database access
```

## Frontend

```text
Page
    -> feature composition

Feature
    -> business UI

Service
    -> API communication

Component
    -> reusable UI
```

---

# 82. Common Mistakes to Avoid

## Mistake 1

Putting all logic inside controllers.

Bad:

```text
Controller
    -> validation
    -> business logic
    -> database
    -> email
    -> audit
```

Better:

```text
Controller
    -> DTO
    -> Service
        -> Repository/Prisma
        -> Business Logic
        -> Audit
```

## Mistake 2

Putting Asset ID only on Invoice.

Use:

```text
Invoice Item -> Asset
```

because one invoice can contain multiple asset-related items.

## Mistake 3

Duplicating costs inside Asset.

Do not manually maintain:

```text
Asset.totalRepairCost
Asset.totalTonerCost
```

unless there is a deliberate reporting/cache strategy.

Use transactions as the source of truth.

## Mistake 4

Deleting financial history.

Prefer:

```text
VOID
CANCELLED
REVERSED
```

where appropriate.

## Mistake 5

Trusting frontend validation.

Always validate on the backend.

## Mistake 6

Using `latest` as the only production Docker version.

Use immutable release tags or image digests.

---

# 83. Long-Term Architecture Goal

The target architecture should allow this:

```text
                    AMS
                     |
       +-------------+-------------+
       |             |             |
     Assets       Finance       Admin
       |             |             |
       |             |             |
   Maintenance    Invoice       Vendors
       |          Petty Cash       |
       |          Expenses         |
       +-------------+-------------+
                     |
                     v
                PostgreSQL
```

The system should maintain one consistent source of truth.

A transaction can be connected to:

```text
Vendor
Account
Asset
User
Department
Document
Approval
```

This allows the system to answer questions such as:

```text
How much did we spend this month?

How much did we spend on Copier Consumables?

How much did AST-COP-001 cost us this year?

Which vendor supplied the toner?

Which invoices are pending?

Which assets are under maintenance?

Which expenses were paid through Petty Cash?

Who created or approved the transaction?
```

---

# 84. Final Architecture Summary

```text
                     USERS
                       |
                       v
                    NGINX
                       |
          +------------+------------+
          |                         |
          v                         v
     React + Vite              NestJS REST API
          |                         |
          |                    Business Logic
          |                         |
          |                    Validation
          |                         |
          |                    Authorization
          |                         |
          |                         v
          |                      Prisma
          |                         |
          |                         v
          +-----------------> PostgreSQL
                                    |
                                    v
                            Persistent Data
```

Core business relationship:

```text
                    TRANSACTION
                         |
          +--------------+--------------+
          |              |              |
          v              v              v
       Account         Vendor          Asset
          |                              |
          v                              v
     What was spent?              Which asset?
```

For the Copier example:

```text
Invoice / Petty Cash
        |
        v
Color Toner — 150,000 MMK
        |
        +---- Account
        |       |
        |       +--> Copier Consumables
        |
        +---- Asset
                |
                +--> AST-COP-001
                     Canon Copier
```

This architecture keeps **financial accounting**, **asset management**, and **administrative records** separate while allowing them to be connected through well-defined relationships.

---

# 85. Development Principle

> **Design the data model and business rules first, then build the API, then build the UI.**

For AMS, the most important foundation is not the dashboard or visual design.

The most important foundation is:

```text
Correct Data Model
        +
Correct Accounting Relationships
        +
Transaction Integrity
        +
Auditability
        +
Clear Permissions
```

If these are correct, reports, dashboards, asset history, invoice history, and administrative workflows can all be built on top of the same reliable data.

