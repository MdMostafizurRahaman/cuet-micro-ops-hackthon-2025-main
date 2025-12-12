import { context, trace } from "@opentelemetry/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  captureFrontendError,
  getTracer,
  instrumentedFetch,
  showFeedbackDialog,
} from "./observability";
import "./App.css";

type DownloadJobStatus =
  | "queued"
  | "running"
  | "processing_artifacts"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

type DownloadJob = {
  jobId: string;
  status: DownloadJobStatus;
  progressPercent: number;
  message: string;
  attempts: number;
  downloadUrl: string | null;
  checksum: string | null;
  size: number | null;
  retryAfterMs: number | null;
  fileIds: number[];
  priority: "standard" | "low";
  userId: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
  lastSyncedAt: number;
};

type HealthStatus = {
  status: "healthy" | "unhealthy";
  storage: "ok" | "error";
  checkedAt: string;
};

type RequestMetric = {
  id: string;
  endpoint: string;
  method: string;
  duration: number;
  status: number;
  success: boolean;
  timestamp: string;
  traceId: string;
};

type ErrorEvent = {
  id: string;
  message: string;
  traceId?: string;
  timestamp: string;
  context?: string;
};

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const JAEGER_UI_URL =
  import.meta.env.VITE_JAEGER_UI_URL ?? "http://localhost:16686";

const terminalStatuses: DownloadJobStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "expired",
];

const parseFileIds = (input: string): number[] =>
  input
    .split(/[\s,]+/)
    .map((token) => Number(token.trim()))
    .filter(
      (num) => Number.isFinite(num) && num >= 10000 && num <= 100000000,
    );

