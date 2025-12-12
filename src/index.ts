import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { sentry } from "@hono/sentry";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { Scalar } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { timeout } from "hono/timeout";
import { rateLimiter } from "hono-rate-limiter";

// Helper for optional URL that treats empty string as undefined
const optionalUrl = z
  .string()
  .optional()
  .transform((val) => (val === "" ? undefined : val))
  .pipe(z.url().optional());

// Environment schema
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: optionalUrl,
  S3_BUCKET_NAME: z.string().default(""),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  SENTRY_DSN: optionalUrl,
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(100),
  CORS_ORIGINS: z
    .string()
    .default("*")
    .transform((val) => (val === "*" ? "*" : val.split(","))),
  // Download delay simulation (in milliseconds)
  DOWNLOAD_DELAY_MIN_MS: z.coerce.number().int().min(0).default(10000), // 10 seconds
  DOWNLOAD_DELAY_MAX_MS: z.coerce.number().int().min(0).default(200000), // 200 seconds
  DOWNLOAD_DELAY_ENABLED: z.coerce.boolean().default(true),
  DOWNLOAD_JOB_TTL_MS: z.coerce.number().int().min(60000).default(86400000), // 24 hours
  DOWNLOAD_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
});

// Parse and validate environment
const env = EnvSchema.parse(process.env);

// S3 Client
const s3Client = new S3Client({
  region: env.S3_REGION,
  ...(env.S3_ENDPOINT && { endpoint: env.S3_ENDPOINT }),
  ...(env.S3_ACCESS_KEY_ID &&
    env.S3_SECRET_ACCESS_KEY && {
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    }),
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

// Initialize OpenTelemetry SDK
const otelSDK = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "delineate-hackathon-challenge",
  }),
  traceExporter: new OTLPTraceExporter(),
});
otelSDK.start();

const app = new OpenAPIHono();

// Request ID middleware - adds unique ID to each request
app.use(async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);
  await next();
});

// Security headers middleware (helmet-like)
app.use(secureHeaders());

// CORS middleware
app.use(
  cors({
    origin: env.CORS_ORIGINS,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Request-ID",
      "traceparent",
      "tracestate",
    ],
    exposeHeaders: [
      "X-Request-ID",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
    ],
    maxAge: 86400,
  }),
);

// Request timeout middleware
app.use(timeout(env.REQUEST_TIMEOUT_MS));

// Rate limiting middleware
app.use(
  rateLimiter({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: "draft-6",
    keyGenerator: (c) =>
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "anonymous",
  }),
);

// OpenTelemetry middleware
app.use(
  httpInstrumentationMiddleware({
    serviceName: "delineate-hackathon-challenge",
  }),
);

// Sentry middleware
app.use(
  sentry({
    dsn: env.SENTRY_DSN,
  }),
);

// Error response schema for OpenAPI
const ErrorResponseSchema = z
  .object({
    error: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  })
  .openapi("ErrorResponse");

// Error handler with Sentry
app.onError((err, c) => {
  c.get("sentry").captureException(err);
  const requestId = c.get("requestId") as string | undefined;
  return c.json(
    {
      error: "Internal Server Error",
      message:
        env.NODE_ENV === "development"
          ? err.message
          : "An unexpected error occurred",
      requestId,
    },
    500,
  );
});

// Schemas
const MessageResponseSchema = z
  .object({
    message: z.string(),
  })
  .openapi("MessageResponse");

const HealthResponseSchema = z
  .object({
    status: z.enum(["healthy", "unhealthy"]),
    checks: z.object({
      storage: z.enum(["ok", "error"]),
    }),
  })
  .openapi("HealthResponse");

