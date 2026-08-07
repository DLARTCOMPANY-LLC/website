import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { File } from "node:buffer";
import {
  assertLiveEvaluationAuthorized,
  scoreFixture,
  thresholdFailures,
} from "./live-eval-lib.mjs";

const target = assertLiveEvaluationAuthorized(process.env);

console.error(
  "LIVE BILLABLE OCR EVALUATION ENABLED: running synthetic fixtures sequentially against the explicit target.",
);

const root = dirname(fileURLToPath(import.meta.url));
const manifestPaths = await findFiles(join(root, "fixtures", "ocr"), "manifest.json");
const results = [];
let failed = false;

for (const manifestPath of manifestPaths.sort()) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const imagePath = join(dirname(manifestPath), manifest.image);
  const form = new FormData();
  form.set(
    "image",
    new File([await readFile(imagePath)], basename(imagePath), { type: manifest.mediaType }),
  );
  form.set("title", manifest.id);

  const started = performance.now();
  let response;
  try {
    response = await fetch(target, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(manifest.thresholds.maxLatencyMs + 10_000),
    });
  } catch (error) {
    failed = true;
    results.push({
      id: manifest.id,
      passed: false,
      error: error instanceof Error ? error.name : "request_error",
    });
    continue;
  }
  if (!response.ok) {
    const latencyMs = Math.round(performance.now() - started);
    failed = true;
    results.push({
      id: manifest.id,
      passed: false,
      status: response.status,
      latencyMs,
    });
    continue;
  }

  const actual = await response.json();
  const latencyMs = Math.round(performance.now() - started);
  const metrics = scoreFixture(manifest, actual, latencyMs);
  const failures = thresholdFailures(manifest.thresholds, metrics);
  if (failures.length > 0) failed = true;
  results.push({
    id: manifest.id,
    passed: failures.length === 0,
    metrics,
    failures,
  });
}

console.log(JSON.stringify({ target, cases: results }, null, 2));
if (failed) process.exitCode = 1;

async function findFiles(directory, name) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findFiles(path, name)));
    else if (entry.name === name) files.push(path);
  }
  return files;
}