function App() {
  const [fileIdsInput, setFileIdsInput] = useState("70000, 71000, 72000");
  const [jobs, setJobs] = useState<Record<string, DownloadJob>>({});
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [initiateError, setInitiateError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<RequestMetric[]>([]);
  const [errorEvents, setErrorEvents] = useState<ErrorEvent[]>([]);
  const [lastTraceId, setLastTraceId] = useState<string | null>(null);

  const recordMetric = useCallback((metric: Omit<RequestMetric, "id" | "timestamp">) => {
    setMetrics((prev) => {
      const next = [
        {
          ...metric,
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        },
        ...prev,
      ];
      return next.slice(0, 30);
    });
  }, []);

  const recordError = useCallback(
    (event: Omit<ErrorEvent, "id" | "timestamp">) => {
      setErrorEvents((prev) => {
        const next = [
          {
            ...event,
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
          },
          ...prev,
        ];
        return next.slice(0, 20);
      });
    },
    [],
  );

  const requestJson = useCallback(
    async <T,>(
      path: string,
      init: RequestInit = {},
      spanName: string,
      label: string,
    ): Promise<T> => {
      const { response, traceId } = await instrumentedFetch(
        `${API_BASE_URL}${path}`,
        init,
        {
          spanName,
          onRecord: ({ traceId: tId, duration: dur, response: res }) => {
            recordMetric({
              endpoint: label,
              method: init.method ?? "GET",
              duration: dur,
              status: res.status,
              success: res.ok,
              traceId: tId,
            });
          },
        },
      );

      setLastTraceId(traceId);

      if (!response.ok) {
        const text = await response.text();
        captureFrontendError(`Request failed: ${label}`, {
          status: response.status,
          body: text,
          traceId,
        });
        recordError({
          message: `${label} failed (${response.status})`,
          traceId,
          context: text,
        });
        showFeedbackDialog();
        throw new Error(text || `Request failed (${response.status})`);
      }

      const data: T = await response.json();
      return data;
    },
    [recordMetric, recordError],
  );

  const pollHealth = useCallback(async () => {
    try {
      const data = await requestJson<{
        status: "healthy" | "unhealthy";
        checks: { storage: "ok" | "error" };
      }>("/health", undefined, "api.health", "health");
      setHealth({
        status: data.status,
        storage: data.checks.storage,
        checkedAt: new Date().toISOString(),
      });
    } catch (err) {
      captureFrontendError("Health check failed", { error: err });
    }
  }, [requestJson]);

  useEffect(() => {
    pollHealth();
    const interval = setInterval(pollHealth, 15000);
    return () => clearInterval(interval);
  }, [pollHealth]);

  const handleDownloadInitiation = useCallback(
    async (fileIds: number[]) => {
      if (!fileIds.length) {
        setInitiateError(
          "Please enter at least one file ID between 10,000 and 100,000,000.",
        );
        return;
      }
      setInitiateError(null);
      setIsSubmitting(true);
      const tracer = getTracer();
      const uiSpan = tracer.startSpan("ui.initiate_download");
      try {
        const payload = await context.with(
          trace.setSpan(context.active(), uiSpan),
          () =>
            requestJson<{
              jobId: string;
              status: DownloadJobStatus;
              expiresAt: string;
              totalFileIds: number;
            }>(
              "/v1/download/initiate",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  file_ids: fileIds,
                  clientRequestId: crypto.randomUUID(),
                  userId: "observability-demo-user",
                }),
              },
              "api.download.initiate",
              "POST /v1/download/initiate",
            ),
        );

        setJobs((prev) => ({
          ...prev,
          [payload.jobId]: {
            jobId: payload.jobId,
            status: payload.status,
            progressPercent: 0,
            message: "Queued for processing",
            attempts: 0,
            downloadUrl: null,
            checksum: null,
            size: null,
            retryAfterMs: null,
            fileIds,
            priority: "standard",
            userId: "observability-demo-user",
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            expiresAt: payload.expiresAt,
            lastSyncedAt: Date.now(),
          },
        }));
      } catch (err) {
        captureFrontendError("Failed to initiate download", { error: err });
        recordError({
          message: "Download initiation failed",
          context: err instanceof Error ? err.message : String(err),
        });
      } finally {
        uiSpan.end();
        setIsSubmitting(false);
      }
    },
    [recordError, requestJson],
  );

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ids = parseFileIds(fileIdsInput);
    await handleDownloadInitiation(ids);
  };

  const handleRetry = (job: DownloadJob) => {
    void handleDownloadInitiation(job.fileIds);
  };

  const handleDownload = (job: DownloadJob) => {
    window.open(
      `${API_BASE_URL}/v1/download/${job.jobId}?format=json`,
      "_blank",
    );
  };

  const pendingJobIds = useMemo(
    () =>
      Object.values(jobs)
        .filter((job) => !terminalStatuses.includes(job.status))
        .map((job) => job.jobId),
    [jobs],
  );

  useEffect(() => {
    if (!pendingJobIds.length) return;
    const interval = setInterval(() => {
      pendingJobIds.forEach(async (jobId) => {
        try {
          const data = await requestJson<DownloadJob>(
            `/v1/download/status/${jobId}`,
            undefined,
            "api.download.status",
            `GET /v1/download/status/${jobId}`,
          );
          setJobs((prev) => ({
            ...prev,
            [jobId]: {
              ...prev[jobId],
              ...data,
              lastSyncedAt: Date.now(),
            },
          }));
        } catch (err) {
          captureFrontendError("Status polling failed", {
            jobId,
            error: err,
          });
        }
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [pendingJobIds, requestJson]);

  useEffect(() => {
    const stored = localStorage.getItem("downloadJobIds");
    if (!stored) return;
    const ids: string[] = JSON.parse(stored);
    ids.forEach(async (jobId) => {
      try {
        const data = await requestJson<DownloadJob>(
          `/v1/download/status/${jobId}`,
          undefined,
          "api.download.status",
          `GET /v1/download/status/${jobId}`,
        );
        setJobs((prev) => ({
          ...prev,
          [jobId]: {
            ...data,
            lastSyncedAt: Date.now(),
          },
        }));
      } catch (err) {
        captureFrontendError("Failed to hydrate job", { jobId, error: err });
      }
    });
  }, [requestJson]);

  useEffect(() => {
    localStorage.setItem("downloadJobIds", JSON.stringify(Object.keys(jobs)));
  }, [jobs]);

  const sortedJobs = useMemo(
    () =>
      Object.values(jobs).sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      ),
    [jobs],
  );

  const metricsSummary = useMemo(() => {
    const summary = new Map<
      string,
      {
        endpoint: string;
        method: string;
        avg: number;
        count: number;
        successCount: number;
      }
    >();

    metrics.forEach((metric) => {
      const key = `${metric.method} ${metric.endpoint}`;
      const current = summary.get(key) ?? {
        endpoint: metric.endpoint,
        method: metric.method,
        avg: 0,
        count: 0,
        successCount: 0,
      };
      current.count += 1;
      current.avg += (metric.duration - current.avg) / current.count;
      if (metric.success) current.successCount += 1;
      summary.set(key, current);
    });

    return Array.from(summary.values());
  }, [metrics]);

  return (
    <div className="app-shell">
      <header>
        <div>
          <p className="eyebrow">Challenge 4</p>
          <h1>Observability Control Room</h1>
          <p className="muted">
            Track download health, correlate traces end-to-end, and capture
            runtime errors with Sentry + OpenTelemetry.
          </p>
        </div>
        <span className="api-target">API base: {API_BASE_URL}</span>
      </header>

      <section className="observability-grid">
        <article className="card">
          <h2>Service Health</h2>
          <p className="muted">
            /health responds every 15 seconds to detect storage outages early.
          </p>
          {health ? (
            <div className="health-grid">
              <div>
                <p className="stat-label">Status</p>
                <p className={`stat-value status-${health.status}`}>
                  {health.status}
                </p>
              </div>
              <div>
                <p className="stat-label">Storage</p>
                <p className={`stat-value status-${health.storage}`}>
                  {health.storage}
                </p>
              </div>
              <div>
                <p className="stat-label">Checked</p>
                <p className="stat-value">
                  {new Date(health.checkedAt).toLocaleTimeString()}
                </p>
              </div>
            </div>
          ) : (
            <p>Waiting for first health check...</p>
          )}
        </article>

        <article className="card">
          <h2>Trace Viewer</h2>
          <p className="muted">
            Click through to Jaeger with the latest trace id captured from
            frontend spans.
          </p>
          {lastTraceId ? (
            <div className="trace-panel">
              <code>{lastTraceId}</code>
              <div className="trace-actions">
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(lastTraceId);
                  }}
                >
                  Copy ID
                </button>
                <a
                  className="ghost"
                  href={`${JAEGER_UI_URL}/trace/${lastTraceId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Jaeger
                </a>
              </div>
            </div>
          ) : (
            <p>No traces captured yet.</p>
          )}
        </article>

        <article className="card">
          <h2>Performance Metrics</h2>
          <p className="muted">Last {metrics.length} requests</p>
          {metricsSummary.length === 0 ? (
            <p>No request metrics yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Count</th>
                  <th>Avg (ms)</th>
                  <th>Success %</th>
                </tr>
              </thead>
              <tbody>
                {metricsSummary.map((row) => (
                  <tr key={`${row.method}-${row.endpoint}`}>
                    <td>
                      <code>
                        {row.method} {row.endpoint}
                      </code>
                    </td>
                    <td>{row.count}</td>
                    <td>{row.avg.toFixed(1)}</td>
                    <td>
                      {((row.successCount / row.count) * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>

        <article className="card">
          <h2>Error Log</h2>
          <p className="muted">
            Captured via Sentry for failed API calls and UI issues.
          </p>
          {errorEvents.length === 0 ? (
            <p>No errors recorded.</p>
          ) : (
            <ul className="error-feed">
              {errorEvents.map((event) => (
                <li key={event.id}>
                  <div>
                    <strong>{event.message}</strong>
                    <p className="muted">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </p>
                    {event.context ? (
                      <p className="muted">{event.context}</p>
                    ) : null}
                  </div>
                  {event.traceId ? (
                    <code className="trace-chip">{event.traceId}</code>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <button className="ghost" type="button" onClick={showFeedbackDialog}>
            Send Feedback
          </button>
        </article>
      </section>

      <section className="card">
        <h2>Start a download job</h2>
        <p className="muted">
          Provide file IDs (10k-100M). Each request spawns a span and polls the
          async API without risking CDN timeouts.
        </p>
        <form className="download-form" onSubmit={handleSubmit}>
          <label htmlFor="fileIds">File IDs</label>
          <textarea
            id="fileIds"
            value={fileIdsInput}
            rows={2}
            onChange={(event) => setFileIdsInput(event.target.value)}
            placeholder="70000, 71000, 72000"
          />
          {initiateError ? <p className="error">{initiateError}</p> : null}
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Queuing..." : "Initiate Download"}
          </button>
        </form>
      </section>

      <section>
        <div className="section-heading">
          <h2>Job activity</h2>
          <p className="muted">
            Showing {sortedJobs.length || "no"} jobs. Active jobs poll every five
            seconds.
          </p>
        </div>
        {sortedJobs.length === 0 ? (
          <div className="empty-state card">
            <p>No downloads yet. Kick off a job to see progress updates.</p>
          </div>
        ) : (
          <div className="jobs-grid">
            {sortedJobs.map((job) => (
              <article key={job.jobId} className="job-card card">
                <header>
                  <div>
                    <p className="eyebrow">
                      Job #{job.jobId.slice(0, 8).toUpperCase()}
                    </p>
                    <h3>{job.status.replace("_", " ")}</h3>
                  </div>
                  <span className={`status-pill status-${job.status}`}>
                    {job.status}
                  </span>
                </header>
                <p className="muted">{job.message}</p>
                <div className="progress">
                  <div
                    className="progress-value"
                    style={{ width: `${job.progressPercent}%` }}
                  />
                </div>
                <dl className="job-meta">
                  <div>
                    <dt>Files</dt>
                    <dd>{job.fileIds.join(", ")}</dd>
                  </div>
                  <div>
                    <dt>Attempts</dt>
                    <dd>{job.attempts}</dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd>
                      {job.startedAt
                        ? new Date(job.startedAt).toLocaleTimeString()
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Completed</dt>
                    <dd>
                      {job.completedAt
                        ? new Date(job.completedAt).toLocaleTimeString()
                        : "—"}
                    </dd>
                  </div>
                </dl>
                <footer>
                  {job.status === "completed" && job.downloadUrl ? (
                    <button onClick={() => handleDownload(job)}>Download</button>
                  ) : null}
                  {job.status === "failed" ? (
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => handleRetry(job)}
                    >
                      Retry
                    </button>
                  ) : null}
                  <span className="muted">
                    Last sync:{" "}
                    {new Date(job.lastSyncedAt).toLocaleTimeString()}
                  </span>
                </footer>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default App;
