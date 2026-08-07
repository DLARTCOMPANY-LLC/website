# LineReader screenplay import API

The screenplay import API is a Cloudflare Worker deployed separately from the static GitHub Pages
site. GitHub Pages cannot execute server code or protect `OPENAI_API_KEY`.

## Endpoint

`POST /v1/screenplays/import`

Send `multipart/form-data` with exactly these fields:

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `image` | File | Yes | One JPEG or PNG, maximum 8 MiB and 40 megapixels |
| `title` | String | No | Maximum 200 characters |

The full request body is limited to 10 MiB. HEIC is rejected with `415` because the OpenAI image
input contract does not currently accept HEIC; convert it to JPEG on-device before upload. The
declared MIME type must match the image magic bytes.

Successful responses use `application/json`:

```json
{
  "title": "Dinner scene",
  "characters": ["Spencer", "Waiter", "Mitch"],
  "items": [
    {
      "order": 1,
      "speaker": null,
      "text": "START",
      "isStageDirection": true,
      "confidence": 0.99
    },
    {
      "order": 2,
      "speaker": "Mitch",
      "text": "(quietly)\nI already know what I want.",
      "isStageDirection": false,
      "confidence": 0.98
    }
  ],
  "diagnostics": {
    "overallConfidence": 0.98,
    "warnings": []
  }
}
```

`characters` and `items` are ordered by first appearance and reading order. `text` is returned
verbatim. Parentheticals remain in their dialogue item's text. Directions, headings, and labels
such as `Role`, `START`, and `END` have a `null` speaker and are not characters. Character names
are deterministically display-cased from spoken cues; cue suffixes remain on item speakers (for
example, `Jane (V.O.)`) but are not part of the character identity (`Jane`).

Errors have a stable shape and do not include image contents or provider responses:

```json
{
  "error": {
    "code": "invalid_image",
    "message": "Image bytes do not match the declared JPEG or PNG type",
    "requestId": "781ea159-2e8c-4979-834f-afee86c031c8"
  }
}
```

Relevant statuses are `400`, `403`, `405`, `413`, `415`, `429`, `502`, `503`, and `504`.

Safe provider-facing error codes include `provider_auth_error`, `provider_quota_exceeded`, and
`provider_model_unavailable`; all other provider failures remain `upstream_error`.

## Privacy and cost controls

- The Worker does not persist the upload or extracted screenplay. Responses requests set
  `store: false`. Images up to 5 MiB are sent inline; larger images are uploaded with OpenAI's
  `vision` file purpose to avoid base64 transport expansion, referenced once, and immediately
  deleted. The file also receives a one-hour expiration as a cleanup backstop. A failed deletion
  fails the API request rather than reporting success.
- Application code does not log request bodies, image data, screenplay text, or OpenAI responses.
  Provider failures log only the endpoint operation, HTTP status, provider request ID, validated
  error type/code, transport error class, and response-format metadata. Bounded redacted messages
  are retained only inside the request's internal error object and are not logged. Logs never
  include request bodies, image data, Authorization, model output, or arbitrary provider responses.
  Cloudflare invocation metadata can still include timestamps, status codes, and request metadata.
- `OPENAI_API_KEY` exists only as a Worker secret. Never ship it or a shared API secret in
  LineReader.
- One image, byte limits, a configurable output-token ceiling, an upstream timeout, and an
  isolate-local concurrency ceiling bound each request's cost.
- A SQLite-backed Cloudflare Durable Object atomically enforces both the configurable per-IP budget
  (`RATE_LIMIT_REQUESTS`) and a global budget (`GLOBAL_RATE_LIMIT_REQUESTS`) in each
  `RATE_LIMIT_WINDOW_SECONDS` window. All edge locations coordinate through one named object.
  Expired client records are deleted, and client IP addresses are SHA-256 hashed before entering
  durable storage. The endpoint fails closed without a healthy `RATE_LIMITER` binding.
- Native clients generally omit `Origin` and are accepted. Browser requests are accepted only when
  their exact origin is listed in `CORS_ALLOWED_ORIGINS`; an empty list rejects all browser origins.
  CORS is not authentication.

Review OpenAI's current API data controls and retention terms before production use, and disclose
the image transfer in LineReader's privacy policy.

## Configuration and deployment

Required secret:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-side OpenAI API key |

Optional variables are documented in `.dev.vars.example`. The default model is
`gpt-4.1-mini`; set `OPENAI_VISION_MODEL` to another Responses API model that supports image input
and strict JSON Schema outputs. `CORS_ALLOWED_ORIGINS` is a comma-separated exact allowlist.
`RATE_LIMIT_REQUESTS` defaults to 10 requests per client per 60 seconds, while
`GLOBAL_RATE_LIMIT_REQUESTS` defaults to 100 total requests in the same durable global window.

Local setup:

```bash
cp .dev.vars.example .dev.vars
# Put a development-only OpenAI key in .dev.vars.
npm run api:dev
```

Production setup:

```bash
npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npm run api:deploy
```

The `v1` Wrangler migration creates the SQLite-backed `RateLimiter` Durable Object on first deploy.

The deployment prints the assigned `workers.dev` URL. No Worker deployment URL is configured in
this repository yet. After deployment, use
`https://<assigned-worker-host>/v1/screenplays/import` in LineReader. For production, attach a
dedicated API hostname in Cloudflare and update the app to that hostname.
