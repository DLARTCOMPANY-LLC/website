import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = dirname(fileURLToPath(import.meta.url));

const cases = [
  {
    id: "png-simple-clean",
    format: "png",
    level: "simple",
    file: "clean-screenplay.png",
    description: "Clean typeset screenplay with punctuation and a printed action line.",
    lines: [
      direction("INT. TEST KITCHEN - DAY", 155, 170),
      direction("A timer rings. NORA checks the blue-green tray.", 155, 220),
      cue("NORA", 500, 300),
      dialogue(["It's ready—right on time."], 325),
      cue("ALEX", 500, 400),
      dialogue(["Then don't re-label it."], 425),
    ],
    expected: output(
      ["Nora", "Alex"],
      [
        item(null, "INT. TEST KITCHEN - DAY", true),
        item(null, "A timer rings. NORA checks the blue-green tray.", true),
        item("Nora", "It's ready—right on time.", false),
        item("Alex", "Then don't re-label it.", false),
      ],
    ),
    artifacts: [],
    thresholds: thresholds({ maxLatencyMs: 90_000 }),
  },
  {
    id: "png-moderate-parenthetical",
    format: "png",
    level: "moderate",
    file: "wrapped-parenthetical.png",
    description: "Wrapped dialogue with leading and interstitial screenplay parentheticals.",
    lines: [
      direction("INT. EMPTY STAGE - NIGHT", 155, 155),
      cue("MAYA", 500, 245),
      parenthetical("(softly)", 430, 280),
      dialogue(["The paper lantern is still", "glowing near the back wall."], 315),
      cue("THEO", 500, 430),
      dialogue(["I can see it."], 465),
      parenthetical("(then; to Maya)", 430, 500),
      dialogue(["Don't switch it off yet."], 535),
    ],
    expected: output(
      ["Maya", "Theo"],
      [
        item(null, "INT. EMPTY STAGE - NIGHT", true),
        item(null, "(softly)", true),
        item("Maya", "The paper lantern is still\nglowing near the back wall.", false),
        item("Theo", "I can see it.", false),
        item(null, "(then; to Maya)", true),
        item("Theo", "Don't switch it off yet.", false),
      ],
    ),
    artifacts: [],
    thresholds: thresholds({ dialogueTextAccuracy: 0.98 }),
  },
  {
    id: "png-complex-viewer-artifacts",
    format: "png",
    level: "complex",
    file: "viewer-chrome-marks.png",
    description: "Viewer chrome, margin revision marks, and handwritten-style START/END overlays.",
    viewer: true,
    lines: [
      direction("EXT. TRAIN PLATFORM - DAWN", 170, 215),
      direction("CAPTAIN VALE folds a weather-stained map.", 170, 260),
      cue("CAPTAIN VALE", 500, 340),
      dialogue(["Keep the north gate clear."], 375),
      revisionMark(790, 375),
      cue("LEE", 500, 455),
      parenthetical("(checking the clock)", 405, 490),
      dialogue(["Two minutes—no more."], 525),
      revisionMark(790, 525),
    ],
    overlays: [
      overlay("Role: CAPTAIN VALE", 32, 38, -2),
      overlay("START", 55, 315, -7),
      overlay("END", 790, 770, 5),
    ],
    expected: output(
      ["Captain Vale", "Lee"],
      [
        item(null, "EXT. TRAIN PLATFORM - DAWN", true),
        item(null, "CAPTAIN VALE folds a weather-stained map.", true),
        item("Captain Vale", "Keep the north gate clear.", false),
        item(null, "(checking the clock)", true),
        item("Lee", "Two minutes—no more.", false),
      ],
    ),
    artifacts: [
      artifact("Role: CAPTAIN VALE", "viewer_chrome"),
      artifact("START", "handwritten_annotation"),
      artifact("END", "handwritten_annotation"),
      artifact("*", "margin_revision_mark"),
    ],
    thresholds: thresholds({
      dialogueTextAccuracy: 0.96,
      directionTextAccuracy: 0.9,
      minimumConfidence: 0.75,
    }),
  },
  {
    id: "jpeg-simple-punctuation",
    format: "jpeg",
    level: "simple",
    file: "punctuation-dialogue.jpg",
    description: "Clean JPEG containing apostrophes, quotation marks, and compound hyphens.",
    lines: [
      direction("INT. PROP ROOM - MORNING", 155, 170),
      cue("JUNE", 500, 270),
      dialogue(['"Don\'t move the blue-green crate."', "It's camera-ready."], 305),
      cue("OMAR", 500, 420),
      dialogue(["Copy that—hands off."], 455),
    ],
    expected: output(
      ["June", "Omar"],
      [
        item(null, "INT. PROP ROOM - MORNING", true),
        item("June", '"Don\'t move the blue-green crate."\nIt\'s camera-ready.', false),
        item("Omar", "Copy that—hands off.", false),
      ],
    ),
    artifacts: [],
    thresholds: thresholds({ dialogueTextAccuracy: 0.98 }),
  },
  {
    id: "jpeg-moderate-low-contrast",
    format: "jpeg",
    level: "moderate",
    file: "low-contrast-lighting.jpg",
    description: "Low-contrast page under simulated uneven warm lighting.",
    lowContrast: true,
    lighting: true,
    lines: [
      direction("INT. REHEARSAL HALL - LATE AFTERNOON", 150, 170),
      cue("ELI", 500, 275),
      dialogue(["The left-hand door sticks", "when the room gets cold."], 310),
      cue("ROSA", 500, 430),
      dialogue(["I'll mark it."], 465),
      parenthetical("(after a beat)", 430, 500),
      dialogue(["But we test it twice."], 535),
    ],
    expected: output(
      ["Eli", "Rosa"],
      [
        item(null, "INT. REHEARSAL HALL - LATE AFTERNOON", true),
        item("Eli", "The left-hand door sticks\nwhen the room gets cold.", false),
        item("Rosa", "I'll mark it.", false),
        item(null, "(after a beat)", true),
        item("Rosa", "But we test it twice.", false),
      ],
    ),
    artifacts: [],
    thresholds: thresholds({
      dialogueTextAccuracy: 0.94,
      directionTextAccuracy: 0.9,
      minimumConfidence: 0.7,
    }),
  },
  {
    id: "jpeg-complex-phone-photo",
    format: "jpeg",
    level: "complex",
    file: "phone-perspective.jpg",
    description: "Simulated phone photo with perspective skew, shadow, chrome, and margin notes.",
    viewer: true,
    perspective: true,
    lighting: true,
    lines: [
      direction("INT. SERVICE CORRIDOR - CONTINUOUS", 170, 220),
      direction("CASEY steadies a half-open equipment case.", 170, 265),
      cue("CASEY", 500, 350),
      dialogue(["We need the pre-check list—", "not yesterday's draft."], 385),
      cue("GUARD", 500, 500),
      parenthetical("(off the radio)", 430, 535),
      dialogue(["Understood. Gate C is clear."], 570),
      revisionMark(790, 385),
    ],
    overlays: [
      overlay("page_07.jpg", 40, 38, 0),
      overlay("START", 62, 640, -10),
      overlay("END", 788, 830, 7),
      overlay("redo?", 65, 735, -12),
    ],
    expected: output(
      ["Casey", "Guard"],
      [
        item(null, "INT. SERVICE CORRIDOR - CONTINUOUS", true),
        item(null, "CASEY steadies a half-open equipment case.", true),
        item("Casey", "We need the pre-check list—\nnot yesterday's draft.", false),
        item(null, "(off the radio)", true),
        item("Guard", "Understood. Gate C is clear.", false),
      ],
    ),
    artifacts: [
      artifact("page_07.jpg", "viewer_chrome"),
      artifact("START", "handwritten_annotation"),
      artifact("END", "handwritten_annotation"),
      artifact("redo?", "handwritten_annotation"),
      artifact("*", "margin_revision_mark"),
    ],
    thresholds: thresholds({
      dialogueTextAccuracy: 0.9,
      directionTextAccuracy: 0.86,
      minimumConfidence: 0.65,
      maxLatencyMs: 90_000,
    }),
  },
];

