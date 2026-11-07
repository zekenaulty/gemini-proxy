# Public résumé chat worker

A narrow, anonymous public-chat endpoint using the OpenAI Responses API. This replaces the raw Gemini proxy. It does not provide a private résumé generator, file access, tools, or an arbitrary OpenAI proxy.

**This is a code-only migration. Chat is disabled by default. The code supports an existing Secrets Store secret; no secret value, account/store identifier, public résumé context, limiter resources, or deployment is supplied by this change.** The existing Gemini frontend is incompatible with the new contract; switch the client and worker together after review.

## Browser contract

`POST /chat` with `Content-Type: application/json` and this body:

```json
{"messages":[{"role":"user","text":"What experience is described on the résumé?"}]}
```

- 1–12 messages, only `user` or `assistant` roles, ending with a user message.
- Exactly `role` and `text` on each message. No extra top-level fields.
- At most 2,000 JavaScript string characters per message, 8,000 total, and 32 KiB actual JSON bytes.
- No model selection, system prompts, provider payloads, response IDs, tools, files, images, or URLs to fetch.
- The only production origin is `https://zekenaulty.github.io`. Missing origins, `null`, other sites, and localhost are rejected. Only `/chat` is routed; queries and legacy `/` requests are rejected.

Success is `{ "text": "…", "incomplete": false, "truncated": false }`. Text is capped at 2,000 characters. Display an explicit partial-answer notice when either flag is true. Do not silently present a partial answer as complete. The client should keep older history locally, send a bounded recent window, and explain when older context is omitted.

Failures are `{ "error": { "code": "…", "message": "…" } }`. Messages are safe to display:

- 400 `invalid_request`; 403 `origin_not_allowed`; 404 `not_found`; 405 `method_not_allowed`.
- 408 `request_timeout`; 413 `request_too_large`; 415 `unsupported_media_type`.
- 429 `rate_limited`, with exposed `Retry-After: 60`.
- 502 `reply_unavailable` when no usable visible answer is available.
- 503 `chat_disabled`, `chat_unavailable`, or `upstream_unavailable`.
- 504 `upstream_timeout`.

Use a client timeout of at least 75 seconds. Never automatically retry a paid request. A timed-out or disconnected request may already have incurred provider costs; aborting is not a billing guarantee. Do not interpret a blank or failed response as an instruction to call Gemini or another endpoint.

## Operator settings

Keep `PUBLIC_CHAT_ENABLED` set to the string `"false"` until configuration and review are complete. Set it to `"true"` only for an authorized rollout. It is also the stop switch if public usage becomes unwanted.

Required settings, configured server-side by the operator:

- `OPENAI_API_KEY`: the approved existing key through a Cloudflare Secrets Store binding. The runtime calls `await env.OPENAI_API_KEY.get()`; the binding object is not a key string. Direct Worker string secrets remain supported for existing deployments/tests, but the prepared operator configuration references the existing account secret instead of creating another key or copying its value. Never put a value in source, a public build, a `VITE_*` variable, a browser token, or a logged request. Preparing this change does not read, install, attach, or deploy a live key.
- `PUBLIC_RESUME_CONTEXT`: a curated plain-text summary containing only facts approved for public answers, at most **4,500 UTF-8 bytes**. No applications, private contact details, correspondence, unpublished projects, private job targets, or generated private résumé drafts. Cloudflare variables have a 5 KB limit. A larger reviewed corpus would require a separately approved bundled asset or data binding, not unbounded visitor-supplied context.
- `CHAT_CLIENT_LIMITER` and `CHAT_AGGREGATE_LIMITER`: both Cloudflare Rate Limiting bindings are mandatory. A missing, broken, or malformed binding fails closed before OpenAI is called. There is no in-memory fallback.

The public context is not confidential simply because it lives server-side: model answers can reveal any fact placed there. The model's topic instructions are guidance, not an authorization or privacy boundary. Keep private material out of this worker entirely.

Two optional settings have safe defaults and hard ceilings:

- `CHAT_MAX_OUTPUT_TOKENS`: default `"4096"`, allowed range 512–8192. This includes reasoning and visible output. With high reasoning, a cap can be reached before useful text is generated. Partial text is returned with a flag; no text produces a clear error. Tune only after a separately authorized representative live check.
- `CHAT_UPSTREAM_TIMEOUT_MS`: default `"55000"`, allowed range 1000–60000. The deadline covers Secrets Store lookup, fetching and reading the response. The incoming request body has its own 10-second deadline.

The model is server-owned `gpt-6.1-sol` with `reasoning.effort: "high"`, low verbosity, `store: false`, and no tools or temperature override. Model access for the chosen account remains unverified. `store: false` is not a promise of zero provider retention; review the account's data controls before launch.

### Existing Secrets Store binding, not deployed

Keep the shared `wrangler.jsonc` disabled and free of operator-specific identifiers. Copy it to the ignored `wrangler.operator.jsonc` in the repository root, then add the following entry using the verified existing store identifier. The binding and existing secret name are both `OPENAI_API_KEY`. The local operator configuration is a prepared deployment input; it does **not** mean a live Worker binding has been created or attached. Do not commit or post that account-specific config, and never put a secret value in it.

```json
"secrets_store_secrets": [
  {
    "binding": "OPENAI_API_KEY",
    "store_id": "<verified existing store ID>",
    "secret_name": "OPENAI_API_KEY"
  }
]
```

