import { createHash } from "node:crypto";

export function assertLiveEvaluationAuthorized(environment) {
  if (environment.RUN_LIVE_OCR_EVAL !== "1") {
    throw new Error(
      "Live OCR evaluation is disabled. Set RUN_LIVE_OCR_EVAL=1 explicitly to authorize billable requests.",
    );
  }
  if (!environment.OPENAI_API_KEY?.trim()) {
    throw new Error(
      "OPENAI_API_KEY must be present as a billing acknowledgement. Its value is never transmitted by this runner.",
    );
  }
  const target = environment.OCR_EVAL_TARGET?.trim();
  if (!target) {
    throw new Error(
      "OCR_EVAL_TARGET is required. Set it to the explicit Worker or local /v1/screenplays/import URL.",
    );
  }
  const url = new URL(target);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OCR_EVAL_TARGET must use HTTP or HTTPS.");
  }
  return url.toString();
}

export function readLiveEvaluationRuns(environment) {
  const raw = environment.OCR_EVAL_RUNS?.trim() || "3";
  if (!/^\d+$/.test(raw)) {
    throw new Error("OCR_EVAL_RUNS must be an integer from 3 to 5.");
  }
  const runs = Number(raw);
  if (runs < 3 || runs > 5) {
    throw new Error("OCR_EVAL_RUNS must be an integer from 3 to 5.");
  }
  return runs;
}

export function assertPlannedRequestCount(environment, plannedRequests) {
  const confirmation = environment.OCR_EVAL_CONFIRM_REQUESTS?.trim();
  if (confirmation !== String(plannedRequests)) {
    throw new Error(
      `Set OCR_EVAL_CONFIRM_REQUESTS=${plannedRequests} to confirm the exact planned billable request count.`,
    );
  }
}

export function buildEvaluationPlan(fixtureIds, runs) {
  return Array.from({ length: runs }, (_, index) =>
    fixtureIds.map((id) => ({ id, run: index + 1 })),
  ).flat();
}

export function scoreFixture(manifest, actual, latencyMs) {
  const response = actual && typeof actual === "object" ? actual : {};
  const expectedItems = manifest.expected.items;
  const actualItems = Array.isArray(response.items) ? response.items : [];
  const expectedDialogue = expectedItems.filter((item) => !item.isStageDirection);
  const actualDialogue = actualItems.filter((item) => !item.isStageDirection);
  const expectedDirections = expectedItems.filter((item) => item.isStageDirection);
  const actualDirections = actualItems.filter((item) => item.isStageDirection);
  const alignment = alignItems(expectedItems, actualItems, manifest.allowedNormalization);

  const characters = Array.isArray(response.characters) ? response.characters : [];
  const characterAccuracy = positionalAccuracy(manifest.expected.characters, characters);
  const pairedItems = alignment.filter(
    ({ expectedItem, actualItem }) => expectedItem && actualItem,
  );
  const speakerClassificationErrors = pairedItems.filter(
    ({ expectedItem, actualItem }) => expectedItem.speaker !== actualItem.speaker,
  ).length;
  const directionClassificationErrors = pairedItems.filter(
    ({ expectedItem, actualItem }) =>
      expectedItem.isStageDirection !== actualItem.isStageDirection,
  ).length;
  const correctSpeakers = pairedItems.filter(
    ({ expectedItem, actualItem }) =>
      !expectedItem.isStageDirection &&
      !actualItem.isStageDirection &&
      expectedItem.speaker === actualItem.speaker,
  ).length;
  const speakerAccuracy = round(
    correctSpeakers / Math.max(expectedDialogue.length, actualDialogue.length, 1),
  );
  const correctFields = pairedItems.filter(
    ({ expectedItem, actualItem }) =>
      expectedItem.isStageDirection === actualItem.isStageDirection &&
      expectedItem.speaker === actualItem.speaker,
  ).length;
  const fieldAccuracy = round(
    correctFields / Math.max(expectedItems.length, actualItems.length, 1),
  );
  const dialogueTextAccuracy = textAccuracy(
    expectedDialogue.map((item) => item.text).join("\n<turn>\n"),
    actualDialogue.map((item) => item.text).join("\n<turn>\n"),
    manifest.allowedNormalization,
  );
  const directionTextAccuracy = textAccuracy(
    expectedDirections.map((item) => item.text).join("\n<direction>\n"),
    actualDirections.map((item) => item.text).join("\n<direction>\n"),
    manifest.allowedNormalization,
  );
  const dialogueOmissions = alignment.filter(
    ({ operation, expectedItem }) =>
      operation === "delete" && !expectedItem.isStageDirection,
  ).length;
  const dialogueSubstitutions = alignment.filter(
    ({ operation, expectedItem, actualItem }) =>
      operation === "substitute" &&
      !expectedItem.isStageDirection &&
      !actualItem.isStageDirection &&
      normalize(expectedItem.text, manifest.allowedNormalization) !==
        normalize(actualItem.text ?? "", manifest.allowedNormalization),
  ).length;
  const outputLines = actualItems.flatMap((item) =>
    String(item.text ?? "").split(/\r\n|\n|\r/),
  );
  const artifactFalsePositives = manifest.excludedArtifacts.filter((artifact) =>
    outputLines.some((line) => artifactLineMatches(line, artifact.text)),
  ).length;
  const confidence =
    typeof response.diagnostics?.overallConfidence === "number"
      ? response.diagnostics.overallConfidence
      : 0;

  return {
    fieldAccuracy,
    characterAccuracy,
    speakerAccuracy,
    dialogueTextAccuracy,
    directionTextAccuracy,
    dialogueOmissions,
    dialogueSubstitutions,
    artifactFalsePositives,
    speakerClassificationErrors,
    directionClassificationErrors,
    confidence,
    latencyMs,
    diff: structuralDiff(expectedItems, actualItems, manifest.allowedNormalization),
  };
}

