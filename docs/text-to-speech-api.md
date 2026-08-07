# LineReader text-to-speech API

The text-to-speech API is part of the Cloudflare Worker deployed separately from the static GitHub
Pages site. OpenAI is the server-side provider by default. `OPENAI_API_KEY` must remain a Worker
secret and must never be returned to or configured in LineReader.

## Endpoint

`POST /v1/tts/speech`

Send `application/json`:

```json
{
  "input": "The line to read aloud.",
  "voice": "alloy",
  "format": "mp3"
}
```

| Field | Type | Required | Limits and defaults |
| --- | --- | --- | --- |
| `input` | String | Yes | Non-empty; maximum 4096 characters |
| `voice` | String | No | Defaults to `OPENAI_TTS_VOICE` (`alloy`) |
| `format` | String | No | Defaults to `OPENAI_TTS_FORMAT` (`mp3`) |

Supported voices are `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `marin`, `nova`, `onyx`,
`sage`, `shimmer`, `verse`, and `cedar`. Supported formats are `mp3`, `opus`, `aac`, `flac`, `wav`,
and `pcm`. Unknown JSON fields are rejected, so clients cannot select a provider or model.

The complete JSON request is limited to 16 KiB and must arrive within 5 seconds. A successful
response is the generated audio bytes with the matching `Content-Type`:

| Format | Response `Content-Type` |
| --- | --- |
| `mp3` | `audio/mpeg` |
| `opus` | `audio/ogg` |
| `aac` | `audio/aac` |
| `flac` | `audio/flac` |
| `wav` | `audio/wav` |
| `pcm` | `application/octet-stream` |

Success responses also include `X-Request-Id`, `X-TTS-Provider`, `X-TTS-Model`, `X-TTS-Voice`, and
`X-TTS-Format`, and use `Cache-Control: no-store`. The default provider is OpenAI, the default model
is `gpt-4o-mini-tts`, the default voice is `alloy`, and the default format is `mp3`.

Errors use the same stable JSON envelope as screenplay import:

```json
{
  "error": {
    "code": "invalid_input",
    "message": "input must be a string",
    "requestId": "781ea159-2e8c-4979-834f-afee86c031c8"
  }
}
```

Relevant statuses are `400`, `403`, `405`, `408`, `413`, `415`, `429`, `502`, `503`, and `504`.
Provider responses and credentials are never included in the error envelope.

## Security and cost controls

- The Worker sends only the validated text, server-selected model, supported voice, and supported
  format to OpenAI's `POST /v1/audio/speech` endpoint.
- `OPENAI_API_KEY` is read only from the Worker environment and is never returned to clients.
- The upstream request has a configurable timeout. Audio is fully read through a byte-limited
  stream before the Worker sends a success response, preventing an unbounded provider response.
- The existing SQLite-backed Durable Object enforces shared per-IP and global request budgets for
  screenplay import and text-to-speech. The isolate-local OpenAI concurrency ceiling also applies.
- Native clients generally omit `Origin` and are accepted. Browser requests require an exact match
  in `CORS_ALLOWED_ORIGINS`. CORS is not authentication.
- Application logs omit input text, audio, authorization headers, and arbitrary provider response
  bodies. Only sanitized provider diagnostics are logged.

OpenAI requires a clear disclosure to users that generated voices are AI-generated and not human
voices. The client experience and privacy policy must provide that disclosure.

## Configuration and deployment

Required Worker secret:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-side OpenAI API key shared by the Worker's OpenAI integrations |

Text-to-speech variables:

| Variable | Default | Allowed range or purpose |
| --- | --- | --- |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | Server-selected OpenAI speech model |
| `OPENAI_TTS_VOICE` | `alloy` | Default supported voice |
| `OPENAI_TTS_FORMAT` | `mp3` | Default supported output format |
| `OPENAI_TTS_TIMEOUT_MS` | `30000` | 1000-90000 milliseconds |
| `OPENAI_TTS_MAX_OUTPUT_BYTES` | `10485760` | 1024-10485760 bytes |
| `MAX_CONCURRENT_TTS_REQUESTS` | `2` | 1-4 in-flight speech responses per isolate |

The existing `RATE_LIMIT_REQUESTS`, `GLOBAL_RATE_LIMIT_REQUESTS`, `RATE_LIMIT_WINDOW_SECONDS`,
`MAX_CONCURRENT_REQUESTS`, and `CORS_ALLOWED_ORIGINS` variables also apply to this route. The
TTS-specific concurrency ceiling and 10 MiB hard output maximum keep worst-case buffering within a
Worker isolate's memory budget. Invalid numeric values fall back to the documented defaults. Invalid
configured model, voice, or format values fail closed.

Local setup and production secret deployment are documented in
[`line-reader-api.md`](line-reader-api.md#configuration-and-deployment). The deployed route is:

```text
https://<assigned-worker-host>/v1/tts/speech
```
