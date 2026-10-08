import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { env } from '../config/env';

let sdk: NodeSDK | null = null;
let initialized = false;

/**
 * Boots the OpenTelemetry SDK.
 *
 * `serviceNameOverride` lets workers register under their own service identity
 * (see `OTEL_WORKER_SERVICE_NAME`) while still reusing the API's exporter and
 * instrumentation setup. Calling this more than once is a no-op, so it is safe
 * to call from worker bootstraps.
 */
export async function startTelemetry(serviceNameOverride?: string): Promise<void> {
  if (initialized) return;

  // Load-test / CI fast path: creating Http + Prisma spans costs CPU on
  // every request even with no collector listening. Opt out explicitly via
  // OTEL_SDK_DISABLED=true (set in the k6 performance job).
  if (process.env.OTEL_SDK_DISABLED === 'true') {
    initialized = true;
    return;
  }

  const traceExporter = new OTLPTraceExporter({
    url: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  sdk = new NodeSDK({
    serviceName: serviceNameOverride ?? env.OTEL_SERVICE_NAME,
    traceExporter,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => {
          return request.url === '/metrics';
        },
      }),
      new PrismaInstrumentation(),
    ],
  });

  sdk.start();
  initialized = true;
  console.log(
    `[Telemetry] OpenTelemetry initialized for service: ${serviceNameOverride ?? env.OTEL_SERVICE_NAME}`,
  );
}

export async function shutdownTelemetry(): Promise<void> {
  if (!initialized || !sdk) return;
  await sdk.shutdown();
  initialized = false;
  sdk = null;
  console.log('[Telemetry] OpenTelemetry shut down');
}