const DownloadPrioritySchema = z.enum(["standard", "low"]);
const DownloadJobStatusSchema = z.enum([
  "queued",
  "running",
  "processing_artifacts",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

// Download API Schemas
const DownloadInitiateRequestSchema = z
  .object({
    file_ids: z
      .array(z.number().int().min(10000).max(100000000))
      .min(1)
      .max(1000)
      .openapi({ description: "Array of file IDs (10K to 100M)" }),
    clientRequestId: z.string().min(3).max(128).optional().openapi({
      description:
        "Optional idempotency key supplied by the client to deduplicate download initiation",
    }),
    priority: DownloadPrioritySchema.optional().openapi({
      description: "Queue priority for the job",
    }),
    userId: z.string().min(1).max(64).optional().openapi({
      description: "Application user identifier for concurrency tracking",
    }),
  })
  .openapi("DownloadInitiateRequest");

const DownloadInitiateResponseSchema = z
  .object({
    jobId: z.string().openapi({ description: "Unique job identifier" }),
    status: DownloadJobStatusSchema,
    nextPollInMs: z
      .number()
      .int()
      .openapi({ description: "Suggested delay before polling status again" }),
    expiresAt: z
      .string()
      .openapi({ description: "ISO timestamp when the job record expires" }),
    deduplicated: z.boolean().optional().openapi({
      description:
        "Indicates if an existing job was returned for the provided clientRequestId",
    }),
  })
  .openapi("DownloadInitiateResponse");

const DownloadCheckRequestSchema = z
  .object({
    file_id: z
      .number()
      .int()
      .min(10000)
      .max(100000000)
      .openapi({ description: "Single file ID to check (10K to 100M)" }),
  })
  .openapi("DownloadCheckRequest");

const DownloadCheckResponseSchema = z
  .object({
    file_id: z.number().int(),
    available: z.boolean(),
    s3Key: z
      .string()
      .nullable()
      .openapi({ description: "S3 object key if available" }),
    size: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "File size in bytes" }),
  })
  .openapi("DownloadCheckResponse");

const DownloadStartRequestSchema = z
  .object({
    file_id: z
      .number()
      .int()
      .min(10000)
      .max(100000000)
      .openapi({ description: "File ID to download (10K to 100M)" }),
  })
  .openapi("DownloadStartRequest");

const DownloadStartResponseSchema = z
  .object({
    file_id: z.number().int(),
    status: z.enum(["completed", "failed"]),
    downloadUrl: z
      .string()
      .nullable()
      .openapi({ description: "Presigned download URL if successful" }),
    size: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "File size in bytes" }),
    processingTimeMs: z
      .number()
      .int()
      .openapi({ description: "Time taken to process the download in ms" }),
    message: z.string().openapi({ description: "Status message" }),
  })
  .openapi("DownloadStartResponse");

const DownloadJobStatusResponseSchema = z
  .object({
    jobId: z.string(),
    status: DownloadJobStatusSchema,
    progressPercent: z.number().int().min(0).max(100),
    message: z.string(),
    attempts: z.number().int().min(0),
    downloadUrl: z.string().nullable(),
    checksum: z.string().nullable(),
    size: z.number().int().nullable(),
    retryAfterMs: z.number().int().nullable(),
    fileIds: z.array(z.number().int()),
    priority: DownloadPrioritySchema,
    userId: z.string(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    expiresAt: z.string(),
  })
  .openapi("DownloadJobStatusResponse");

// Input sanitization for S3 keys - prevent path traversal
const sanitizeS3Key = (fileId: number): string => {
  // Ensure fileId is a valid integer within bounds (already validated by Zod)
  const sanitizedId = Math.floor(Math.abs(fileId));
  // Construct safe S3 key without user-controlled path components
  return `downloads/${String(sanitizedId)}.zip`;
};

// S3 health check
const checkS3Health = async (): Promise<boolean> => {
  if (!env.S3_BUCKET_NAME) return true; // Mock mode
  try {
    // Use a lightweight HEAD request on a known path
    const command = new HeadObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: "__health_check_marker__",
    });
    await s3Client.send(command);
    return true;
  } catch (err) {
    // NotFound is fine - bucket is accessible
    if (err instanceof Error && err.name === "NotFound") return true;
    // AccessDenied or other errors indicate connection issues
    return false;
  }
};

// S3 availability check
const checkS3Availability = async (
  fileId: number,
): Promise<{
  available: boolean;
  s3Key: string | null;
  size: number | null;
}> => {
  const s3Key = sanitizeS3Key(fileId);

  // If no bucket configured, use mock mode
  if (!env.S3_BUCKET_NAME) {
    const available = fileId % 7 === 0;
    return {
      available,
      s3Key: available ? s3Key : null,
      size: available ? Math.floor(Math.random() * 10000000) + 1000 : null,
    };
  }

  try {
    const command = new HeadObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: s3Key,
    });
    const response = await s3Client.send(command);
    return {
      available: true,
      s3Key,
      size: response.ContentLength ?? null,
    };
  } catch {
    return {
      available: false,
      s3Key: null,
      size: null,
    };
  }
};

