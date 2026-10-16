# Freebuff AI Coding Plan — Fleet Management System (FMS)

## 1. Purpose

This document is a practical implementation guide for building the Fleet Management System (FMS) with Freebuff AI Coding Agent.

## Important GPS Assumption

The current fleet vehicles already use GPS devices and an existing GPS Company's web-based tracking platform.

For the current FMS project, **assume that the existing GPS Company's API is NOT available**.

Therefore:

- Do not make Core FMS dependent on the existing GPS Company's API.
- Do not scrape or automate the existing GPS Company's website.
- Do not require replacement of the existing GPS devices.
- Live GPS tracking is **not a current implementation dependency**.
- GPS integration is a **Future / Optional Integration**.
- Core FMS must operate fully without GPS integration.
- Keep a clean integration boundary so a GPS provider/API can be added later without redesigning Core FMS.


The existing FMS requirements define the following major areas:

- Kilo & Distance Tracking
- Fuel Management
- Maintenance & Repair
- Asset & Driver Management
- GPS & Route Management
- AI Predictive Maintenance
- AI Fuel Theft & Anomaly Detection
- AI Driver Behavior & Safety Analysis
- AI Route Optimization & Dynamic Dispatch
- AI Analytics & Assistant
- Expense & Financial Analytics

The implementation should be incremental. Do not ask the coding agent to build the entire FMS in one operation.

---

# 2. Recommended AI Coding Workflow

Use this workflow for every major module:

1. Analyze
2. Plan
3. Implement
4. Review
5. Test
6. Fix
7. Document

### Rule

The AI coding agent must first inspect the existing project before changing code.

Do not allow it to:

- Rewrite the whole project unnecessarily
- Change unrelated modules
- Replace the existing architecture without approval
- Create duplicate business logic
- Remove existing functionality without explicit approval
- Add AI features before the required data model exists

---

# 3. Master Project Prompt

Use the following prompt when starting the project:

```text
You are the lead software architect and senior full-stack engineer for this Fleet Management System.

First, inspect the existing repository completely enough to understand:

- Application architecture
- Backend framework
- Frontend framework
- Database technology
- Existing modules
- Authentication and authorization
- API conventions
- UI conventions
- Validation patterns
- Testing strategy
- Configuration and environment variables
- Existing coding standards

DO NOT modify files during the initial analysis.

Create a technical implementation plan for the Fleet Management System based on the supplied requirements.

The system must be designed for long-term maintainability and future AI/IoT integration.

Priorities:

1. Correct domain model
2. Data integrity
3. Security
4. Role-based authorization
5. Auditability
6. API consistency
7. Testability
8. Performance
9. AI-ready historical data
10. GPS/telematics integration readiness

Separate Core FMS functionality from AI functionality.

Do not implement AI features until the required operational data model is stable.

After analysis, report:

- Current architecture
- Recommended architecture
- Database entities
- Relationships
- Main modules
- API boundaries
- Security model
- Implementation phases
- Risks
- Assumptions
- Questions requiring human approval

Do not write code yet.
```

---

# 4. Phase 0 — Architecture & Database

## Objective

Establish a stable foundation before implementing business modules.

### Recommended core entities

- users
- roles
- permissions
- departments
- vehicles
- vehicle_documents
- drivers
- driver_documents
- vehicle_assignments
- trips
- trip_stops
- odometer_readings
- fuel_transactions
- fuel_receipts
- maintenance_records
- maintenance_items
- spare_parts
- workshops
- expenses
- gps_positions
- geofences
- alerts
- audit_logs

AI-related tables should be introduced only where they are justified by actual data requirements.

### Prompt

```text
Implement Phase 0 only.

Create or update the database architecture required for the Fleet Management System.

Before changing anything:

1. Inspect the current database.
2. Identify existing entities that can be reused.
3. Identify missing entities.
4. Check naming conventions.
5. Check foreign keys and indexes.
6. Check audit requirements.
7. Check soft-delete requirements where appropriate.

Do not implement UI yet.

Create migrations/models/entities according to the existing project's conventions.

Add appropriate:

- Primary keys
- Foreign keys
- Unique constraints
- Indexes
- Timestamps
- Audit fields where required
- Status fields
- Data validation rules

Do not create speculative tables that are not currently justified.

After implementation, run database validation and tests.

Report every file changed.
```

---

# 5. Phase 1 — Vehicle Management

## Scope

Implement:

- Vehicle profile
- Plate number
- Model
- Chassis number
- Engine number
- Vehicle type
- Department
- Status
- Vehicle documents
- Wheel tax renewal
- Insurance renewal
- Periodic inspection
- Expiry reminders

### Prompt

