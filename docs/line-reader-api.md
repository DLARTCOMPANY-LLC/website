# LineReader cloud AI API

The OpenAI screenplay-import and speech API is a Cloudflare Worker deployed separately from the
static GitHub Pages site. GitHub Pages and the public mobile app cannot protect
`OPENAI_API_KEY`.

## Screenplay import

`POST /v1/screenplays/import`

Send `multipart/form-data` with exactly one upload plus an optional title:

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `file` | File | Preferred | One JPEG, PNG, or PDF; maximum 8 MiB |
| `image` | File | Legacy alternative | One JPEG or PNG; maximum 8 MiB and 40 megapixels |
| `title` | String | No | Maximum 200 characters |

Do not send both `file` and `image`. The full request body is limited to 10 MiB. HEIC is rejected
with `415`; convert it to JPEG before upload. Declared MIME types must match validated file bytes.
PDFs are byte-bounded and checked for a PDF header/trailer without locally decompressing or
rendering attacker-controlled content. OpenAI Responses performs the actual document parsing,
extracting both text and page images at high detail. The Worker uploads PDFs transiently with
`purpose=user_data` and deletes them after the response. Unsupported, encrypted, or malformed
documents are rejected by OpenAI and mapped to a generic provider error.

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
verbatim. Standalone screenplay parentheticals are separate direction items with a `null` speaker;
dialogue before and after one becomes separate spoken items for the same character. Directions,
headings, and labels such as `Role`, `START`, and `END` have a `null` speaker and are not characters. Character names
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

## OpenAI speech

`POST /v1/audio/speech`

Send `application/json` with exactly:

```json
{
  "text": "Privacy-safe rehearsal line.",
  "voice": "marin"
}
```

| Field | Type | Limits |
| --- | --- | --- |
| `text` | String | One non-empty dialogue utterance, no outer whitespace, maximum 2,000 Unicode characters and 8 KiB UTF-8 |
| `voice` | String | One allowlisted built-in OpenAI voice |

Allowed voices are `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`,
`shimmer`, `verse`, `marin`, and `cedar`. OpenAI currently recommends `marin` or `cedar` for best
quality. The request body is limited to 16 KiB; unknown fields, unsupported controls, invalid
Unicode, and unsupported voices are rejected before provider access.

A successful response is binary AAC audio:

```http
HTTP/1.1 200 OK
Content-Type: audio/aac
Cache-Control: no-store, private
X-Speech-Model: gpt-4o-mini-tts
X-Speech-Voice: marin
X-Request-Id: <uuid>
```

The Worker uses OpenAI's current `POST /v1/audio/speech` API with `response_format: "aac"` and
`stream_format: "audio"`. AAC is directly playable by iOS and Android. Audio is capped at 8 MiB,
generated under a configurable 30-second timeout, and never cached. OpenAI requires the app to
clearly disclose that playback is AI-generated speech.

Errors use the same JSON shape as screenplay import. Provider authentication, quota, and model
availability remain safely distinguishable without exposing provider response text.

## Privacy and cost controls

- The Worker does not persist uploads, extracted screenplay, dialogue sent for speech, or generated
  audio. Responses requests set
  `store: false`. Images up to 5 MiB are sent inline; larger images are uploaded with OpenAI's
  `vision` file purpose to avoid base64 transport expansion, referenced once, and immediately
  deleted. PDFs use the same transient workflow with `user_data`. Files receive a one-hour
  expiration as a cleanup backstop. A failed deletion fails the API request rather than reporting
  success.
- Application code does not log request bodies, image/PDF data, screenplay/dialogue text, generated
  audio, or OpenAI responses.
  Provider failures log only the endpoint operation, HTTP status, provider request ID, validated
  error type/code, transport error class, and response-format metadata. Bounded redacted messages
  are retained only inside the request's internal error object and are not logged. Logs never
  include request bodies, image data, Authorization, model output, or arbitrary provider responses.
  Cloudflare invocation metadata can still include timestamps, status codes, and request metadata.
- `OPENAI_API_KEY` exists only as a Worker secret. Never ship it or a shared API secret in
  LineReader.
- One upload or speech utterance, byte/character limits, a configurable output-token ceiling,
  upstream timeouts, and an isolate-local concurrency ceiling bound each request's cost.
