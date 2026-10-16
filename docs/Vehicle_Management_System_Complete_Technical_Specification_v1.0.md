# Vehicle Management System (VMS)

## Complete Technical Specification --- Integrated with IT Asset Management System

**Document version:** 1.0\
**Status:** Proposed for business and technical review\
**Scope:** Company Group, all legal entities and branches\
**Target platform:** Existing web-based IT Asset Management /
Administration Management System (AMS)\
**Proposed stack:** React + TypeScript, NestJS REST API, PostgreSQL,
Prisma, Docker Compose, Nginx\
**Document date:** 16 October 2026\
**Primary objective:** Manage the full lifecycle of company vehicles,
compliance documents, assignments, trips, maintenance, fuel, expenses,
alerts, and approvals in one auditable system.

------------------------------------------------------------------------

## 1. Executive Summary

The Vehicle Management System (VMS) will be implemented as a dedicated
module inside the existing IT Asset Management / Administration
Management System. It will use the current organization hierarchy,
identity and access management, approval engine, notification framework,
attachment storage, audit logging, expense/account mapping, and
reporting infrastructure wherever those services already exist.

The module must support cars, pickups, trucks, motorcycles, vans, buses,
forklifts, trailers, generators-on-wheels, and configurable additional
vehicle types. It must support vehicles owned, leased, rented, or
temporarily assigned to the company.

The system's most important compliance feature is proactive document
expiry monitoring. It will track vehicle registration/license, road tax,
insurance, inspection certificates, permits, and other configurable
documents. It will calculate expiry status daily and notify the
responsible users through the dashboard, email, and Telegram. Alert
thresholds and recipients must be configurable.

### 1.1 Core design principles

1.  Reuse the existing AMS organization, user, role, approval, expense,
    attachment, audit, and notification services.
2.  Keep vehicle-specific workflows and data in a separate VMS module
    with clear module boundaries.
3.  Use one authoritative vehicle record; do not create duplicate
    generic IT assets for the same vehicle.
4.  Treat expenses as financial transactions and vehicles as operational
    assets. An expense can reference a vehicle without duplicating the
    financial transaction.
5.  Enforce company, branch, department, and role-based data scope on
    the server, not only in the UI.
6.  Preserve historical records. Prefer archive/deactivation over
    deleting records used by transactions.
7.  Make business rules configurable where they differ by company,
    vehicle type, or document type.
8.  Record state transitions, approvals, notification attempts, and
    important changes in an audit trail.

### 1.2 Success criteria

-   Every in-scope vehicle has a unique vehicle code and an assigned
    company/branch.
-   Vehicle documents have clear current status and expiry dates where
    applicable.
-   Expired and upcoming documents appear in the dashboard and generate
    configured notifications.
-   A vehicle with an expired mandatory document can be flagged as
    restricted and blocked from new trip approval or dispatch according
    to policy.
-   Maintenance, fuel, trips, assignment, and expenses can be traced to
    the correct vehicle.
-   Approval decisions are validated by the backend and fully auditable.
-   Cross-company and cross-branch access tests show no unauthorized
    data disclosure.
-   Database and document attachments can be restored together from
    backup.
-   Existing AMS functionality remains stable after deployment.

------------------------------------------------------------------------

## 2. Scope

### 2.1 In scope

-   Group/company/branch/department/location integration.
-   Vehicle register and configurable vehicle categories.
-   Vehicle specifications by category.
-   Ownership, purchase, lease, rental, and disposal records.
-   Driver and custodian assignment.
-   Vehicle document register and expiry alert engine.
-   Maintenance schedules, service jobs, repairs, parts, and maintenance
    vendors.
-   Fuel transactions, odometer readings, mileage, and efficiency
    reporting.
-   Trip requests, approvals, dispatch, return, and trip history.
-   Vehicle reservation/availability checks and conflict prevention.
-   Expense records and integration with existing AMS expense/accounting
    references.
-   Configurable approval workflows.
-   Dashboard, alerts, reports, attachments, exports, and audit logs.
-   Email and Telegram notifications.
-   Data import, validation, reconciliation, and migration.
-   Security, backup, monitoring, testing, and rollout.

### 2.2 Out of scope for the initial release

-   GPS tracking or live telematics unless a supported provider is
    selected later.
-   Automatic vehicle diagnostics/OBD integration.
-   Full accounting, payroll, procurement, or ERP replacement.
-   Automatic payment of license, tax, insurance, or repair invoices.
-   Native mobile apps; the first release will use a responsive web
    interface.
-   Legal interpretation of Myanmar vehicle rules. Administrators must
    configure dates and document requirements based on verified company
    policy and applicable regulations.
-   Automatic enforcement against physical vehicle use. The system can
    flag and block digital workflows, but dispatchers must follow
    company procedures.

### 2.3 Future enhancements

-   QR code on each vehicle for quick lookup.
-   Mobile-friendly inspection checklist and photo upload.
-   GPS/telematics integration.
-   Driver license expiry and driver safety records.
-   Accident, claim, fine, and incident management.
-   Tyre/battery/parts lifecycle.
-   Vehicle replacement and total-cost-of-ownership analysis.
-   Fuel card or supplier integration.
-   ERP/accounting integration through approved APIs.

------------------------------------------------------------------------

## 3. Existing AMS Integration Requirements

The existing AMS specification describes a React/Vite frontend, NestJS
backend, PostgreSQL database, Prisma ORM, Nginx reverse proxy, and
Docker-based deployment. The VMS should follow the same standards rather
than introducing a second application stack.

### 3.1 Reuse existing services

  -----------------------------------------------------------------------
  Existing AMS capability             VMS integration requirement
  ----------------------------------- -----------------------------------
  Organization master                 Reuse Group, Company, Branch,
                                      Department, Location

  User and identity service           Reuse stable user IDs and current
                                      authentication/SSO

  RBAC and data scope                 Add VMS permissions and
                                      vehicle-specific scope rules

  Approval engine                     Reuse configurable approval
                                      templates and approval history

  Expense/account mapping             Reference existing
                                      accounts/categories and transaction
                                      IDs

  Vendor/supplier master              Reuse suppliers for garages, fuel
                                      stations, insurers, and dealers
                                      where suitable

  Attachment service                  Reuse protected file storage and
                                      download authorization

  Audit log                           Reuse common audit service; include
                                      VMS entity and event metadata

  Notification framework              Reuse email service and add
                                      Telegram channel adapter if not
                                      available

  Dashboard/report framework          Reuse common layout, filters,
                                      exports, and permission rules

  Deployment/monitoring               Reuse Docker Compose, Nginx, logs,
                                      health checks, backup and release
                                      process
  -----------------------------------------------------------------------

### 3.2 Integration rules

-   Use existing canonical organization and user IDs. Do not create
    duplicate Company, Branch, Department, or User tables unless the
    current AMS architecture requires a documented adapter.
-   The VMS module must not directly modify another module's tables
    without an approved service/repository contract.
-   Use shared transaction or expense records where possible. If the AMS
    expense model cannot represent vehicle-specific data, extend it
    through a safe relation or module-owned expense detail table.
-   Reuse the current approval engine if it supports configurable
    templates, thresholds, approver resolution, immutable decisions, and
    escalation. Otherwise, extend it as a shared capability rather than
    creating an isolated second approval engine.
