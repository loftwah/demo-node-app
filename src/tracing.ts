// OpenTelemetry setup for the demo Node app
// Enables HTTP/Express, Postgres (pg), and Redis (ioredis) tracing.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

function parseOtlpHeadersFromEnv(envValue?: string): Partial<Record<string, unknown>> | undefined {
  if (!envValue) return undefined;
  const headers: Record<string, string> = {};
  for (const pair of envValue.split(',')) {
    if (!pair) continue;
    const [rawKey, ...rest] = pair.split('=');
    const key = rawKey?.trim();
    const value = rest.join('=');
    if (!key) continue;
    headers[key] = value?.trim();
  }
  return headers;
}

const serviceName = process.env.OTEL_SERVICE_NAME || 'demo-node-app';
const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector.observability:4318';

const traceExporter = new OTLPTraceExporter({
  url: `${otlpEndpoint}/v1/traces`,
  headers: parseOtlpHeadersFromEnv(process.env.OTEL_EXPORTER_OTLP_HEADERS),
});

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    [SemanticResourceAttributes.SERVICE_VERSION]: process.env.APP_VERSION || '0.1.0',
    'deployment.environment': process.env.APP_ENV || 'staging',
  }),
  traceExporter,
  instrumentations: getNodeAutoInstrumentations({
    // Keep defaults but ensure these common libs are on
    '@opentelemetry/instrumentation-http': { enabled: true },
    '@opentelemetry/instrumentation-express': { enabled: true },
    '@opentelemetry/instrumentation-pg': { enabled: true },
    '@opentelemetry/instrumentation-ioredis': { enabled: true },
  }),
});

sdk.start();

process.on('SIGTERM', async () => {
  try {
    await sdk.shutdown();
  } finally {
    process.exit(0);
  }
});
