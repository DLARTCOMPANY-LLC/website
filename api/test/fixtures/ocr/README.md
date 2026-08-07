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
$env:OCR_EVAL_RUNS = "3" # Optional, 1–5; every run must pass.
npm run api:eval:live
```

The runner never sends or prints `OPENAI_API_KEY`; the configured Worker owns provider authentication.
It runs cases sequentially and reports only case IDs and metrics: field, character, speaker, dialogue
and direction accuracy; dialogue omissions; artifact false positives; confidence; and latency. Any
manifest threshold failure in any repeated run exits nonzero. Repeated runs are paced to stay within
the default durable per-IP budget. Point `OCR_EVAL_TARGET` at a local Worker URL to avoid
production traffic, but OpenAI usage may still be billable if that Worker has provider credentials.