-   Use a versioned API namespace such as `/api/v1/vehicles`.
-   Review the actual deployed AMS schema before finalizing migrations.
    Names in this document are logical names and may need mapping to
    existing canonical tables.

------------------------------------------------------------------------

## 4. Users, Roles, and Data Scope

### 4.1 Recommended roles

  -----------------------------------------------------------------------
  Role                                Typical responsibilities
  ----------------------------------- -----------------------------------
  System Administrator                System configuration, integrations,
                                      controlled emergency administration

  Group Fleet Manager                 Group-wide fleet configuration,
                                      oversight, reports, exceptions

  Company Fleet Manager               Manage vehicles and workflows for
                                      assigned company

  Branch Fleet Coordinator            Maintain local vehicles, documents,
                                      trips, fuel, and service records

  Requester / Employee                Submit trip or vehicle requests and
                                      view permitted requests

  Driver                              View assigned trips, submit trip
                                      readings/checklists, report issues

  Approver                            Approve/reject requests within
                                      assigned authority

  Maintenance Officer                 Manage service schedules, repair
                                      jobs, and vendors

  Finance Officer                     Review permitted expense and
                                      fuel-cost information

  Auditor / Read-only                 View authorized records and audit
                                      history without changing data
  -----------------------------------------------------------------------

Roles should be permission bundles, not hard-coded assumptions. One user
may hold multiple roles with different organization scopes.

### 4.2 Data scope

Every VMS query and command must apply server-side scope checks. A
user's permitted scope may include:

-   Group-wide access.
-   One or more companies.
-   One or more branches.
-   Selected departments or locations.
-   Only records they requested, drive, or are assigned to, where
    applicable.

The API must not trust `companyId`, `branchId`, `vehicleId`, or
`requestedBy` supplied by the client without authorization checks.
Exports, search, attachment downloads, reports, notifications, and
direct-object-ID requests must apply the same access rules.

### 4.3 Suggested permission codes

-   `vms.dashboard.view`
-   `vms.vehicle.view`, `vms.vehicle.create`, `vms.vehicle.update`,
    `vms.vehicle.archive`
-   `vms.document.view`, `vms.document.manage`, `vms.document.renew`
-   `vms.maintenance.view`, `vms.maintenance.create`,
    `vms.maintenance.approve`, `vms.maintenance.close`
-   `vms.fuel.view`, `vms.fuel.create`, `vms.fuel.approve`
-   `vms.trip.request`, `vms.trip.view`, `vms.trip.approve`,
    `vms.trip.dispatch`, `vms.trip.complete`, `vms.trip.cancel`
-   `vms.assignment.manage`
-   `vms.expense.view`, `vms.expense.create`, `vms.expense.approve`
-   `vms.report.view`, `vms.report.export`
-   `vms.configuration.manage`
-   `vms.audit.view`

Permissions should be checked together with organization scope. A
permission alone does not grant access to every company's records.

------------------------------------------------------------------------

## 5. Vehicle Register

### 5.1 Common vehicle fields

  -------------------------------------------------------------------------
  Field                   Type / rule             Notes
  ----------------------- ----------------------- -------------------------
  `id`                    UUID, primary key       Internal stable
                                                  identifier

  `vehicle_code`          Required, unique        Human-readable ID,
                                                  e.g. `VH-YGN-0001`

  `registration_number`   Required where          Plate number; duplicate
                          registered; normalized  policy must be defined

  `vehicle_type_id`       Required FK             Car, Pickup, Truck,
                                                  Motorcycle, Van, Bus,
                                                  Other

  `company_id`            Required FK             Existing organization
                                                  master

  `branch_id`             Required FK             Existing branch master

  `department_id`         Optional FK             Cost owner or operational
                                                  department

  `location_id`           Optional FK             Parking/garage/location

  `make` / `model`        Configurable            Manufacturer and model

  `manufacture_year`      Optional integer        Validate reasonable range

  `color`                 Optional                Vehicle color

  `vin_chassis_number`    Optional string         Normalize and check
                                                  duplicates according to
                                                  policy

  `engine_number`         Optional string         Restricted visibility if
                                                  policy requires

  `fuel_type`             Configurable enum       Petrol, Diesel, Hybrid,
                                                  Electric, LPG, Other

  `transmission`          Optional enum           Automatic, Manual, Other

  `ownership_type`        Required enum           Owned, Leased, Rented,
                                                  Employee-owned, Other

  `purchase_date`         Optional date           Usually for owned
                                                  vehicles

  `purchase_cost`         Optional decimal        Use decimal, never
                                                  floating-point

  `currency_code`         Optional ISO-style code Must follow AMS currency
                                                  conventions

  `supplier_id`           Optional FK             Reuse supplier/vendor
                                                  master

  `seat_capacity`         Optional integer        For passenger vehicles

  `load_capacity_kg`      Optional decimal        For trucks/pickups

  `odometer_current`      Optional decimal        Must not be less than
                                                  accepted previous reading

  `status`                Required enum           Draft, Active, Reserved,
                                                  In Maintenance,
                                                  Restricted, Disposed,
                                                  Archived

  `condition`             Optional enum           Excellent, Good, Fair,
                                                  Poor, Unserviceable

  `notes`                 Optional text           Avoid storing secrets

  `created_at`,           System-managed          Audit metadata
  `created_by`                                    

  `updated_at`,           System-managed          Audit metadata
  `updated_by`                                    

  `archived_at`,          Nullable                Prefer archive over
  `archived_by`                                   delete
  -------------------------------------------------------------------------

### 5.2 Vehicle type and category-specific specifications

Use the AMS pattern of common asset fields plus configurable
category-specific specification fields. Do not add every possible
specification as a nullable column on the main vehicle table.

Examples:

-   **Car:** body type, seat capacity, engine capacity, transmission,
    drive type.
-   **Pickup:** cab type, payload capacity, bed length, 4WD/2WD.
-   **Truck:** gross vehicle weight, payload, axle count, body type,
    trailer compatibility.
-   **Motorcycle:** engine capacity, motorcycle class, transmission
    type.
-   **Van/Bus:** passenger capacity, body configuration.
-   **Electric vehicle:** battery capacity, connector type, range
    estimate.
-   **Other:** configurable key/value specifications with type
    validation.

Each specification definition should include key, label, data type,
unit, allowed options, requiredness, validation range,
searchable/reportable flags, and applicable vehicle categories. Changing
a category must not silently delete previously recorded specification
values.

### 5.3 Vehicle lifecycle

Suggested statuses:

`Draft → Pending Approval → Active → Restricted / In Maintenance → Active → Disposed → Archived`

Rules:

-   Only authorized roles can activate, restrict, dispose, or archive a
    vehicle.
-   Disposed or archived vehicles cannot be newly assigned or selected
    for a new trip.
-   A vehicle in maintenance cannot be dispatched unless an authorized
    policy exception is recorded.
-   Restricted vehicles require a restriction reason and, where
    configured, an authorized clearance before returning to Active.
-   Status changes must be written to vehicle history with actor, time,
    old status, new status, and reason.
