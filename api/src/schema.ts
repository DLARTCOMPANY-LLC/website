export interface ScreenplayItem {
  order: number;
  speaker: string | null;
  text: string;
  isStageDirection: boolean;
  confidence: number;
}

export interface ScreenplayImport {
  title: string | null;
  characters: string[];
  items: ScreenplayItem[];
  diagnostics: {
    overallConfidence: number;
    warnings: string[];
  };
}

export interface ModelScreenplayImport {
  characters: string[];
  items: ScreenplayItem[];
  diagnostics: ScreenplayImport["diagnostics"];
}

export const screenplayJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["characters", "items", "diagnostics"],
  properties: {
    characters: {
      type: "array",
      description: "Character names in order of first appearance. Excludes headings and directions.",
      items: { type: "string", minLength: 1 },
    },
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["order", "speaker", "text", "isStageDirection", "confidence"],
        properties: {
          order: { type: "integer", minimum: 1 },
          speaker: {
            anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
          },
          text: { type: "string", minLength: 1 },
          isStageDirection: { type: "boolean" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    diagnostics: {
      type: "object",
      additionalProperties: false,
      required: ["overallConfidence", "warnings"],
      properties: {
        overallConfidence: { type: "number", minimum: 0, maximum: 1 },
        warnings: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

const reservedDirectionNames = new Set(["ROLE", "START", "END"]);

export function validateModelImport(value: unknown): ModelScreenplayImport {
  const root = asRecord(value, "response");
  assertExactKeys(root, ["characters", "items", "diagnostics"], "response");

  if (!Array.isArray(root.characters)) {
    throw new ModelValidationError("characters must be an array");
  }
  const characters = root.characters.map((character, index) =>
    requireNonEmptyString(character, `characters[${index}]`),
  );
  if (characters.length === 0) {
    throw new ModelValidationError("at least one character is required");
  }
  const canonicalCharacters = new Set<string>();
  for (const character of characters) {
    const canonical = character.toLocaleUpperCase("en-US");
    if (reservedDirectionNames.has(canonical)) {
      throw new ModelValidationError(`${character} is a direction, not a character`);
    }
    if (canonicalCharacters.has(canonical)) {
      throw new ModelValidationError(`duplicate character: ${character}`);
    }
    canonicalCharacters.add(canonical);
  }

  if (!Array.isArray(root.items) || root.items.length === 0) {
    throw new ModelValidationError("at least one screenplay item is required");
  }

  const spokenCharacters = new Set<string>();
  const spokenCharacterOrder: string[] = [];
  let dialogueCount = 0;
  const items = root.items.map((item, index): ScreenplayItem => {
    const record = asRecord(item, `items[${index}]`);
    assertExactKeys(
      record,
      ["order", "speaker", "text", "isStageDirection", "confidence"],
      `items[${index}]`,
    );
    if (record.order !== index + 1) {
      throw new ModelValidationError(`items[${index}].order must equal ${index + 1}`);
    }
    const text = requireNonEmptyString(record.text, `items[${index}].text`);
    const confidence = requireConfidence(record.confidence, `items[${index}].confidence`);
    if (typeof record.isStageDirection !== "boolean") {
      throw new ModelValidationError(`items[${index}].isStageDirection must be a boolean`);
    }

    if (record.isStageDirection) {
      if (record.speaker !== null) {
        throw new ModelValidationError(`items[${index}].speaker must be null for a direction`);
      }
    } else {
      const speaker = requireNonEmptyString(record.speaker, `items[${index}].speaker`);
      const canonical = speaker.toLocaleUpperCase("en-US");
      if (reservedDirectionNames.has(canonical)) {
        throw new ModelValidationError(`${speaker} must be classified as a direction`);
      }
      if (!canonicalCharacters.has(canonical)) {
        throw new ModelValidationError(`dialogue speaker ${speaker} is missing from characters`);
      }
      if (!spokenCharacters.has(canonical)) {
        spokenCharacters.add(canonical);
        spokenCharacterOrder.push(canonical);
      }
      dialogueCount += 1;
    }

    return {
      order: index + 1,
      speaker: record.speaker as string | null,
      text,
      isStageDirection: record.isStageDirection,
      confidence,
    };
  });

  if (dialogueCount === 0) {
    throw new ModelValidationError("at least one dialogue item is required");
  }
  for (const canonical of canonicalCharacters) {
    if (!spokenCharacters.has(canonical)) {
      throw new ModelValidationError("every character must have a dialogue item");
    }
  }
  if (
    characters.some(
      (character, index) =>
        character.toLocaleUpperCase("en-US") !== spokenCharacterOrder[index],
    )
  ) {
    throw new ModelValidationError("characters must be ordered by first spoken appearance");
  }

  const diagnostics = asRecord(root.diagnostics, "diagnostics");
  assertExactKeys(diagnostics, ["overallConfidence", "warnings"], "diagnostics");
  const overallConfidence = requireConfidence(
    diagnostics.overallConfidence,
    "diagnostics.overallConfidence",
  );
  if (!Array.isArray(diagnostics.warnings)) {
    throw new ModelValidationError("diagnostics.warnings must be an array");
  }
  const warnings = diagnostics.warnings.map((warning, index) =>
    requireNonEmptyString(warning, `diagnostics.warnings[${index}]`),
  );

  return {
    characters,
    items,
    diagnostics: { overallConfidence, warnings },
  };
}

export class ModelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelValidationError";
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelValidationError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new ModelValidationError(`${path} has unexpected or missing fields`);
  }
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ModelValidationError(`${path} must be a non-empty string`);
  }
  return value;
}

function requireConfidence(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ModelValidationError(`${path} must be between 0 and 1`);
  }
  return value;
}