// Random delay helper for simulating long-running downloads
const getRandomDelay = (): number => {
  if (!env.DOWNLOAD_DELAY_ENABLED) return 0;
  const min = env.DOWNLOAD_DELAY_MIN_MS;
  const max = env.DOWNLOAD_DELAY_MAX_MS;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type DownloadPriority = z.infer<typeof DownloadPrioritySchema>;
type DownloadJobStatus = z.infer<typeof DownloadJobStatusSchema>;

interface DownloadJob {
  jobId: string;
  fileIds: number[];
  clientRequestId?: string;
  userId: string;
  status: DownloadJobStatus;
  progressPercent: number;
  message: string;
  attempts: number;
  downloadUrl: string | null;
  checksum: string | null;
  size: number | null;
  retryAfterMs: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  expiresAt: number;
  priority: DownloadPriority;
}

const downloadJobs = new Map<string, DownloadJob>();
const clientRequestJobIndex = new Map<string, string>();
const jobQueue: string[] = [];
let activeWorkers = 0;
const DEFAULT_POLL_INTERVAL_MS = 5000;

const toJobResponse = (job: DownloadJob) => ({
  jobId: job.jobId,
  status: job.status,
  progressPercent: job.progressPercent,
  message: job.message,
  attempts: job.attempts,
  downloadUrl: job.downloadUrl,
  checksum: job.checksum,
  size: job.size,
  retryAfterMs: job.retryAfterMs,
  fileIds: job.fileIds,
  priority: job.priority,
  userId: job.userId,
  createdAt: new Date(job.createdAt).toISOString(),
  startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
  completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
  expiresAt: new Date(job.expiresAt).toISOString(),
});

const createDownloadJob = (params: {
  fileIds: number[];
  priority: DownloadPriority;
  clientRequestId?: string;
  userId: string;
}) => {
  const now = Date.now();
  const jobId = crypto.randomUUID();
  const job: DownloadJob = {
    jobId,
    fileIds: params.fileIds,
    clientRequestId: params.clientRequestId,
    userId: params.userId,
    status: "queued",
    progressPercent: 0,
    message: "Queued for processing",
    attempts: 0,
    downloadUrl: null,
    checksum: null,
    size: null,
    retryAfterMs: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
    expiresAt: now + env.DOWNLOAD_JOB_TTL_MS,
    priority: params.priority,
  };
  downloadJobs.set(jobId, job);
  if (params.clientRequestId) {
    clientRequestJobIndex.set(params.clientRequestId, jobId);
  }
  return job;
};

const enqueueJob = (jobId: string) => {
  jobQueue.push(jobId);
  processQueue();
};

const processQueue = () => {
  if (activeWorkers >= env.DOWNLOAD_WORKER_CONCURRENCY) {
    return;
  }
  const nextJobId = jobQueue.shift();
  if (!nextJobId) return;
  activeWorkers += 1;
  runJob(nextJobId)
    .catch((err: unknown) => {
      console.error(`[Worker] Failed to process job ${nextJobId}:`, err);
    })
    .finally(() => {
      activeWorkers = Math.max(0, activeWorkers - 1);
      processQueue();
    });
};

const runJob = async (jobId: string) => {
  const job = downloadJobs.get(jobId);
  if (!job) return;
  job.attempts += 1;
  job.status = "running";
  job.message = "Validating file availability";
  job.progressPercent = 5;
  job.startedAt ??= Date.now();
  job.updatedAt = Date.now();

  const totalDuration = Math.max(1000, getRandomDelay());
  const progressStepMs = Math.max(1000, Math.floor(totalDuration / 10));
  let elapsed = 0;

  const progressTimer = setInterval(() => {
    elapsed += progressStepMs;
    const percent = Math.min(95, Math.round((elapsed / totalDuration) * 100));
    job.progressPercent = percent;
    if (percent > 70 && job.status === "running") {
      job.status = "processing_artifacts";
      job.message = "Packaging download artifacts";
    } else if (percent <= 70) {
      job.message = "Processing source files";
    }
    job.updatedAt = Date.now();
  }, progressStepMs);

  try {
    await sleep(totalDuration);
    const availabilityResults = await Promise.all(
      job.fileIds.map((fileId) => checkS3Availability(fileId)),
    );

    const allAvailable = availabilityResults.every(
      (result) => result.available,
    );
    const totalSize =
      availabilityResults.reduce(
        (sum, result) => sum + (result.size ?? 0),
        0,
      ) || null;

    if (allAvailable) {
      job.status = "completed";
      job.downloadUrl = `https://storage.example.com/downloads/${job.jobId}.zip?token=${crypto.randomUUID()}`;
      job.checksum = crypto.randomUUID().replace(/-/g, "");
      job.size = totalSize;
      job.message = `Download ready after ${(totalDuration / 1000).toFixed(1)} seconds`;
      job.retryAfterMs = null;
    } else {
      job.status = "failed";
      job.downloadUrl = null;
      job.size = null;
      job.message = "One or more files were unavailable in storage";
      job.retryAfterMs = 60000;
    }
  } catch (err) {
    job.status = "failed";
    job.downloadUrl = null;
    job.size = null;
    job.message =
      err instanceof Error ? err.message : "Unexpected worker failure";
    job.retryAfterMs = 60000;
  } finally {
    clearInterval(progressTimer);
    job.progressPercent =
      job.status === "completed" ? 100 : job.progressPercent;
    job.completedAt = Date.now();
    job.updatedAt = Date.now();
    job.expiresAt = Date.now() + env.DOWNLOAD_JOB_TTL_MS;
  }
};

const jobJanitor = setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of downloadJobs.entries()) {
    if (job.status !== "expired" && now >= job.expiresAt) {
      job.status = "expired";
      job.downloadUrl = null;
      job.message = "Job expired. Initiate a new download to regenerate files.";
      job.updatedAt = now;
    }
    const purgeAfter = job.expiresAt + env.DOWNLOAD_JOB_TTL_MS;
    if (now >= purgeAfter) {
      downloadJobs.delete(jobId);
      if (job.clientRequestId) {
        clientRequestJobIndex.delete(job.clientRequestId);
      }
    }
  }
}, 60000);