-   Never delete a vehicle that has linked trips, expenses, documents,
    assignments, or maintenance records.

------------------------------------------------------------------------

## 6. Document and Expiry Management

### 6.1 Document types

Configure document types by company and vehicle type. Suggested
defaults:

-   Vehicle registration/license.
-   Road tax.
-   Motor insurance.
-   Comprehensive insurance.
-   Third-party insurance.
-   Inspection/roadworthiness certificate.
-   Commercial permit/route permit.
-   Lease/rental contract.
-   Import/customs or other required certificate.
-   Other configurable documents.

Driver license belongs to a driver/person record if the AMS has a
personnel master; it should not be duplicated as a vehicle-owned
document. A trip can validate that the assigned driver has a valid
license where this data is maintained.

### 6.2 Document fields

-   `id` UUID.
-   `vehicle_id` FK.
-   `document_type_id` FK.
-   Document/reference number.
-   Issuing authority/provider.
-   Issue date.
-   Expiry date, nullable only if the document type allows it.
-   Reminder policy ID or reminder thresholds.
-   Attachment/file reference.
-   Renewal status: Not Started, Requested, In Progress, Renewed, Not
    Required.
-   Current-record flag / superseded reference.
-   Notes and renewal cost reference.
-   Created/updated metadata.

Store document versions/history. A renewal creates a new version or new
document record linked to the prior record; do not overwrite the old
expiry date without preserving history.

### 6.3 Expiry status calculation

Use a single server-side status calculation shared by dashboard, APIs,
reports, and notifications.

Recommended statuses:

-   `NOT_CONFIGURED`: required document is missing.
-   `VALID`: expiry is beyond the warning window.
-   `UPCOMING`: expiry is within a configured warning threshold.
-   `DUE_TODAY`: expiry date equals the business-local current date.
-   `EXPIRED`: expiry date is before the business-local current date.
-   `NOT_APPLICABLE`: document type does not apply to this vehicle.

Default reminder thresholds: 30, 14, 7, and 1 calendar day before
expiry, on the expiry date, then daily or at a configured cadence after
expiry. These are configurable defaults, not legal requirements.

Use the organization's configured timezone (initial deployment may use
`Asia/Yangon`) for date comparisons. Store timestamps in UTC and expiry
dates as database `DATE` values where the source is a date without time.
Do not use browser-local time as the source of truth.

### 6.4 Alert delivery rules

Channels: 1. Dashboard in-app notification / alert list. 2. Email. 3.
Telegram bot.

Recipients may include the assigned fleet coordinator, company fleet
manager, group fleet manager, and configured backup recipient. Recipient
resolution must use active users and their authorized company/branch
scope.

Notification requirements:

-   Daily scheduled job identifies newly due reminders and overdue
    documents.
-   Use a deduplication key such as
    `document_id + expiry_date + threshold + channel + recipient`.
-   Log queued, sent, failed, retry count, provider response summary,
    and timestamps.
-   Retry temporary failures with capped exponential backoff.
-   Do not log bot tokens, SMTP credentials, or sensitive document
    contents.
-   Do not send a message to a Telegram chat until the recipient has
    explicitly linked/registered the chat according to company policy.
-   Provide an administrator test-notification function.
-   Keep the alert visible on the dashboard even if email or Telegram
    delivery fails.
-   A renewal must close or supersede reminders for the old document and
    schedule the new expiry reminders.

Example notification:

> **Vehicle Document Expiry Alert**\
> Vehicle: VH-YGN-0001 / YGN-1234\
> Document: Motor Insurance\
> Expiry date: 30 October 2026\
> Status: Expires in 14 days\
> Responsible branch: Yangon\
> Action: Start renewal and update the new document record.

### 6.5 Expired document restrictions

Each document type must have a configurable `mandatory_for_dispatch` or
equivalent policy flag. When a mandatory document is expired or missing:

-   Show a prominent alert and the reason.
-   Prevent new trip approval or dispatch according to configured
    policy.
-   Optionally set vehicle status to `Restricted`, but do not
    automatically overwrite an existing `In Maintenance` or `Disposed`
    state.
-   Allow only a role-authorized, time-limited exception if company
    policy permits it.
-   Require exception reason, approver, expiry time, and audit record.
-   Never silently allow dispatch just because notification delivery
    failed.

------------------------------------------------------------------------

## 7. Driver and Vehicle Assignment

### 7.1 Assignment use cases

-   Assign a primary driver or custodian to a vehicle.
-   Record temporary assignment for a trip or date range.
-   Transfer a vehicle between branches or companies.
-   Return a vehicle from a user/driver.
-   Record handover condition, odometer, fuel level, accessories, and
    photos.
-   Maintain assignment history.

### 7.2 Assignment fields

-   Vehicle, person/driver, company, branch, department.
-   Assignment type: Permanent, Temporary, Trip-specific, Custodian.
-   Start date/time and end date/time.
-   Assigned by and approval reference if required.
-   Handover/return odometer and fuel level.
-   Condition checklist and attachment references.
-   Notes, return reason, created/updated metadata.

### 7.3 Business rules

-   Prevent overlapping primary assignments unless the configured policy
    explicitly permits shared assignment.
-   Validate user/driver is active and within the allowed organization
    scope.
-   If driver license data is available, validate license category and
    validity for the vehicle type before dispatch.
-   Record every assignment, transfer, handover, and return as history;
    do not merely overwrite the current assigned user.
-   Branch transfer requires approval when configured and must update
    the authoritative organization location only after approval.
-   Trip-specific assignment should not conflict with a different active
    trip or vehicle reservation.

------------------------------------------------------------------------

## 8. Trip and Vehicle Request Management

### 8.1 Trip request fields

-   Trip/request number.
-   Requester, company, branch, department, cost center.
-   Purpose/business justification.
-   Origin, destination, stops, and planned route description.
-   Planned departure and return date/time.
-   Passenger count and passenger notes if policy permits.
-   Required vehicle type/capacity.
-   Preferred vehicle (optional).
-   Assigned vehicle and driver (after allocation).
-   Approval status and approval history.
-   Dispatch odometer/fuel level.
-   Return odometer/fuel level.
-   Actual departure/return times.
-   Trip distance, calculated from accepted odometer readings.
-   Tolls, parking, other trip costs.
-   Incident/delay notes and attachments.
-   Cancellation reason and completion confirmation.

### 8.2 Trip workflow

1.  Requester submits a trip request.
2.  Server validates requester scope, date/time, required fields, and
    duplicate/conflicting requests.
3.  Approval engine resolves approvers using company, branch,
    department, vehicle type, and configurable policy.
4.  Approver approves, rejects with reason, or requests changes.
5.  Fleet coordinator allocates an available vehicle and driver.
6.  System validates document compliance, maintenance status, assignment
    conflicts, capacity, and driver eligibility where available.
7.  Dispatcher records pre-trip inspection, odometer, fuel level, and
    dispatch time.
8.  Driver uses the vehicle and reports problems/incidents.
9.  Return is recorded with return odometer, fuel level, time,
    condition, and expenses.
10. System validates odometer progression and calculates trip distance.
11. Trip is completed; relevant expenses are linked and reports updated.

### 8.3 Trip rules