```text
Implement Phase 1 — Vehicle Management.

Follow the existing architecture and coding conventions.

Required functionality:

- Vehicle CRUD
- Vehicle status
- Vehicle type
- Department assignment
- Plate number
- Chassis number
- Engine number
- Vehicle documents
- Document expiry tracking
- Renewal reminders

Requirements:

- Server-side validation
- Authorization
- Duplicate prevention
- Audit logging
- Search
- Filtering
- Pagination
- Proper error handling
- Automated tests

Do not modify unrelated modules.

After implementation, review the code for security and data-integrity issues.
```

---

# 6. Phase 2 — Driver Management

## Scope

- Driver profile
- Contact information
- License type
- License expiry
- Emergency contact
- Driver documents
- Driver-to-vehicle assignment

### Prompt

```text
Implement Phase 2 — Driver Management.

Use the existing database and architecture.

Implement:

- Driver CRUD
- License information
- License expiry tracking
- Driver documents
- Emergency contact
- Driver status
- Vehicle assignment

Prevent invalid assignments.

For example:

- Expired driver license
- Inactive driver
- Inactive vehicle

must be validated according to business rules.

Add authorization, audit logging, tests, search, filtering and pagination.

Do not modify unrelated modules.
```

---

# 7. Phase 3 — Trip & Odometer Management

## Scope

- Trip creation
- Driver assignment
- Vehicle assignment
- Start kilometer
- End kilometer
- Distance calculation
- Trip status
- Trip history
- Daily/monthly mileage

### Prompt

```text
Implement Phase 3 — Trip and Odometer Management.

Implement:

- Trip creation
- Vehicle assignment
- Driver assignment
- Start location
- Destination
- Start date/time
- End date/time
- Start odometer
- End odometer
- Calculated distance
- Trip status
- Trip history

Business rules:

- End odometer cannot be less than start odometer.
- Vehicle and driver must be eligible for assignment.
- Kilometer records must be auditable.
- Manual corrections must be tracked.

Add daily and monthly mileage aggregation.

Add tests for calculation and validation edge cases.
```

---

# 8. Phase 4 — Fuel Management

The original FMS requirements include fuel date/time, station, fuel type, quantity, total cost, price per liter and receipt upload.

### Prompt

```text
Implement Phase 4 — Fuel Management.

Implement:

- Fuel transaction
- Date/time
- Station
- Station location
- Fuel type
- Quantity
- Unit price
- Total cost
- Vehicle
- Driver
- Odometer
- Receipt upload
- Fuel history

Calculate:

- Cost per liter
- Distance per liter
- Fuel consumption
- Fuel cost per kilometer

Validate:

- Quantity > 0
- Unit price >= 0
- Total cost consistency
- Odometer consistency
- Vehicle assignment

Create reporting APIs and dashboard data.

Do not implement AI fuel theft detection yet.
```

---

# 9. Phase 5 — Maintenance & Repair

The requirements include preventive maintenance, corrective maintenance, spare parts, labor cost and breakdown history.

### Prompt

```text
Implement Phase 5 — Maintenance and Repair.

Implement:

Preventive Maintenance:
- Engine oil
- Filters
- Tires
- Brakes
- Battery
- Fluids
- Kilometer-based schedules
- Time-based schedules

Corrective Maintenance:
- Repair work orders
- Workshop
- Repair description
- Spare parts
- Labor cost
- Total cost
- Breakdown history

Implement maintenance alerts.

Track:

- Previous service
- Next service
- Service interval
- Kilometer threshold
- Date threshold
- Maintenance status

Add audit logging and tests.

Do not implement predictive maintenance yet.
```

---

# 10. Phase 6 — Expense & Financial Analytics

### Prompt

```text
Implement Phase 6 — Expense and Financial Analytics.

Track:

- Fuel cost
- Maintenance cost
- Spare parts
- Labor
- Tolls
- Parking
- Penalties/fines
- Other operational expenses

Calculate:

- Total vehicle cost
- Cost per kilometer
- Fuel cost per kilometer
- Maintenance cost per kilometer
- Fleet utilization
- Vehicle-level monthly cost
- Department-level cost

Provide dashboard-ready APIs.

Do not create financial accounting functionality unless explicitly required.
```

---

# 11. Phase 7 — GPS & Telematics Integration

The requirements include real-time GPS tracking, geofencing and trip history playback.

### Important

GPS integration depends on the actual tracker/device/API provider.

Do not hard-code assumptions about the GPS vendor.

### Prompt

```text
Implement GPS integration architecture without assuming a specific vendor.

Create a provider abstraction such as:

GPS Provider Interface
    |
    +-- Provider A
    +-- Provider B
    +-- Future Provider

Support:

- Vehicle location
- Latitude
- Longitude
- Timestamp
- Speed
- Heading
- GPS device ID
- GPS status
- Trip history

Prepare the system for:

- Real-time tracking
- Geofencing
- Historical route playback

Do not tightly couple the FMS domain model to a specific GPS vendor.

Document the integration contract and required API fields.
```