for (const fixture of cases) {
  const directory = join(root, fixture.format, fixture.level);
  await mkdir(directory, { recursive: true });
  const imagePath = join(directory, fixture.file);
  const svg = renderSvg(fixture);
  let pipeline = sharp(Buffer.from(svg));
  if (fixture.perspective) {
    pipeline = pipeline.affine(
      [
        [1, 0.025],
        [-0.018, 1],
      ],
      { background: "#303238", interpolator: sharp.interpolators.bicubic },
    );
  }
  if (fixture.format === "png") {
    await pipeline.png({ compressionLevel: 9, palette: true }).toFile(imagePath);
  } else {
    await pipeline.jpeg({ quality: fixture.level === "complex" ? 68 : 78 }).toFile(imagePath);
  }

  const manifest = {
    schemaVersion: 1,
    id: fixture.id,
    description: fixture.description,
    image: fixture.file,
    mediaType: fixture.format === "png" ? "image/png" : "image/jpeg",
    complexity: fixture.level,
    provenance: {
      kind: "synthetic",
      generator: "api/test/fixtures/ocr/generate.mjs",
      textOwnership: "Original test text authored for this repository",
      thirdPartyContent: false,
    },
    expected: fixture.expected,
    excludedArtifacts: fixture.artifacts,
    allowedNormalization: ["line_endings", "outer_whitespace"],
    thresholds: fixture.thresholds,
  };
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function output(characters, items) {
  return { characters, items };
}

function item(speaker, text, isStageDirection) {
  return { speaker, text, isStageDirection };
}

function artifact(text, kind) {
  return { text, kind };
}

function thresholds(overrides = {}) {
  return {
    fieldAccuracy: 1,
    characterAccuracy: 1,
    speakerAccuracy: 1,
    dialogueTextAccuracy: 0.98,
    directionTextAccuracy: 0.92,
    maxDialogueOmissions: 0,
    maxArtifactFalsePositives: 0,
    minimumConfidence: 0.8,
    maxLatencyMs: 60_000,
    ...overrides,
  };
}

function direction(text, x, y) {
  return textLine(text, x, y, "action");
}

function cue(text, x, y) {
  return textLine(text, x, y, "cue");
}

function dialogue(lines, y) {
  return lines.map((text, index) => textLine(text, 335, y + index * 34, "dialogue"));
}

function parenthetical(text, x, y) {
  return textLine(text, x, y, "parenthetical");
}

function revisionMark(x, y) {
  return textLine("*", x, y, "revision");
}

function overlay(text, x, y, rotation) {
  return { type: "overlay", text, x, y, rotation };
}

function textLine(text, x, y, role) {
  return { type: "text", text, x, y, role };
}

function renderSvg(fixture) {
  const paperX = fixture.viewer ? 115 : 80;
  const paperY = fixture.viewer ? 110 : 55;
  const textColor = fixture.lowContrast ? "#77736d" : "#181818";
  const background = fixture.viewer ? "#42464e" : "#d8d8d5";
  const content = fixture.lines
    .flat()
    .map((line) => renderLine(line, textColor))
    .join("\n");
  const overlays = (fixture.overlays ?? []).map(renderOverlay).join("\n");
  const lighting = fixture.lighting
    ? '<rect width="900" height="1200" fill="url(#light)" opacity="0.28"/>'
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">
  <defs>
    <linearGradient id="light" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffd88a"/>
      <stop offset="0.48" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#1e2530"/>
    </linearGradient>
    <filter id="shadow"><feDropShadow dx="8" dy="12" stdDeviation="10" flood-opacity="0.35"/></filter>
  </defs>
  <rect width="900" height="1200" fill="${background}"/>
  ${fixture.viewer ? '<rect x="0" y="0" width="900" height="78" fill="#24272d"/><circle cx="840" cy="38" r="13" fill="#8a9099"/>' : ""}
  <rect x="${paperX}" y="${paperY}" width="720" height="1040" rx="2" fill="${fixture.lowContrast ? "#eee9dc" : "#fffef9"}" filter="url(#shadow)"/>
  <g transform="translate(${paperX - 80} ${paperY - 55})">${content}</g>
  ${overlays}
  ${lighting}
</svg>`;
}

function renderLine(line, color) {
  const sizes = {
    action: 24,
    cue: 25,
    dialogue: 24,
    parenthetical: 22,
    revision: 28,
  };
  const weight = line.role === "cue" ? 700 : 400;
  return `<text x="${line.x}" y="${line.y}" fill="${color}" font-family="Courier New, monospace" font-size="${sizes[line.role]}" font-weight="${weight}" xml:space="preserve">${escapeXml(line.text)}</text>`;
}

function renderOverlay(line) {
  return `<text x="${line.x}" y="${line.y}" transform="rotate(${line.rotation} ${line.x} ${line.y})" fill="#d83b31" font-family="Comic Sans MS, cursive" font-size="27" font-weight="700">${escapeXml(line.text)}</text>`;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
