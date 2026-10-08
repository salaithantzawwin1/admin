# AMS Procurement Management Module
## Complete Functional & Workflow Design

**Document Type:** Separate Module Design  
**Purpose:** Complete Procurement / Purchase Management design for integration with AMS  
**Basis:** AMS Administration Management System Development Guide v1.2, Last Updated 2026-09-24

---

# 1. Module Objective

The Procurement Module manages the complete purchasing lifecycle:

> Purchase Need → Purchase Request → Approval → Budget Check → Stock Check → Procurement → Vendor Selection → Purchase Order → Receiving → Invoice Verification → Payment → Completion

The module should provide traceability for:

- What is being purchased
- Which department requested it
- Who approved it
- Budget availability
- Stock availability
- Which vendors were contacted
- Which quotation was selected
- Why a vendor was selected
- Purchase Order details
- Goods received
- Invoice received
- Payment status
- Related account
- Related asset
- Complete audit history

---

# 2. Relationship with AMS Development Spec

The existing AMS Development Spec identifies the following as future modules:

- Purchase Request
- Purchase Order
- Approval Workflow
- Budget Management
- Inventory
- Consumable Stock
- Payment
- Advanced Accounting

The current AMS Purchasing / Invoice phase focuses on:

- Invoice
- Invoice Items
- Vendor
- Account
- Related Asset
- Approval

Therefore, this document is a **separate detailed Procurement Module Design** that can later be integrated into AMS without changing the core architecture.

