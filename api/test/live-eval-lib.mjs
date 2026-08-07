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

export function scoreFixture(manifest, actual, latencyMs) {
  const expectedItems = manifest.expected.items;
  const actualItems = Array.isArray(actual.items) ? actual.items : [];
  const expectedDialogue = expectedItems.filter((item) => !item.isStageDirection);
  const actualDialogue = actualItems.filter((item) => !item.isStageDirection);
  const expectedDirections = expectedItems.filter((item) => item.isStageDirection);
  const actualDirections = actualItems.filter((item) => item.isStageDirection);

  const characters = Array.isArray(actual.characters) ? actual.characters : [];
  const characterAccuracy = positionalAccuracy(manifest.expected.characters, characters);
  const expectedSpeakers = expectedDialogue.map((item) => item.speaker);
  const actualSpeakers = actualDialogue.map((item) => item.speaker);
  const speakerAccuracy = positionalAccuracy(expectedSpeakers, actualSpeakers);
  const fieldAccuracy = positionalAccuracy(
    expectedItems.map((item) => `${item.isStageDirection}:${item.speaker ?? ""}`),
    actualItems.map((item) => `${item.isStageDirection}:${item.speaker ?? ""}`),
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
  const dialogueOmissions =
    expectedSpeakers.length - longestCommonSubsequenceLength(expectedSpeakers, actualSpeakers);
  const outputLines = actualItems.flatMap((item) =>
    String(item.text ?? "").split(/\r\n|\n|\r/),
  );
  const artifactFalsePositives = manifest.excludedArtifacts.filter((artifact) =>
    outputLines.some((line) => artifactLineMatches(line, artifact.text)),
  ).length;
  const confidence =
    typeof actual.diagnostics?.overallConfidence === "number"
      ? actual.diagnostics.overallConfidence
      : 0;

  return {
    fieldAccuracy,
    characterAccuracy,
    speakerAccuracy,
    dialogueTextAccuracy,
    directionTextAccuracy,
    dialogueOmissions,
    artifactFalsePositives,
    confidence,
    latencyMs,
  };
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

function normalizeArtifact(value) {
  return String(value)
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}*✱]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function longestCommonSubsequenceLength(left, right) {
  const rows = Array.from({ length: left.length + 1 }, () =>
    Array(right.length + 1).fill(0),
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      rows[leftIndex][rightIndex] =
        left[leftIndex - 1] === right[rightIndex - 1]
          ? rows[leftIndex - 1][rightIndex - 1] + 1
          : Math.max(rows[leftIndex - 1][rightIndex], rows[leftIndex][rightIndex - 1]);
    }
  }
  return rows[left.length][right.length];
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
