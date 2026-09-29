import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { env, envFlag } from '../config/env';

let sdk: NodeSDK | null = null;
let initialized = false;

/**
 * Master switch for tracing. `OTEL_TRACES_ENABLED=false` stops the SDK from
 * being constructed at all, so a deployment that cannot reach a collector pays
 * nothing for the instrumentation rather than queueing spans it can never ship.
 */
export function isTelemetryEnabled(): boolean {
  return envFlag(env.OTEL_TRACES_ENABLED, true);
}

export interface StartTelemetryOptions {
  /**
   * Overrides `OTEL_SERVICE_NAME` for this process. Worker processes must pass
   * their own name (e.g. `stellar-alerts-dispatcher`) or their spans land in
   * Jaeger indistinguishable from the API server's.
   */
  serviceName?: string;
}

export async function startTelemetry(options: StartTelemetryOptions = {}): Promise<void> {
  if (initialized) return;

  if (!isTelemetryEnabled()) {
    console.log('[Telemetry] Tracing disabled (OTEL_TRACES_ENABLED=false)');
    return;
  }

  const serviceName = options.serviceName ?? env.OTEL_SERVICE_NAME;

  const traceExporter = new OTLPTraceExporter({
    url: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  sdk = new NodeSDK({
    serviceName,
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
  console.log(`[Telemetry] OpenTelemetry initialized for service: ${serviceName}`);
}

export async function shutdownTelemetry(): Promise<void> {
  if (!initialized || !sdk) return;
  await sdk.shutdown();
  initialized = false;
  sdk = null;
  console.log('[Telemetry] OpenTelemetry shut down');
}