-   A trip cannot be dispatched if the vehicle is disposed, archived, in
    maintenance, or blocked by a mandatory compliance rule, except
    through an approved and audited exception policy.
-   Prevent overlapping vehicle bookings for conflicting time ranges.
    Use a database-safe concurrency strategy; do not rely only on UI
    checks.
-   Prevent impossible odometer sequences. Any exception requires
    authorized correction and reason.
-   Actual return later than planned can trigger an overdue-trip alert.
-   Cancellation after approval or dispatch must follow defined policy
    and retain history.
-   Trip completion should not automatically mark every expense as
    approved; expense approval remains a separate control where
    required.

------------------------------------------------------------------------

## 9. Maintenance and Repair Management

### 9.1 Maintenance categories

-   Scheduled preventive maintenance.
-   Oil and filter service.
-   Tyre, battery, brake, engine, transmission, electrical, body repair.
-   Breakdown/emergency repair.
-   Inspection and safety check.
-   Other configurable service types.

### 9.2 Maintenance records

-   Work order number.
-   Vehicle and odometer at intake.
-   Reported issue and priority.
-   Maintenance type.
-   Requested by, assigned coordinator, service vendor/garage.
-   Planned start/end and actual start/end.
-   Vehicle downtime start/end.
-   Work performed, diagnosis, parts, labor, external service fees.
-   Warranty/claim reference.
-   Approval and purchase/expense reference.
-   Invoice/receipt attachments.
-   Next service date and/or next service odometer.
-   Completion inspection and release-to-service approval.
-   Status and full history.

### 9.3 Maintenance workflow

`Issue Reported → Work Order Created → Approval (if required) → Vehicle In Maintenance → Work In Progress → Inspection → Completed → Release to Service`

Rules:

-   Vehicle downtime must be visible to trip allocation.
-   Maintenance work over configurable cost thresholds requires
    approval.
-   Emergency repairs may use an emergency path but must capture the
    reason and be reviewed after the event.
-   A vehicle is not released to Active until the required completion
    checks are satisfied.
-   Parts and labor are stored as line items when itemized cost analysis
    is required.
-   Scheduled maintenance can be triggered by date, odometer, or
    whichever threshold occurs first.
-   Overdue service alerts must use the last accepted service/odometer
    record.

### 9.4 Maintenance alerts

-   Upcoming service by date.
-   Upcoming service by odometer.
-   Service overdue.
-   Work order awaiting approval.
-   Vehicle out of service longer than the configured target.
-   Repeated repair pattern or cost threshold (report/optional alert).

------------------------------------------------------------------------

## 10. Fuel and Mileage Management

### 10.1 Fuel transaction fields

-   Fuel transaction number.
-   Vehicle, driver, trip (optional), company, branch.
-   Transaction date/time.
-   Fuel type.
-   Liters/gallons or other configured unit; standardize reporting
    units.
-   Unit price, total amount, currency.
-   Odometer at refueling.
-   Fuel station/vendor.
-   Payment method/card/reference.
-   Receipt attachment.
-   Entered by, approval status, approver, notes.

### 10.2 Fuel rules and controls

-   Total amount should reconcile to quantity × unit price, subject to
    rounding policy; any manual override requires a reason and
    permission.
-   Odometer readings must be non-decreasing unless a correction is
    approved.
-   Flag duplicate transactions using a configurable combination of
    vehicle, date/time, amount, quantity, and receipt/reference.
-   Detect outliers such as unusually high liters, cost, or repeated
    same-day fills using configurable thresholds; flags are for review,
    not automatic accusations.
-   Fuel expense approval should follow the organization's existing
    expense policy.
-   Fuel transactions should link to the shared AMS expense/financial
    record when available, avoiding duplicate financial postings.

### 10.3 Mileage and fuel-efficiency calculations

-   Distance since prior accepted reading = current odometer − previous
    accepted odometer.
-   Efficiency for liquid fuel may be shown as liters per 100 km or km
    per liter, depending on company preference.
-   Electric vehicles should use kWh per 100 km where charging data is
    available.
-   Exclude or flag records with missing, corrected, or implausible
    odometer readings.
-   Reports must state the formula and unit used; do not compare
    different fuel types without clear normalization.

------------------------------------------------------------------------

## 11. Expense Management and AMS Financial Integration

### 11.1 Expense categories

-   Fuel.
-   Preventive maintenance.
-   Repair and spare parts.
-   Insurance.
-   Road tax/license renewal.
-   Inspection and permit.
-   Tolls and parking.
-   Cleaning.
-   Rental/lease payments.
-   Accident/claim-related expenses.
-   Other configurable costs.

### 11.2 Integration principles

-   VMS records the operational relationship: which vehicle, trip, work
    order, or document renewal incurred the cost.
-   AMS/finance remains the source of truth for accounting transaction
    IDs, account mapping, payment status, and any formal financial
    posting.
-   Do not post a second financial transaction if one already exists.
-   If expenses are created in VMS, they must be linked to an AMS
    expense transaction through a shared service/API or an approved
    extension of the shared expense model.
-   Store amount as `DECIMAL`, currency, tax if applicable, supplier,
    invoice/receipt reference, cost center, approval status, and linked
    entity IDs.
-   Keep operational status (e.g., repair completed) separate from
    financial status (e.g., invoice approved/paid).

### 11.3 Cost reports

-   Total cost per vehicle per month/year.
-   Cost by company, branch, department, and cost center.
-   Fuel vs maintenance vs insurance vs taxes.
-   Cost per kilometer where odometer data is sufficient.
-   Owned vs leased/rented vehicle cost comparison.
-   Repair cost and downtime by vehicle.
-   Budget vs actual where AMS budget data exists.

------------------------------------------------------------------------

## 12. Approval Workflow

Use the existing AMS approval engine where it meets the requirements.
Approval templates should be configurable by company, branch, request
type, cost threshold, vehicle type, and policy.

### 12.1 Approval scenarios

  -----------------------------------------------------------------------
  Transaction                         Suggested approval condition
  ----------------------------------- -----------------------------------
  New vehicle registration/activation Fleet Manager or designated
                                      reviewer

  Vehicle purchase/lease record       Existing procurement/finance
                                      approval; VMS stores reference

  Trip request                        Department manager and/or Fleet
                                      Manager

  Vehicle branch transfer             Source and destination managers, if
                                      required

  Maintenance/repair                  Fleet Manager; Finance approval
                                      above threshold

  Emergency repair                    Emergency authorization plus
                                      mandatory retrospective review

  Fuel/vehicle expense                Existing expense approval policy

  Document renewal                    Fleet/Administration approval;
                                      finance approval if cost policy
                                      requires

  Vehicle disposal                    Fleet Manager and
                                      Finance/Management according to
                                      policy

  Compliance exception                Authorized senior approver, reason,
                                      time limit, audit record
  -----------------------------------------------------------------------

### 12.2 Approval state model

Common states:

`Draft → Submitted → Pending Approval → Approved / Rejected / Changes Requested → In Progress → Completed`

Not every transaction uses every state. Configure valid transitions per
workflow type.

### 12.3 Approval engine requirements

-   Resolve approvers server-side from approved policy.
-   Prevent self-approval unless an explicitly approved policy permits
    it.
