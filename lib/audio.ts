/**
 * Client-side audio: WAV decode/encode, stitching with gaps, peak
 * normalization, MP3 encode, SRT timing. Everything runs in the browser —
 * the server only ever returns base64 WAV chunks.
 */

import { Mp3Encoder } from "@breezystack/lamejs";
import { NORMALIZE_PEAK_DBFS, PARAGRAPH_GAP_SEC, SENTENCE_GAP_SEC } from "./config";

export interface PcmAudio {
  samples: Float32Array;
  sampleRate: number;
}

// ---------------------------------------------------------------------------
// WAV decode / encode
// ---------------------------------------------------------------------------

/** Parse a RIFF/WAVE buffer to mono float32. Supports PCM 16/24/32 and float32. */
export function decodeWav(buf: ArrayBuffer): PcmAudio {
  const view = new DataView(buf);
  if (view.getUint32(0, false) !== 0x52494646 /* RIFF */ ||
      view.getUint32(8, false) !== 0x57415645 /* WAVE */) {
    throw new Error("Not a WAV file");
  }

  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    if (id === 0x666d7420 /* fmt  */) {
      fmt = {
        format: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bits: view.getUint16(offset + 22, true),
      };
    } else if (id === 0x64617461 /* data */) {
      dataOffset = offset + 8;
      dataLength = Math.min(size, view.byteLength - dataOffset);
    }
    offset += 8 + size + (size % 2);
  }

  if (!fmt || dataOffset < 0) throw new Error("Malformed WAV: missing fmt/data chunk");

  const { format, channels, sampleRate, bits } = fmt;
  const bytesPerSample = bits / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  const samples = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let acc = 0;
    for (let ch = 0; ch < channels; ch++) {
      const p = dataOffset + (i * channels + ch) * bytesPerSample;
      let v: number;
      if (format === 3 || (format === 0xfffe && bits === 32)) {
        v = view.getFloat32(p, true);
      } else if (bits === 16) {
        v = view.getInt16(p, true) / 32768;
      } else if (bits === 24) {
        const b0 = view.getUint8(p);
        const b1 = view.getUint8(p + 1);
        const b2 = view.getUint8(p + 2);
        let n = (b2 << 16) | (b1 << 8) | b0;
        if (n & 0x800000) n |= ~0xffffff;
        v = n / 8388608;
      } else if (bits === 32) {
        v = view.getInt32(p, true) / 2147483648;
      } else {
        throw new Error(`Unsupported WAV bit depth: ${bits}`);
      }
      acc += v;
    }
    samples[i] = acc / channels;
  }

  return { samples, sampleRate };
}

/** Encode mono float32 → 16-bit PCM WAV blob. */
export function encodeWavPcm16({ samples, sampleRate }: PcmAudio): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// transforms
// ---------------------------------------------------------------------------

export function resampleLinear(audio: PcmAudio, targetRate: number): PcmAudio {
  if (audio.sampleRate === targetRate) return audio;
  const ratio = audio.sampleRate / targetRate;
  const outLength = Math.round(audio.samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, audio.samples.length - 1);
    const t = pos - i0;
    out[i] = audio.samples[i0] * (1 - t) + audio.samples[i1] * t;
  }
  return { samples: out, sampleRate: targetRate };
}

export function trimAudio(audio: PcmAudio, startSec: number, endSec: number): PcmAudio {
  const start = Math.max(0, Math.floor(startSec * audio.sampleRate));
  const end = Math.min(audio.samples.length, Math.ceil(endSec * audio.sampleRate));
  return { samples: audio.samples.slice(start, end), sampleRate: audio.sampleRate };
}