> **Status update (2026-10-08):** Since this design was written, AMS has shipped modules the
> spec then listed as future — notably **Inventory** (office supplies: `InventoryItem`,
> `StockTransaction`, supply-request fulfilment) and a **generic approval framework**
> (`ApprovalWorkflow`/`ApprovalStep`/`RequestDocument`) that already carries
> `docType = PURCHASE_REQUEST` requests, plus **Supplier** master data with PO drafts
> (the codebase models this design's "Vendor" as `Supplier`). Budget Management and
> Payment remain future. The Stock Check step (§10) should therefore integrate with the
> **existing** Inventory stock ledger, not a new one. See
> `docs/AMS_Design_vs_Implementation_Gap_Analysis.md` for the full comparison.

---

# 3. Complete Procurement Workflow

```text
                    PURCHASE NEED
                         |
                         v
                Purchase Request (PR)
                         |
                         v
                 Department Review
                         |
                         v
                  Budget Check
                         |
              +----------+----------+
              |                     |
          Budget OK             Budget Issue
              |                     |
              v                     v
       Stock Availability      Return / Reject
              |
       +------+------+
       |             |
   Stock Available  No Stock
       |             |
       v             v
   Stock Issue    Procurement
                     |
                     v
              RFQ / Quotation
                     |
                     v
             Vendor Quotations
                     |
                     v
            Quotation Comparison
                     |
                     v
             Vendor Selection
                     |
                     v
              Approval Check
                     |
                     v
              Purchase Order
                     |
                     v
             Vendor Delivery
                     |
                     v
               GRN / Receive
                     |
                     v
            Quantity / Quality
                Verification
                     |
                     v
              Invoice Received
                     |
                     v
          3-Way Matching Check
       PR/PO ↔ GRN ↔ Invoice
                     |
                     v
              Invoice Approval
                     |
                     v
                  Payment
                     |
                     v
             Transaction Posted
                     |
                     v
               PROCUREMENT
                 COMPLETED
```

---

# 4. Procurement Main Documents

| Document | Purpose |
|---|---|
| Purchase Request (PR) | Request for goods/services |
| RFQ | Request quotation from vendors |
| Quotation | Vendor quotation |
| Quotation Comparison | Compare vendor quotations |
| Purchase Order (PO) | Official purchase order |
| GRN | Goods receiving record |
| Invoice | Vendor billing document |
| Payment | Vendor payment |
| Procurement Record | Complete purchase history |

---

# 5. Purchase Request (PR)

PR is the starting point of the procurement process.

## PR Form

```text
Purchase Request

PR Number
PR Date

Requesting Department
Requested By
Required Date
Priority

Purpose / Justification

Items
------------------------------------------------
Item / Description
Quantity
Unit
Estimated Unit Price
Estimated Amount
Account
Related Asset
------------------------------------------------

Estimated Total

Budget
Budget Code

Attachment

Notes

Save Draft
Submit
Cancel
```

## Example

```text
PR-2026-00125

Department:
Administration

Requested By:
Admin Officer

Purpose:
Office printer toner replacement

Item:
Canon Color Toner

Qty:
4

Estimated Unit Price:
150,000 MMK

Estimated Total:
600,000 MMK

Account:
Copier Consumables

Related Asset:
AST-COP-001
```

Consumables should normally be treated as expenses rather than assets. A consumable can optionally reference the asset that consumes it.

---

# 6. PR Status

```text
DRAFT
   |
   v
SUBMITTED
   |
   +----> REJECTED
   |
   v
UNDER_REVIEW
   |
   v
APPROVED
   |
   v
PROCUREMENT
```

Additional statuses:

```text
CANCELLED
RETURNED
CLOSED
```

### Status Meaning

**DRAFT**  
User is preparing the request.

**SUBMITTED**  
Submitted for approval.

**UNDER_REVIEW**  
Approver is reviewing.

**APPROVED**  
Approved for procurement.

**REJECTED**  
Request was rejected.

**RETURNED**  
Request must be corrected and resubmitted.

---

# 7. Approval Workflow

Recommended general structure:

```text
Requester
   |
   v
Department Head
   |
   v
Administration / Procurement
   |
   v
Finance / Budget
   |
   v
Management
```

Approval levels and amount thresholds should be configurable because the existing AMS Development Spec does not define specific approval thresholds.

---

# 8. Amount-Based Approval

Example policy structure:

```text
≤ 500,000 MMK
    Department Head

500,001 – 2,000,000 MMK
    Department Head
    + Administration

2,000,001 – 10,000,000 MMK
    Department Head
    + Administration
    + Finance

> 10,000,000 MMK
    Department Head
    + Administration
    + Finance
    + Management
```

**Note:** These amounts are design examples only. Actual thresholds must be configured according to company policy.

---

# 9. Budget Check

After PR submission:

```text
PR
 |
 v
Budget Check
 |
 +---- Budget Available ----> Continue
 |
 +---- Budget Not Available -> Return / Reject
```

Budget Management is identified as a future AMS module. The Procurement Module should therefore expose an integration point for budget validation.

---

# 10. Stock Check

A purchase request should not automatically result in a purchase if stock is already available.

```text
Purchase Request
       |
       v
Stock Check
       |
   +---+---+
   |       |
Available  Not Available
   |       |
   v       v
Issue    Procurement
Stock
```

Example:

```text
PR
 ↓
Stock Check
 ↓
Available
 ↓
Store Issue
 ↓
PR Completed
```

If stock is unavailable:

```text
PR
 ↓
Stock Check
 ↓
Not Available
 ↓
Procurement
```

Inventory / Consumable Stock are future AMS modules and should be integrated later.

---

# 11. RFQ — Request for Quotation

When stock is unavailable:

```text
PR Approved
     |
     v
Create RFQ
     |
     +---- Vendor A
     |
     +---- Vendor B
     |
     +---- Vendor C
```

RFQ fields:

```text
RFQ Number
RFQ Date
Related PR

Required Date

Items
Quantity
Specification

Vendors

Quotation Due Date

Attachments
Notes
```

---

# 12. Vendor Quotation

Each vendor quotation should be recorded separately.

```text
Vendor A

Quotation No:
Q-001

Item:
Color Toner

Qty:
4

Unit Price:
145,000

Delivery:
7 Days

Warranty:
3 Months

Payment Terms:
30 Days

Tax:
5%
```

---

# 13. Quotation Comparison

The system should provide a comparison table.

| Criteria | Vendor A | Vendor B | Vendor C |
|---|---:|---:|---:|
| Unit Price | 145,000 | 155,000 | 148,000 |
| Delivery | 7 Days | 3 Days | 5 Days |
| Warranty | 3 Months | 6 Months | 3 Months |
| Payment Terms | 30 Days | COD | 30 Days |
| Total | ... | ... | ... |

The Procurement Officer should record:

```text
Recommended Vendor
Reason / Justification
Supporting Document
```

Lowest price should not automatically determine vendor selection.

---

# 14. Vendor Selection

```text
Quotation Comparison
        |
        v
Vendor Selection
        |
        +---- Selected Vendor
        |
        +---- Selection Reason
        |
        +---- Supporting Document
```

Example:

```text
Selected Vendor:
ABC Company

Reason:
Competitive price,
available stock,
3-day delivery,
and acceptable warranty.
```

---

# 15. Purchase Order (PO)

After vendor selection and approval:

```text
Approved PR
    |
    v
Selected Vendor
    |
    v
Purchase Order
```

## PO Structure

```text
PURCHASE ORDER

PO Number
PO Date

Vendor
Vendor Address
Contact

Related PR
Related RFQ

Delivery Address
Expected Delivery Date

Items
------------------------------------------------
Description
Quantity
Unit Price
Discount
Tax
Amount
------------------------------------------------

Subtotal
Discount
Tax
Grand Total

Payment Terms
Delivery Terms

Prepared By
Approved By

Attachments
```

---

# 16. PO Status

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
SENT_TO_VENDOR
   |
   v
PARTIALLY_RECEIVED
   |
   v
FULLY_RECEIVED
   |
   v
CLOSED
```

Additional:

```text
CANCELLED
EXPIRED
```

---

# 17. Vendor Delivery

When goods arrive, receiving should reference the Purchase Order.

```text
PO
 |
 v
Vendor Delivery
 |
 v
Receiving
```

---

# 18. GRN — Goods Received Note

## GRN Structure

```text
GRN Number
GRN Date

PO Number
Vendor

Received By
Warehouse / Location

Items
------------------------------------------------
Item
Ordered Qty
Received Qty
Accepted Qty
Rejected Qty
Unit
Condition
------------------------------------------------

Remarks

Attachment
Delivery Note
```

Example:

```text
PO Qty       = 100
Received     = 100
Accepted     = 98
Rejected     = 2
```

The system should show:

```text
100 Ordered
98 Received
2 Rejected
```

---

# 19. Partial Delivery

The system must support partial delivery.

Example:

```text
PO = 100 Units

First Delivery
40 Units

Second Delivery
60 Units
```

System:

```text
PO
 |
 +-- GRN-001 = 40
 |
 +-- GRN-002 = 60
 |
 v
100% Received
```

---

# 20. Quality / Acceptance

Received goods should not automatically be considered accepted.

```text
Received
   |
   v
Inspection
   |
 +---+---+
 |       |
Pass    Fail
 |       |
 v       v
Accept  Reject
```

Optional fields:

```text
Condition
Serial Number
Batch Number
Expiry Date
Remarks
Photo
```

---

# 21. Asset vs Consumable vs Service

Procurement items should be classified.

## Asset

```text
Laptop
Aircon
Copier
Printer
Server
Furniture
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

## Consumable

```text
Toner
Paper
Stationery
Cleaning Supplies
```

Usually does not need an Asset Code.

It may still have a Related Asset.

## Service

```text
Aircon Maintenance
Internet Service
Software Subscription
Repair Service
```

Usually becomes an expense transaction.

---

# 22. Invoice Verification

When the vendor invoice is received, it should be checked against the PO and GRN.

```text
Vendor
PO
GRN
Invoice
```

should be linked.

---

# 23. Three-Way Matching

The procurement control should compare:

```text
             PO
              |
        Ordered Quantity
        Agreed Price
              |
              v
             GRN
              |
        Received Quantity
              |
              v
           INVOICE
              |
        Billed Quantity
        Billed Amount
```

The system should identify:

```text
MATCHED
PARTIAL_MATCH
MISMATCH
```

Quantity:

```text
PO Quantity
      =
GRN Quantity
      =
Invoice Quantity
```

Price:

```text
PO Unit Price
      =
Invoice Unit Price
```

Exceptions should be sent for review.

---

# 24. Invoice

The existing AMS Invoice design should be extended with procurement references.

```text
Invoice

Vendor
Invoice Number
Invoice Date

Related PO
Related GRN

Items
--------------------------------
Description
Quantity
Unit Price
Account
Related Asset
Amount
--------------------------------

Subtotal
Tax
Total

Attachment
```

One invoice may contain multiple invoice items, and each item may reference an Account and an optional Asset.

---

# 25. Invoice Approval

```text
Invoice Received
       |
       v
3-Way Match
       |
   +---+---+
   |       |
Matched  Mismatch
   |       |
   v       v
Approval  Resolve
   |
   v
Approved
```

The existing AMS accounting lifecycle is:

```text
DRAFT
  ↓
SUBMITTED
  ↓
APPROVED
  ↓
POSTED
```

The Procurement Invoice process should align with this lifecycle.

---

# 26. Payment Integration

Payment is identified as a future AMS module.

Recommended integration:

```text
Approved Invoice
       |
       v
Payment Request
       |
       v
Finance Payment
       |
       v
Payment Completed
       |
       v
Accounting Transaction Posted
```

Payment and accounting logic should remain in the Finance / Accounting area rather than duplicating it inside Procurement.

---

# 27. Complete End-to-End Example

```text
1. User creates PR
        ↓
2. Department Head approves
        ↓
3. Budget check
        ↓
4. Store checks stock
        ↓
5. No stock
        ↓
6. Procurement creates RFQ
        ↓
7. 3 vendors submit quotations
        ↓
8. Procurement compares quotations
        ↓
9. Vendor selected
        ↓
10. Management approval
        ↓
11. PO created
        ↓
12. PO sent to vendor
        ↓
13. Vendor delivers goods
        ↓
14. GRN created
        ↓
15. Items inspected
        ↓
16. Invoice received
        ↓
17. PO ↔ GRN ↔ Invoice matched
        ↓
18. Invoice approved
        ↓
19. Finance pays vendor
        ↓
20. Accounting Transaction posted
        ↓
21. Procurement closed
```

---

# 28. Recommended Database Entities

```text
PurchaseRequest
PurchaseRequestItem

RFQ
RFQVendor
RFQItem

Quotation
QuotationItem

QuotationComparison

PurchaseOrder
PurchaseOrderItem

GoodsReceipt
GoodsReceiptItem

Invoice
InvoiceItem

Payment
```

Supporting entities:

```text
Vendor
Account
Asset
Department
User
Approval
Attachment
AuditLog
```

---

# 29. Entity Relationship

```text
Department
    |
    v
PurchaseRequest
    |
    +---- PurchaseRequestItem
    |
    v
Approval
    |
    v
RFQ
    |
    +---- RFQVendor
    |
    v
Quotation
    |
    +---- QuotationItem
    |
    v
QuotationComparison
    |
    v
PurchaseOrder
    |
    +---- PurchaseOrderItem
    |
    v
GoodsReceipt
    |
    +---- GoodsReceiptItem
    |
    v
Invoice
    |
    +---- InvoiceItem
    |
    v
Payment
```

---

# 30. Important Relationships

## PR → PO

One PR may result in one or multiple POs.

```text
One PR
   ↓
One or Multiple PO
```

This supports cases where different items are purchased from different vendors.

## PO → GRN

```text
One PO
   ↓
Multiple GRN
```

Required for partial deliveries.

## PO → Invoice

```text
One PO
   ↓
One or Multiple Invoice
```

Partial invoicing can be supported according to business rules.

## Invoice → Invoice Item

```text
Invoice
   |
   +-- Item 1 → Account
   |          → Asset
   |
   +-- Item 2 → Account
              → Asset
```

---

# 31. Approval Entity

Approval should be implemented as a reusable framework rather than hard-coded separately for every document.

```text
Approval

id
entityType
entityId
step
approverId
status
comments
approvedAt
```

Example:

```text
entityType = PURCHASE_REQUEST
entityId   = PR-2026-00125
step       = DEPARTMENT_HEAD
status     = APPROVED
```

This allows the same framework to support:

```text
PR
PO
Invoice
Payment
```

---

# 32. Audit Trail

Procurement must maintain a complete audit trail.

Example:

```text
10:05
User created PR-00125

10:20
Manager approved PR-00125

11:15
Procurement created RFQ-0008

14:30
Vendor quotation uploaded

15:00
Procurement selected Vendor ABC

16:00
Manager approved PO-0021

Next Day
GRN-0031 created

Next Day
Invoice INV-1002 submitted
```

Important events should be recorded in AuditLog.

---

# 33. Procurement Dashboard

## Purchase Requests

```text
Draft
Pending Approval
Approved
Rejected
Completed
```

## Purchase Orders

```text
Draft
Pending Approval
Sent
Partially Received
Fully Received
Closed
```

## Invoices

```text
Pending
Matched
Mismatch
Approved
Posted
```

## Purchasing Summary

```text
This Month Purchase
Pending Purchase
Outstanding PO
Pending GRN
Pending Invoice
Pending Payment
```

---

# 34. Reports

## Purchase Request Report

```text
PR No
Date
Department
Requester
Amount
Status
```

## Purchase Order Report

```text
PO No
Vendor
Date
Amount
Received
Outstanding
Status
```

## Vendor Purchase Report

```text
Vendor
PO Count
Purchase Amount
Invoice Amount
Paid Amount
Outstanding
```

## Purchase by Account

```text
Account
Amount
Period
Vendor
Department
```

## Purchase by Asset

```text
Asset
Purchase Cost
Consumable Cost
Maintenance Cost
Other Related Cost
Total
```

---

# 35. Procurement Controls

## Control 1 — No Approval, No PO

```text
PR not approved
      ↓
Cannot create PO
```

## Control 2 — PO Required for Receiving

Normal purchases should require a valid PO before receiving, except approved emergency-purchase workflows.

## Control 3 — GRN Check

```text
Invoice
   ↓
No GRN
   ↓
Warning / Hold
```

## Control 4 — PO Amount Check

```text
Invoice Amount
      <=
PO Amount
```

Exceptions should require review.

## Control 5 — Duplicate Invoice Check

Recommended uniqueness check:

```text
Vendor + Invoice Number
```

---

# 36. Emergency Purchase

The module should support exceptional purchase types:

```text
Normal Purchase
Emergency Purchase
Petty Cash Purchase
Direct Purchase
```

Emergency purchases should require:

```text
Emergency Reason
Urgency
Approver
Supporting Document
```

---

# 37. Petty Cash Integration

For small purchases:

```text
Purchase Request
       |
       v
Approved
       |
       v
Petty Cash Purchase
       |
       v
Receipt
       |
       v
Petty Cash Transaction
```

This should integrate with the existing AMS Petty Cash concept.

---

# 38. Fixed Asset Purchase

Example:

```text
PR
 ↓
Approval
 ↓
Quotation
 ↓
PO
 ↓
GRN
 ↓
Invoice
 ↓
Payment
 ↓
Asset Registration
```

Example asset record:

```text
Asset Code:
AST-SRV-002

Purchase Cost:
15,000,000 MMK

Vendor:
ABC Technology

Purchase Date:
...

PO:
PO-2026-0012

Invoice:
INV-2026-0098

Location:
Server Room
```

---

# 39. Procurement → Asset Integration

The core relationship should be:

```text
Purchase
   |
   v
Invoice Item
   |
   +---- Account
   |
   +---- Asset
```

Example:

```text
Laptop
    → Asset

Laptop Bag
    → Expense

Laptop Setup Service
    → Service Expense
```

---

# 40. Recommended Menu Structure

```text
Administration
│
├── Procurement
│   │
│   ├── Dashboard
│   ├── Purchase Requests
│   ├── RFQ
│   ├── Quotations
│   ├── Comparison
│   ├── Purchase Orders
│   ├── Goods Receipts
│   ├── Vendor Invoices
│   ├── Payments
│   └── Reports
│
├── Vendors
├── Assets
├── Finance
└── Audit Logs
```

---

# 41. Permission Design

| Function | Requester | Dept Head | Procurement | Finance | Manager | Admin |
|---|---:|---:|---:|---:|---:|---:|
| Create PR | ✓ | ✓ | ✓ | - | - | ✓ |
| Approve PR | - | ✓ | - | - | ✓ | ✓ |
| Create RFQ | - | - | ✓ | - | - | ✓ |
| Enter Quotation | - | - | ✓ | - | - | ✓ |
| Select Vendor | - | - | ✓ | - | ✓ | ✓ |
| Create PO | - | - | ✓ | - | - | ✓ |
| Approve PO | - | - | - | ✓* | ✓ | ✓ |
| Create GRN | - | - | ✓ | - | - | ✓ |
| Enter Invoice | - | - | ✓ | ✓ | - | ✓ |
| Approve Invoice | - | - | - | ✓ | ✓ | ✓ |
| Payment | - | - | - | ✓ | ✓ | - |
| View Reports | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

`✓*` depends on company policy.

---

# 42. Final Complete Flow

```text
┌─────────────────────────────┐
│        PURCHASE NEED        │
└──────────────┬──────────────┘
               ↓
┌─────────────────────────────┐
│      PURCHASE REQUEST       │
└──────────────┬──────────────┘
               ↓
┌─────────────────────────────┐
│      DEPARTMENT APPROVAL    │
└──────────────┬──────────────┘
               ↓
┌─────────────────────────────┐
│         BUDGET CHECK        │
└──────────────┬──────────────┘
               ↓
┌─────────────────────────────┐
│         STOCK CHECK         │
└───────┬─────────────┬───────┘
        │             │
     AVAILABLE     NOT AVAILABLE
        │             │
        ↓             ↓
   STORE ISSUE       RFQ
                      ↓
                QUOTATIONS
                      ↓
                COMPARISON
                      ↓
                VENDOR SELECT
                      ↓
                   APPROVAL
                      ↓
                PURCHASE ORDER
                      ↓
                VENDOR DELIVERY
                      ↓
                     GRN
                      ↓
                 INSPECTION
                      ↓
              INVOICE RECEIVED
                      ↓
              3-WAY MATCHING
                      ↓
              INVOICE APPROVAL
                      ↓
                   PAYMENT
                      ↓
              ACCOUNTING POST
                      ↓
             ASSET / STOCK UPDATE
                      ↓
                  AUDIT LOG
                      ↓
              PROCUREMENT CLOSED
```

---

# 43. Integration with AMS

The final architecture should be:

```text
AMS
│
├── Core / Authentication
├── Asset Management
├── Vendor Management
├── Accounting
│
├── Procurement Management
│   ├── Purchase Request
│   ├── Approval
│   ├── RFQ
│   ├── Quotation
│   ├── Comparison
│   ├── Purchase Order
│   ├── GRN
│   ├── Invoice Matching
│   └── Payment Integration
│
├── Petty Cash
├── Maintenance
├── Reports
└── Audit
```

The Procurement Module should remain a separate module while sharing common AMS entities such as:

```text
User
Role
Permission
Vendor
Account
Asset
Department
Attachment
Approval
AuditLog
```

---

# 44. Recommended Implementation Order

For future development:

```text
Phase P1 — Purchase Request
    ↓
Phase P2 — Approval Workflow
    ↓
Phase P3 — RFQ / Quotation
    ↓
Phase P4 — Vendor Comparison
    ↓
Phase P5 — Purchase Order
    ↓
Phase P6 — Goods Receipt / GRN
    ↓
Phase P7 — Invoice Matching
    ↓
Phase P8 — Payment Integration
    ↓
Phase P9 — Reports / Dashboard
    ↓
Phase P10 — Advanced Controls
```

Advanced controls can include:

```text
Budget Integration
Inventory Integration
Approval Rules
Amount Thresholds
Vendor Evaluation
Contract Purchase
Recurring Purchase
Multi-level Approval
```

---

# 45. Key Design Principles

1. **PR is the starting point for normal purchases.**
2. **Approval must happen before controlled purchasing actions.**
3. **Stock should be checked before purchasing where inventory exists.**
4. **Vendor quotations should be traceable.**
5. **Vendor selection should record justification.**
6. **PO should be the official purchasing commitment.**
7. **GRN should record actual receiving.**
8. **Partial delivery must be supported.**
9. **Invoice should be checked against PO and GRN.**
10. **Accounting Transaction should remain the financial source of truth.**
11. **Asset and Consumable concepts must remain separate.**
12. **Audit history must not be deleted.**
13. **Approval rules should be configurable.**
14. **Procurement should integrate with AMS rather than duplicate core data.**
15. **Complex business features should be designed at the business-rule and data-model level before UI implementation.**
