/* Optional tracing with OpenTelemetry, for the workday simulation. Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
   It sends only to this machine (a local OpenObserve): any other endpoint is refused. The span of a request carries the
   W3C `traceparent` header, so a call from one desk to another shows as one trace. The packages are optional dependencies;
   without them every function here does nothing. Setup: workday-sim-plan/observability/README. */
import type { MiddlewareHandler } from "hono";

type Api = typeof import("@opentelemetry/api");
let api: Api | null = null;
const LOCAL = ["127.0.0.1", "localhost", "[::1]", "::1"];

export async function startTelemetry(service: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim().replace(/\/$/, "");
  if (!endpoint || api) return !!api;
  for (const v of [env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, endpoint]) if (v && !LOCAL.includes(new URL(v).hostname)) throw new Error("Telemetry goes to this machine only: OTEL_EXPORTER_OTLP_ENDPOINT must be localhost.");
  try {
    const [a, node, exp, res] = await Promise.all([import("@opentelemetry/api"), import("@opentelemetry/sdk-trace-node"), import("@opentelemetry/exporter-trace-otlp-http"), import("@opentelemetry/resources")]);
    const headers = Object.fromEntries((env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",").filter(Boolean).map((h) => { const i = h.indexOf("="); return [h.slice(0, i).trim(), decodeURIComponent(h.slice(i + 1).trim())]; }));
    const provider = new node.NodeTracerProvider({
      resource: res.resourceFromAttributes({ "service.name": service }),
      spanProcessors: [new node.BatchSpanProcessor(new exp.OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }), { scheduledDelayMillis: 1000 })],
    });
    provider.register();
    process.on("beforeExit", () => { void provider.shutdown(); });
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => { void provider.shutdown().finally(() => process.exit(0)); });
    api = a;
    return true;
  } catch {
    console.error("Telemetry is set but the OpenTelemetry packages are not installed (npm install).");
    return false;
  }
}

/** Flushes spans before a short-lived script exits. */
export async function flushTelemetry(): Promise<void> {
  if (!api) return;
  const p = api.trace.getTracerProvider() as unknown as { forceFlush?: () => Promise<void> };
  await p.forceFlush?.();
}

/** A Hono middleware: one server span per request, continuing the caller's trace when it sent a `traceparent`. */
export function traceRequests(): MiddlewareHandler {
  return async (c, next) => {
    if (!api || c.req.path === "/api/health") return next();
    const a = api;
    const parent = a.propagation.extract(a.context.active(), Object.fromEntries(c.req.raw.headers.entries()));
    const span = a.trace.getTracer("events-desk").startSpan(`${c.req.method} ${c.req.path}`, { kind: a.SpanKind.SERVER, attributes: { "http.request.method": c.req.method, "url.path": c.req.path } }, parent);
    try {
      await a.context.with(a.trace.setSpan(parent, span), next);
      span.setAttribute("http.response.status_code", c.res.status);
      if (c.res.status >= 500) span.setStatus({ code: a.SpanStatusCode.ERROR });
    } catch (e) { span.setStatus({ code: a.SpanStatusCode.ERROR }); throw e; } finally { span.end(); }
  };
}

/** fetch that adds a client span and the `traceparent` header while tracing is on; plain fetch otherwise. */
export const tracedFetch: typeof fetch = async (input, init) => {
  if (!api) return fetch(input, init);
  const a = api;
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const span = a.trace.getTracer("events-desk").startSpan(`${init?.method ?? "GET"} ${url.host}${url.pathname}`, { kind: a.SpanKind.CLIENT, attributes: { "http.request.method": init?.method ?? "GET", "url.full": `${url.origin}${url.pathname}` } });
  const headers = new Headers(init?.headers);
  a.propagation.inject(a.trace.setSpan(a.context.active(), span), headers, { set: (h, k, v) => h.set(k, v) });
  try {
    const r = await fetch(input, { ...init, headers });
    span.setAttribute("http.response.status_code", r.status);
    if (r.status >= 500) span.setStatus({ code: a.SpanStatusCode.ERROR });
    return r;
  } catch (e) { span.setStatus({ code: a.SpanStatusCode.ERROR }); throw e; } finally { span.end(); }
};