---

# 12. Phase 8 — AI Foundation

Before implementing AI, create reliable historical datasets.

The AI layer should consume operational data rather than becoming the source of truth.

Recommended architecture:

```text
Operational Database
        |
        v
Data Preparation / Feature Extraction
        |
        v
AI / Analytics Layer
        |
        v
Prediction / Anomaly / Recommendation
        |
        v
FMS Dashboard + Alerts
```

AI outputs must be traceable to the underlying data.

---

# 13. AI Feature 1 — Predictive Maintenance

The requirements propose using telematics, engine sensors, mileage and workshop history to predict component failures.

### Prompt

```text
Implement the foundation for AI Predictive Maintenance.

Do NOT claim that a prediction model is accurate unless sufficient historical data exists.

First implement:

- Maintenance history dataset
- Vehicle mileage history
- Component/service history
- Breakdown history
- Feature extraction pipeline
- Prediction result storage
- Prediction timestamp
- Model/version metadata
- Confidence value where supported
- Explanation/reference data

Create a baseline analytics implementation before introducing a machine-learning model.

The system must distinguish:

1. Historical fact
2. Statistical estimate
3. AI prediction

Do not automatically create maintenance work orders from an AI prediction without explicit business approval.
```

---

# 14. AI Feature 2 — Fuel Anomaly Detection

The requirements include detecting unusual fuel reduction/leak/theft patterns and OCR receipt processing.

### Prompt

```text
Implement AI-assisted Fuel Anomaly Detection.

First create rule-based anomaly detection.

Compare:

- Fuel quantity
- Odometer
- Distance
- Vehicle fuel efficiency history
- GPS trip data when available
- Fuel transaction timing

Identify unusual patterns.

Store:

- Detection timestamp
- Vehicle
- Transaction
- Anomaly type
- Supporting data
- Detection method
- Confidence
- Review status

Do not automatically label an event as theft.

Use neutral statuses such as:

- Normal
- Review Required
- Possible Leak
- Possible Data Error
- Unusual Consumption

Human review must remain available.

OCR receipt processing should extract:

- Date
- Station
- Fuel type
- Quantity
- Unit price
- Total cost

All OCR-extracted values must be reviewable before final confirmation.
```

---

# 15. AI Feature 3 — Driver Safety Analytics

The requirements include speeding, harsh braking, aggressive driving and optional camera-based monitoring.

### Prompt

```text
Implement Driver Safety Analytics.

Start with telemetry-based analytics:

- Speeding events
- Harsh braking
- Harsh acceleration
- Excessive cornering
- Trip duration
- Distance

Do not implement a subjective driver score initially.

Instead provide measurable event counts and trends.

If a future safety score is implemented, document:

- Formula
- Inputs
- Weighting
- Time period
- Limitations

Camera-based DMS should be treated as a separate integration because it requires compatible hardware and privacy/security controls.
```

---

# 16. AI Feature 4 — Route Optimization

### Prompt

```text
Design Route Optimization as a separate service/module.

Inputs may include:

- Destination
- Vehicle location
- Vehicle type
- Vehicle capacity
- Driver availability
- Traffic data
- Road restrictions
- Fuel efficiency

Do not assume live traffic or weather data exists.

If external data is unavailable, the system must continue operating using available data.

The recommendation must be explainable:

- Why this vehicle was selected
- Why this route was selected
- Estimated distance
- Estimated duration
- Estimated fuel impact
```

---

# 17. AI Feature 5 — Natural Language Fleet Assistant

The requirements include questions such as:

- Which vehicle required the most engine-oil changes last month?
- Which driver had the highest fuel cost?

### Prompt

```text
Implement a Natural Language Fleet Assistant.

Security is mandatory.

The AI assistant must respect the logged-in user's permissions.

It must not directly execute arbitrary SQL generated by an LLM.

Use a controlled query layer:

User Question
    ->
Intent Detection
    ->
Allowed Query Definition
    ->
Validated Query
    ->
Database
    ->
Result
    ->
Natural Language Response

The assistant must identify the data period used in its answer.

If the data is insufficient, say so instead of inventing an answer.

Keep an audit record of AI-generated queries/actions where appropriate.
```

---

# 18. Dashboard Requirements

Create dashboards only after the underlying modules exist.

Recommended dashboards:

## Fleet Dashboard

- Total vehicles
- Active vehicles
- Idle vehicles
- Vehicles requiring maintenance
- Expiring documents
- Current trips
- Monthly mileage
- Monthly fuel cost
- Maintenance cost
- Cost per kilometer

## Fuel Dashboard

