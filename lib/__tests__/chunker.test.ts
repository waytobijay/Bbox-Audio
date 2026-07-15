import { describe, expect, it } from "vitest";
import { MAX_CHARS, MIN_CHARS } from "../config";
import { chunkScript, splitLongSentence, splitSentences } from "../chunker";

// -- helpers ----------------------------------------------------------------

/** Build a realistic ~3,000-word script: 30 paragraphs, varied sentences. */
function buildLongScript(): string {
  const sentences = [
    "The history of computing is a story of relentless abstraction, each layer hiding the complexity of the one beneath it.",
    "Early programmers wrote machine code by hand, flipping switches and reading blinking lights.",
    "By 2026 the picture had changed completely, and even small teams could train useful models.",
    "It cost $5 to run the experiment, which produced 15GB of logs in under an hour.",
    "Researchers estimated a 3.5% improvement, e.g. on summarization benchmarks.",
    "Nobody believed them at first.",
    "The result held up under scrutiny, and replication followed quickly across a dozen independent labs around the world.",
    "What happened next surprised everyone involved in the project, because the technique generalized far beyond its original domain.",
    "Dr. Smith called it the most important shift of the decade.",
    "Progress rarely announces itself; it accumulates quietly until one day the landscape looks entirely different.",
  ];
  const paragraphs: string[] = [];
  for (let p = 0; p < 45; p++) {
    const count = 3 + (p % 4);
    const parts: string[] = [];
    for (let s = 0; s < count; s++) {
      parts.push(sentences[(p + s * 3) % sentences.length]);
    }
    paragraphs.push(parts.join(" "));
  }
  return paragraphs.join("\n\n");
}

// -- sentence splitting -----------------------------------------------------

describe("splitSentences", () => {
  it("splits on terminal punctuation", () => {
    expect(splitSentences("One sentence. Two sentences! Three?")).toEqual([
      "One sentence.",
      "Two sentences!",
      "Three?",
    ]);
  });

  it("does not split after abbreviations or initials", () => {
    expect(splitSentences("Mt. Everest is tall. Really tall.")).toEqual([
      "Mt. Everest is tall.",
      "Really tall.",
    ]);
    expect(splitSentences("J. K. Rowling wrote it. It sold well.")).toEqual([
      "J. K. Rowling wrote it.",
      "It sold well.",
    ]);
  });
});

// -- long-sentence splitting --------------------------------------------------

describe("splitLongSentence", () => {
  it("returns short sentences untouched", () => {
    expect(splitLongSentence("Short and sweet.")).toEqual(["Short and sweet."]);
  });

  it("splits over-long sentences at clause boundaries, never mid-word", () => {
    const clause = "the committee reviewed every proposal in exhaustive detail";
    const long = `${clause}, ${clause}, ${clause}, ${clause}, and then ${clause}.`;
    expect(long.length).toBeGreaterThan(MAX_CHARS);

    const pieces = splitLongSentence(long);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(MAX_CHARS);
    }
    // no word was cut in half: rejoining pieces yields the original word list
    const originalWords = long.split(/\s+/).filter(Boolean);
    const rejoined = pieces.join(" ").split(/\s+/).filter(Boolean);
    expect(rejoined).toEqual(originalWords);
  });
});

// -- chunkScript --------------------------------------------------------------

describe("chunkScript", () => {
  it("holds every invariant on a ~3,000-word script", () => {
    const script = buildLongScript();
    expect(script.split(/\s+/).length).toBeGreaterThan(2500);

    const chunks = chunkScript(script);
    expect(chunks.length).toBeGreaterThan(30);

    for (const c of chunks) {
      expect(c.charCount).toBeLessThanOrEqual(MAX_CHARS);
      expect(c.charCount).toBeGreaterThanOrEqual(MIN_CHARS);
      expect(c.text).toMatch(/[.!?]$/); // terminal punctuation
      expect(c.text).not.toMatch(/\d/); // numbers were expanded
      expect(c.charCount).toBe(c.text.length);
    }

    // 45 paragraphs → exactly 45 paragraph-end chunks, the last one included
    expect(chunks.filter((c) => c.isParagraphEnd)).toHaveLength(45);
    expect(chunks[chunks.length - 1].isParagraphEnd).toBe(true);
  });

  it("treats blank lines as paragraph boundaries", () => {
    const chunks = chunkScript(
      "First paragraph with enough words to stand alone comfortably.\n\n" +
        "Second paragraph, also long enough to be its own chunk entirely."
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0].isParagraphEnd).toBe(true);
    expect(chunks[1].isParagraphEnd).toBe(true);
  });

  it("forces a chunk break on --- without a paragraph gap", () => {
    const chunks = chunkScript(
      "This sentence sits before the forced break marker line.\n" +
        "---\n" +
        "This sentence sits after the forced break marker line."
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0].isParagraphEnd).toBe(true); // segment ends close the paragraph
  });

  it("never merges tiny chunks across a paragraph boundary", () => {
    const chunks = chunkScript(
      "A perfectly ordinary opening paragraph that runs long enough.\n\nYes."
    );
    // "Yes." stays its own (tiny) chunk rather than crossing the boundary
    expect(chunks).toHaveLength(2);
    expect(chunks[1].text).toBe("Yes.");
  });

  it("packs multiple sentences into one chunk up to the limit", () => {
    const chunks = chunkScript(
      "Sentence number one is here. Sentence number two is here. Sentence number three is here."
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].charCount).toBeLessThanOrEqual(MAX_CHARS);
  });

  it("normalizes markdown and numbers before chunking", () => {
    const chunks = chunkScript("# Intro\n\nIt costs **$5** and takes 3.5% longer.");
    expect(chunks.map((c) => c.text).join(" ")).toContain("five dollars");
    expect(chunks.map((c) => c.text).join(" ")).toContain("three point five percent");
  });

  it("returns nothing for empty or whitespace scripts", () => {
    expect(chunkScript("")).toEqual([]);
    expect(chunkScript("  \n\n  ")).toEqual([]);
  });
});
