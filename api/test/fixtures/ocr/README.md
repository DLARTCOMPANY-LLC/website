# Synthetic screenplay OCR fixtures

This suite contains only generated raster images and original test text authored for this repository.
It does not contain the user-provided actor screenshot, any Racket Club screenplay content, or other
third-party material.

## Matrix

```text
ocr/
├── jpeg/
│   ├── simple/    punctuation and compound words
│   ├── moderate/  low contrast and uneven lighting
│   └── complex/   simulated phone perspective, chrome, notes, and revision marks
└── png/
    ├── simple/    clean screenplay layout
    ├── moderate/  wrapped dialogue and parentheticals
    └── complex/   viewer chrome, margin marks, and START/END annotations
```

Each case has one image and one `manifest.json`. The manifest records synthetic provenance, ordered
expected characters/items, artifacts that must be excluded, permitted normalization, and pass/fail
thresholds for characters, speakers, text, omissions, artifacts, confidence, and latency. Standalone
parentheticals are expected as null-speaker direction items.

Images are generated from SVG templates by `generate.mjs` and encoded with Sharp. Regenerate them
deterministically after changing a case:

```bash
npm run api:fixtures:generate
npm run api:fixtures:test
```

Generated images must remain below 100 KiB. The normal API test suite validates manifests, magic
bytes, provenance, ordering, parenthetical semantics, artifact exclusion, scenario coverage, and size
without contacting OpenAI.

## Opt-in live evaluation

Live evaluation is deliberately separate from normal CI and fails before any request unless all three
values are explicitly provided:

```powershell
$env:RUN_LIVE_OCR_EVAL = "1"
$env:OPENAI_API_KEY = "<present only as explicit billing acknowledgement>"
$env:OCR_EVAL_TARGET = "https://dlartcompany-screenplay-api.dlartcompany.workers.dev/v1/screenplays/import"
$env:OCR_EVAL_RUNS = "3" # Optional, 3–5; defaults to 3.
$env:OCR_EVAL_CONFIRM_REQUESTS = "18" # Current 6 fixtures x 3 runs.
npm run api:eval:live
```

The runner never sends or prints `OPENAI_API_KEY`; the configured Worker owns provider authentication.
Before sending anything, it prints the calculated request count and requires
`OCR_EVAL_CONFIRM_REQUESTS` to match exactly. It runs cases sequentially and reports per-run parsed
output hashes and structural diffs; dialogue omissions/substitutions; artifact false positives;
speaker/direction classification errors; confidence; latency; and the provider-model response header.
Every fixture runs at least three times and **all attempts must pass**—there is no majority-pass rule.
Aggregate output reports hash variance and metric ranges. Repeated requests are paced to stay within
the default durable per-IP budget.

Raw response bodies are written only to the gitignored
`.ocr-eval-artifacts/<timestamp>/<fixture>/run-<n>.json` directory and are never printed or committed
by default. Point `OCR_EVAL_TARGET` at a local Worker URL to avoid production traffic, but OpenAI
usage may still be billable if that Worker has provider credentials.
