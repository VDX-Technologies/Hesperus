# VDX Core Architecture

This document explains **how the Core works from end to end**, from a sensor sending a reading all the way to the graph displayed to the customer in the web console. It is written for anyone: new developers, technical operators, and product managers. Where relevant, specific source files are referenced for further exploration.

---

## 1. What the Core Is, in One Sentence

The Core is a **platform that receives data from field devices, stores it, processes it, generates alerts, and displays it to customers** in a web console.

The Core is divided into two parts:

- **Engine**: the generic core engine (`lib/engine/`). It knows nothing about greenhouses, specific sensors, or particular industry verticals. It only manages "objects", "metrics", "events", "rules", and "alerts".
- **Modules (packages)**: domain-specific knowledge (`lib/packages/`). Currently includes **LoRa**, used for greenhouse climate monitoring. A module informs the engine about what object types exist, how to parse raw incoming payloads, and what calculations to execute.

This design keeps the engine identical across every industry vertical; adding support for a new product simply requires writing a new module.

A module is not always necessary. A customer can define their **own types** of objects and events (`custom` module) directly from the schema editor and ingest them via `/api/push`. **VDX Research** is built entirely this way: projects, datasets, and pipeline results (the first being TESS, for anomalous stars) are purely schema configuration (§11.6, §16).

---

## 2. Minimal Glossary

