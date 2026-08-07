import { describe, expect, it } from "vitest";
import {
  assertLiveEvaluationAuthorized,
  readLiveEvaluationRuns,
  scoreFixture,
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
      artifactFalsePositives: 0,
      confidence: 0.99,
      latencyMs: 500,
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
    expect(typoMetrics.dialogueTextAccuracy).toBeLessThan(1);

    const missing = response({ items: response().items.slice(0, 2) });
    expect(scoreFixture(manifest, missing, 500).dialogueOmissions).toBe(1);
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
    expect(readLiveEvaluationRuns({})).toBe(1);
    expect(readLiveEvaluationRuns({ OCR_EVAL_RUNS: "3" })).toBe(3);
    expect(() => readLiveEvaluationRuns({ OCR_EVAL_RUNS: "0" })).toThrow(
      "integer from 1 to 5",
    );
    expect(() => readLiveEvaluationRuns({ OCR_EVAL_RUNS: "6" })).toThrow(
      "integer from 1 to 5",
    );
  });
});