export function parsedOutputHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function summarizeEvaluation(results, fixtureIds, requiredRuns) {
  return fixtureIds.map((id) => {
    const attempts = results.filter((result) => result.id === id);
    const hashes = [...new Set(attempts.map((result) => result.outputHash).filter(Boolean))];
    const metrics = attempts.map((result) => result.metrics).filter(Boolean);
    const allRunsPresent =
      attempts.length === requiredRuns &&
      new Set(attempts.map((result) => result.run)).size === requiredRuns;
    return {
      id,
      attempts: attempts.length,
      requiredRuns,
      allRunsPresent,
      allPassed: allRunsPresent && attempts.every((result) => result.passed),
      uniqueOutputHashes: hashes.length,
      structurallyStable: hashes.length === 1 && allRunsPresent,
      providerModels: [...new Set(attempts.map((result) => result.providerModel).filter(Boolean))],
      variance: {
        itemCount: range(metrics.map((metric) => metric.diff.actualItemCount)),
        dialogueTextAccuracy: range(metrics.map((metric) => metric.dialogueTextAccuracy)),
        confidence: range(metrics.map((metric) => metric.confidence)),
        latencyMs: range(metrics.map((metric) => metric.latencyMs)),
      },
    };
  });
}

export function evaluationPassed(summaries) {
  return summaries.length > 0 && summaries.every((summary) => summary.allPassed);
}

export function thresholdFailures(thresholds, metrics) {
  const failures = [];
  for (const metric of [
    "fieldAccuracy",
    "characterAccuracy",
    "speakerAccuracy",
    "dialogueTextAccuracy",
    "directionTextAccuracy",
  ]) {
    if (metrics[metric] < thresholds[metric]) {
      failures.push(`${metric} ${metrics[metric]} < ${thresholds[metric]}`);
    }
  }
  if (metrics.dialogueOmissions > thresholds.maxDialogueOmissions) {
    failures.push(
      `dialogueOmissions ${metrics.dialogueOmissions} > ${thresholds.maxDialogueOmissions}`,
    );
  }
  if (metrics.artifactFalsePositives > thresholds.maxArtifactFalsePositives) {
    failures.push(
      `artifactFalsePositives ${metrics.artifactFalsePositives} > ${thresholds.maxArtifactFalsePositives}`,
    );
  }
  if (metrics.confidence < thresholds.minimumConfidence) {
    failures.push(`confidence ${metrics.confidence} < ${thresholds.minimumConfidence}`);
  }
  if (metrics.latencyMs > thresholds.maxLatencyMs) {
    failures.push(`latencyMs ${metrics.latencyMs} > ${thresholds.maxLatencyMs}`);
  }
  return failures;
}

function artifactLineMatches(line, artifact) {
  const candidate = normalizeArtifact(line);
  const expected = normalizeArtifact(artifact);
  if (!candidate || !expected) return false;
  if (candidate === expected) return true;
  if (expected.length < 4) return false;
  return textAccuracy(expected, candidate, []) >= 0.85;
}

function structuralDiff(expectedItems, actualItems, allowedNormalization) {
  const operations = alignItems(expectedItems, actualItems, allowedNormalization)
    .filter(({ operation }) => operation !== "match")
    .map(({ operation, expectedIndex, actualIndex }) => ({
      operation,
      expectedIndex: expectedIndex === null ? null : expectedIndex + 1,
      actualIndex: actualIndex === null ? null : actualIndex + 1,
    }));
  return {
    expectedItemCount: expectedItems.length,
    actualItemCount: actualItems.length,
    itemCountDelta: actualItems.length - expectedItems.length,
    operations,
  };
}