The Worker accepts either the configured asynchronous binding or an existing direct Worker string secret under that environment name, not both at once. There is no fallback lookup, second credential, automatic key creation, or cross-request application cache. All public route/configuration checks, request validation and both limiter decisions run before a store lookup. Retrieval failures, empty/malformed values and invalid binding shapes return the same sanitized `chat_unavailable` error without an OpenAI request. A stalled lookup shares the bounded upstream deadline. Disconnects/timeouts prevent late lookup completion from starting a paid call, although the Secrets Store API itself does not expose cancellation of an already-started `get()`.

Before any separately approved attachment/deployment, confirm the existing secret permits Workers usage and the deploying identity has the necessary Secrets Store Deployer role (or an existing sufficient role). Do not expand roles, persistent access or scope implicitly. Do not add a same-name direct Worker secret, run a secret-create/put command, or read the value back just to complete this migration. Scope the already-authorized Wrangler identity to the intended Cloudflare account and this repository's explicit config; do not copy login material or tokens into the repo, command line, scripts or public review comments.

For code/config validation without credentials or deployment, use the installed Wrangler CLI with `deploy --dry-run --config ./wrangler.operator.jsonc --outdir <disposable-directory>` and metrics disabled. Run that check with an isolated temporary HOME/XDG configuration and no inherited Cloudflare/OpenAI credentials. This is a local bundle/schema check, not proof that the store/secret exists, that its scope permits Workers, or that the account can call the selected OpenAI model. Node tests use synthetic `get()` implementations only. Cloudflare documents that local development cannot read production Secrets Store values; never enable remote development or load a live key just to test this branch.

### Proposed limiter configuration, not provisioned

Add this `ratelimits` array to the reviewed Wrangler configuration only after selecting two unused namespace IDs for the account. The numbers below are examples, not verified account identifiers. Suggested initial thresholds are 6 requests/minute per client network and 20/minute across the public route at each location; adjust for real visitor traffic.

```json
"ratelimits": [
  {
    "name": "CHAT_CLIENT_LIMITER",
    "namespace_id": "6101001",
    "simple": { "limit": 6, "period": 60 }
  },
  {
    "name": "CHAT_AGGREGATE_LIMITER",
    "namespace_id": "6101002",
    "simple": { "limit": 20, "period": 60 }
  }
]
```

The client limiter uses Cloudflare's edge-supplied `CF-Connecting-IP`, grouping IPv6 addresses by /64 and hashing the daily key. It does not trust `X-Forwarded-For` or a visitor-chosen ID. These keys are pseudonymous, not anonymous. Shared/mobile networks can share a quota; rotateable networks and bots can evade a per-client limit. Do not reuse this trust assumption behind a server where clients can control the IP header.

**These are abuse controls, not authentication or a hard spending cap.** A script can copy the allowed Origin. A secret embedded in public JavaScript would not help. Cloudflare's binding counts are approximate and local to each Cloudflare location; the aggregate binding is not a worldwide quota. Prompt injection can also defeat topic guidance. Per-call input/output ceilings limit individual request size, not total spend under distributed abuse. If a strict global budget is required, keep chat disabled until a separately approved coordinated quota mechanism exists. No paid infrastructure is provisioned here.

## Verification and rollout

Run `npm test` with Node 22+ and `node --check src/index.js`. The tests use dummy credentials, mocked OpenAI responses, and mocked limiter bindings; they make no network or paid API calls. They cover the request contract, failed configuration, spoofable browser-origin boundary, per-client/aggregate denial, IPv6 grouping, byte limits, provider-error redaction, partial answers, cancellation, asynchronous secret retrieval/rotation, no lookup before validation or rate limits, malformed/missing secrets, redacted lookup failures, and lookup timeout/disconnect behavior. No external packages are needed for these tests.

Before an authorized production switch:

1. Review the public-only context and configure the two limiters. Confirm the current Cloudflare plan supports the bindings without an unapproved plan change.
2. Review the prepared Secrets Store binding and obtain approval for live attachment/deployment. Reuse the existing approved account secret; do not create another key or implicitly expand persistent access. Keep the chat switch false.
3. Perform a Wrangler local/dry-run validation and approved staging check, including actual binding behavior and model access. These are not established by the mocked tests.
4. Configure the frontend's full HTTPS `/chat` URL, preserve useful disabled/error notices, and deploy the matching client and worker only with approval. The historic worker name can remain `gemini-proxy` to avoid changing its hostname.
5. Enable public chat deliberately and inspect aggregate status/usage without logging prompts, raw IPs, keys, or provider response bodies. This application adds no request logging, but platform observability settings still need review.
6. To stop spend through this route, set `PUBLIC_CHAT_ENABLED` to `"false"`. Preserve the static résumé site. Do not restore the old unrestricted Gemini proxy as a silent fallback.

Private résumé generation belongs in a separate authenticated service or local workflow. Do not add its route, data, service token, or credentials to this public worker or its frontend. CORS and anonymous rate limits do not protect private features.

## Verified references

- [OpenAI GPT-6.1 Sol model](https://developers.openai.com/api/docs/models/gpt-6.1-sol): model ID and supported high reasoning.
- [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning): token caps include reasoning; incomplete replies can contain no visible text.
- [OpenAI text generation](https://developers.openai.com/api/docs/guides/text): Responses output contains multiple typed items; extract assistant text rather than returning the raw body.
- [Cloudflare rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/): configuration and approximate per-location behavior.
- [Cloudflare Secrets Store Worker integration](https://developers.cloudflare.com/secrets-store/integrations/workers/): binding configuration, asynchronous `get()`, required roles and local-development limits.
- [Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/): environment-variable size.