-   Capture approver ID, decision, timestamp, comment, step, delegation,
    and policy/template version.
-   Rejection requires a reason.
-   Approval decisions must be immutable; corrections use a new audited
    event.
-   Support sequential steps, optional parallel approvals, delegation
    with effective dates, escalation, and reminders where supported.
-   Re-check authority and transaction state at decision time.
-   Never trust a client-supplied `Approved` status.
-   Enforce idempotency to prevent duplicate approvals from repeated
    requests.
-   Provide an approval history view and export for auditors.

------------------------------------------------------------------------

## 13. Dashboard and User Experience

### 13.1 Group dashboard

Recommended cards and charts:

-   Total vehicles.
-   Active, restricted, in-maintenance, disposed.
-   Documents expiring in 30/14/7 days.
-   Expired or missing mandatory documents.
-   Maintenance due/overdue.
-   Open work orders and downtime.
-   Trips awaiting approval, scheduled today, overdue, and completed.
-   Fuel spend this month.
-   Maintenance and total vehicle spend this month.
-   Top vehicles by cost and cost per kilometer where data is reliable.
-   Branch-by-branch fleet utilization.
-   Notification delivery failures.

### 13.2 Role-based dashboard

-   **Group Fleet Manager:** group totals and company/branch comparison.
-   **Company Fleet Manager:** company fleet and exceptions.
-   **Branch Coordinator:** local document alerts, trips, service due,
    and open tasks.
-   **Approver:** pending approval queue and overdue decisions.
-   **Finance:** expense approval queue and cost summaries.
-   **Driver:** assigned trips, required pre-trip checks, and issue
    reporting.
-   **Auditor:** read-only reports and history.

### 13.3 Main navigation

1.  Dashboard
2.  Vehicles
3.  Documents & Expiry Alerts
4.  Assignments
5.  Trip Requests / Trips
6.  Maintenance & Work Orders
7.  Fuel Records
8.  Expenses
9.  Vendors (reuse AMS master)
10. Reports
11. Approvals
12. Notifications
13. Configuration
14. Audit Log (permission restricted)

### 13.4 Search and filters

Search by vehicle code, registration number, VIN/chassis, make/model,
company, branch, driver, document status, maintenance status, trip
number, and date range. Filters and exports must preserve the user's
data scope.

------------------------------------------------------------------------

## 14. Reporting Requirements

Minimum reports:

1.  Vehicle Register by company/branch/type/status.
2.  Vehicle document register with issue/expiry dates and attachment
    availability.
3.  Upcoming Expiry Report (configurable horizon).
4.  Expired/Missing Mandatory Documents Report.
5.  Renewal history and renewal cost.
6.  Vehicle assignment and transfer history.
7.  Trip log, distance, duration, destination, and requester.
8.  Vehicle utilization by days/hours, with calculation definition.
9.  Maintenance schedule and overdue service.
10. Work order history, repair cost, and downtime.
11. Fuel consumption and fuel efficiency.
12. Fuel transaction exceptions and duplicate flags.
13. Vehicle expenses by category/company/branch/period.
14. Total cost of ownership and cost per kilometer.
15. Approval pending/decision history.
16. Notification delivery status/failures.
17. Audit log and controlled data export.

Report features: - Date range, company, branch, vehicle type, vehicle,
driver, status, and category filters as appropriate. - CSV/XLSX export
if supported by AMS; PDF only where needed. - Export audit logging for
sensitive or large exports. - Consistent timezone, currency, unit, and
calculation definitions. - Avoid showing restricted cost or personal
data to users without permission.

------------------------------------------------------------------------

## 15. Logical Database Design

The following are logical entity names, not a demand to duplicate
existing AMS master tables. Map organization, users, vendors, expenses,
attachments, approvals, and audit records to existing canonical entities
wherever possible.

### 15.1 Core entities

  -----------------------------------------------------------------------
  Entity                              Purpose / important fields
  ----------------------------------- -----------------------------------
  `vehicles`                          Vehicle identity, type,
                                      company/branch, ownership, status,
                                      current odometer

  `vehicle_types`                     Configurable type catalog

  `vehicle_spec_definitions`          Category-specific specification
                                      definitions

  `vehicle_spec_values`               Typed specification values per
                                      vehicle

  `vehicle_status_history`            From/to status, reason, actor,
                                      timestamp

  `vehicle_documents`                 Document type, reference, dates,
                                      attachment, current/superseded
                                      state

  `vehicle_document_types`            Configurable requiredness,
                                      applicability, dispatch restriction

  `vehicle_document_history`          Renewal/version lineage and prior
                                      values

  `vehicle_assignments`               Driver/custodian, type, dates,
                                      handover/return data

  `vehicle_transfers`                 Source/destination company/branch,
                                      approvals, effective date

  `vehicle_trips`                     Request, schedule, route, assigned
                                      vehicle/driver, actual readings

  `vehicle_trip_stops`                Optional ordered origin/destination
                                      stops

  `vehicle_trip_events`               Dispatch, return, incident,
                                      cancellation, and other trip events

  `vehicle_inspections`               Pre-trip/post-trip checklist,
                                      defects, photos

  `vehicle_maintenance_orders`        Work order, diagnosis, status,
                                      downtime, vendor, approval

  `vehicle_maintenance_items`         Parts/labor/service line items and
                                      costs

  `vehicle_maintenance_schedules`     Date/odometer-based service
                                      intervals

  `vehicle_fuel_transactions`         Quantity, unit price, total,
                                      odometer, vendor, receipt

  `vehicle_expense_links`             Links vehicle/trip/work
                                      order/document to canonical AMS
                                      expense transaction

  `vehicle_alert_policies`            Thresholds, channels, recipients,
                                      escalation and restriction rules

  `notification_outbox` or shared     Queue, delivery attempts,
  notification entity                 deduplication key, status

  Shared `approval_*` entities        Approval template, instance, steps,
                                      decisions

  Shared `attachments` entity         File metadata and protected storage
                                      reference

  Shared `audit_logs` entity          Actor, action, entity, before/after
                                      or change summary
  -----------------------------------------------------------------------

### 15.2 Relationship overview

``` text
Organization (Group / Company / Branch / Department)
                    |
                    +---- Vehicles ---- Vehicle Documents
                    |         |              |
                    |         |              +---- Attachments
                    |         |
                    |         +---- Assignments ---- Users / Drivers
                    |         |
                    |         +---- Trips ---- Trip Stops / Inspections
                    |         |      |
                    |         |      +---- AMS Expense References
                    |         |
                    |         +---- Maintenance Orders ---- Vendors / Line Items
                    |         |
                    |         +---- Fuel Transactions ---- AMS Expense References
                    |         |
                    |         +---- Vehicle Status History
                    |
                    +---- Shared Approvals / Notifications / Audit Logs
```

### 15.3 Data types and constraints

-   Primary IDs: UUID.
-   Money: `DECIMAL(18,2)` or the AMS-approved precision; never floating
    point.
-   Fuel quantity and odometer: `DECIMAL` with precision sufficient for
    the unit and meter.
-   Calendar expiry dates: `DATE`; event timestamps: timezone-aware
    timestamps stored in UTC.
-   Status/type values: controlled enum or reference tables consistent
    with AMS conventions.