function alignItems(expectedItems, actualItems, allowedNormalization) {
  const rows = Array.from({ length: expectedItems.length + 1 }, () =>
    Array(actualItems.length + 1),
  );
  rows[0][0] = {
    cost: 0,
    exact: 0,
    substitutions: 0,
    operation: null,
  };

  for (let expectedIndex = 1; expectedIndex <= expectedItems.length; expectedIndex += 1) {
    rows[expectedIndex][0] = {
      cost: expectedIndex,
      exact: 0,
      substitutions: 0,
      operation: "delete",
    };
  }
  for (let actualIndex = 1; actualIndex <= actualItems.length; actualIndex += 1) {
    rows[0][actualIndex] = {
      cost: actualIndex,
      exact: 0,
      substitutions: 0,
      operation: "insert",
    };
  }

  const prefer = (candidate, current) => {
    if (candidate.cost !== current.cost) return candidate.cost < current.cost;
    if (candidate.exact !== current.exact) return candidate.exact > current.exact;
    return candidate.substitutions < current.substitutions;
  };

  for (let expectedIndex = 1; expectedIndex <= expectedItems.length; expectedIndex += 1) {
    for (let actualIndex = 1; actualIndex <= actualItems.length; actualIndex += 1) {
      const exact = itemsEqual(
        expectedItems[expectedIndex - 1],
        actualItems[actualIndex - 1],
        allowedNormalization,
      );
      const diagonal = rows[expectedIndex - 1][actualIndex - 1];
      let best = {
        cost: diagonal.cost + (exact ? 0 : 1),
        exact: diagonal.exact + (exact ? 1 : 0),
        substitutions: diagonal.substitutions + (exact ? 0 : 1),
        operation: exact ? "match" : "substitute",
      };
      const deletion = rows[expectedIndex - 1][actualIndex];
      const deleteCandidate = {
        cost: deletion.cost + 1,
        exact: deletion.exact,
        substitutions: deletion.substitutions,
        operation: "delete",
      };
      if (prefer(deleteCandidate, best)) best = deleteCandidate;

      const insertion = rows[expectedIndex][actualIndex - 1];
      const insertCandidate = {
        cost: insertion.cost + 1,
        exact: insertion.exact,
        substitutions: insertion.substitutions,
        operation: "insert",
      };
      if (prefer(insertCandidate, best)) best = insertCandidate;
      rows[expectedIndex][actualIndex] = best;
    }
  }

  const operations = [];
  let expectedIndex = expectedItems.length;
  let actualIndex = actualItems.length;
  while (expectedIndex > 0 || actualIndex > 0) {
    const operation = rows[expectedIndex][actualIndex].operation;
    if (operation === "match" || operation === "substitute") {
      operations.push({
        operation,
        expectedIndex: expectedIndex - 1,
        actualIndex: actualIndex - 1,
        expectedItem: expectedItems[expectedIndex - 1],
        actualItem: actualItems[actualIndex - 1],
      });
      expectedIndex -= 1;
      actualIndex -= 1;
    } else if (operation === "delete") {
      operations.push({
        operation,
        expectedIndex: expectedIndex - 1,
        actualIndex: null,
        expectedItem: expectedItems[expectedIndex - 1],
        actualItem: null,
      });
      expectedIndex -= 1;
    } else {
      operations.push({
        operation: "insert",
        expectedIndex: null,
        actualIndex: actualIndex - 1,
        expectedItem: null,
        actualItem: actualItems[actualIndex - 1],
      });
      actualIndex -= 1;
    }
  }
  return operations.reverse();
}

function itemsEqual(expected, actual, allowedNormalization) {
  return (
    expected.speaker === actual.speaker &&
    expected.isStageDirection === actual.isStageDirection &&
    normalize(expected.text, allowedNormalization) ===
      normalize(actual.text ?? "", allowedNormalization)
  );
}

function normalizeArtifact(value) {
  return String(value)
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}*✱]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function positionalAccuracy(expected, actual) {
  const total = Math.max(expected.length, actual.length, 1);
  let matches = 0;
  for (let index = 0; index < total; index += 1) {
    if (expected[index] === actual[index]) matches += 1;
  }

  return round(matches / total);
}

function textAccuracy(expected, actual, allowedNormalization) {
  const left = normalize(expected, allowedNormalization);
  const right = normalize(actual, allowedNormalization);
  const total = Math.max(left.length, right.length, 1);
  return round(1 - levenshtein(left, right) / total);
}

function normalize(value, allowedNormalization) {
  let normalized = String(value);
  if (allowedNormalization.includes("line_endings")) {
    normalized = normalized.replace(/\r\n?|\n/g, "\n");
  }
  if (allowedNormalization.includes("outer_whitespace")) normalized = normalized.trim();
  return normalized;
}

function levenshtein(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function range(values) {
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}