| Term | Meaning |
|---|---|
| **Organization (org / tenant)** | A customer. All data belongs to an organization and is strictly isolated from that of other customers. |
| **Membership** | A user who belongs to an organization with a specific role: `owner`, `member`, or `viewer`. |
| **Platform admin** | A member of VDX staff with access across all customer tenants. |
| **Module** | A domain package (e.g. `lora`) enabled for an org (`org_modules`), complete with its configuration (the customer's threshold settings). |
| **Console** | A dedicated dashboard UI (currently `terra` and `research`) enabled by staff for an org (`organizations.consoles`). An org has at least one; new orgs start with Terra. |
| **Source** | An ingestion channel through which data arrives (e.g. a LoRa gateway). Authenticated via a secret token. |
| **Object** | A real-world entity: a sensor node, a greenhouse, a research project... It has an object type (`object_type`), properties, and state. |
| **Metric** | A time-series numeric value bound to an object (e.g. temperature at 10:05 = 24.3). |
| **Rollup** | An aggregated summary of metrics over 5-minute or 1-hour buckets (min, max, avg, count). |
| **Event** | An occurrence at a point in time (e.g. "irrigation started", "alert opened"). |
| **Rule** | "If metric X exceeds threshold Y for Z seconds, trigger an alert". |
| **Alert** | An active issue opened on an object (`object_alerts`), which resolves automatically once values return to normal. |
| **Raw** | The original inbound payload, preserved exactly as received, prior to any processing. |
| **Custom type** | A customer-defined object or event type (`custom.<key>`) configured in the schema editor without code: properties, declared links, field ordering. |
| **Source scope** | The boundary restriction of a `custom` source (`sources.config.scope`): the root object it operates against (e.g. a project), the link specifying it, and other permitted types. Out-of-scope messages are rejected. |

---

## 3. The Big Picture

```
  Field                     Core (Vercel + Supabase + R2)                     Users
 ───────                   ──────────────────────────────                    ───────

 Sensors ─► Gateway ──HTTPS──► POST /api/push ──► Engine (ingest)
                     Bearer token        │
                                         ├─► raw_inbox ──(hourly)────► R2 (raw archive .jsonl.gz)
                                         │
                                         ├─► Module: normalize + step
                                         │
                                         ├─► objects / metrics / events      (Postgres)
                                         │
                                         └─► Rules ─► object_alerts ─┐
                                                                     │
                     pg_cron (every 15 min): rollups, retention,     │ Supabase Realtime
                     partitions                                      ▼
                                                             Web Console (Next.js)
                     GitHub Actions (hourly): flush raw,     /terra/o/[slug]  ◄── Customers
                     health check ──► email (Resend)        /admin           ◄── VDX Staff
```

Technologies:

- **Next.js 16 + React 19** for the web console and APIs, hosted on **Vercel** (`fra1` region).
- **Supabase** for authentication, Postgres database, Row Level Security (RLS), and Realtime subscriptions.
- **Direct Postgres** connection pool (`pg`, `DATABASE_URL`) for heavy engine operations.
- **Cloudflare R2** (S3-compatible) for raw payload archiving.
- **pg_cron** inside Postgres for recurring database maintenance tasks.
- **GitHub Actions** for deployments and hourly scheduled cron jobs.
- **Resend** for operational system health alerts and notifications.

---

## 4. Customers, Users, and Security

### 4.1 Structure

```
organizations ──< memberships >── users (Supabase auth)
      │   .consoles  (active dashboards: e.g. {terra,research})
      │
      ├──< org_modules   (enabled products and their config)
      └──< sources, objects, metrics, events, alerts…  (all keyed by tenant_id)
```

Physical locations are modeled as `core.site` / `core.area` objects linked via `part_of` and `located_in`. Legacy `sites` and `zones` tables were dropped (`20261023000000_drop_sites_zones.sql`) after migrating data into objects.

`platform_admins` defines VDX staff members.

### 4.2 Access Control and Roles

Primary access control is enforced via Postgres **Row Level Security (RLS)**: every table defines policies determining which rows a user can read or modify. These policies rely on SQL helper functions:

- `is_platform_admin()`: Is the current user a member of VDX staff?
- `org_role(org)`: What role does the user hold in that organization?
- `can_read(org)`: Is the user an admin or any member of the organization?
- `can_manage(org)`: Is the user an admin or an organization `owner`?

An organization owner can **only** edit the `config` column of their enabled modules (threshold settings); they cannot enable or disable products directly.

### 4.3 Control Layers in the Application

1. **`proxy.ts`** (Next.js 16 proxy / middleware): refreshes the Supabase session and redirects unauthenticated requests to `/login`. This is a fast preliminary gateway check, not the primary security boundary.
2. **`lib/auth.ts`**: helper functions `requireUser`, `requireAdmin`, `requireOrg(slug)` strictly verify the user, role, and tenant membership on every server-rendered page and Server Action.
3. **Database RLS**: the ultimate defense layer.

> Important: the engine and `lib/packages/console.ts` utilize direct Postgres pooling, which **bypasses RLS**. Consequently, every query executed through the pool must explicitly filter by `tenant_id`. Any new query written using the pool must maintain this invariant.

---

## 5. The Engine Ontology (Data Modeling)

The engine describes domain models through a small set of generic abstractions (migration `supabase/migrations/20261017000000_engine_ontology.sql` and subsequent migrations):

| Table | Description |
|---|---|
| `object_types` | Object type definitions, owned by a module (e.g. `lora.node`, or `custom.result` for customer-defined schemas), containing property schemas, **declared links** (`links`: key → target type, required or optional), and `field_order`. Triggers `validate_properties`, `objects_validate_schemas`, and `links_validate_declared` enforce schema and link integrity. |
| `objects` | Concrete object entities. `properties` contains descriptive attributes (name, config, latest IR thermal frame...). `state` holds runtime computational state: `state.derived` for engine-calculated metrics and `state.pkg` for module state. `last_seen` records when the object last ingested data. |
| `links` | Relationships between objects. |
| `metrics` | One row per (object, metric, timestamp, value). **Partitioned daily**, making historical data eviction as fast as dropping an entire partition. |
| `metric_rollups` | 5-minute and 1-hour pre-aggregated metric summaries. |
| `events` + `event_objects` | Event records and the associated objects they reference. |
| `documents` + `document_objects` | Documents (files stored on R2) and their associations with objects. |
| `event_types` | Structured event schemas for registries: `fields`, `subject`, `also` (additional object types that can be referenced), and `field_order`. |
| `sources` | Ingestion conduits (`push`, `pull`, `upload`). The auth token is **never stored in plaintext**: only its SHA-256 hash (`token_hash`) and its trailing characters (`token_hint`) are stored. |
| `raw_inbox` | Staging table for incoming raw payloads awaiting hourly compression and archiving to R2. |
| `rules`, `rule_state`, `object_alerts` | Alert rules, evaluation state machines, and active alerts (see §7). |
| `engine_settings` | Dynamic operational limits and engine configuration parameters (see §9). |
| `engine_jobs`, `engine_usage`, `engine_notices` | Background job statuses, usage metrics (e.g. R2 operational counters), and deduplicated email notification tracking. |

Legacy tables (`readings`, `alerts`, `gateways`, `devices`) have been retired. All data flows exclusively through engine objects.

Custom types leverage two advanced property formats (`lib/engine/schema.ts`):

- **`format: "schema"`**: the property itself stores a child schema definition. Example: a project's `result_schema` (TIC ID, orbital period, sector, etc.).
- **`schemaFrom: "<link>.<property>"`**: the property is dynamically validated against the schema defined on the linked object. Example: `custom.result.extra` conforms to the `result_schema` of its linked project. This allows each project to possess arbitrary result structures without modifying code or creating new table schemas.

Schema validation is enforced at the database level via triggers (migration `20261105000000_custom_object_types.sql`), ensuring strict consistency across the web console, push APIs, and automation scripts.

---

## 6. The Journey of a Data Point

This represents the primary data lifecycle. Below is the step-by-step path of a message from the gateway to the user interface.

### 6.1 Ingestion: `POST /api/push`

The gateway sends an HTTPS POST request containing an `Authorization: Bearer <token>` header and a JSON payload (containing one or more messages). The handler in `app/api/push/route.ts` forwards the request to `ingestPush` in `lib/engine/ingest.ts`.

Preliminary validation steps, executed in order:

1. The token hash must match an existing source; otherwise, the request is immediately rejected (`401`).
2. The source must be of type `push` and not paused.
3. The module assigned to the source must be enabled for the tenant.
4. The request payload body cannot exceed 4 MB.
5. Every item in the batch must be a valid JSON object.
6. The message count cannot exceed `ingest.max_batch` (default 500).

### 6.2 Raw Persistence First: Zero Data Loss

Every payload item is written **immediately** to `raw_inbox` prior to downstream processing. Should a transformation bug arise in business logic, original data remains intact for retrospective replay (see replay, §8.2).

### 6.3 Module Interpretation: `normalize`

The engine loads (with in-memory caching) the object types and metrics declared by the package (`registerPackage`). Each incoming message is then passed to `pkg.normalize`, which maps the raw payload into standard engine primitives: *"this belongs to object X of type Y, with these timestamped metrics, and these associated events"*.

If a message is malformed (`ValidationError`), **only that individual message is discarded**; valid messages within the batch continue processing. Telemetry timestamps set too far into the future are also rejected (`ingest.max_future_s`, 300 s).

### 6.4 Sequential Object and State Calculation

1. Every referenced object is created or updated once per batch (upsert by type + external ID).
2. For each object, **in strict chronological order**:
   - `applyDerived` computes module-declared derived metrics (average, sum, min, max, difference, ratio, delta, rate of change).
   - `pkg.step` executes stateful module logic (e.g. accumulating continuous leaf-wetness duration hours).
   - The updated computational state is saved in `objects.state`, allowing the next payload to resume seamlessly.

### 6.5 Persistence

- **Metrics**: batch inserted with `ON CONFLICT DO NOTHING`. If identical datapoints arrive multiple times, duplicates are ignored, ensuring complete *idempotency*. Metrics **not explicitly declared** by the module are excluded from `metrics` and preserved only in the raw archive.
- **Events**: stored under the namespaced key `<module>.<type>`, e.g. `lora.irrigation`.

### 6.6 Rules, Alerts, and Responses

- Threshold rules are evaluated against newly arrived datapoints (see §7). Rule evaluation is bypassed during replay runs.
- If a device configuration version lags behind the current desired state (`configAck`), the newer configuration payload is attached to the HTTP response, enabling the gateway to reconfigure field hardware.
- Triggered *alert hooks* (`lib/engine/hooks.ts`) are invoked asynchronously, providing an integration point for downstream AI/notification layers. Hook failures never interrupt the ingestion pipeline.
- `sources.last_seen` and `last_error` timestamps and messages are updated.

The HTTP response details accepted/rejected counts, written metric and event counts, triggered alerts, and pending configurations. If **all** messages in the payload are rejected, HTTP status `422` is returned.

### 6.6b Ingestion for Custom Types (`lib/engine/custom-ingest.ts`)

A push source configured with `module = 'custom'` bypasses package loaders: `ingestCustom` writes customer-defined objects and events directly:

- **Objects** (`{kind: "object", type, externalId, name, properties, defaults, links}`): upserted by type + `externalId` (**idempotent**). Returned statuses are `created`, `updated`, and `unchanged`. Default values (`defaults`) apply only upon initial creation, preventing subsequent ingest runs from overwriting manual console edits. Explicitly passing `null` removes a property.
- **Events** (`{kind: "event", type, key, payload, objects}`): the deduplication `key` is mandatory; identical keys are ignored (returning `duplicate`). Objects are referenced either by internal ID or by `{type, externalId}`.
- **CSV Ingestion**: supported via `Content-Type: text/csv` and query parameter `?type=<type>`. Columns map to `external_id`, `name`, `link.<key>`, properties (`prop.sub` for nested properties), and `default.<prop>`. Both comma and semicolon separators, as well as European decimal commas, are parsed automatically (`csvMessages`).
- **Scope Enforcement**: when `sources.config.scope = {link, id, also}` is set, the source is restricted to creating objects linked to `id` through `link` (the link is injected automatically), plus types listed in `also`. It cannot alter its parent scoping object nor associate events with foreign projects.
- **Audit Logging**: all mutations are recorded in `audit_log` with the actor set to `source:<name>`.
- **Limits**: bounded by `custom.objects_max` per tenant, in addition to standard ingestion size constraints (§6.1).

### 6.6c Attachments: `POST /api/push/document`

Using the same source token, a `custom` source can attach files to an object via `multipart/form-data` (`file` plus `objectId`, or `type` + `externalId`). Files are uploaded to R2 at `docs/<tenant>/<source>/<sha256>-<name>`, registered in `documents`, and bound via `document_objects`. Uploading identical file content to the same target object returns status `duplicate` alongside the existing `documentId`. Guardrails: `push.document_max_bytes` (`413`) and `push.documents_per_day` (`429`). Actions are audited under `document.create` and `document.attach`. During local development without R2 credentials, files are stored locally under `.data/store` (`FileStore`, gitignored).

### 6.6d Python Client (`clients/python/vdx_core_client`)

A dependency-free Python client for data pipelines: `Client(base_url, token)` provides `.send(messages)` (in 500-item chunks), `.send_csv(type, text_or_file)`, and `.attach(file, ref(type, external_id))`. Methods `.iter_results(filter)` and `.get_results(filter)` retrieve project results with revision statuses (`GET /api/research/results`, paginated in chunks of 1000; the filter mirrors project console queries as a dictionary or query string). Helpers `obj`, `event`, and `ref` construct payload envelopes. The client transparently retries on `429` following `Retry-After`. A `422` returns validation errors, while other HTTP errors raise `CoreError(status)`.

### 6.7 Realtime Updates on Screen

The web console subscribes to `objects` and `object_alerts` via **Supabase Realtime** (`components/terra/live-refresh.tsx`). When data updates occur, the page initiates a server refresh debounced by 800 ms to coalesce bursts of events. A fallback periodic refresh fires every 60 seconds.

### 6.8 Another Entry Point: CSV File Uploads

Not all data originates from automated gateways: logbooks and registries (harvest logs, agronomic treatments) often live in spreadsheets. A source configured with `connector = 'upload'` accepts CSV files uploaded through the console at `/terra/o/[slug]/upload`. Implemented in `lib/engine/upload.ts` (`ingestUpload`) and `lib/engine/csv.ts`.

1. Only organization **owners** can upload files. The target source must be of type `upload`, active, and owned by the tenant.
2. Controlled by `engine_settings`: maximum payload size (`upload.max_bytes`, `413`), maximum rows (`upload.max_rows`, `413`), and daily uploads per source (`upload.files_per_day`, `429`; rejected uploads do not decrement this quota).
3. Encodings are decoded as UTF-8 with automatic fallback to Windows-1252 (standard Excel exports). Delimiters (`,`, `;`, tab) are detected from the header line.
4. Duplicate files (matching SHA-256 hash) within the same source are rejected with `409`.
5. Columns are mapped according to rules stored in `sources.config.mapping` (file column → module field); static constants in `config.fixed` (e.g. `kind: "harvest"`) are merged into each row. Unmapped columns are skipped; if no columns match, `422` is returned.
6. Each CSV row becomes a message following the **standard ingestion pipeline** (§6.2–6.6): raw storage, `normalize`, objects, metrics, events, and rules. Invalid rows are rejected reporting their **1-based row number in the file** while valid rows continue processing.
7. The original file is preserved on R2 (`docs/<tenant>/<source>/<hash>-<name>`) with an entry in `documents` (recording total, accepted, and rejected row counts) and links in `document_objects`.
8. Audit events `upload.mapping` (mapping modified) and `upload.file` (file uploaded) are logged.

The client-side UI parses only the header row in the browser, suggests auto-mapped fields, and submits the file and schema mapping via a Next.js Server Action (body size limit expanded to 6 MB in `next.config.ts`).

---

## 7. Rules and Alerts (`lib/engine/rules.ts`)

A monitoring rule specifies: *metric, comparison operator (above or below), threshold, minimum duration (`for_s`), and hysteresis*.

- **Rule Families and Overrides**: rules sharing the same identifier key belong to a family. An object-specific rule overrides the global type-level rule (`effectiveRules`). This allows global default thresholds with fine-grained per-sensor customization.
- **Trigger Duration**: an alert triggers only after a reading violates the threshold **continuously for at least `for_s` seconds**, filtering out transient sensor spikes.
- **Hysteresis Recovery**: an alert resolves only when readings clear `threshold ± hysteresis`, preventing flapping when values hover near threshold boundaries.
- **Peak Tracking**: during an active alert, the maximum deviation **peak value** is tracked.
- **Out-of-Order Protection**: readings older than the last evaluated timestamp (`rule_state.last_ts`) are skipped, ensuring historical or delayed data cannot reopen resolved alerts.
- **Lifecycle Events**: opening and resolving alerts emit `alert.opened` and `alert.resolved` events.
- **Acknowledgment**: users can acknowledge active alerts via `ack_alert()`.
- **Edge Deployment**: rules flagged with `push_to_device` compile into a `DeviceConfig` payload for downstream hardware. Its version is an FNV-1a hash of the threshold parameters: when thresholds change, the version increments and the device receives the update on its next sync (§6.6).

Rules are not hand-written: modules generate them programmatically from user configurations using `upsertRules(db, tenantId, module, specs, objectId?)`. This occurs when an owner saves settings (`app/terra/o/[slug]/settings/actions.ts`):

- `saveOrgSettings` persists company-wide thresholds in `org_modules.config` and updates base rules.
- `saveDeviceSettings` persists object-specific overrides in `properties.config` and registers dedicated object rules.

---

## 8. Raw Archive and Replay

### 8.1 Archiving (`lib/engine/archive.ts`)

Every hour, `flushRawInbox` aggregates items from `raw_inbox` belonging to **fully completed hourly windows** and writes compressed archives to R2:

```
raw/{tenant}/{source}/yyyy/mm/dd/hh.jsonl.gz
```

Guarantees:

- **Immutable Writes**: if a target key exists, an incremental suffix is appended (`-1`, `-2`...) using the S3 condition `IfNoneMatch: "*"`.
- **Transactional Deletion**: rows are removed from `raw_inbox` **only after** storage write verification succeeds.
- **Concurrency Safety**: uses `FOR UPDATE SKIP LOCKED`, preventing overlapping flush workers from processing the same rows.

Storage drivers are decoupled (`lib/engine/store.ts`):

- `S3Store` for Cloudflare R2 in production.
- `MemoryStore` for fast in-memory unit tests.
- `MeteredStore` wraps drivers to track billable operations in `engine_usage`.

### 8.2 Replay (`lib/engine/replay.ts`, `scripts/replay.ts`)

When bugs in normalization or computation are patched, raw archives can be **replayed**. Replay operations:

- Never overwrite or modify the raw archive.
- Suppress alert generation.
- Suppress event emission unless `--events` is explicitly supplied.
- Provide a non-destructive dry-run mode.

Due to idempotent storage semantics, previously computed metrics are updated without duplication.

---

## 9. Rollups, Retention, and Settings

### 9.1 Automated Maintenance

The SQL procedure `engine_maintenance` runs inside Postgres via **pg_cron** every `rollup.interval_min` minutes (default 15). The schedule is configured via `engine_schedule()`. Each iteration:

1. **Computes Rollups**: aggregates 5-minute and 1-hour rollups, rewinding slightly behind the last processed mark (`rollup.lookback_min`, 60 min) to absorb late-arriving measurements.
2. **Applies Retention**: drops daily raw metric partitions older than `retention.raw_days`, but **only if rollup coverage is verified complete**, guaranteeing no historical loss of aggregates. Applies configured retention to rollups via `rollup_*_days`.
3. **Pre-allocates Partitions**: pre-creates daily metric tables for upcoming days.

### 9.2 Reading Charts (`lib/engine/query.ts`)

The `series()` query engine dynamically routes reads to appropriate data tiers based on requested time ranges:

| Chart Range | Data Source |
|---|---|
| Up to 24 hours | Raw granular metrics |
| Up to 7 days | 5-minute rollups |
| Greater than 7 days | 1-hour rollups |

### 9.3 `engine_settings`: Dynamic Configuration

All operational parameters are adjustable via `/admin/settings` without requiring code redeployments:

| Key | Default | Description |
|---|---|---|
| `retention.raw_days` | 14 | Days of raw metric points retained in Postgres |
| `retention.rollup_5m_days` | 30 | Days of 5-minute rollups retained |
| `retention.rollup_1h_days` | null | Retention for 1-hour rollups (null = indefinite) |
| `rollup.interval_min` | 15 | Maintenance job execution frequency |
| `rollup.lookback_min` | 60 | Lookback recalculation window for late data |
| `metrics.partitions_ahead_days` | 3 | Daily partitions pre-created in advance |
| `query.raw_max_hours` | 24 | Maximum chart window served from raw metrics |
| `query.rollup_5m_max_days` | 7 | Maximum chart window served from 5-minute rollups |
| `raw.flush_interval_min` | 60 | R2 raw archiving frequency |
| `raw.inbox_stale_min` | 120 | Warning age threshold for unarchived raw inbox data |
| `quota.db_bytes` | 500 MB | Database storage warning ceiling |
| `quota.r2_bytes` | 10 GB | Cloudflare R2 storage warning ceiling |
| `quota.r2_writes_month` / `quota.r2_reads_month` | 1M / 10M | Monthly R2 operation quotas |
| `quota.alert_ratio` | 0.8 | Quota consumption ratio triggering warning alerts |
| `health.source_silent_min` | 30 | Silence threshold before a source is flagged offline |
| `ingest.max_batch` | 500 | Maximum message count per ingestion payload |
| `ingest.max_future_s` | 300 | Future timestamp drift tolerance window |
| `alerts.email_to` | [] | Health alert email recipients (empty = platform admins) |
| `alerts.email_from` | VDX Core | Health email sender name / address |
| `alerts.repeat_h` | 24 | Reminder interval for unresolved health issues |
| `upload.max_bytes` | 5 MB | Maximum allowed CSV file upload size |
| `upload.max_rows` | 5000 | Maximum row count per uploaded CSV file |
| `upload.files_per_day` | 50 | Uploaded file limit per 24 hours per upload source |
| `registers.types_max` | 50 | Maximum custom event types per tenant |
| `registers.export_chunk` | 500 | Query pagination batch size during exports |
| `registers.object_types_max` | 30 | Maximum custom object types per tenant |
| `custom.objects_max` | 5000 | Maximum custom-typed objects per tenant |
| `objects.page_size` | 100 | Default pagination limit for object lists |
| `push.document_max_bytes` | 3 MB | Maximum file size for `/api/push/document` attachments |
| `push.documents_per_day` | 200 | Maximum document attachments per 24 hours per source |

---

## 10. System Health Monitoring (`lib/engine/health.ts`)

An hourly diagnostic sweep evaluates:

- **Resource Quotas**: database size, R2 storage volume, and monthly read/write quotas;
- **Silent Sources**: sources that have ceased transmitting beyond tolerance thresholds;
- **Stalled Inbox**: unprocessed raw messages persisting in `raw_inbox`;
- **Failed Engine Jobs**: background execution failures.

Results are persisted in `engine_jobs` under the `health` job identifier. Administrators receive notification emails via Resend **upon issue detection**, periodically every `alerts.repeat_h` hours if the issue persists, and **upon resolution**. Historical notifications are tracked in `engine_notices` to prevent duplicate alerts.

`GET /api/health` is an unauthenticated endpoint suitable for external monitoring: it returns `200 OK` when healthy and `503 Service Unavailable` when an issue is detected or if diagnostic sweeps have not run within 2 hours.

---

## 11. Modules and LoRa

### 11.1 Anatomy of a Module

Each module presents **two interfaces**:

**Engine Side**: `ModulePackage`, registered in `lib/packages/index.ts` (currently `[loraPackage]`), defining:

- `id`: e.g. `"lora"`;
- `objectTypes`: supported object types and property schemas;
- `metrics`: list of declared metrics;
- `derived`: computed metric transformations executed by the engine;
- `normalize(msg)`: transforms raw telemetry into standard engine structures;
- `step(state, point)`: stateful calculation logic.

**Console UI Side**: `PackageDef` (`lib/packages/types.ts`, `lib/packages/ui.ts`), defining:

- metrics exposed in dashboard views;
- `defaults`: default configuration values;
- `settings`: dynamic form schema fields;
- `presets`: ready-to-use configuration templates;
- `validate`: business validation ensuring threshold consistency;
- `rules(config)`: transforms user settings into engine monitoring rules;
- `alertText`: alert notification templates;
- `offlineAfterS`: threshold duration before marking a device offline.

`components/terra/modules/registry.tsx` binds modules to their corresponding React UI views: Overview and Device detail pages.

### 11.2 LoRa: Greenhouse Climate Monitoring

The LoRa module ingests telemetry from environmental sensor nodes linked through a LoRaWAN gateway.

**`normalize`** ingests raw node telemetry and computes:

- **Dew Point** (Magnus formula);
- **VPD** (Vapor Pressure Deficit), critical for plant transpiration;
- **PAR** (Photosynthetically Active Radiation), estimated as lux / 54;
- **Thermal IR Analysis**: thermal delta (`spread`) and hot spot percentage (`hot_area`); the most recent frame is persisted in properties for console visualization;
- `cond_margin` (temperature buffer before condensation forms) and `leaf_air` (canopy-to-ambient temperature differential).

**`step`** maintains stateful calculations over time:

- **Suppresses** humidity threshold alerts during active irrigation cycles to prevent false positives;
- Tracks cumulative **leaf wetness hours** (`wet_h`), **high humidity hours** (`humid_h`), and conditions favorable to **downy mildew** (`downy_h`);
- Evaluates a **powdery mildew** risk index (adapted from the Gubler-Thomas epidemiological model);
- Computes accumulated daily plant stress (`stress_day`).

Default model constants live in `model.ts`; `rulesFromConfig` translates customer threshold preferences into engine alert rules.

### 11.3 Records: Generic Logbooks from Files

The `records` module (`lib/packages/records/`) provides generic logging capabilities: each row represents an **entry** containing a timestamp (`date`), subject entity (`subject`, e.g. a greenhouse plot), and optional metadata (`kind`, `product`, `quantity`, `unit`, `dose`, `area`, `operator`, `note`). `normalize` parses European dates (`03/09/2026`, `3.9.26 07:30`, ISO) as well as comma/period decimals (`1.234,5`), rejecting rows missing timestamps or subjects.

Subjects are indexed as engine objects, while each entry is recorded as a `records.entry` event; numeric attributes like `quantity`, `dose`, and `area` are ingested as metrics, enabling graphical analysis. The console exposes recent entries grouped by subject (`console.ts`, `listEntries`).

### 11.4 Agronomy: Treatment and Field Registry

The `agronomy` module (`lib/packages/agronomy/`) encapsulates agricultural domain knowledge; the core engine provides manual object and event management primitives (`lib/engine/manual.ts`). There is no automated computation or AI: data is authored and curated by users.

- **Crops** (`crop`): manually tracked entities specifying species, variety, acreage, phenological stage, start/end dates, and lifecycle `status` (`CROP_PROPERTIES`; the input form uses `CROP_FORM`, excluding status), optionally linked to a physical site (`located_in`). Total count is governed by `objects_max` (excess yields `429`).
- **Crops Management** (`/terra/o/[slug]/crops`): lists active and archived crops, creation workflows, and inline editing via `?edit=`.
  - **Editing** (`updateManualObject`): updates descriptive properties while preserving status; audited under `object.update` with before-and-after snapshots.
  - **Archiving** (`archiveManualObject`): sets completion date and marks `status = archived`; audited under `object.archive`. Archived crops are excluded from active dropdowns; new events referencing them return `409`. Historical records remain fully accessible in registries.
  - **Deletion** (`deleteManualObject`): allowed only when no events reference the crop (otherwise `409`, requiring archiving instead); audited under `object.delete`.
  - Existing registered treatments are immutable: edits or archival never alter historical logs.
- **Agricultural Events**: `treatment`, `sowing`, `transplant`, `harvest`, each backed by dedicated schemas with `subject = agronomy.crop`. Managed through the generic registry (§11.5), enhanced with:
  - `fromSubject`: selecting a crop auto-populates land area and growth stage;
  - Structured JSON export matching official agricultural compliance registries (`exports.ts`, registered in `lib/packages/exports.ts`).
- `/terra/o/[slug]/treatments` permanently redirects to `/terra/o/[slug]/registers/agronomy.treatment` (supporting `?crop=` → `?obj=`).
- **Crop View** (`/terra/o/[slug]/devices/[id]`): displays attributes, an event timeline, and, if a LoRa node is associated with the zone, 30-day trend graphs for relative humidity (`rh`) and leaf wetness (`wet_h`).

### 11.5 Generic Registries (`lib/engine/registers.ts`)

Every structured event type automatically benefits from a full management UI without custom code:

- **Event Types**: aggregates module-defined events (`eventTypes`) and customer-defined types in `event_types` where `module = 'custom'` (`listEventTypes`). A type defines `fields` (schema), `subject` (bound object type: forms offer active instances of this type), `fromSubject` (fields copied automatically from the selected subject), and `field_order` (preserves input order, compensating for JSONB key reordering).
- **Schema Editor** (`/terra/o/[slug]/registers/types`, owner-only): `saveEventType` validates the structure (`checkEventType`), checks `registers.types_max`, and writes `event_type.create|update` audit entries. Previously stored events remain unaffected.
- **Registry Views** (`/terra/o/[slug]/registers/[type]`): dynamic form input (`formSchema`, decimal comma support), "repeat last entry", versioned historical corrections, and database-level filters for `from`, `to`, `obj`, and `f.<field>` (`registerQuery` using JSONB containment).
- **Keyset Pagination**: cursor-based pagination using `(ts, id)` (`cursorOf` / `parseCursor`, parameter `after`), eliminating missing or duplicate rows across concurrent writes.
- **Data Export** (`registers/[type]/export?format=csv|pdf|<extra>`): `allEvents` streams data in chunks of `registers.export_chunk` in chronological order; CSV exports stream with headers, semicolons, comma decimals, split quantity columns, and UTF-8 BOM; PDF exports use `tablePdf` (`lib/engine/pdf.ts`, pdf-lib, landscape A4 spanning multiple pages). Additional export formats can be declared by packages (`exportsOf`).
- Permissions: owners and members have write access; viewers have read-only access. All mutations generate `audit_log` entries.

### 11.6 Custom Object Types and VDX Research

**Custom Object Types** (`lib/engine/custom-objects.ts`, `custom` module):

- The schema editor manages properties, declared link constraints, and UI field order (`/terra/o/[slug]/registers/types?kind=object` in Terra, `/research/o/[slug]/types/edit` in Research). `saveObjectType` runs `checkObjectType`, enforces `registers.object_types_max`, and audits changes.
- Object operations: `createObject`, `upsertObject`, `updateObject`, `setLink`, and `deleteObject`, strictly scoped by tenant with `object.*` audit logging.
- Universal search: `searchObjects` provides link filtering, full-text search on name and external ID, property predicates (`where`), numeric bounds (`min`/`max`), sorting by properties or name, total counts, and pagination; complemented by `countLinked` and `objectDocuments`. When `schemas` is supplied, `prop.sub` syntax queries nested JSON properties (e.g. `extra.tic_id`) typed according to the declared schema.
- Generic views at `/terra/o/[slug]/registers/objects` and `/research/o/[slug]/objects` inspect, create, and edit objects of any custom type; shared forms and validation rules live in `lib/object-forms.ts`.

**VDX Research** combines schema configuration with a tailored console interface:

- **Activation**: from `/admin` (at organization creation or from the tenant details page under Dashboards), staff assigns active consoles in `organizations.consoles` (migration `20261108000000_org_consoles.sql`; restricted to platform admins).
  - Terra is also modeled as a console (`20261109000000_terra_console.sql`: granted to existing orgs and enabled by default for new orgs). An org must retain at least one console; disabling the final remaining console is rejected.
  - Registries, schema editors, audit logs, and consent settings share unified console-agnostic components (`components/registers`, `components/activity-view.tsx`, `components/consent-settings.tsx`). Each console exposes isolated routes and Server Actions protected by its respective `requireConsole` guard.
  - Root route `/` and consent confirmation flow redirect to the primary active console (`consoleHome`); consent agreements can be signed from whichever console is opened first.
  - Upon activation, `prepareConsole` (`lib/console-setup.ts`) seeds Research schemas if the tenant lacks `custom.project`; existing custom schemas are left untouched.
  - Actions are audited under `console.enable` and `console.disable`.
  - Without console entitlement, `/research/o/[slug]` routes return 404; navigation switchers link active consoles.
  - The registry of consoles is maintained in `lib/consoles.ts` and initialized in `prepareConsole`. The `org_modules` table is intentionally bypassed, as the backend treats it strictly as a product catalog.
- **Type Definitions** (`scripts/research/types.ts`, loaded during setup or via `scripts/seed-research.ts <org>` using the public schema APIs):
  - `custom.project`: domain area, research question, hypothesis, project stage, experimental protocol, `result_links` (multi-line mappings `Label https://...{field}` expanded by `expandLinks` using result attributes, including `extra`), `result_schema`, and notification hooks `notify_email` (comma-separated), `notify_webhook` (HTTPS only), and `notify_score`;
  - `custom.dataset`: source provenance, description, file size, URL, licensing;
  - `custom.result`: anomaly score, triage status `to_review|discarded|interesting|sent`, notes, `assignee` (member email), pipeline run ID, and `extra` validated against `project.result_schema`; mandatory `project` link;
  - `custom.view`: saved search query (filter string), mandatory `project` link;
  - Structured events: `custom.run` (commit SHA, parameters, dataset items, runtime duration, status; references both project and dataset), `custom.lab_note` (rich text, bound to project), and `custom.comment` (text and `reply_to`, bound to result).
  - Multi-line `text` attributes render as multiline textareas in forms and preserve whitespace in views; utilized by notes, descriptions, and `result_links`.
- **Ingestion Sources**: `scripts/create-research-source.ts <org> <project>` creates a scoped push source bound to a specific project (`also: custom.dataset`) and outputs the ingestion token once.
- **Pipeline Integration** (`lib/research-pipeline.ts`):
  - `ingestCustom` updates telemetry metadata via `markSeen` (`sources.last_seen`, and `last_error` capturing rejected counts and first error reason; whole-request failures are logged by `/api/push`). The project UI lists associated sources (`scopedSources`: push sources with `config.scope.id` matching the project) with connection status, token hint, last contact, and error details.
  - `GET /api/research/results` with source bearer token: `pipelineResults` reads project results within scope applying `resultFilters` (`review`, `min`, `f.<key>`, `q`, `sort`), paginated via `offset` and `limit` (default 1000, max 2000). Sources not scoped to a project are rejected with 403; missing projects return 409; rate limiting follows standard ingestion throttles (429).
  - Notifications: after response dispatch (`after()` in `/api/push`), `notifyPush` evaluates ingestion diffs (`pushNews`): newly created runs and results meeting or exceeding `notify_score`. Dispatches email digests (`newsMail`, sender `alerts.email_from`, requiring `RESEND_API_KEY`) and HTTPS webhook POST payloads `{project, url, runs, results}` (5-second timeout, redirects disabled). Deduplicated by tracking only `created` records. Individual channel failures do not block delivery and are logged.
- **Console Interface** (`/research/o/[slug]`):
  - Dashboard overview: three summary indicators (pending triage, new since last visit, failed pipeline runs in the past 24 hours), active projects with stage badges, score distribution curves, review progress bars, recent runs, lab notes, and comments. Visit timestamps are tracked via `research_visit` cookies (`lastVisit`: after 30 minutes of inactivity, previous timestamp becomes reference point); updated client-side by `<VisitMarker>` calling `POST /research/o/[slug]/visit` to avoid SSR cookie write restrictions;
  - Project workspace: run history and results displayed according to `result_schema`:
    - Analytical charts (`components/research/charts.tsx`): histograms for numeric attributes (`objectHistogram`, `hist`; drag-to-select sets `min`/`max` bounds), 2D scatter plots (`objectPoints`, `x`/`y`, up to 1500 points; clicking points opens result details), and triage funnel charts (total → reviewed → interesting → submitted);
    - Saved Views: `custom.view` entities bound to the project storing filter query strings (`viewQuery` strips pagination and volatile parameters); managed via `saveView` / `deleteView` and shared among team members;
    - Column customization via `cols` (`shownColumns`); CSV exports always retain full column datasets;
    - Parametric filtering: search `q`, attribute filters `f.<key>`, `min.<key>`, `max.<key>` derived from schema (including `extra.<field>`), "assigned to me" (`mine=1`), and column sorting (`sort`, `order`). Parsed via `resultFilters` and preserved across links by `filterQuery`;
    - Batch Operations (`reviewMany`): bulk triage status and assignee changes for selected items, updating individual objects with audit logging, restricted to owner/member roles;
    - Data Export: `/p/[id]/export?format=csv|json` applying active filters and sort orders, streamed in paginated batches (CSV with headers, semicolons, and decimal commas via `resultsCsv`);
  - Keyboard Triage Queue (`/p/[id]/review`): single-item focus queue with preserved table filters and keyboard shortcuts (`REVIEW_KEYS`: `i` interesting, `d` discard, `s` send; `j`/`k` next/prev, `n` note) via `quickReview`;
  - Run Inspector: `/p/[id]/run/[eventId]` displays metadata, input parameters, consumed datasets, and review breakdowns for produced results (clicking filters the table with `f.run`); `/p/[id]/compare?a=&b=` diffs two project runs side-by-side, analyzing parameter deltas via `paramDiff` (modified, only in A, only in B) alongside triage counts;
  - Laboratory Notebook: `/p/[id]/notes` (`addLabNote`); project home highlights the three latest entries;
  - Dataset Registry: `/d` and `/d/[id]` display properties, relationships, and consuming runs;
  - Result Detail: inspects attributes, external links, originating run, file attachments, and audit history. File attachments (`attachments.tsx`, shared with triage queue): inline previews for raster images, tabular preview for CSVs (`csvPreview`), and secure new-tab links for PDFs (preventing iframe injection via strict security headers);
  - Discussion Threads: threaded comments on results (`addComment`), grouped via `commentThreads`: `reply_to` anchors to the thread `rootId`, ensuring integrity if comments are edited;
  - Review Audit: triage updates (status + comment) are recorded in the audit log;
  - Shared configuration routes for types, objects, audit logs, and consent preferences are exposed under `/types`, `/types/edit`, `/objects/[type]`, `/activity`, and `/settings`; mutation actions redirect back to Research paths. Shared forms and validation logic live in `lib/object-forms.ts`, with form state initialization handled in `lib/type-drafts.ts`.
- Associated event objects are explicitly ordered (`event_objects.pos`, migration `20261110000000_event_object_order.sql`): position 0 represents the primary entity (e.g. the project of a run, the result of a comment). `listEvents` and `manual.ts` queries return records ordered by `pos` and ID.
- Type and attribute identifiers used by the console are isolated in `lib/research.ts`. The underlying engine contains zero domain knowledge of projects or research results.

---

## 12. The Web Console

### 12.1 Route Map

| URL | Access | Purpose |
|---|---|---|
| `/login` | Public | Authentication |
| `/` | Authenticated | Traffic router: staff to `/admin`, customers to primary active console |
| `/terra/o/[slug]` | Org members | Fleet and device operational overview |
| `/terra/o/[slug]/alerts` | Members | Active and resolved alert histories |
| `/terra/o/[slug]/devices/[id]` | Members | Device telemetry details and historical charts |
| `/terra/o/[slug]/registers` | Members | Registry index with record counters |
| `/terra/o/[slug]/registers/[type]` | Members (Viewers read-only) | Generic registry: data entry, revisions, filtering, pagination, export |
| `/terra/o/[slug]/registers/types` | Owners | Custom event type schema editor |
| `/terra/o/[slug]/crops` | Members (Viewers read-only) | Crop tracking: creation, editing, archival, deletion |
| `/terra/o/[slug]/treatments` | — | Permanent redirect to `agronomy.treatment` registry |
| `/terra/o/[slug]/upload` | Owners (Members read-only) | CSV upload interface and ingestion history |
| `/terra/o/[slug]/settings` | Owners (Members read-only) | Global and per-device threshold management |
| `/admin` | VDX Staff | Tenant management and organization provisioning (with console assignment) |
| `/admin/orgs/[id]` | Staff | Comprehensive tenant management (modules, dashboards, thresholds, sites, members, audit) |
| `/admin/engine` | Staff | Engine operations (jobs, quotas, health) and source management (create, re-key, pause) |
| `/admin/settings` | Staff | Engine settings (`engine_settings`) and health alert recipients |
| `/terra/o/[slug]/registers/objects[/type]` | Members (Viewers read-only) | Custom-typed object directory and relationship manager |
| `/research/o/[slug]` | Members | VDX Research: dashboard with metrics, projects, and recent activity |
| `/research/o/[slug]/visit` (POST) | Members | Updates the last-visit tracking cookie |
| `/research/o/[slug]/types` | Members (Creation: Owners) | Custom object type registry |
| `/research/o/[slug]/types/edit` | Owners | Custom object type schema editor |
| `/research/o/[slug]/objects/[type]` | Members (Viewers read-only) | Custom object browser and relationship viewer |
| `/research/o/[slug]/activity` | Members | Organization audit trail |
| `/research/o/[slug]/settings` | Members | User consent review and management |
| `/research/o/[slug]/p/[id]` | Members (Batch actions & views: Owner/Member) | Project workspace: runs, analytics, saved views, filtered results |
| `/research/o/[slug]/p/[id]/review` | Members (Triage: Owner/Member) | Keyboard-driven result triage queue |
| `/research/o/[slug]/p/[id]/export` | Members | Export filtered results to CSV or JSON |
| `/research/o/[slug]/r/[id]` | Members (Triage: Owner/Member) | Result detail: attributes, attachments, history, review |
| `/research/o/[slug]/doc/[id]` | Members | Attachment download and preview |
| `/api/push` | Gateways, Pipelines | Telemetry ingestion endpoint (JSON, or CSV for `custom` sources) |
| `/api/push/document` | Pipelines | Document and artifact attachment endpoint |
| `/api/research/results` | Pipelines (Source token) | Paginated, filtered project results API |
| `/api/health` | Public | System health status probe |

### 12.2 Data Fetching Architecture

- Console routes are implemented as Next.js **Server Components**: data fetching occurs securely on the server.
- `lib/packages/console.ts` retrieves objects, computational state, and active alerts through direct Postgres pooling, strictly filtering by `tenant_id` (§4.3).
- Data visualizations consume pre-aggregated series via `series()` (§9.2) rendered with Recharts.
- Mutations are dispatched through Next.js **Server Actions** (e.g. `app/actions.ts`, `app/terra/o/[slug]/settings/actions.ts`). `lib/settings.ts` (`parseSettings`) handles form payload validation and type coercion.
- Localization: supports Italian and English, toggled via the `locale` cookie.

---

## 13. Scripts, Scheduled Jobs, and Deployment

### 13.1 Automation Scripts (`scripts/`, executed via `npx tsx`)

| Script | Purpose |
|---|---|
| `create-source.ts` | Creates an ingestion source and **prints its bearer token once**: to be handed to the gateway operator (token is unrecoverable). |
| `flush-raw.ts` | Flushes pending `raw_inbox` telemetry batches to compressed R2 storage. |
| `health.ts` | Runs diagnostic health checks and dispatches notification emails. |
| `replay.ts` | Replays historical raw archives through the engine. |
| `env.ts` | Loads `.env.local` for standalone command-line scripts. |
| `seed-research.ts <org>` | Seeds or updates default VDX Research schemas for an organization (idempotent). |
| `create-research-source.ts <org> <project> [name]` | Generates a project-scoped push source token for automated pipelines. |

The Python client library is located in `clients/python/` (complete with a quickstart README).

### 13.2 Automation and Scheduling

- **`.github/workflows/deploy.yml`**: continuous deployment to Vercel (production deployment for `main`, preview deployments for pull requests).
- **`.github/workflows/engine-hourly.yml`**: runs at minute 5 of every hour to execute `flush-raw`, followed by `health`. The health check runs unconditionally, ensuring flush errors are reported immediately.
- **pg_cron** (internal to Postgres): triggers `engine_maintenance` every 15 minutes.

### 13.3 Environment Variables (`.env.example`)

| Variable | Usage |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public Supabase client (authentication, RLS, Realtime) |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged Supabase administrative client |
| `DATABASE_URL` | Direct Postgres pooler connection string (port 6543) |
| `DATABASE_POOL_MAX` | Maximum connection pool capacity |
| `R2_*` | Cloudflare R2 bucket credentials and S3 endpoint configurations |
| `RESEND_API_KEY` | Resend API key for diagnostic alert emails |

### 13.4 Database Migrations

Database schemas are versioned under `supabase/migrations/` (timestamp-ordered SQL files). Schema alterations must be introduced as new migration files; existing, applied migrations are immutable.

---

## 14. Testing

Test suites are run with `npm test` powered by Vitest:

- `tests/engine/`: ingestion mechanics, rule evaluation, archiving, health checks, rollups, and CSV uploads.
- `tests/packages/lora.test.ts`: mathematical and agronomic computations for the LoRa module.
- `tests/packages/agronomy.test.ts`: crop entities, permissions, registries, audit logging, tenant isolation, exports, and quotas.
- `tests/engine/custom-objects.test.ts`, `research-seed.test.ts`: custom object types, declared relationships, `schemaFrom` resolution, limits, audit tracking, tenant isolation, and Research schemas.
- `tests/engine/custom-ingest.test.ts`: custom push ingestion (idempotency, event key deduplication, scoping, CSV payloads, attachments, source-signed audit trails).
- `tests/engine/research-console.test.ts`: search, parametric filtering, sorting, task assignment, bulk actions, CSV export streaming, attachment handling, and triage state.
- `tests/engine/console-setup.test.ts`: console activation lifecycle (default Terra assignment, landing console routing, one-time seeding, tenant schema preservation, isolation).
- `clients/python/tests/`: unit test suite for the Python client library (`cd clients/python && python3 -m unittest discover -s tests`).
- `tests/db/`: ephemeral database harness creating **isolated scratch databases** for each test file, applying migrations sequentially. Requires local Supabase (`npx supabase start`) or `TEST_DATABASE_URL`.

Archive test cases use `MemoryStore`, avoiding any network requests to Cloudflare R2.

---

## 15. How to Add a New Domain Module

1. Create directory `lib/packages/<name>/` implementing the `ModulePackage` interface: object types, metrics, derived definitions, `normalize`, and optional stateful `step` logic.
2. Register the package in `lib/packages/index.ts`.
3. Define the UI interface via `PackageDef` (form fields, defaults, `rules(config)`, alert templates) and register it in `lib/packages/ui.ts`.
4. Implement Overview and Device React views, registering them in `components/terra/modules/registry.tsx`.
5. Write unit tests under `tests/packages/<name>/`.
6. Enable the module for an organization via `/admin/orgs/[id]`, then provision a source from `/admin/engine` (or via `scripts/create-source.ts`).
7. Configure field gateways with the generated bearer token pointing to `/api/push`.

The generic engine remains untouched: domain isolation is maintained by design.

A dedicated module is required only when **custom computation** is performed (normalization, derived metrics, stateful steps, alert rules). When structured data is already computed and formatted upstream, schema configuration is sufficient (§16).

---

## 16. How to Add a Vertical Domain Without Code

Example: launching a **genomics research project** (identifying cohort gene variants) alongside astrophysics projects like TESS.

**Scenario A: Adding a new research project (Zero Lines of Code).**

1. From the console (`/terra/o/[slug]/registers/objects/custom.project`), create the project object: domain `genomics`, research question, hypothesis, stage.
2. In its `result_schema` property, define the domain fields: e.g. `gene` (text, required), `variant` (text), `patient_id` (text), `allele_freq` (number), and `pathogenic` (enum). Ingested results for this project will be dynamically validated against these attributes (`schemaFrom`) and rendered as columns in the UI.
3. Provision an ingestion source: `npx tsx scripts/create-research-source.ts <org> <project>`.
4. Automated pipelines stream datasets, runs, and results using the Python client (`send`, `send_csv`, `attach`). Anomaly scoring and triage workflows function out of the box.

**Scenario B: Adding a vertical with distinct entities** (e.g. patients, biological samples, clinical visits).

1. In the schema editor (`/terra/o/[slug]/registers/types`), define the object types: properties, declared link constraints (e.g. `sample.patient → custom.patient`, required), and field ordering.
2. Define event types with primary subjects and secondary objects (`also`: e.g. `custom.visit` on a patient).
3. For version-controlled deployments, declare schemas in a file patterned after `scripts/research/types.ts` and apply them programmatically through the editor API, matching `seed-research.ts`.
4. Provision a `custom` push source: `npx tsx scripts/create-source.ts <org> custom <name>`: without scope restrictions, it can ingest across all custom types for that tenant. To constrain it to a specific parent entity, configure `sources.config.scope = {link, id, also}`, as done for projects by `create-research-source.ts`. (Note: the `/admin/engine` UI form lists only installed module packages and intentionally omits `custom`).
5. Transmit data via `/api/push` (JSON or CSV) and `/api/push/document`. Object browsing, relationship graphs, registries, and data exports are immediately available via the generic `/registers/objects` and `/registers/[type]` interfaces.

What still requires code, and why:

- **Dedicated Consoles** (such as `/research`) represent presentation code: they read type constants from a schema dictionary like `lib/research.ts` and interact exclusively through generic engine primitives (`searchObjects`, `countLinked`, `objectDocuments`).
- **Automated Ingestion Calculations** (derived metrics, real-time rules, threshold alerts) require a dedicated engine module (§15).

In both scenarios, the underlying engine remains completely unchanged.

---

## 17. Core Architectural Principles

- **Zero Data Loss**: incoming payloads hit `raw_inbox` first, followed by immutable R2 archiving.
- **Idempotency Everywhere**: transmitting identical payloads multiple times never generates duplicate records.
- **Fault-Tolerant Ingestion**: an invalid message or a failed notification hook will never abort the remainder of a batch.
- **Strict Multi-Tenancy**: enforced by Row Level Security in Postgres and explicit `tenant_id` filtering in direct connection pools.
- **Generic Engine, Specialized Modules**: vertical domain intelligence is strictly encapsulated inside modules or custom schema configurations.
- **Complete Auditability**: every mutation is recorded with the acting identity (user or `source:<name>`), accompanied by before-and-after snapshots.
- **Everything Is Configurable**: operational thresholds and quotas reside in `engine_settings`, never hard-coded in application logic.