if (typeof jobJanitor.unref === "function") {
  jobJanitor.unref();
}
// Routes
const rootRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["General"],
  summary: "Root endpoint",
  description: "Returns a welcome message",
  responses: {
    200: {
      description: "Successful response",
      content: {
        "application/json": {
          schema: MessageResponseSchema,
        },
      },
    },
  },
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Health"],
  summary: "Health check endpoint",
  description: "Returns the health status of the service and its dependencies",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: HealthResponseSchema,
        },
      },
    },
    503: {
      description: "Service is unhealthy",
      content: {
        "application/json": {
          schema: HealthResponseSchema,
        },
      },
    },
  },
});

app.openapi(rootRoute, (c) => {
  return c.json({ message: "Hello Hono!" }, 200);
});

app.openapi(healthRoute, async (c) => {
  const storageHealthy = await checkS3Health();
  const status = storageHealthy ? "healthy" : "unhealthy";
  const httpStatus = storageHealthy ? 200 : 503;
  return c.json(
    {
      status,
      checks: {
        storage: storageHealthy ? "ok" : "error",
      },
    },
    httpStatus,
  );
});

// Download API Routes
const downloadInitiateRoute = createRoute({
  method: "post",
  path: "/v1/download/initiate",
  tags: ["Download"],
  summary: "Initiate download job",
  description: "Initiates a download job for multiple IDs",
  request: {
    body: {
      content: {
        "application/json": {
          schema: DownloadInitiateRequestSchema,
        },
      },
    },
  },
  responses: {
    202: {
      description: "Download job accepted for asynchronous processing",
      content: {
        "application/json": {
          schema: DownloadInitiateResponseSchema,
        },
      },
    },
    200: {
      description: "Existing job returned (idempotent clientRequestId)",
      content: {
        "application/json": {
          schema: DownloadInitiateResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid request",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

const downloadStatusRoute = createRoute({
  method: "get",
  path: "/v1/download/status/:jobId",
  tags: ["Download"],
  summary: "Fetch download job status",
  description:
    "Returns asynchronous job metadata, including progress and download URL if ready",
  request: {
    params: z.object({
      jobId: z
        .string()
        .min(1)
        .openapi({ description: "Download job identifier" }),
    }),
  },
  responses: {
    200: {
      description: "Current job status",
      content: {
        "application/json": {
          schema: DownloadJobStatusResponseSchema,
        },
      },
    },
    404: {
      description: "Job not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

const downloadRetrieveRoute = createRoute({
  method: "get",
  path: "/v1/download/:jobId",
  tags: ["Download"],
  summary: "Retrieve completed download",
  description:
    "Redirects to the presigned URL when the job is completed or returns the latest status when still processing.",
  request: {
    params: z.object({
      jobId: z
        .string()
        .min(1)
        .openapi({ description: "Download job identifier" }),
    }),
    query: z.object({
      format: z.enum(["json"]).optional().openapi({
        description:
          "Set to json to receive a JSON payload instead of a redirect",
      }),
    }),
  },
  responses: {
    302: {
      description: "Redirect to presigned download URL",
    },
    200: {
      description: "JSON download metadata",
      content: {
        "application/json": {
          schema: DownloadJobStatusResponseSchema,
        },
      },
    },
    404: {
      description: "Job not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    409: {
      description: "Job not ready",
      content: {
        "application/json": {
          schema: DownloadJobStatusResponseSchema,
        },
      },
    },
  },
});

const downloadCheckRoute = createRoute({
  method: "post",
  path: "/v1/download/check",
  tags: ["Download"],
  summary: "Check download availability",
  description:
    "Checks if a single ID is available for download in S3. Add ?sentry_test=true to trigger an error for Sentry testing.",
  request: {
    query: z.object({
      sentry_test: z.string().optional().openapi({
        description:
          "Set to 'true' to trigger an intentional error for Sentry testing",
      }),
    }),
    body: {
      content: {
        "application/json": {
          schema: DownloadCheckRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Availability check result",
      content: {
        "application/json": {
          schema: DownloadCheckResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid request",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(downloadInitiateRoute, (c) => {
  const { file_ids, clientRequestId, priority, userId } = c.req.valid("json");
  const normalizedPriority: DownloadPriority = priority ?? "standard";
  const normalizedUserId = userId ?? "anonymous";
  const trimmedClientId = clientRequestId?.trim();

  if (trimmedClientId) {
    const existingJobId = clientRequestJobIndex.get(trimmedClientId);
    if (existingJobId) {
      const existingJob = downloadJobs.get(existingJobId);
      if (existingJob) {
        return c.json(
          {
            jobId: existingJob.jobId,
            status: existingJob.status,
            nextPollInMs: DEFAULT_POLL_INTERVAL_MS,
            expiresAt: new Date(existingJob.expiresAt).toISOString(),
            totalFileIds: existingJob.fileIds.length,
            deduplicated: true,
          },
          200,
        );
      }
    }
  }

  const job = createDownloadJob({
    fileIds: file_ids,
    priority: normalizedPriority,
    clientRequestId: trimmedClientId,
    userId: normalizedUserId,
  });

  const enqueueHandle = setTimeout(() => {
    enqueueJob(job.jobId);
  }, 0);
  if (typeof enqueueHandle.unref === "function") {
    enqueueHandle.unref();
  }

  return c.json(
    {
      jobId: job.jobId,
      status: job.status,
      nextPollInMs: DEFAULT_POLL_INTERVAL_MS,
      expiresAt: new Date(job.expiresAt).toISOString(),
      totalFileIds: job.fileIds.length,
    },
    202,
  );
});

app.openapi(downloadStatusRoute, (c) => {
  const { jobId } = c.req.valid("param");
  const job = downloadJobs.get(jobId);
  if (!job) {
    return c.json(
      {
        error: "Not Found",
        message: `Job ${jobId} was not found or has expired`,
        requestId: c.get("requestId"),
      },
      404,
    );
  }
  return c.json(toJobResponse(job), 200);
});

app.openapi(downloadRetrieveRoute, (c) => {
  const { jobId } = c.req.valid("param");
  const { format } = c.req.valid("query");
  const job = downloadJobs.get(jobId);
  if (!job) {
    return c.json(
      {
        error: "Not Found",
        message: `Job ${jobId} was not found or has expired`,
        requestId: c.get("requestId"),
      },
      404,
    );
  }

  if (job.status !== "completed" || !job.downloadUrl) {
    return c.json(toJobResponse(job), 409);
  }

  if (format === "json") {
    return c.json(toJobResponse(job), 200);
  }
  return c.redirect(job.downloadUrl, 302);
});

app.openapi(downloadCheckRoute, async (c) => {
  const { sentry_test } = c.req.valid("query");
  const { file_id } = c.req.valid("json");

  // Intentional error for Sentry testing (hackathon challenge)
  if (sentry_test === "true") {
    throw new Error(
      `Sentry test error triggered for file_id=${String(file_id)} - This should appear in Sentry!`,
    );
  }

  const s3Result = await checkS3Availability(file_id);
  return c.json(
    {
      file_id,
      ...s3Result,
    },
    200,
  );
});

// Download Start Route - simulates long-running download with random delay
const downloadStartRoute = createRoute({
  method: "post",
  path: "/v1/download/start",
  tags: ["Download"],
  summary: "Start file download (long-running)",
  description: `Starts a file download with simulated processing delay.
    Processing time varies randomly between ${String(env.DOWNLOAD_DELAY_MIN_MS / 1000)}s and ${String(env.DOWNLOAD_DELAY_MAX_MS / 1000)}s.
    This endpoint demonstrates long-running operations that may timeout behind proxies.`,
  request: {
    body: {
      content: {
        "application/json": {
          schema: DownloadStartRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Download completed successfully",
      content: {
        "application/json": {
          schema: DownloadStartResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid request",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(downloadStartRoute, async (c) => {
  const { file_id } = c.req.valid("json");
  const startTime = Date.now();

  // Get random delay and log it
  const delayMs = getRandomDelay();
  const delaySec = (delayMs / 1000).toFixed(1);
  const minDelaySec = (env.DOWNLOAD_DELAY_MIN_MS / 1000).toFixed(0);
  const maxDelaySec = (env.DOWNLOAD_DELAY_MAX_MS / 1000).toFixed(0);
  console.log(
    `[Download] Starting file_id=${String(file_id)} | delay=${delaySec}s (range: ${minDelaySec}s-${maxDelaySec}s) | enabled=${String(env.DOWNLOAD_DELAY_ENABLED)}`,
  );

  // Simulate long-running download process
  await sleep(delayMs);

  // Check if file is available in S3
  const s3Result = await checkS3Availability(file_id);
  const processingTimeMs = Date.now() - startTime;

  console.log(
    `[Download] Completed file_id=${String(file_id)}, actual_time=${String(processingTimeMs)}ms, available=${String(s3Result.available)}`,
  );

  if (s3Result.available) {
    return c.json(
      {
        file_id,
        status: "completed" as const,
        downloadUrl: `https://storage.example.com/${s3Result.s3Key ?? ""}?token=${crypto.randomUUID()}`,
        size: s3Result.size,
        processingTimeMs,
        message: `Download ready after ${(processingTimeMs / 1000).toFixed(1)} seconds`,
      },
      200,
    );
  } else {
    return c.json(
      {
        file_id,
        status: "failed" as const,
        downloadUrl: null,
        size: null,
        processingTimeMs,
        message: `File not found after ${(processingTimeMs / 1000).toFixed(1)} seconds of processing`,
      },
      200,
    );
  }
});

// OpenAPI spec endpoint (disabled in production)
if (env.NODE_ENV !== "production") {
  app.doc("/openapi", {
    openapi: "3.0.0",
    info: {
      title: "Delineate Hackathon Challenge API",
      version: "1.0.0",
      description: "API for Delineate Hackathon Challenge",
    },
    servers: [{ url: "http://localhost:3000", description: "Local server" }],
  });

  // Scalar API docs
  app.get("/docs", Scalar({ url: "/openapi" }));
}

// Graceful shutdown handler
const gracefulShutdown = (server: ServerType) => (signal: string) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    console.log("HTTP server closed");

    // Shutdown OpenTelemetry to flush traces
    otelSDK
      .shutdown()
      .then(() => {
        console.log("OpenTelemetry SDK shut down");
      })
      .catch((err: unknown) => {
        console.error("Error shutting down OpenTelemetry:", err);
      })
      .finally(() => {
        // Destroy S3 client
        s3Client.destroy();
        console.log("S3 client destroyed");
        console.log("Graceful shutdown completed");
      });
  });
};

// Start server
const server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${String(info.port)}`);
    console.log(`Environment: ${env.NODE_ENV}`);
    if (env.NODE_ENV !== "production") {
      console.log(`API docs: http://localhost:${String(info.port)}/docs`);
    }
  },
);

// Register shutdown handlers
const shutdown = gracefulShutdown(server);
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
