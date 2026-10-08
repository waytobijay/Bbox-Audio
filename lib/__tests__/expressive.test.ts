import { describe, expect, it } from "vitest";
import { chunkScript } from "../chunker";
import { normalizeText } from "../normalize";
import { mergeRefs } from "../server/voices";

/**
 * Expressive narration, gateway side: tone tags must survive normalization
 * only when the caller asked for them, and linked voices must merge safely.
 */

describe("prosody tags", () => {
  const tagged = "[excited] तपाईंको laptop को IP कसैले देख्न सक्छ? [pause] अब सेटिङ खोल्नुहोस्।";

  it("keeps the tags when asked", () => {
    const out = normalizeText(tagged, "ne", { keepProsodyTags: true });
    expect(out).toContain("[excited]");
    expect(out).toContain("[pause]");
  });

  it("lower-cases and tidies a sloppy tag", () => {
    expect(normalizeText("[ Calm ] ठिक छ।", "ne", { keepProsodyTags: true })).toBe("[calm] ठिक छ।");
  });

  it("does not keep unknown bracket text", () => {
    const out = normalizeText("[shout] ठिक छ।", "ne", { keepProsodyTags: true });
    expect(out).not.toContain("[");
  });

  it("is unchanged for everyone who did not ask", () => {
    expect(normalizeText(tagged, "ne")).not.toContain("[");
  });

  it("travels through the chunker", () => {
    const drafts = chunkScript(tagged, undefined, "ne", { keepProsodyTags: true });
    const joined = drafts.map((d) => d.text).join(" ");
    expect(joined).toContain("[excited]");
    expect(joined).toContain("[pause]");
  });

  it("keeps English words in English letters for code-switching", () => {
    const drafts = chunkScript("तपाईंको laptop को IP कसैले देख्न सक्छ?", undefined, "ne");
    expect(drafts[0].text).toContain("laptop");
    expect(drafts[0].text).toContain("IP");
  });
});

describe("mergeRefs", () => {
  it("links, unlinks and refuses self-links", () => {
    expect(mergeRefs("me", undefined, { en: "me-en" })).toEqual({ en: "me-en" });
    expect(mergeRefs("me", { en: "me-en", calm: "c" }, { en: null })).toEqual({ calm: "c" });
    expect(mergeRefs("me", { calm: "c" }, { calm: "me" })).toBeUndefined();
  });

  it("leaves untouched slots alone", () => {
    expect(mergeRefs("me", { en: "a" }, { excited: "b" })).toEqual({ en: "a", excited: "b" });
  });

  it("ignores no patch at all", () => {
    expect(mergeRefs("me", { en: "a" }, undefined)).toEqual({ en: "a" });
  });
});