- A SQLite-backed Cloudflare Durable Object atomically enforces both the configurable per-IP budget
  (`RATE_LIMIT_REQUESTS`) and a global budget (`GLOBAL_RATE_LIMIT_REQUESTS`) in each
  `RATE_LIMIT_WINDOW_SECONDS` window. All edge locations coordinate through one named object.
  Expired client records are deleted, and client IP addresses are SHA-256 hashed before entering
  durable storage. The endpoint fails closed without a healthy `RATE_LIMITER` binding.
- Native clients generally omit `Origin` and are accepted. There is deliberately no embedded shared
  app secret because a public mobile binary cannot keep one confidential. Durable per-IP/global
  budgets are the server-enforced abuse and billing boundary. Browser requests are accepted only when
  their exact origin is listed in `CORS_ALLOWED_ORIGINS`; an empty list rejects all browser origins.
  CORS is not authentication.

Review OpenAI's current API data controls and retention terms before production use, and disclose
file/dialogue transfer plus AI-generated speech in LineReader's privacy policy.

Plain TXT files and pasted text do not require OCR and should be parsed deterministically by
LineReader as text. Image and PDF visual extraction must use this OpenAI endpoint; this Worker
contains no Apple Vision, Tesseract, or other non-OpenAI OCR path.

## Configuration and deployment

Required secret:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-side OpenAI API key |

Optional variables are documented in `.dev.vars.example`. The default model is
`gpt-5.6-sol`; set `OPENAI_VISION_MODEL` to another Responses API model that supports image input
and strict JSON Schema outputs. `CORS_ALLOWED_ORIGINS` is a comma-separated exact allowlist.
`OPENAI_SPEECH_MODEL` defaults to `gpt-4o-mini-tts` and is restricted to supported OpenAI speech
models. `OPENAI_SPEECH_TIMEOUT_MS` defaults to 30,000 milliseconds.
`RATE_LIMIT_REQUESTS` defaults to 10 requests per client per 60 seconds, while
`GLOBAL_RATE_LIMIT_REQUESTS` defaults to 100 total requests in the same durable global window.

GPT-5.6 requests use original image detail and medium bounded reasoning to preserve small screenplay
text and layout. The extraction schema explicitly classifies viewer chrome and audition annotations
so they are removed before the public response; a narrow deterministic guard also removes audition
`Role:` banners or control-character START/END overlays accidentally merged into retained stage text.
Dialogue is never modified by this guard. At published standard pricing, GPT-5.6 Sol costs $5 per
million input tokens and $30 per million output tokens; image tokens count as input, and reasoning
tokens count toward the configured output-token ceiling.

### Synthetic OCR fixture suite

`api/test/fixtures/ocr/` contains a six-case PNG/JPEG matrix across simple, moderate, and complex
screenplay layouts. All text and images are original generated test assets; the user-provided actor
image and third-party screenplay content are not included. Machine-readable manifests define ordered
expected output, excluded UI/annotations, permitted normalization, and quality thresholds.

`npm run api:fixtures:test` is deterministic and runs without OpenAI. `npm run api:eval:live` is a
separate billable evaluator that refuses to start unless `RUN_LIVE_OCR_EVAL=1`, `OPENAI_API_KEY`, and
an explicit `OCR_EVAL_TARGET` are present. The key serves only as billing acknowledgement and is never
transmitted or printed by the runner. Every live fixture defaults to three independent attempts
(`OCR_EVAL_RUNS` may be 3–5), and every attempt must pass. Before execution, the runner prints the
planned billable request count and requires an exact `OCR_EVAL_CONFIRM_REQUESTS` acknowledgement.
Per-run hashes/diffs and quality metrics plus aggregate variance are printed; raw responses go only
to gitignored `.ocr-eval-artifacts/`. See `api/test/fixtures/ocr/README.md` for metrics and usage.

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

Production currently uses `https://dlartcompany-screenplay-api.dlartcompany.workers.dev`. LineReader
uses `/v1/screenplays/import` for OpenAI OCR and `/v1/audio/speech` for OpenAI speech. A dedicated
API hostname can replace the `workers.dev` hostname later without changing either route contract.
