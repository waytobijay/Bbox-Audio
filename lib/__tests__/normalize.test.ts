import { describe, expect, it } from "vitest";
import {
  normalizeText,
  numberToWords,
  ordinalToWords,
  stripMarkdown,
  yearToWords,
} from "../normalize";

describe("numberToWords", () => {
  it("handles small numbers", () => {
    expect(numberToWords(0)).toBe("zero");
    expect(numberToWords(7)).toBe("seven");
    expect(numberToWords(15)).toBe("fifteen");
    expect(numberToWords(42)).toBe("forty-two");
  });

  it("handles hundreds and thousands", () => {
    expect(numberToWords(100)).toBe("one hundred");
    expect(numberToWords(250)).toBe("two hundred fifty");
    expect(numberToWords(1250)).toBe("one thousand two hundred fifty");
    expect(numberToWords(1_000_000)).toBe("one million");
  });
});

describe("yearToWords", () => {
  it("reads years in pairs", () => {
    expect(yearToWords(2026)).toBe("twenty twenty-six");
    expect(yearToWords(1999)).toBe("nineteen ninety-nine");
    expect(yearToWords(1905)).toBe("nineteen oh five");
  });

  it("special-cases round and 200x years", () => {
    expect(yearToWords(2000)).toBe("two thousand");
    expect(yearToWords(2005)).toBe("two thousand five");
    expect(yearToWords(1900)).toBe("nineteen hundred");
  });
});

describe("ordinalToWords", () => {
  it("converts ordinals", () => {
    expect(ordinalToWords(1)).toBe("first");
    expect(ordinalToWords(3)).toBe("third");
    expect(ordinalToWords(12)).toBe("twelfth");
    expect(ordinalToWords(20)).toBe("twentieth");
    expect(ordinalToWords(21)).toBe("twenty-first");
  });
});

describe("normalizeText — numbers", () => {
  it("expands years", () => {
    expect(normalizeText("In 2026 we ship.")).toBe("In twenty twenty-six we ship.");
  });

  it("expands units", () => {
    expect(normalizeText("It needs 15GB of RAM.")).toBe(
      "It needs fifteen gigabytes of RAM."
    );
    expect(normalizeText("only 1 GB left")).toBe("only one gigabyte left");
  });

  it("expands currency", () => {
    expect(normalizeText("It costs $5.")).toBe("It costs five dollars.");
    expect(normalizeText("$5.50 each")).toBe("five dollars and fifty cents each");
    expect(normalizeText("a $3M budget")).toBe("a three million dollars budget");
    expect(normalizeText("$1,250.50 total")).toBe(
      "one thousand two hundred fifty dollars and fifty cents total"
    );
  });

  it("expands percentages", () => {
    expect(normalizeText("3.5% growth")).toBe("three point five percent growth");
    expect(normalizeText("100% done")).toBe("one hundred percent done");
  });

  it("expands ordinals and times", () => {
    expect(normalizeText("the 21st century")).toBe("the twenty-first century");
    expect(normalizeText("at 3:30 sharp")).toBe("at three thirty sharp");
  });

  it("expands plain and separated numbers", () => {
    expect(normalizeText("about 1,000 people")).toBe("about one thousand people");
    expect(normalizeText("wait 10-15 minutes")).toBe("wait ten-fifteen minutes");
  });

  it("leaves no digits behind", () => {
    const out = normalizeText(
      "In 2024, 3.5% of the $2,500 budget bought 15GB at 3:45, ranked 2nd of 1,000."
    );
    expect(out).not.toMatch(/\d/);
  });
});

describe("normalizeText — abbreviations", () => {
  it("expands common abbreviations", () => {
    expect(normalizeText("Fruit, e.g. apples.")).toBe("Fruit, for example, apples.");
    expect(normalizeText("Dr. Smith agrees.")).toBe("Doctor Smith agrees.");
    expect(normalizeText("Cats, dogs, etc.")).toBe("Cats, dogs, et cetera.");
    expect(normalizeText("A vs. B")).toBe("A versus B");
    expect(normalizeText("bread & butter")).toBe("bread and butter");
  });
});

describe("stripMarkdown / normalizeText — markdown", () => {
  it("strips headings, emphasis, code", () => {
    expect(normalizeText("# Big Title")).toBe("Big Title");
    expect(normalizeText("This is **bold** and *italic*.")).toBe(
      "This is bold and italic."
    );
    expect(normalizeText("run `npm install` now")).toBe("run npm install now");
  });

  it("keeps link text, drops URLs", () => {
    expect(normalizeText("See [the docs](https://example.com/docs).")).toBe(
      "See the docs."
    );
    expect(stripMarkdown("go to https://example.com now")).toBe("go to  now");
  });

  it("strips list markers", () => {
    expect(normalizeText("- first item\n- second item")).toBe(
      "first item\nsecond item"
    );
  });
});

describe("normalizeText — non-English languages", () => {
  it("skips English number/abbreviation expansion for Hindi", () => {
    expect(normalizeText("कीमत $5 है और 15GB चाहिए।", "hi")).toBe(
      "कीमत $5 है और 15GB चाहिए।"
    );
  });

  it("still strips markdown for Hindi", () => {
    expect(normalizeText("# शीर्षक — **मोटा** पाठ", "hi")).toBe("शीर्षक - मोटा पाठ");
  });
});

describe("normalizeText — punctuation", () => {
  it("converts smart quotes and dashes to ASCII", () => {
    expect(normalizeText("“Hello,” she said — twice.")).toBe(
      '"Hello," she said - twice.'
    );
    expect(normalizeText("it’s fine…")).toBe("it's fine...");
  });

  it("collapses whitespace", () => {
    expect(normalizeText("too   many    spaces")).toBe("too many spaces");
  });
});