-   Required organization foreign keys must reference valid active
    master data.
-   Add indexes for common search, date-range reports, status filters,
    foreign keys, and notification due jobs.
-   Use database constraints for uniqueness and data integrity where
    feasible.
-   Enforce overlapping trip/assignment prevention transactionally. On
    PostgreSQL, consider exclusion constraints for time ranges where
    suitable; otherwise use explicit locking and conflict checks in a
    transaction.
-   Use soft archive for core records and preserve transactional
    history.
-   Store attachments outside the relational database when that matches
    AMS architecture; keep protected metadata and references in the
    database.

### 15.4 Recommended indexes

-   Unique index on normalized `vehicle_code`.
-   Index on normalized registration number, with duplicate policy
    explicitly defined.
-   Composite indexes on `(company_id, branch_id, status)` and
    `(vehicle_type_id, status)`.
-   Index on document `(expiry_date, status/current flag)` and
    `(vehicle_id, document_type_id)`.
-   Index on trip
    `(vehicle_id, planned_departure, planned_return, status)`.
-   Index on assignment `(vehicle_id, start_at, end_at)` and
    `(person_id, start_at, end_at)`.
-   Index on maintenance `(vehicle_id, status, planned_date)` and
    `(next_service_date)`.
-   Index on fuel `(vehicle_id, transaction_at)` and
    `(company_id, branch_id, transaction_at)`.
-   Index on notification `(status, scheduled_at)` and unique
    deduplication key.
-   Index all foreign keys used for joins and authorization checks as
    appropriate.

### 15.5 Data integrity rules

-   Registration number duplicate handling must be configurable for
    historical, disposed, or transferred vehicles; do not blindly assume
    a plate can never be reused.
-   VIN/chassis and engine numbers should use normalized comparison and
    a documented exception process.
-   Trip return odometer must be greater than or equal to dispatch
    odometer.
-   New accepted odometer readings should not be lower than the previous
    accepted reading unless a correction is approved and audited.
-   A document renewal must preserve old record history.
-   Vehicle deletion is prohibited when linked transactional records
    exist.
-   Currency and units must be explicit; do not aggregate mixed
    currencies without a defined conversion source/date.
-   Do not store Telegram bot tokens or SMTP credentials in normal
    configuration tables or source control.

------------------------------------------------------------------------

## 16. API Design

Use versioned REST APIs under `/api/v1`. Apply authentication, DTO
validation, authorization, scope filtering, pagination, rate limits
where appropriate, and consistent error responses.

### 16.1 Example endpoints

  ---------------------------------------------------------------------------------------
  Method                  Endpoint                             Purpose
  ----------------------- ------------------------------------ --------------------------
  GET                     `/vehicles`                          Search/list vehicles

  POST                    `/vehicles`                          Create vehicle draft

  GET                     `/vehicles/:id`                      View permitted vehicle
                                                               details

  PATCH                   `/vehicles/:id`                      Update permitted fields

  POST                    `/vehicles/:id/activate`             Activate after required
                                                               validation/approval

  POST                    `/vehicles/:id/restrict`             Restrict with reason

  POST                    `/vehicles/:id/archive`              Archive according to
                                                               policy

  GET                     `/vehicles/:id/documents`            List documents

  POST                    `/vehicles/:id/documents`            Register document

  POST                    `/documents/:id/renew`               Record renewal/version

  GET                     `/alerts/expiry`                     Query
                                                               upcoming/expired/missing
                                                               documents

  POST                    `/trips`                             Submit trip request

  POST                    `/trips/:id/submit`                  Submit for approval

  POST                    `/trips/:id/approve`                 Approval action through
                                                               shared engine

  POST                    `/trips/:id/dispatch`                Dispatch with checks and
                                                               odometer

  POST                    `/trips/:id/complete`                Return and complete trip

  POST                    `/maintenance/orders`                Create work order

  POST                    `/maintenance/orders/:id/complete`   Complete and request
                                                               release

  POST                    `/fuel-transactions`                 Record fuel purchase

  GET                     `/reports/vehicle-costs`             Authorized vehicle cost
                                                               report

  GET                     `/reports/expiry`                    Expiry report

  POST                    `/notifications/test`                Send authorized test
                                                               notification
  ---------------------------------------------------------------------------------------

Endpoint names may be adapted to existing AMS conventions.

### 16.2 API rules

-   Use DTO schemas with server-side validation.
-   Never accept arbitrary status changes that bypass workflow actions.
-   Use pagination and sorting limits.
-   Support idempotency keys for operations vulnerable to duplicate
    submission.
-   Return stable error codes for validation, authorization, conflict,
    and workflow-state failures.
-   Do not expose database stack traces or secrets.
-   Write audit events for important
    create/update/approval/dispatch/renewal/export operations.
-   Use transactions for multi-step operations such as trip dispatch and
    document renewal.
-   Publish OpenAPI/Swagger documentation from the backend.

------------------------------------------------------------------------

## 17. Background Jobs and Notifications

Required scheduled jobs:

1.  Document expiry scan --- daily, using configured timezone.
2.  Missing mandatory document scan --- daily or after vehicle/document
    changes.
3.  Maintenance due scan --- daily and after odometer updates.
4.  Overdue trip scan --- configurable interval.
5.  Notification delivery worker --- continuous or frequent queue
    processing.
6.  Notification retry worker --- retry temporary failures with capped
    exponential backoff.
7.  Data integrity checks --- scheduled, report-only initially where
    corrections could be consequential.
8.  Optional monthly summary email --- configurable by company/branch.

Jobs must be idempotent, observable, and safe to retry. Use a
database-backed queue/outbox or the established AMS job framework. Do
not depend on a user keeping a browser open.

------------------------------------------------------------------------

## 18. Security and Audit Requirements

-   Reuse the AMS authentication/SSO design and stable local user
    mapping.
-   Apply least privilege and scoped RBAC.
-   Enforce authorization in backend services for all
    read/write/export/download operations.
-   Require HTTPS for browser and API traffic.
-   Store secrets in deployment environment/secret management, not Git
    or application source.
-   Validate and restrict uploaded file types and sizes; scan files if
    the platform supports malware scanning.
-   Use private attachment storage and authorization-controlled
    downloads.
-   Protect Telegram bot tokens and email credentials; redact secrets
    from logs.
-   Apply input validation, output encoding, CSRF protections where
    relevant, secure cookies, and rate limiting consistent with AMS
    standards.
-   Use parameterized ORM queries; avoid raw SQL unless reviewed.
-   Log security-relevant events and failed authorization attempts
    without logging passwords, tokens, or unnecessary personal data.
-   Audit vehicle creation, edits, status changes, document renewal,
    restriction exceptions, assignment/transfer, trip approvals,
    dispatch/return, maintenance approvals, expense links, role/scope
    changes, and exports.
-   Audit records should not be editable by ordinary users.
    Administrative correction must be controlled and itself audited.
-   Define retention periods with management/legal requirements before
    production.

### 18.1 Audit event minimum fields

-   Event ID and timestamp.
-   Actor/user ID and effective role/scope.
-   Action and entity type/ID.
-   Company/branch scope.
-   Correlation/request ID.
-   Changed fields or before/after summary where safe.
-   Reason/comment where required.
-   Source (UI/API/background job).
-   Outcome (success/failure).

