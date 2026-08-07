import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ExpectedItem {
  speaker: string | null;
  text: string;
  isStageDirection: boolean;
}

interface FixtureManifest {
  schemaVersion: number;
  id: string;
  description: string;
  image: string;
  mediaType: "image/png" | "image/jpeg";
  complexity: "simple" | "moderate" | "complex";
  provenance: {
    kind: "synthetic";
    generator: string;
    textOwnership: string;
    thirdPartyContent: boolean;
  };
  expected: {
    characters: string[];
    items: ExpectedItem[];
  };
  excludedArtifacts: Array<{
    text: string;
    kind: "viewer_chrome" | "handwritten_annotation" | "margin_revision_mark";
  }>;
  allowedNormalization: string[];
  thresholds: Record<string, number>;
}

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ocr");
const manifests = findFiles(fixtureRoot, "manifest.json").map((path) => ({
  path,
  value: JSON.parse(readFileSync(path, "utf8")) as FixtureManifest,
}));

describe("synthetic OCR fixture contracts", () => {
  it("contains a complete PNG/JPEG complexity matrix with small generated images", () => {
    expect(manifests).toHaveLength(6);
    expect(
      manifests
        .map(({ value }) => `${value.mediaType}:${value.complexity}`)
        .sort(),
    ).toEqual([
      "image/jpeg:complex",
      "image/jpeg:moderate",
      "image/jpeg:simple",
      "image/png:complex",
      "image/png:moderate",
      "image/png:simple",
    ]);

    for (const { path, value } of manifests) {
      const imagePath = join(dirname(path), value.image);
      expect(existsSync(imagePath), `${value.id} image is missing`).toBe(true);
      expect(statSync(imagePath).size, `${value.id} should stay below 100 KiB`).toBeLessThan(
        100 * 1024,
      );
      const bytes = readFileSync(imagePath);
      if (value.mediaType === "image/png") {
        expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect(extname(imagePath)).toBe(".png");
      } else {
        expect([...bytes.subarray(0, 2)]).toEqual([255, 216]);
        expect([...bytes.subarray(-2)]).toEqual([255, 217]);
        expect(extname(imagePath)).toBe(".jpg");
      }
    }
  });

  it("uses only declared synthetic original content with bounded quality thresholds", () => {
    const thresholdNames = [
      "fieldAccuracy",
      "characterAccuracy",
      "speakerAccuracy",
      "dialogueTextAccuracy",
      "directionTextAccuracy",
      "maxDialogueOmissions",
      "maxArtifactFalsePositives",
      "minimumConfidence",
      "maxLatencyMs",
    ];

    for (const { value } of manifests) {
      expect(value.schemaVersion).toBe(1);
      expect(value.provenance).toEqual({
        kind: "synthetic",
        generator: "api/test/fixtures/ocr/generate.mjs",
        textOwnership: "Original test text authored for this repository",
        thirdPartyContent: false,
      });
      expect(value.id.toLocaleLowerCase()).not.toContain("racket");
      expect(value.description.toLocaleLowerCase()).not.toContain("racket");
      expect(value.allowedNormalization).toEqual(["line_endings", "outer_whitespace"]);
      expect(Object.keys(value.thresholds).sort()).toEqual([...thresholdNames].sort());
      for (const name of thresholdNames.slice(0, 7)) {
        expect(Number.isFinite(value.thresholds[name]), `${value.id}.${name}`).toBe(true);
        expect(value.thresholds[name], `${value.id}.${name}`).toBeGreaterThanOrEqual(0);
      }
      expect(value.thresholds.fieldAccuracy).toBeLessThanOrEqual(1);
      expect(value.thresholds.characterAccuracy).toBeLessThanOrEqual(1);
      expect(value.thresholds.speakerAccuracy).toBeLessThanOrEqual(1);
      expect(value.thresholds.dialogueTextAccuracy).toBeLessThanOrEqual(1);
      expect(value.thresholds.directionTextAccuracy).toBeLessThanOrEqual(1);
      expect(value.thresholds.minimumConfidence).toBeLessThanOrEqual(1);
      expect(value.thresholds.maxLatencyMs).toBeGreaterThanOrEqual(1_000);
    }
  });

  it("defines ordered characters and direction-safe parentheticals without artifact leakage", () => {
    for (const { value } of manifests) {
      expect(value.expected.items.length, `${value.id} has no expected items`).toBeGreaterThan(0);
      const spokenOrder: string[] = [];
      for (const item of value.expected.items) {
        expect(item.text.trim().length, `${value.id} contains empty text`).toBeGreaterThan(0);
        if (item.isStageDirection) {
          expect(item.speaker, `${value.id} direction has a speaker`).toBeNull();
        } else {
          expect(item.speaker, `${value.id} dialogue lacks a speaker`).toBeTypeOf("string");
          const identity = item.speaker!.replace(/\s+(?:\([^()]+\)\s*)+$/, "");
          if (!spokenOrder.includes(identity)) spokenOrder.push(identity);
        }
        if (/^\([^()\r\n]+\)$/.test(item.text.trim())) {
          expect(item.isStageDirection, `${value.id} parenthetical is spoken`).toBe(true);
          expect(item.speaker).toBeNull();
        }
      }
      expect(spokenOrder, `${value.id} character order`).toEqual(value.expected.characters);

      const retained = value.expected.items.map((item) => item.text).join("\n");
      for (const artifact of value.excludedArtifacts) {
        expect(retained, `${value.id} leaked ${artifact.kind}`).not.toContain(artifact.text);
      }
    }
  });

  it("covers the required layout, noise, artifact, and punctuation scenarios", () => {
    const descriptions = manifests.map(({ value }) => value.description).join(" ").toLowerCase();
    const allText = manifests
      .flatMap(({ value }) => value.expected.items.map((item) => item.text))
      .join("\n");
    const artifactKinds = new Set(
      manifests.flatMap(({ value }) => value.excludedArtifacts.map((artifact) => artifact.kind)),
    );

    expect(descriptions).toContain("clean");
    expect(descriptions).toContain("wrapped");
    expect(descriptions).toContain("low-contrast");
    expect(descriptions).toContain("uneven");
    expect(descriptions).toContain("perspective");
    expect(descriptions).toContain("viewer chrome");
    expect(artifactKinds).toEqual(
      new Set(["viewer_chrome", "handwritten_annotation", "margin_revision_mark"]),
    );
    expect(allText).toMatch(/[’']/);
    expect(allText).toContain("—");
    expect(allText).toMatch(/\w-\w/);
    expect(allText).toMatch(/\([^()\r\n]+\)/);
  });
});

function findFiles(directory: string, name: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findFiles(path, name);
    return entry.name === name ? [path] : [];
  });
}
