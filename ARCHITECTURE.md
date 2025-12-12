# Challenge 2 - Long-Running Download Architecture

This document proposes a production-ready integration plan for the existing Hono-based download microservice so it can serve downloads ranging from 10 seconds to more than 2 minutes without timing out in front of reverse proxies or browsers. The design emphasizes resiliency, predictable UX, and cost-aware scaling.

## 1. Architecture Overview

### Goals
- Acknowledge long-running work immediately to free up client and proxy connections.
- Provide deterministic status tracking plus resumable downloads when users disconnect.
- Support multiple concurrent downloads per user without stampeding the API.
- Reuse the existing S3-backed storage and stay aligned with the Node.js ecosystem (BullMQ, Redis).

### Architecture Diagram

```mermaid
flowchart LR
    subgraph Client Tier
        A[React/Next.js App]
    end
    subgraph Edge Tier
        B[Cloudflare / nginx / ALB]
    end
    subgraph API Tier
        C[Download API (Hono)]
        H[(Redis / Job + Status Store)]
    end
    subgraph Worker Tier
        D[BullMQ Queue]
        E[Download Worker Pods]
    end
    subgraph Storage
        F[(S3 or MinIO downloads bucket)]
        G[(Object cache or CDN)]
    end

    A -->|POST /v1/download/initiate| B
    B --> C
    C -->|enqueue job| D
    D -->|lock + deliver job| E
    E -->|fetch source / build zip| F
    E -->|persist job status + presigned URL| H
    A -->|GET /v1/download/status/:jobId| B --> C
    C -->|read status| H
    A -->|GET /v1/download/:jobId| B --> C -->|302 redirect or JSON| A
    C -->|optional presigned URL| G
```

### Data Flow (fast vs slow)
- **Fast download (about 10 seconds):** The worker completes before the first poll. The status endpoint switches from `queued` to `completed` and returns a presigned URL, so the client moves straight to the download. Edge timeouts never trigger because the initial POST completes in milliseconds.
- **Slow download (90 to 120 seconds):** The worker executes asynchronously. The client polls every five seconds; statuses move `queued -> running -> processing_artifacts -> completed`. If a user closes their browser, the job keeps running because state lives in Redis. When they return, any device can resume polling with the same jobId until the TTL expires.

## 2. Technical Approach - Option A: Resilient Polling

Polling is chosen because it:
- Works through any HTTP proxy or CDN (Cloudflare, nginx, ALB) with no WebSocket or SSE requirements.
- Keeps the API surface RESTful and cache friendly while enabling retries and exponential backoff to avoid retry storms.
- Scales horizontally: API pods remain stateless and only enqueue work, while workers scale independently.
- Simplifies multi-tenant orchestration; webhooks or push channels can be layered later, but polling is the lowest common denominator protocol.

## 3. Implementation Details

### 3.1 API contract
| Endpoint | Method | Behavior | Notes |
| --- | --- | --- | --- |
| `/v1/download/initiate` | `POST` | Accepts `{ fileIds: number[], priority?: "standard" \| "low" }` and optional `clientRequestId`. Returns `202 Accepted` with `{ jobId, status: "queued", nextPollInMs, expiresAt }`. | Replace the current blocking `/start` route. Validate file IDs with existing Zod schemas. |
| `/v1/download/status/:jobId` | `GET` | Returns `{ jobId, status, progressPercent, message, downloadUrl, checksum, startedAt, completedAt, attempts }`. Sets `Cache-Control: no-store`. | Primary polling endpoint. |
| `/v1/download/:jobId` | `GET` | When `status === completed`, respond with `302` redirect to the presigned URL or stream the file body. When incomplete, return `409` with the latest status payload. | Allows browsers to treat the route as a direct download link or resume later. |
| `/v1/download/cancel/:jobId` (optional) | `POST` | Marks a job as `cancelled` if still queued or running so workers skip it. | Useful for large queues or user-requested aborts. |

