# @arc/telemetry

Telemetry provides spans, diagnostic context, measurements, schemas, adapters, and conformance checks. Applications own sampling, export, and persistence policy. The optional SQLite recorder is exported by Durable.

## Example

```ts
import { InMemoryTelemetryContext } from "@arc/telemetry";

const telemetry = new InMemoryTelemetryContext();
const duration = telemetry.histogram("load.duration", { unit: "ms" });
await telemetry.startSpan({ name: "load", attributes: { source: "disk" } }, async (span) => {
	span.addEvent("started");
	const count = await span.startSpan({ name: "read" }, () => 2);
	span.setAttributes({ count });
	duration.record(12, {}, span);
});
console.log(JSON.stringify(telemetry.getSpans().map((span) => span.name)));
console.log(telemetry.getMetrics()[0].value);
```

## Reference

- [Package specification](docs/spec.md)

[API reference](docs/api.md)