------------------------------------------------------------------------

## 19. Non-Functional Requirements

  -----------------------------------------------------------------------
  Area                                Proposed requirement
  ----------------------------------- -----------------------------------
  Availability                        Target 99.5% monthly for the
                                      application, excluding approved
                                      maintenance windows, subject to
                                      infrastructure capacity

  Performance                         Common list/search API p95 under 2
                                      seconds at agreed pilot load;
                                      reports may have longer documented
                                      limits

  Scale                               Support group-wide growth through
                                      pagination, indexes, and background
                                      jobs; baseline capacity must be
                                      load-tested

  Accessibility                       Keyboard-accessible forms, readable
                                      status labels, and clear validation
                                      messages

  Browser                             Current supported Edge, Chrome, and
                                      Firefox versions

  Responsive design                   Desktop-first with usable
                                      tablet/mobile layouts

  Localization                        English-first; keep labels/messages
                                      localization-ready; Myanmar
                                      language can be added

  Timezone                            Configurable organization timezone;
                                      initial suggested value
                                      `Asia/Yangon`

  Currency                            Follow AMS currency configuration;
                                      never silently combine currencies

  Observability                       Health endpoints, structured logs,
                                      job failure metrics, notification
                                      delivery metrics

  Backup                              Database and attachments backed up
                                      together under the AMS policy

  Recovery                            Set and approve RPO/RTO with
                                      management; test restore before
                                      production

  Maintainability                     Modular monolith, documented
                                      interfaces, automated tests,
                                      versioned migrations

  Data integrity                      Server validation, DB constraints,
                                      transactional workflow actions
  -----------------------------------------------------------------------

These targets are proposed starting points and must be confirmed against
the actual user count, infrastructure, and business criticality.

------------------------------------------------------------------------

## 20. Deployment Architecture

Follow the existing AMS deployment model:

``` text
Users (Browser)
      |
    HTTPS
      |
  Nginx Reverse Proxy
      |
      +---------------- React/Vite Frontend
      |
      +---------------- NestJS API
                               |
                 +-------------+-------------+
                 |             |             |
             PostgreSQL   Job/Outbox     File Storage
                 |          Worker       / Attachments
                 |             |
              Audit       Email Provider
                           Telegram Bot API
```

Deployment recommendations:

-   Add the VMS module to the existing frontend and backend repositories
    if that matches the current AMS codebase.
-   Use a modular backend structure, for example `vehicles`,
    `documents`, `assignments`, `trips`, `maintenance`, `fuel`,
    `expenses`, `alerts`, and `reports`.
-   Use Prisma migrations reviewed and tested in staging.
-   Deploy as versioned Docker images through the established CI/CD
    process.
-   Keep PostgreSQL private; do not expose its port to the public
    internet.
-   Configure HTTPS, secrets, persistent attachment storage, health
    checks, logs, disk monitoring, and backups.
-   Run scheduled jobs as controlled workers or scheduler processes with
    a single-execution/locking strategy to avoid duplicate runs.
-   Use a staging/testing environment before production.
-   Ensure rollback covers application image and database migration
    strategy; destructive schema changes require expand/migrate/contract
    planning.

------------------------------------------------------------------------

## 21. Migration and Initial Data Setup

### 21.1 Initial master data

-   Verify Group, Company, Branch, Department, Location, User, Vendor,
    Expense Category, Currency, and Approval masters in AMS.
-   Configure vehicle types and category-specific specifications.
-   Configure document types and which are mandatory for dispatch.
-   Configure alert thresholds, recipients, channels, and escalation.
-   Configure vehicle code format and duplicate registration policy.
-   Configure approval templates and cost thresholds.

### 21.2 Vehicle data import

Import from a reviewed Excel/CSV template containing:

-   Vehicle code (if existing).
-   Registration number.
-   Vehicle type.
-   Company/branch/department/location.
-   Make/model/year.
-   Chassis/VIN and engine number where available.
-   Ownership type.
-   Current odometer and date of reading.
-   Current status and condition.
-   Document type, reference, issue/expiry dates.
-   Assigned driver/custodian if applicable.
-   Purchase cost/currency where approved.
-   Notes and attachment references if available.

### 21.3 Migration procedure

1.  Inventory existing vehicle records and source files.
2.  Agree field mapping and required values.
3.  Normalize plate numbers and vehicle codes without losing original
    values.
4.  Import into staging and produce row-level validation errors.
5.  Resolve duplicates and missing required fields with business owners.
6.  Import accepted master records.
7.  Import documents, assignments, maintenance, fuel, and historical
    expenses in dependency order.
8.  Reconcile counts and key totals against source data.
9.  Review a sample of records with each company/branch.
10. Obtain sign-off and capture unresolved exceptions.
11. Cut over with a rollback plan and read-only source snapshot where
    applicable.

Never silently discard invalid rows. Record rejected rows, reasons, and
correction status.

------------------------------------------------------------------------

## 22. Testing and Acceptance Criteria

### 22.1 Functional tests

-   Create/edit/archive vehicles with valid and invalid data.
-   Configure category-specific specifications and enforce validation.
-   Register documents with issue/expiry dates and attachments.
-   Verify expiry status at 30/14/7/1 days, due today, and expired.
-   Verify missing mandatory documents appear in alerts.
-   Verify dashboard, email, and Telegram channels independently.
-   Verify deduplication, retry, and delivery-failure logging.
-   Renew a document and ensure old reminders are superseded.
-   Verify assignment and transfer history.
-   Submit, approve, reject, cancel, dispatch, return, and complete
    trips.
-   Verify overlapping bookings are rejected under concurrent requests.
-   Verify maintenance scheduling by date and odometer.
-   Verify maintenance downtime blocks allocation as configured.
-   Verify fuel calculations, odometer validation, duplicate flags, and
    expense links.
-   Verify reports and exports against known test data.

### 22.2 Security tests

-   User from Company A cannot access Company B data by changing IDs in
    the URL/API.
-   Branch user cannot export group-wide data without permission.
-   Attachment URLs cannot bypass authorization.
-   Unauthorized users cannot approve, dispatch, renew, restrict, or
    archive.
-   Self-approval rules are enforced server-side.
-   Telegram and email secrets are absent from logs and client
    responses.
-   Approval and audit history cannot be silently edited.
-   Rate limits and upload validation work as configured.

### 22.3 Acceptance tests

-   Expiry dashboard counts match the underlying document records.
-   No duplicate alert is sent for the same configured
    threshold/channel/recipient.
-   Expired mandatory documents block dispatch when policy requires it.
-   Trip distance matches accepted odometer readings.
-   Vehicle cost reports reconcile to linked AMS expense transactions.
-   Every approved/rejected workflow has actor, time, decision, and
    history.
-   Data migration totals reconcile and exceptions are documented.
-   Backup restore recovers database and attachment references
    successfully.
-   Pilot users sign off before group-wide rollout.

------------------------------------------------------------------------

## 23. Implementation Plan

Indicative timeline: approximately 8--12 weeks for a first
production-ready release, depending on existing AMS readiness,
integration complexity, data quality, and available developers. This is
an estimate, not a commitment.