### 3.2 Data and cache schema
- **Primary store:** Redis (or managed Upstash/ElastiCache) since BullMQ already requires Redis.
- **Keys**
  - `download:job:{jobId}` (Hash) with fields `status`, `progressPercent`, `fileIds`, `downloadUrl`, `checksum`, `retries`, `errorCode`, `errorMessage`, `expiresAt`, `priority`, `userId`, `heartbeatAt`.
  - `download:jobsByUser:{userId}` (Sorted Set) with score `createdAt` to list active jobs and enforce per-user concurrency limits.
  - `download:url:{jobId}` (String) storing the presigned URL with TTL matching the S3 expiry to prevent stale reuse.
- **Status enum:** `queued`, `running`, `processing_artifacts`, `completed`, `failed`, `cancelled`, `expired`.
- **TTL:** Base 24 hours after completion, configurable via `DOWNLOAD_JOB_TTL_MS`. A cleanup job sweeps expired entries nightly.

### 3.3 Background job processing
- **Queue:** BullMQ queue `download-jobs` on Redis.
- **Producer (API):** `enqueueDownload({ jobId, userId, fileIds, priority })`. Use UUID v7 job IDs and deduplicate by `clientRequestId` to guard against double submissions.
- **Workers:** Node worker pods or serverless functions. Concurrency tuned via `DOWNLOAD_WORKER_CONCURRENCY`. Each worker:
  1. Updates status to `running` and writes a heartbeat timestamp to Redis.
  2. Streams file fragments from S3 or the upstream source, builds the artifact, uploads the final object to the `downloads` bucket.
  3. Generates a short-lived presigned URL (for example 5 minutes) and stores it in Redis; optionally push the object to a CDN cache.
- **Observability:** Emit OpenTelemetry spans per job with `jobId` attributes and log progress for dashboards.

### 3.4 Error handling and retries
- BullMQ retry strategy: up to 3 attempts with exponential backoff (for example 5s, 30s, 2m). Persist `attempts` and the last error in the job hash.
- If retries are exhausted, set status `failed`, include `errorCode`, `errorMessage`, and `retryAfterMs`, and optionally attach a `supportTicketId`.
- A worker heartbeat watchdog marks jobs as `stalled` after `HEARTBEAT_TIMEOUT_MS`; BullMQ requeues or marks them failed depending on configuration.
- `POST /initiate` accepts `clientRequestId` so that repeated calls from the frontend return the original job instead of creating duplicates.
- Clients apply jittered polling intervals (for example random delay between 4 and 8 seconds) to avoid synchronized storms after outages.

### 3.5 Timeout configuration
| Layer | Setting | Value |
| --- | --- | --- |
| Client fetch | AbortController timeout | 5 s for initiate and status requests, 2+ minutes for the actual download link request. |
| API server | `REQUEST_TIMEOUT_MS` | 5 s on initiate and status routes (responses are immediate). Keep 30 s for other synchronous routes. |
| BullMQ worker | `DOWNLOAD_JOB_TIMEOUT_MS` | 180 s (greater than the worst case 120 s) before a job is marked stalled. |
| Redis TTL | `DOWNLOAD_JOB_TTL_MS` | 86,400,000 ms (24 hours). |
| Cloudflare or CDN | Origin max keepalive | 30 s; initiate and status calls return before this limit. |
| nginx | `proxy_connect_timeout 5s`, `proxy_read_timeout 15s` for initiate/status routes; for `/download/:jobId` use `proxy_read_timeout 180s` and disable buffering to stream the file. |

## 4. Proxy Configuration

### 4.1 Cloudflare
- **Origin rules**
  - Route `/v1/download/initiate` and `/v1/download/status/*` to an Origin Response Timeout of 30 s (default 100 s also works, but lower values protect against hung origins).
  - Route `/v1/download/*` to the default 100 s timeout or upgrade the plan to enable the 600 s limit if artifacts are very large.
