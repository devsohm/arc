# Session storage

Arc uses one storage backend for each session. SQLite is the default. JSONL and memory are already available through the same Durable interface.

| Start command | Session backend | Survives exit |
| --- | --- | --- |
| `arc` | SQLite | Yes |
| `arc --backend sqlite` | SQLite | Yes |
| `arc --backend jsonl` | JSONL directory | Yes |
| `arc --backend memory` | `MemoryStorage` | No |

SQLite sessions still use memory for running tasks, loaded documents and terminal state. `MemoryStorage` is an alternative session backend. It is not an extra cache that must be enabled beside SQLite.

Memory mode does not disable ordinary application files. Login credentials, settings and trust decisions can still be saved in the application home.

## Locate the current session

Run `/session` to show the active session path. Persistent sessions are grouped under `~/.arc/sessions/<working-directory-hash>/`. Set `--home` to use another application data directory.

A normal launch creates a session. `arc --continue` opens the most recently changed session for the current working directory. `arc --session <path>` opens a particular session. Its path selects SQLite or JSONL when reopening; the backend flag selects the backend for a new session.

`/new` creates another session using the selected backend. In memory mode, it creates an independent conversation in the current in-memory Harness. `/resume` lists saved sessions. `/clone` copies a file-backed session using the same backend. It is not a SQLite-to-JSONL converter.

## Inspect SQLite

`/session` reports the database filename. Conversations, entries, tasks, submissions, documents and revisions are stored as tables inside that database.

SQLite may create `-wal` and `-shm` companion files while it is open. These are SQLite files, not extra sessions. Keep them with the database while it is in use. Use a read-only SQLite viewer to inspect records.

## Inspect JSONL

Start a JSONL session:

```sh
arc --backend jsonl
```

Use `/session` to find its directory. Despite its `.jsonl` suffix, the session path is a directory with several files:

- `main.jsonl` contains format-1 commit records with a sequence and writes.
- `doc-<id>.jsonl` contains document bases and changes.
- `task-<id>.jsonl` holds live task state when needed.

Sidecar files can be reclaimed when their records no longer need them. Each complete line is JSON. Records describe durable runtime state, not just chat messages.

Read these files without editing them while Arc runs. To retain a complete session, copy the directory after closing Arc. Copying only `main.jsonl` can omit required document or task data.

## Export a conversation

`/export conversation.json` writes model messages in the Arc transcript format. `/export conversation.html` writes a readable HTML conversation. These exports omit complete task and document state and are not storage backups.

Arc does not automatically mirror a SQLite session into JSONL. The three backends are alternatives. Running three independent writers for one session would require a consistency protocol; Arc does not do that.


## Stored record layout

The SQLite backend uses schema version 2. Schema version 1 creates the records and indexes. Version 2 allows the `sleeping` task state. Schema version numbers describe the database layout; they are separate from the JSONL format number.

| SQLite table | Stored information |
| --- | --- |
| `durable_schema` | Applied schema versions |
| `durable_metadata` | Next record ID and commit sequence |
| `record_ids` | Record ID ownership and record type |
| `conversations` | Conversation identity, parent and owner |
| `entries` | Conversation entries, heads and commit sequences |
| `tasks` | Task identity, status, ownership and serialized state |
| `submissions` | Submitted requests, placement and completion |
| `documents` | Document identity, scope, lifetime and serialized metadata |
| `document_revisions` | Document bases and changes, ordered by commit sequence |

The `record` columns contain JSON. A document revision stores its JSON in `content`. IDs use SQLite integer keys; `next_id` uses text to preserve values outside JavaScript's safe integer range. A configured table prefix changes identifiers without changing record semantics.

A JSONL commit has this outer shape:

```json
{"format":1,"type":"commit","seq":1,"writes":[{"type":"conversation","value":{"id":1}}]}
```

Document and active-task sidecars use this outer shape:

```json
{"format":1,"type":"record","seq":2,"ordinal":0,"payload":{"type":"document","id":2,"content":{"kind":"base","version":1,"value":{"count":0}}}}
```

The main commit references sidecar records by sequence and ordinal. A complete session can contain conversation, entry, submission, task and document writes. Task checkpoints and document changes preserve runtime state across reopening. These are storage records; they are not Markdown tables or terminal rows.

Arc adds its own application documents and entry kinds for features such as session labels and custom messages. The storage container does not make another application's complete session interchangeable: application kinds, extension definitions and provider identity still have to be understood.


## Recover interrupted work

Opening a saved session with `/resume`, `--session`, or `--continue` starts its recoverable tasks after extensions and session hooks finish loading. Closing the interactive terminal preserves unfinished durable work. Ctrl+C during a turn and `/abort` explicitly cancel it instead.

Recovery continues from committed checkpoints, not an arbitrary instruction inside a tool. A tool marked safe to replay can run again. A tool without that guarantee receives an interrupted result because it may already have changed files or external state. The model receives that result and can inspect the outcome before continuing. Completed tool results remain recorded.

Previously cancelled turns remain cancelled when reopened; send a new continuation message to start another turn. A memory-only session cannot survive process exit. A crashed process can leave the session lock in place until its 30-second stale interval expires.

SDK applications retain the existing cancelling `close()` behavior. Use `close({preserveWork: true})` to release the host while keeping durable tasks recoverable. External side effects are not rolled back by closing the host.
