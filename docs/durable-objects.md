# Hosting Durable in a Cloudflare Durable Object

Arc's Durable library includes a Cloudflare SQLite adapter. The local Arc CLI uses Node and local session files. Installing the CLI does not deploy a Worker or create a cloud session.

## Runtime layout

A hosted application needs this connection:

```text
Terminal or another client
  -> authenticated HTTP or WebSocket gateway Worker
     -> one Durable Object per session
        -> Harness and the object's SQLite storage
```

The gateway checks access before choosing an object by session ID. A Durable Object stores its own data through `ctx.storage`. Its class extends Cloudflare's `DurableObject`. A namespace binding lets the gateway obtain a stub and call that object. See the [Cloudflare setup guide](https://developers.cloudflare.com/durable-objects/get-started/).

## Existing support

`openDurableObjectSqliteStorage` from `@arc/durable/storage/sqlite/cloudflare` connects the runtime to object storage. The library's documents, conversations, task records and commits use that backend.

The runnable example in [test/workers/worker.mjs](../test/workers/worker.mjs) opens a Harness, registers tools, runs a model/tool exchange, closes the Harness and checks persisted data after reopening. The worker tests also exercise Code Mode locally in workerd through Miniflare.

Run the local checks with:

```sh
npm run test:workers
```

These checks exercise the library in a local worker runtime. They do not deploy the complete Arc application or establish production hosting readiness.

## Application work for a hosted agent

A hosted agent must supply authentication, session routing, streamed updates and reconnect handling. It must register its extensions and execution environment before resuming recovered work. Use object alarms and explicit host lifecycle handling for deadlines and wakeups; an in-memory timer alone does not survive object eviction.

A Worker cannot run Bash against your laptop's filesystem. File and shell tools need a separate authenticated execution service or a connection to a local host. Worker-compatible extensions belong in the deployed bundle. Arc's native Node extension-file loader is not a Workers module loader; local file reload and Worker deployment are different operations.

The reusable TUI can display a remote session, but the current Arc CLI has no complete remote-session gateway client. That transport and its UI connection must be implemented before using this layout as the application.