- **Cache rules**
  - Bypass cache for initiate and status routes (`Cache Level: Bypass`).
  - Cache completed downloads using Tiered Cache if artifacts are the same for all users; otherwise serve private objects with `Cache-Control: private`.
- **Other settings**
  - Enable `Proxy Keep Alive` and HTTP/3 for faster handshake resumption.
  - Optionally configure Cloudflare Queues or Workers later to push job updates to partner systems.

### 4.2 nginx (fronting the API pods)

```nginx
upstream download_api {
    server api-1:3000;
    server api-2:3000;
    keepalive 32;
}

map $request_uri $download_route {
    default "short";
    ~^/v1/download/(status|initiate) short;
    ~^/v1/download/[^/]+$ long;
}

server {
    listen 443 ssl;
    server_name downloads.example.com;

    location / {
        proxy_pass http://download_api;
        proxy_set_header Host $host;
        proxy_set_header X-Request-ID $request_id;
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        if ($download_route = short) {
            proxy_connect_timeout 5s;
            proxy_read_timeout 15s;
            proxy_send_timeout 15s;
        }

        if ($download_route = long) {
            proxy_connect_timeout 5s;
            proxy_read_timeout 180s;
            proxy_send_timeout 180s;
            proxy_buffering off;  # stream file without buffering
        }
    }
}
```

## 5. Frontend (React or Next.js) integration

1. **Initiate download**
   - `const res = await fetch("/v1/download/initiate", { method: "POST", body: JSON.stringify({ fileIds }) })`.
   - Store `{ jobId, expiresAt }` in React Query or SWR cache and in localStorage so the job can be resumed after refresh or navigation.
2. **Polling hook**
   - Use React Query with `refetchInterval: status === "completed" ? false : jitter(4000, 8000)`.
   - Abort each request after 5 s. On HTTP 409 keep the same interval; on 423 (rate limited) back off exponentially.
3. **Progress UI**
   - Map statuses to UI copy: `queued` -> spinner, `running` -> progress bar based on `progressPercent`, `processing_artifacts` -> textual update such as "Packaging download".
   - Show ETA as `(100 - progressPercent) * averageStepDuration`.
   - Surface `attempts` and `errorMessage` if the job fails; allow "Try again" which reuses `clientRequestId`.
4. **Download completion**
   - When the job is `completed`, request `/v1/download/:jobId`. On a 302 redirect, let the browser start downloading. If the API returns JSON with `downloadUrl`, set `window.location` or provide a button link.
   - Optionally load the link in a hidden iframe to keep the UI interactive.
5. **Failure and retry logic**
   - If `failed` with `retryAfterMs`, show a countdown and re-enable the retry button afterwards. Retrying calls `/v1/download/initiate` with the previous payload.
   - If `expired`, prompt the user to start a new download.
6. **Multiple concurrent downloads**
   - Maintain a "My downloads" drawer listing active jobs from `/v1/download/jobs` (aggregating `download:jobsByUser`). Each entry owns its own polling hook so the user can launch several downloads at once.
7. **Browser close scenario**
   - Persist job IDs in IndexedDB or localStorage. When the app boots, rehydrate by fetching `/v1/download/status/:jobId`. If already completed, immediately call `/v1/download/:jobId` to resume the transfer.

## 6. Additional Considerations
- **Security:** Sign presigned URLs with the least-privilege IAM role, limit TTL, and include the hashed `jobId` in the object key to prevent guessing.
- **Cost:** A single managed Redis cluster powers both BullMQ and status lookups. Workers can autoscale with KEDA based on queue depth. CDN caching or S3 lifecycle policies keep storage and egress costs predictable.
- **Monitoring:** Add metrics such as `download_job_duration_seconds` and `download_job_failed_total`, and propagate `traceparent` headers so frontend, API, and worker traces can be correlated.

This plan decouples user latency from backend processing time, ensuring that even 120-second downloads complete reliably through real-world proxies while keeping UX responsive and informative.
