import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { File } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertLiveEvaluationAuthorized,
  assertPlannedRequestCount,
  buildEvaluationPlan,
  evaluationPassed,
  parsedOutputHash,
  readLiveEvaluationRuns,
  scoreFixture,
  summarizeEvaluation,
  thresholdFailures,
} from "./live-eval-lib.mjs";

const target = assertLiveEvaluationAuthorized(process.env);
const runCount = readLiveEvaluationRuns(process.env);
const root = dirname(fileURLToPath(import.meta.url));
const manifestPaths = await findFiles(join(root, "fixtures", "ocr"), "manifest.json");
const manifests = await Promise.all(
  manifestPaths.sort().map(async (path) => ({
    path,
    value: JSON.parse(await readFile(path, "utf8")),
  })),
);
const fixtureIds = manifests.map(({ value }) => value.id);
const plan = buildEvaluationPlan(fixtureIds, runCount);
console.error(
  `PLANNED BILLABLE OCR REQUESTS: ${plan.length} (${fixtureIds.length} fixtures x ${runCount} independent runs).`,
);
assertPlannedRequestCount(process.env, plan.length);
console.error(
  "LIVE BILLABLE OCR EVALUATION CONFIRMED: every run must pass; no majority-pass masking.",
);

const repeatPauseMs = 7_000;
const artifactRoot = join(
  root,
  "..",
  "..",
  ".ocr-eval-artifacts",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
await mkdir(artifactRoot, { recursive: true });
const results = [];

for (let requestNumber = 0; requestNumber < plan.length; requestNumber += 1) {
    if (requestNumber > 0) await delay(repeatPauseMs);
    const attempt = plan[requestNumber];
    const entry = manifests.find(({ value }) => value.id === attempt.id);
    if (!entry) throw new Error(`Missing manifest for planned fixture ${attempt.id}`);
    const { path: manifestPath, value: manifest } = entry;
    const imagePath = join(dirname(manifestPath), manifest.image);
    const artifactDirectory = join(artifactRoot, manifest.id);
    await mkdir(artifactDirectory, { recursive: true });
    const rawResponsePath = join(artifactDirectory, `run-${attempt.run}.json`);
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
      await writeFile(
        rawResponsePath,
        JSON.stringify({
          transportError: error instanceof Error ? error.name : "request_error",
        }),
        "utf8",
      );
      results.push({
        id: manifest.id,
        run: attempt.run,
        passed: false,
        error: error instanceof Error ? error.name : "request_error",
      });
      continue;
    }
    const rawResponse = await response.text();
    const latencyMs = Math.round(performance.now() - started);
    await writeFile(rawResponsePath, rawResponse, "utf8");
    if (!response.ok) {
      results.push({
        id: manifest.id,
        run: attempt.run,
        passed: false,
        status: response.status,
        latencyMs,
        providerModel: response.headers.get("X-OCR-Model") ?? "unknown",
      });
      continue;
    }

    let actual;
    try {
      actual = JSON.parse(rawResponse);
    } catch {
      results.push({
        id: manifest.id,
        run: attempt.run,
        passed: false,
        error: "invalid_json",
        latencyMs,
        providerModel: response.headers.get("X-OCR-Model") ?? "unknown",
      });
      continue;
    }
    const metrics = scoreFixture(manifest, actual, latencyMs);
    const failures = thresholdFailures(manifest.thresholds, metrics);
    results.push({
      id: manifest.id,
      run: attempt.run,
      passed: failures.length === 0,
      outputHash: parsedOutputHash(actual),
      providerModel: response.headers.get("X-OCR-Model") ?? "unknown",
      metrics,
      failures,
    });
}

const summaries = summarizeEvaluation(results, fixtureIds, runCount);
console.log(
  JSON.stringify(
    {
      target,
      plannedRequests: plan.length,
      runs: runCount,
      rawArtifacts: artifactRoot,
      cases: results,
      stability: summaries,
      passed: evaluationPassed(summaries),
    },
    null,
    2,
  ),
);
if (!evaluationPassed(summaries)) process.exitCode = 1;

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
