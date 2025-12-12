import * as Sentry from "@sentry/react";
import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import { ZoneContextManager } from "@opentelemetry/context-zone";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { UserInteractionInstrumentation } from "@opentelemetry/instrumentation-user-interaction";

const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
const otlpEndpoint = import.meta.env.VITE_OTEL_EXPORTER_URL;

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration(),
    ],
    tracesSampleRate: 1.0,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
}

const provider = new WebTracerProvider({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: "download-dashboard",
  }),
});

if (otlpEndpoint) {
  const exporter = new OTLPTraceExporter({ url: otlpEndpoint });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
}

provider.register({
  contextManager: new ZoneContextManager(),
});

registerInstrumentations({
  instrumentations: [
    new DocumentLoadInstrumentation(),
    new UserInteractionInstrumentation(),
  ],
});

const tracer = provider.getTracer("download-dashboard");

type InstrumentedFetchOptions = {
  spanName?: string;
  parentSpan?: Span;
  onRecord?: (args: {
    traceId: string;
    duration: number;
    response: Response;
  }) => void;
  ignoreErrors?: boolean;
};

export const getTracer = () => tracer;

const headerSetter = {
  set(carrier: Headers, key: string, value: string) {
    carrier.set(key, value);
  },
};

export async function instrumentedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: InstrumentedFetchOptions = {},
) {
  const parentContext = options.parentSpan
    ? trace.setSpan(context.active(), options.parentSpan)
    : context.active();

  const span = tracer.startSpan(
    options.spanName ?? `fetch:${init.method ?? "GET"}`,
    {
      attributes: {
        "http.url": typeof input === "string" ? input : input.toString(),
        "http.method": init.method ?? "GET",
      },
    },
    parentContext,
  );

  const ctx = trace.setSpan(parentContext, span);
  const headers = new Headers(init.headers ?? {});
  propagation.inject(ctx, headers, headerSetter);
  const started = performance.now();

  try {
    const response = await context.with(ctx, () =>
      fetch(input, { ...init, headers }),
    );
    const duration = performance.now() - started;
    span.setAttribute("http.status_code", response.status);
    span.setStatus({
      code:
        response.ok || options.ignoreErrors
          ? SpanStatusCode.OK
          : SpanStatusCode.ERROR,
    });

    const traceId = span.spanContext().traceId;
    options.onRecord?.({ traceId, duration, response });
    return { response, traceId, duration };
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    Sentry.captureException(err);
    throw err;
  } finally {
    span.end();
  }
}

export function captureFrontendError(
  message: string,
  contextData?: Record<string, unknown>,
) {
  Sentry.captureMessage(message, {
    level: "error",
    extra: contextData,
  });
}

export function showFeedbackDialog() {
  if (sentryDsn) {
    Sentry.showReportDialog();
  }
}