- Total fuel consumption
- Fuel cost
- Fuel efficiency
- Vehicle comparison
- Unusual fuel events
- Receipt verification status

## Maintenance Dashboard

- Upcoming maintenance
- Overdue maintenance
- Maintenance cost
- Breakdown count
- Parts usage

## Driver Dashboard

- Active drivers
- License expiry
- Trip count
- Distance
- Safety events

---

# 19. Security Requirements

Every module should implement:

- Authentication
- Authorization
- Role-based access control
- Input validation
- Server-side validation
- Audit logging
- Secure file upload
- File type validation
- File size validation
- Access control for uploaded receipts/documents
- Rate limiting where appropriate
- Secure secrets/configuration
- Error handling without leaking sensitive information

AI features must follow the same authorization rules as normal application features.

---

# 20. Testing Requirements

For every module, require:

### Unit Tests

Business calculations and validation.

### Integration Tests

Database and API behavior.

### Authorization Tests

Verify that users cannot access unauthorized fleet data.

### Edge Cases

Examples:

- Negative fuel quantity
- Invalid odometer
- Duplicate plate number
- Expired license
- Expired vehicle document
- Vehicle already assigned
- Driver unavailable
- Missing GPS data
- Duplicate GPS events
- OCR extraction errors
- Incomplete maintenance history

---

# 21. AI Coding Agent Review Prompt

Use this after every major implementation:

```text
Review the current implementation as a senior software architect.

Do not modify files.

Check:

1. Security
2. Authorization
3. Data integrity
4. Database design
5. API consistency
6. Validation
7. Error handling
8. Performance
9. Duplicate logic
10. Code maintainability
11. Test coverage
12. AI data quality
13. Auditability

For every issue provide:

- Severity
- File
- Problem
- Why it matters
- Recommended fix

Do not invent issues.
```

---

# 22. Final Verification Prompt

```text
Perform a complete production-readiness review of the Fleet Management System.

Do not modify files initially.

Verify:

- Core modules
- Database migrations
- API endpoints
- Authentication
- Authorization
- File uploads
- Audit logging
- GPS integration architecture remains optional
- Core FMS works without GPS
- No dependency on the existing GPS Company's API
- Fuel calculations
- Maintenance calculations
- Expense calculations
- Dashboard calculations
- AI data pipelines
- AI permission boundaries
- Tests
- Error handling
- Environment configuration
- Deployment configuration
- Backup/recovery considerations

Identify blockers separately from improvements.

Do not declare the system production-ready unless the evidence supports it.
```

---

# 23. Recommended Development Order

Use this order:

```text
Phase 0  Architecture + Database
   |
Phase 1  Vehicle Management
   |
Phase 2  Driver Management
   |
Phase 3  Trip + Odometer
   |
Phase 4  Fuel
   |
Phase 5  Maintenance
   |
Phase 6  Expense + Analytics
   |
Phase 7  GPS Integration Architecture (Future / Optional — No Live Integration)
   |
Phase 8  AI Foundation
   |
Phase 9  Predictive Maintenance
   |
Phase 10 Fuel Anomaly Detection + OCR
   |
Phase 11 Driver Safety Analytics
   |
Phase 12 Route Optimization
   |
Phase 13 AI Fleet Assistant
   |
Phase 14 Production Review
```

---

# 24. Important Rules for Freebuff

1. Never ask the agent to build the whole application in one prompt.
2. Always inspect before modifying.
3. Keep each task limited to one module or closely related feature.
4. Ask the agent to report changed files.
5. Review before accepting large changes.
6. Run tests after every major phase.
7. Keep database migrations version-controlled.
8. Do not allow AI predictions to silently become business decisions.
9. Keep AI output explainable and auditable.
10. Treat GPS, camera/DMS, OCR and external services as integrations with explicit interfaces.
11. The current GPS provider is assumed to have no available API. Do not make Core FMS dependent on it.
12. GPS integration must remain optional and be added later when a supported API/integration method becomes available.
11. Do not expose sensitive fleet information to users without authorization.
12. Do not use AI-generated code without testing and review.

---

# 25. Definition of Done

A module is considered complete only when:

- Database changes are implemented
- API/backend is implemented
- UI is implemented where required
- Validation exists
- Authorization exists
- Audit logging exists where required
- Tests exist
- Edge cases are handled
- Documentation is updated
- No unrelated files were unnecessarily changed
- Review has been completed
- Tests pass

---

# 26. Final Principle

The FMS should be built as a reliable operational system first and an AI-powered system second.

The AI layer should use trustworthy historical operational data from:

- Vehicles
- Drivers
- Trips
- Odometers
- Fuel
- Maintenance
- Expenses
- GPS/Telematics

This approach makes future AI capabilities more useful, explainable and maintainable.
