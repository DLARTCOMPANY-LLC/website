import { describe, expect, it } from "vitest";
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

const manifest = {
  expected: {
    characters: ["Alex", "Blair"],
    items: [
      { speaker: "Alex", text: "See you this weekend.", isStageDirection: false },
      { speaker: null, text: "(then; to Blair)", isStageDirection: true },
      { speaker: "Blair", text: "Bring the blue-green case.", isStageDirection: false },
    ],
  },
  excludedArtifacts: [
    { text: "END", kind: "handwritten_annotation" },
    { text: "Role: CAPTAIN", kind: "viewer_chrome" },
    { text: "*", kind: "margin_revision_mark" },
  ],
  allowedNormalization: ["line_endings", "outer_whitespace"],
  thresholds: {
    fieldAccuracy: 1,
    characterAccuracy: 1,
    speakerAccuracy: 1,
    dialogueTextAccuracy: 0.9,
    directionTextAccuracy: 0.9,
    maxDialogueOmissions: 0,
    maxArtifactFalsePositives: 0,
    minimumConfidence: 0.8,
    maxLatencyMs: 1_000,
  },
};

function response(overrides = {}) {
  return {
    characters: ["Alex", "Blair"],
    items: [
      {
        order: 1,
        speaker: "Alex",
        text: "See you this weekend.",
        isStageDirection: false,
        confidence: 0.99,
      },
      {
        order: 2,
        speaker: null,
        text: "(then; to Blair)",
        isStageDirection: true,
        confidence: 0.99,
      },
      {
        order: 3,
        speaker: "Blair",
        text: "Bring the blue-green case.",
        isStageDirection: false,
        confidence: 0.99,
      },
    ],
    diagnostics: { overallConfidence: 0.99, warnings: [] },
    ...overrides,
  };
}

