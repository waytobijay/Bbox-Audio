import { describe, expect, it } from "vitest";
import {
  VoiceStorageError,
  newVoiceId,
  readWavMeta,
  slugifyVoiceName,
} from "../server/voices";

/**
 * The library's pure edges. The store itself is thin Redis/Blob plumbing, but
 * these two decide whether a clip is accepted at all — and a bad duration
 * reading is how you end up with a 2-second reference that clones badly.
 */

/** Minimal PCM WAV, optionally with an extra chunk before `data`. */
function wav({
  seconds = 1,
  sampleRate = 24000,
  channels = 1,
  bits = 16,
  extraChunk = false,
  declaredDataSize,
}: {
  seconds?: number;
  sampleRate?: number;
  channels?: number;
  bits?: number;
  extraChunk?: boolean;
  declaredDataSize?: number;
} = {}): ArrayBuffer {
  const bytesPerFrame = (channels * bits) / 8;
  const dataBytes = Math.round(seconds * sampleRate) * bytesPerFrame;
  // LIST chunks really do appear before `data` in files from real editors.
  const extra = extraChunk ? 8 + 10 : 0;
  const buf = new ArrayBuffer(44 + extra + dataBytes);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };

  ascii(0, "RIFF");
  v.setUint32(4, buf.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * bytesPerFrame, true);
  v.setUint16(32, bytesPerFrame, true);
  v.setUint16(34, bits, true);

  let off = 36;
  if (extraChunk) {
    ascii(off, "LIST");
    v.setUint32(off + 4, 10, true);
    off += 18;
  }
  ascii(off, "data");
  v.setUint32(off + 4, declaredDataSize ?? dataBytes, true);
  return buf;
}

describe("slugifyVoiceName", () => {
  it("makes a readable blob path", () => {
    expect(slugifyVoiceName("Bijay Narration")).toBe("bijay-narration");
  });

  it("strips punctuation and collapses separators", () => {
    expect(slugifyVoiceName("  My?? Voice -- v2!! ")).toBe("my-voice-v2");
  });

  it("never returns an empty slug, so the path stays valid", () => {
    expect(slugifyVoiceName("हिन्दी")).toBe("voice");
    expect(slugifyVoiceName("")).toBe("voice");
  });

  it("caps the length", () => {
    expect(slugifyVoiceName("a".repeat(100)).length).toBe(32);
  });
});

describe("newVoiceId", () => {
  it("keeps the slug and adds a tail, so two voices can share a name", () => {
    expect(newVoiceId("My Voice", () => "deadbeef")).toBe("my-voice-deadbeef");
  });

  it("generates distinct ids for the same name", () => {
    expect(newVoiceId("Me")).not.toBe(newVoiceId("Me"));
  });
});

describe("readWavMeta", () => {
  it("reads rate, channels and duration", () => {
    const meta = readWavMeta(wav({ seconds: 15, sampleRate: 24000 }));
    expect(meta.sampleRate).toBe(24000);
    expect(meta.channels).toBe(1);
    expect(meta.bitsPerSample).toBe(16);
    expect(meta.durationSec).toBeCloseTo(15, 3);
  });

  it("halves the duration for stereo, rather than doubling it", () => {
    const meta = readWavMeta(wav({ seconds: 10, channels: 2 }));
    expect(meta.durationSec).toBeCloseTo(10, 3);
  });

  it("skips chunks it doesn't care about to find `data`", () => {
    expect(readWavMeta(wav({ seconds: 8, extraChunk: true })).durationSec).toBeCloseTo(8, 3);
  });

  it("falls back to the real byte count when `data` declares zero", () => {
    // Streamed WAVs do this; trusting the header would report a 0s clip.
    const meta = readWavMeta(wav({ seconds: 12, declaredDataSize: 0 }));
    expect(meta.durationSec).toBeCloseTo(12, 3);
  });

  it("rejects something that isn't a WAV", () => {
    const notWav = new ArrayBuffer(64);
    expect(() => readWavMeta(notWav)).toThrow(VoiceStorageError);
  });

  it("rejects a truncated file instead of guessing", () => {
    expect(() => readWavMeta(new ArrayBuffer(8))).toThrow(/isn't a WAV/i);
  });
});
