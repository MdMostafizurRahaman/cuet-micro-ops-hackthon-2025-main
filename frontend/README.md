# Download Observability Dashboard

This Vite + React dashboard (Challenge 4) layers observability features on top of the asynchronous download service. It calls the Hono API in `../src`, emits spans through OpenTelemetry, and records UI/API failures with Sentry.

## Getting Started

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Environment variables (`.env.local`):

| Variable | Description |
| --- | --- |
| `VITE_API_BASE_URL` | Download API base URL (defaults to `http://localhost:3000`) |
| `VITE_SENTRY_DSN` | Browser Sentry DSN; leave empty to disable error reporting |
| `VITE_OTEL_EXPORTER_URL` | OTLP/HTTP collector endpoint (Jaeger exposes `http://localhost:4318/v1/traces`) |
| `VITE_JAEGER_UI_URL` | The Jaeger UI used for deep-linking traces (defaults to `http://localhost:16686`) |

## Features

- **Health Status** &mdash; Polls `/health` every 15 seconds so storage outages show up immediately.
- **Download Jobs** &mdash; Initiates jobs, polls `/v1/download/status/:jobId`, and drives retries/download links when they finish.
- **Error Log** &mdash; Captures failed API calls and UI issues via `@sentry/react`, surfacing a “Send Feedback” button to open Sentry’s user dialog.
- **Trace Viewer** &mdash; Displays the most recent `traceId` emitted by the browser instrumentation and links directly to Jaeger for correlation with backend spans.
- **Performance Metrics** &mdash; Aggregates latency/success rates for the last 30 requests to highlight regressions.
- **Trace Propagation** &mdash; Every fetch injects a `traceparent` header so frontend spans share the same ID as backend spans.

Use `curl -X POST "http://localhost:3000/v1/download/check?sentry_test=true" -H "Content-Type: application/json" -d '{"file_id":70000}'` to trigger the backend’s Sentry test error and watch it surface in the Error Log and Sentry UI.