/** Scale so the loudest sample sits at `dbfs` (default −1 dBFS). */
export function peakNormalize(audio: PcmAudio, dbfs = NORMALIZE_PEAK_DBFS): PcmAudio {
  let peak = 0;
  for (const s of audio.samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  if (peak === 0) return audio;
  const target = Math.pow(10, dbfs / 20);
  const gain = target / peak;
  const out = new Float32Array(audio.samples.length);
  for (let i = 0; i < audio.samples.length; i++) out[i] = audio.samples[i] * gain;
  return { samples: out, sampleRate: audio.sampleRate };
}

export interface StitchItem {
  audio: PcmAudio;
  isParagraphEnd: boolean;
}

export interface GapConfig {
  sentenceGapSec: number;
  paragraphGapSec: number;
}

export const DEFAULT_GAPS: GapConfig = {
  sentenceGapSec: SENTENCE_GAP_SEC,
  paragraphGapSec: PARAGRAPH_GAP_SEC,
};

/** Concatenate chunks in order with silence gaps between them. */
export function stitchChunks(items: StitchItem[], gaps: GapConfig = DEFAULT_GAPS): PcmAudio {
  if (items.length === 0) return { samples: new Float32Array(0), sampleRate: 24000 };
  const sampleRate = items[0].audio.sampleRate;
  const aligned = items.map((it) => ({
    ...it,
    audio: resampleLinear(it.audio, sampleRate),
  }));

  let total = 0;
  aligned.forEach((it, i) => {
    total += it.audio.samples.length;
    if (i < aligned.length - 1) {
      const gapSec = it.isParagraphEnd ? gaps.paragraphGapSec : gaps.sentenceGapSec;
      total += Math.round(gapSec * sampleRate);
    }
  });

  const out = new Float32Array(total);
  let pos = 0;
  aligned.forEach((it, i) => {
    out.set(it.audio.samples, pos);
    pos += it.audio.samples.length;
    if (i < aligned.length - 1) {
      const gapSec = it.isParagraphEnd ? gaps.paragraphGapSec : gaps.sentenceGapSec;
      pos += Math.round(gapSec * sampleRate); // silence — already zeroed
    }
  });

  return { samples: out, sampleRate };
}

// ---------------------------------------------------------------------------
// MP3
// ---------------------------------------------------------------------------

export function encodeMp3(audio: PcmAudio, kbps = 128): Blob {
  const encoder = new Mp3Encoder(1, audio.sampleRate, kbps);
  const int16 = new Int16Array(audio.samples.length);
  for (let i = 0; i < audio.samples.length; i++) {
    const s = Math.max(-1, Math.min(1, audio.samples[i]));
    int16[i] = s < 0 ? s * 32768 : s * 32767;
  }
  const parts: Uint8Array[] = [];
  const blockSize = 1152;
  for (let i = 0; i < int16.length; i += blockSize) {
    const encoded = encoder.encodeBuffer(int16.subarray(i, i + blockSize));
    if (encoded.length > 0) parts.push(new Uint8Array(encoded));
  }
  const flushed = encoder.flush();
  if (flushed.length > 0) parts.push(new Uint8Array(flushed));
  return new Blob(parts as BlobPart[], { type: "audio/mpeg" });
}

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------

export interface SrtEntry {
  text: string;
  startSec: number;
  endSec: number;
}

/** Derive caption timings from actual chunk durations + the stitch gaps. */
export function computeSrtEntries(
  chunks: Array<{ text: string; durationSec: number; isParagraphEnd: boolean }>,
  gaps: GapConfig = DEFAULT_GAPS
): SrtEntry[] {
  const entries: SrtEntry[] = [];
  let t = 0;
  chunks.forEach((c, i) => {
    entries.push({ text: c.text, startSec: t, endSec: t + c.durationSec });
    t += c.durationSec;
    if (i < chunks.length - 1) {
      t += c.isParagraphEnd ? gaps.paragraphGapSec : gaps.sentenceGapSec;
    }
  });
  return entries;
}

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rem = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rem, 3)}`;
}

export function buildSrt(entries: SrtEntry[]): string {
  return entries
    .map((e, i) => `${i + 1}\n${srtTime(e.startSec)} --> ${srtTime(e.endSec)}\n${e.text}\n`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function base64ToBlob(b64: string, mime: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export async function wavBlobToPcm(blob: Blob): Promise<PcmAudio> {
  return decodeWav(await blob.arrayBuffer());
}

/** Decode any browser-supported audio blob (mp3/m4a/webm/wav) to mono PCM. */
export async function decodeAudioBlob(blob: Blob): Promise<PcmAudio> {
  const ctx = new AudioContext();
  try {
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(buffer.length);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
    return { samples: mono, sampleRate: buffer.sampleRate };
  } finally {
    void ctx.close();
  }
}

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return "0:00";
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