### Phase 1 --- Discovery and design (Week 1)

-   Review the deployed AMS schema and shared services.
-   Confirm company/branch structure, roles, document policies, alert
    thresholds, approval matrices, and report needs.
-   Confirm notification provider and Telegram registration approach.
-   Produce approved data dictionary, screen map, and workflow diagrams.

**Exit criteria:** Business owner and IT approve requirements and
integration boundaries.

### Phase 2 --- Data model and foundations (Weeks 2--3)

-   Add VMS schema and Prisma migrations.
-   Add vehicle types/specification configuration.
-   Integrate shared identity, organization, permissions, attachments,
    audit, and approval services.
-   Add seed data and test fixtures.

**Exit criteria:** Schema review, migrations, RBAC and scope tests pass.

### Phase 3 --- Vehicle registry and documents (Weeks 3--5)

-   Build vehicle list/detail/create/edit screens.
-   Build document register, attachment support, renewal history, and
    expiry calculation.
-   Build dashboard alert list and scheduled expiry job.
-   Add email and Telegram delivery adapters and logs.

**Exit criteria:** Expiry tests and notification deduplication/retry
tests pass.

### Phase 4 --- Assignment, trips, and maintenance (Weeks 5--8)

-   Build assignments, transfers, and handover/return.
-   Build trip request, approval, allocation, dispatch, and completion.
-   Build maintenance schedules, work orders, downtime, and
    release-to-service flow.
-   Add inspections and conflict validation.

**Exit criteria:** End-to-end workflows and concurrency tests pass.

### Phase 5 --- Fuel, expenses, and reports (Weeks 7--9)

-   Build fuel transactions and odometer validation.
-   Integrate shared AMS expenses and vendor references.
-   Build standard reports and controlled exports.
-   Validate currency and cost calculation rules.

**Exit criteria:** Expense reconciliation and report acceptance tests
pass.

### Phase 6 --- UAT, migration, and security hardening (Weeks 9--11)

-   Import representative test data.
-   Run UAT with Group Fleet, branch coordinators, approvers, drivers,
    and Finance.
-   Perform access-scope, upload, notification, backup/restore, and load
    tests.
-   Fix defects and document operational procedures.

**Exit criteria:** UAT sign-off, no unresolved critical/high security
issues, restore test complete.

### Phase 7 --- Pilot and group rollout (Weeks 11--12)

-   Pilot one selected company/branch.
-   Monitor errors, alert delivery, and user feedback.
-   Correct configuration and data issues.
-   Roll out by company/branch in controlled waves.
-   Train users and publish support contacts/runbooks.

**Exit criteria:** Pilot sign-off and stable operational metrics.

### 23.1 Delivery milestones

1.  Approved requirements and data dictionary.
2.  Schema and RBAC complete.
3.  Vehicle register and document alerts complete.
4.  Trips, maintenance, assignments complete.
5.  Fuel, expense links, and reports complete.
6.  UAT and migration sign-off.
7.  Pilot acceptance.
8.  Group-wide production release.

------------------------------------------------------------------------

## 24. Risks and Mitigations

  -----------------------------------------------------------------------
  Risk                                Mitigation
  ----------------------------------- -----------------------------------
  Incomplete or inaccurate expiry     Data cleanup, mandatory fields,
  dates                               missing-document report, owner
                                      sign-off

  Email/Telegram delivery failure     Dashboard remains source of truth;
                                      retry queue, logs, monitoring

  Duplicate AMS expense postings      Shared expense IDs, idempotency,
                                      reconciliation tests

  Cross-branch data leakage           Server-side scoped authorization
                                      and negative security tests

  Conflicting vehicle reservations    Transactional conflict checks and
                                      database constraints/locking

  Inconsistent odometer readings      Validation, correction workflow,
                                      audit trail

  Unclear approval authority          Approved matrix and versioned
                                      workflow templates

  Database schema conflicts with      Review actual schema before
  current AMS                         migration; reuse canonical entities

  Overly broad first release          Deliver by phases; prioritize
                                      compliance, register, and alerts

  Unsupported legal assumptions       Business/legal owner verifies
                                      document types and policy

  Loss of attachments during restore  Back up database and file storage
                                      together and test recovery
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## 25. Decisions Required Before Development

The following decisions require business/IT approval:

-   [ ] Final list of companies, branches, departments, and fleet
    coordinators.
-   [ ] Vehicle code format and uniqueness scope.
-   [ ] Duplicate registration/VIN/chassis number policy.
-   [ ] Required fields for each vehicle type.
-   [ ] Document types required for each vehicle type and company.
-   [ ] Which expired/missing documents block trip approval or dispatch.
-   [ ] Default and maximum alert thresholds.
-   [ ] Dashboard/email/Telegram recipient rules and escalation.
-   [ ] Telegram bot ownership, user/chat registration, and security
    policy.
-   [ ] Approval matrix for trips, repairs, renewals, fuel, transfers,
    and disposal.
-   [ ] Expense thresholds and integration with existing AMS financial
    records.
-   [ ] Driver master source and driver license validation requirements.
-   [ ] Maintenance schedule rules by vehicle type.
-   [ ] Currency, fuel units, odometer units, and timezone.
-   [ ] Data retention and audit retention policy.
-   [ ] Initial migration source and data owner.
-   [ ] Hosting, backup, RPO/RTO, and production support responsibility.

------------------------------------------------------------------------

## 26. Definition of Done

A VMS feature is complete only when:

-   [ ] Requirement and business rule are documented.
-   [ ] Data model and migration are reviewed.
-   [ ] Backend validation and authorization are implemented.
-   [ ] Organization scope is enforced in all APIs and exports.
-   [ ] Frontend loading, empty, validation, success, and error states
    are implemented.
-   [ ] Audit events are implemented where required.
-   [ ] Unit and integration tests pass.
-   [ ] Workflow and concurrency tests pass where applicable.
-   [ ] Documentation and OpenAPI definitions are updated.
-   [ ] Logs and monitoring are available.
-   [ ] Backup/restore implications are considered.
-   [ ] Staging/UAT acceptance is recorded.
-   [ ] Release and rollback procedures are documented.

------------------------------------------------------------------------

## 27. Final Recommendation

Implement VMS as a modular feature inside the existing AMS, reusing its
organization hierarchy, authentication, scoped RBAC, approvals, vendor
and expense masters, attachments, audit, reporting, and deployment
processes. Keep vehicle operations in dedicated module tables and APIs,
while linking financial transactions to the existing AMS expense source
of truth.

For the first release, prioritize:

1.  Vehicle register and organization scope.
2.  Document register, expiry dashboard, email/Telegram alerts, and
    mandatory-document restrictions.
3.  Assignment and transfer history.
4.  Trip request/approval/dispatch/return.
5.  Maintenance schedule and work orders.
6.  Fuel records and odometer controls.
7.  AMS expense integration and standard reports.
8.  Security, migration, backup/restore, UAT, and controlled rollout.

Do not begin production coding until the existing AMS schema and shared
services have been reviewed and the decisions in Section 25 are
approved. This prevents duplicate masters, duplicate expenses,
inconsistent approval logic, and expensive rework.