describe("live OCR evaluator scoring", () => {
  it("scores a perfect response without treating weekend as an END artifact", () => {
    const metrics = scoreFixture(manifest, response(), 500);

    expect(metrics).toEqual({
      fieldAccuracy: 1,
      characterAccuracy: 1,
      speakerAccuracy: 1,
      dialogueTextAccuracy: 1,
      directionTextAccuracy: 1,
      dialogueOmissions: 0,
      dialogueSubstitutions: 0,
      artifactFalsePositives: 0,
      speakerClassificationErrors: 0,
      directionClassificationErrors: 0,
      confidence: 0.99,
      latencyMs: 500,
      diff: {
        expectedItemCount: 3,
        actualItemCount: 3,
        itemCountDelta: 0,
        operations: [],
      },
    });
    expect(thresholdFailures(manifest.thresholds, metrics)).toEqual([]);
  });

  it("reports transcription errors separately from genuinely omitted turns", () => {
    const typo = response({
      items: response().items.map((item, index) =>
        index === 0 ? { ...item, text: "See you this weakend." } : item,
      ),
    });
    const typoMetrics = scoreFixture(manifest, typo, 500);
    expect(typoMetrics.dialogueOmissions).toBe(0);
    expect(typoMetrics.dialogueSubstitutions).toBe(1);
    expect(typoMetrics.dialogueTextAccuracy).toBeLessThan(1);

    const missing = response({ items: response().items.slice(0, 2) });
    expect(scoreFixture(manifest, missing, 500).dialogueOmissions).toBe(1);
  });

  it("aligns sequence shifts without inventing downstream substitutions or classification errors", () => {
    const missingFirstTurn = response({ items: response().items.slice(1) });
    const metrics = scoreFixture(manifest, missingFirstTurn, 500);

    expect(metrics.dialogueOmissions).toBe(1);
    expect(metrics.dialogueSubstitutions).toBe(0);
    expect(metrics.speakerClassificationErrors).toBe(0);
    expect(metrics.directionClassificationErrors).toBe(0);
    expect(metrics.diff.operations).toEqual([
      { operation: "delete", expectedIndex: 1, actualIndex: null },
    ]);
  });

  it("detects isolated exact or bounded-fuzzy artifacts but not substrings", () => {
    const leaked = response({
      items: [
        ...response().items,
        {
          order: 4,
          speaker: null,
          text: "END\nRole CAPTAlN\n*",
          isStageDirection: true,
          confidence: 0.9,
        },
      ],
    });
    expect(scoreFixture(manifest, leaked, 500).artifactFalsePositives).toBe(3);
  });

  it("requires every explicit live-billing gate", () => {
    expect(() => assertLiveEvaluationAuthorized({})).toThrow(
      "Live OCR evaluation is disabled",
    );
    expect(() =>
      assertLiveEvaluationAuthorized({ RUN_LIVE_OCR_EVAL: "1" }),
    ).toThrow("OPENAI_API_KEY");
    expect(() =>
      assertLiveEvaluationAuthorized({
        RUN_LIVE_OCR_EVAL: "1",
        OPENAI_API_KEY: "present",
      }),
    ).toThrow("OCR_EVAL_TARGET");
    expect(
      assertLiveEvaluationAuthorized({
        RUN_LIVE_OCR_EVAL: "1",
        OPENAI_API_KEY: "present",
        OCR_EVAL_TARGET: "http://127.0.0.1:8787/v1/screenplays/import",
      }),
    ).toBe("http://127.0.0.1:8787/v1/screenplays/import");
  });

  it("bounds repeated evaluation runs", () => {
    expect(readLiveEvaluationRuns({})).toBe(3);
    expect(readLiveEvaluationRuns({ OCR_EVAL_RUNS: "3" })).toBe(3);
    expect(readLiveEvaluationRuns({ OCR_EVAL_RUNS: "5" })).toBe(5);
    expect(() => readLiveEvaluationRuns({ OCR_EVAL_RUNS: "1" })).toThrow(
      "integer from 3 to 5",
    );
    expect(() => readLiveEvaluationRuns({ OCR_EVAL_RUNS: "6" })).toThrow(
      "integer from 3 to 5",
    );
  });

  it("plans every fixture for three independent attempts and confirms exact billing", () => {
    expect(buildEvaluationPlan(["a", "b"], 3)).toEqual([
      { id: "a", run: 1 },
      { id: "b", run: 1 },
      { id: "a", run: 2 },
      { id: "b", run: 2 },
      { id: "a", run: 3 },
      { id: "b", run: 3 },
    ]);
    expect(() => assertPlannedRequestCount({}, 18)).toThrow(
      "OCR_EVAL_CONFIRM_REQUESTS=18",
    );
    expect(() =>
      assertPlannedRequestCount({ OCR_EVAL_CONFIRM_REQUESTS: "17" }, 18),
    ).toThrow("OCR_EVAL_CONFIRM_REQUESTS=18");
    expect(
      assertPlannedRequestCount({ OCR_EVAL_CONFIRM_REQUESTS: "18" }, 18),
    ).toBeUndefined();
  });

  it("hashes parsed output canonically and reports one-of-three failure plus variance", () => {
    const hash = parsedOutputHash({ b: 2, a: 1 });
    expect(parsedOutputHash({ a: 1, b: 2 })).toBe(hash);
    const attempts = [
      {
        id: "fixture",
        run: 1,
        passed: true,
        outputHash: hash,
        providerModel: "gpt-5.6-sol",
        metrics: {
          ...scoreFixture(manifest, response(), 400),
        },
      },
      {
        id: "fixture",
        run: 2,
        passed: false,
        outputHash: parsedOutputHash({ a: 2 }),
        providerModel: "gpt-5.6-sol",
        metrics: {
          ...scoreFixture(manifest, response(), 600),
          confidence: 0.7,
        },
      },
      {
        id: "fixture",
        run: 3,
        passed: true,
        outputHash: hash,
        providerModel: "gpt-5.6-sol",
        metrics: {
          ...scoreFixture(manifest, response(), 500),
        },
      },
    ];
    const summaries = summarizeEvaluation(attempts, ["fixture"], 3);

    expect(summaries[0]).toMatchObject({
      attempts: 3,
      requiredRuns: 3,
      allRunsPresent: true,
      allPassed: false,
      uniqueOutputHashes: 2,
      structurallyStable: false,
      providerModels: ["gpt-5.6-sol"],
      variance: {
        itemCount: { min: 3, max: 3 },
        confidence: { min: 0.7, max: 0.99 },
        latencyMs: { min: 400, max: 600 },
      },
    });
    expect(evaluationPassed(summaries)).toBe(false);
  });
});
