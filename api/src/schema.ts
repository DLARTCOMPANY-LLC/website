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
      description:
        "Canonical character identities in order of first spoken appearance. Excludes cue suffixes, headings, directions, annotations, and viewer UI.",
      items: { type: "string" },
    },
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "order",
          "speaker",
          "text",
          "isStageDirection",
          "isArtifact",
          "confidence",
        ],
        properties: {
          order: { type: "integer", minimum: 1 },
          speaker: {
            description:
              "Visible character cue for dialogue, including cue suffixes such as (V.O.); null for non-dialogue.",
            anyOf: [{ type: "string" }, { type: "null" }],
          },
          text: {
            type: "string",
            description:
              "Verbatim screenplay text with original punctuation, apostrophes, hyphens, and line breaks. Standalone parentheticals are separate direction items.",
          },
          isStageDirection: {
            type: "boolean",
            description:
              "False only for a character cue's spoken block; true for useful screenplay action, headings, and transitions.",
          },
          isArtifact: {
            type: "boolean",
            description:
              "True only for detected viewer/app UI, handwritten annotations, or isolated margin marks that must not appear in the screenplay import.",
          },
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
          items: { type: "string" },
        },
      },
    },
  },
} as const;

export const screenplayExtractionInstructions = [
  "You are a production screenplay transcription engine. Analyze the image visually and return only the screenplay content represented by the schema.",
  "",
  "CONTENT BOUNDARY",
  "- Separate the screenplay page from surrounding PDF/image viewer chrome, audition-app controls, page thumbnails, toolbars, filenames, status bars, buttons, and navigation labels.",
  "- Classify handwritten audition annotations, highlights, arrows, circles, strike-throughs, isolated margin marks, and overlay labels such as Role, START, or END as isArtifact=true when they are not typeset screenplay text.",
  "- Audition screenshots commonly place a `Role: CHARACTER` banner above the page and floating START/END markers beside or over it. Treat those banners and markers as app UI, not screenplay directions, even though their text is legible. Never merge a UI banner line into a printed page header.",
  "- Use the page's paper boundary, background, typography, alignment, and continuous text flow to decide what belongs to the screenplay. When a retained printed line is adjacent to excluded UI, return only the printed line.",
  "- Represent each detected UI/annotation unit as its own item with speaker=null, isStageDirection=true, and isArtifact=true. Never combine artifact text with printed screenplay text in one item. Set isArtifact=false for every retained screenplay unit.",
  "- Include typeset screenplay scene headings, action, transitions, character cues, parentheticals, and dialogue. Page headers or revision marks may be retained only when clearly printed as part of the screenplay page.",
  "",
  "LAYOUT AND READING ORDER",
  "- Infer screenplay roles from visual layout, especially cue centering/indentation, dialogue-column indentation, parenthetical placement, and top-to-bottom reading order; do not classify by capitalization alone.",
  "- Create one item per contiguous screenplay unit. Every standalone parenthetical under a character cue is its own item with speaker=null and isStageDirection=true.",
  "- Split a character block around parentheticals. For example, `Not from me.` then `(then; to Spencer)` then `You ready?` becomes three ordered items: Mitch dialogue, direction, Mitch dialogue. Never put the parenthetical in either spoken item.",
  "- Never merge separate turns, even when the same character speaks again later. Never split one turn merely because it wraps across visual lines.",
  "",
  "VERBATIM TRANSCRIPTION",
  "- Preserve every visible dialogue word exactly. Preserve punctuation, straight or curly apostrophes, quotation marks, hyphens/dashes, capitalization, and line order. Preserve visible line breaks within each item.",
  "- Do not modernize punctuation, silently correct grammar, normalize contractions, paraphrase, summarize, infer hidden text, or invent missing words.",
  "- Retain useful printed stage directions and action. Exclude non-content UI and annotations rather than turning them into stage directions.",
  "",
  "SPEAKERS AND VALIDATION",
  "- For dialogue, speaker is the visible character cue and isStageDirection is false. For all retained non-dialogue, speaker is null and isStageDirection is true.",
  "- characters contains character identities in first-spoken order. Cross-check it against every spoken item. Do not include cue suffixes such as (V.O.) or (O.S.) in the identity; preserve those suffixes on item speakers.",
  "- Before returning, self-audit the page from top to bottom: verify that every visible dialogue block appears exactly once, no separate turns were merged, no screenplay text was invented, and all item order values are consecutive.",
  "- Cross-check every isArtifact classification against the visual page boundary. If uncertain whether text is printed screenplay content, retain it with isArtifact=false and add a warning rather than silently dropping it.",
  "- Use confidence honestly. Put concise location-specific uncertainty in diagnostics.warnings when text is cropped, obscured, ambiguous, or illegible; never guess to avoid a warning.",
].join("\n");

const reservedDirectionNames = new Set(["ROLE", "START", "END"]);

