# Pi Durable migration fixture

`pi-durable-1.4.0.sqlite.gz` is a gzip-compressed SQLite database produced by the actual `@earendil-works/pi-durable` 1.4.0 Harness and SqliteStorage with Chord 1.4.0, using Uzina's Bun SQLite facade. It is not a database assembled from the new runtime's schema or exported logical records.

The fixture was generated in a disposable directory by opening a Harness with a fresh registry and the deterministic `uzina-test/fixed-model` provider, creating its root with that model, and submitting `keep this pre-upgrade request` under request ID `legacy-request`. The provider returned `persisted by Pi Durable 1.4.0`. After waiting for the submission and closing the Harness, the complete SQLite file was compressed. Only the external model transport was deterministic; storage and task execution used the real 1.4.0 runtime.

The root ID is 1 and the settled submission ID is 8. There is one user message and one assistant response, with no pending work. The database contains only synthetic test content and no credentials, Factory records, or workspace files. Do not regenerate it with the current dependency: doing so would stop testing an old on-disk format.

The migration test opens a decompressed copy with the current runtime, verifies the old context and receipt, retries the same request without a model call, and then runs one new request. This tests settled-store upgrade behavior, not recovery of every possible old in-flight task.
