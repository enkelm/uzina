# Authenticated Factory client

`@uzina/client` exports `FactoryClient`, a reusable, runtime-decoding JSON HTTP SDK for the single Factory's query and input operations. It is a public client package, not a claim that Pi Durable custom tools or a private assistant runtime are installed; those consumers are deferred to slice 7b.

```ts
import { FactoryClient } from "@uzina/client";

const client = new FactoryClient({
  baseUrl: "http://127.0.0.1:8788",
  credential: namedAssistantCredential,
});

const identity = await client.me({ signal }); // includes non-secret credentialId and actor identity
const projects = await client.listProjects({ limit: 50, signal });
const receipt = await client.submitInput(
  "thread:target",
  "request:stable-application-id",
  "Investigate the failing test",
  { signal },
);
const reconciled = await client.getReceipt(receipt.requestId, { signal });
```

`baseUrl` must be one `http:` or `https:` origin without path, URL credentials, query, or fragment. The supplied bearer credential is sent only to same-origin Factory paths. Every fetch uses `redirect: "error"`; redirect responses and response URLs on another origin are refused, so an HTTP redirect cannot forward the credential elsewhere. This does not configure a private route, Cloudflare Access, or tailnet ingress.

The client supports typed `me()` identity verification plus bounded `listProjects`, `listThreads`, `listNodes`, `listWorkspaces`, `listRuns`, `getReceipt`, `submitInput`, `getContext`, `getStatus`, `getEvents`, and `getLifecycleCapabilities`. `me()` additively returns the non-secret active `credentialId`, actor identity, and participant; hosts use it to verify a configured assistant ID and accountable owner without caching its grants. Query limits are validated to 1–100, event cursors are nonnegative safe integers, JSON responses are runtime-decoded with contract schemas where available, and all response bodies are streamed under a 256 KiB actual-byte cap. The client cancels and releases an overflowing reader before decoding; it uses a fixed-cap byte buffer and decodes UTF-8 only after a complete bounded read. Body-read `AbortError`s are rethrown unchanged. Safe `FactoryClientError` values include only an HTTP status and bounded error code, never response bodies or credentials.

The caller must supply the stable application `requestId` for `submitInput`. The client never generates a replacement ID after a lost acknowledgement: call `getReceipt(requestId)` or retry `submitInput` with the same target, ID, and payload. The Factory command receipt is distinct from an HTTP, MCP JSON-RPC, or Pi tool call ID. Core enforces authorization on each request and stores only credential hashes.

The owner-private assistant uses a separately operator-installed host bearer and this client through ordinary Core HTTP operations. Its private input/context/status/receipt routes are owner-only, distinct from thread queues, and do not accept a client role. Guests, viewers, nodes, and other assistant actors cannot read its transcript or receipts.