export function validateModelImport(value: unknown): ModelScreenplayImport {
  const root = asRecord(value, "response");
  assertExactKeys(root, ["characters", "items", "diagnostics"], "response");

  if (!Array.isArray(root.characters)) {
    throw new ModelValidationError("characters must be an array");
  }
  const providerCharacters = root.characters.map((character, index) =>
    requireNonEmptyString(character, `characters[${index}]`),
  );
  if (providerCharacters.length === 0) {
    throw new ModelValidationError("at least one character is required");
  }
  for (const character of providerCharacters) {
    const { identity } = parseSpeakerCue(character);
    if (reservedDirectionNames.has(identity.toLocaleUpperCase("en-US"))) {
      throw new ModelValidationError(`${character} is a direction, not a character`);
    }
  }

  if (!Array.isArray(root.items) || root.items.length === 0) {
    throw new ModelValidationError("at least one screenplay item is required");
  }

  const characterNames = new Map<string, string>();
  const characters: string[] = [];
  let dialogueCount = 0;
  const items: ScreenplayItem[] = [];
  root.items.forEach((item, index) => {
    const record = asRecord(item, `items[${index}]`);
    assertExactKeys(
      record,
      ["order", "speaker", "text", "isStageDirection", "isArtifact", "confidence"],
      `items[${index}]`,
    );
    if (record.order !== index + 1) {
      throw new ModelValidationError(`items[${index}].order must equal ${index + 1}`);
    }
    let text = requireNonEmptyString(record.text, `items[${index}].text`);
    const confidence = requireConfidence(record.confidence, `items[${index}].confidence`);
    if (typeof record.isStageDirection !== "boolean") {
      throw new ModelValidationError(`items[${index}].isStageDirection must be a boolean`);
    }
    if (typeof record.isArtifact !== "boolean") {
      throw new ModelValidationError(`items[${index}].isArtifact must be a boolean`);
    }

    let normalizedSpeaker: string | null;
    if (record.isArtifact) {
      if (record.speaker !== null || !record.isStageDirection) {
        throw new ModelValidationError(
          `items[${index}] artifacts must be directions with a null speaker`,
        );
      }
      return;
    } else if (record.isStageDirection) {
      if (record.speaker !== null) {
        throw new ModelValidationError(`items[${index}].speaker must be null for a direction`);
      }
      text = removeMergedAuditionUi(text);
      if (!text) return;
      normalizedSpeaker = null;
    } else {
      const speaker = requireNonEmptyString(record.speaker, `items[${index}].speaker`);
      const cue = parseSpeakerCue(speaker);
      const identityKey = cue.identity.toLocaleUpperCase("en-US");
      if (reservedDirectionNames.has(identityKey)) {
        throw new ModelValidationError(`${speaker} must be classified as a direction`);
      }
      const segments = splitDialogueParentheticals(text);
      for (const segment of segments) {
        if (segment.isParenthetical) {
          items.push({
            order: items.length + 1,
            speaker: null,
            text: segment.text,
            isStageDirection: true,
            confidence,
          });
          continue;
        }
        let characterName = characterNames.get(identityKey);
        if (!characterName) {
          characterName = toDisplayName(cue.identity);
          characterNames.set(identityKey, characterName);
          characters.push(characterName);
        }
        items.push({
          order: items.length + 1,
          speaker: characterName + cue.suffix,
          text: segment.text,
          isStageDirection: false,
          confidence,
        });
        dialogueCount += 1;
      }
      return;
    }

    items.push({
      order: items.length + 1,
      speaker: normalizedSpeaker,
      text,
      isStageDirection: record.isStageDirection,
      confidence,
    });
  });

  if (dialogueCount === 0) {
    throw new ModelValidationError("at least one dialogue item is required");
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

function parseSpeakerCue(value: string): { identity: string; suffix: string } {
  const trimmed = value.trim().replace(/\s+/g, " ");
  const match = trimmed.match(/^(.*?)(\s+(?:\([^()]+\)\s*)+)$/);
  const identity = (match?.[1] ?? trimmed).trim();
  if (!identity) {
    throw new ModelValidationError("speaker cue must include a character name");
  }
  const suffix = match
    ? ` ${match[2]
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleUpperCase("en-US")}`
    : "";
  return { identity, suffix };
}

function toDisplayName(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/(^|[\s\-'])\p{L}/gu, (match) => match.toLocaleUpperCase("en-US"));
}

function removeMergedAuditionUi(value: string): string {
  const cleaned = value
    .replace(/^[ \t]*Role:[^\r\n]*(?:\r?\n)+/i, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+\s*\d*(?:START|END)\s*$/i, "")
    .replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "");
  return /^[*✱]$/.test(cleaned.trim()) ? "" : cleaned;
}

function splitDialogueParentheticals(
  value: string,
): Array<{ text: string; isParenthetical: boolean }> {
  const parts = value.split(/(\r\n|\n|\r)/);
  const segments: Array<{ text: string; isParenthetical: boolean }> = [];
  let dialogue = "";

  const flushDialogue = (): void => {
    const text = dialogue.replace(/^(?:\r\n|\n|\r)+|(?:\r\n|\n|\r)+$/g, "");
    if (text) segments.push({ text, isParenthetical: false });
    dialogue = "";
  };

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const separator = parts[index + 1] ?? "";
    if (/^[ \t]*\([^()\r\n]+\)[ \t]*$/.test(line)) {
      flushDialogue();
      segments.push({ text: line.trim(), isParenthetical: true });
    } else {
      dialogue += line + separator;
    }
  }
  flushDialogue();

  return segments.length > 0 ? segments : [{ text: value, isParenthetical: false }];
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
