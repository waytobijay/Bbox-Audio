"use client";

import { useEffect, useRef, useState } from "react";
import {
  decodeAudioBlob,
  encodeWavPcm16,
  trimAudio,
  type PcmAudio,
} from "@/lib/audio";
import { cloneVoice } from "@/lib/backend";
import {
  SAMPLE_IDEAL_MAX_SEC,
  SAMPLE_IDEAL_MIN_SEC,
  SAMPLE_MIN_SEC,
} from "@/lib/config";
import { useApp } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { Voice } from "@/lib/types";
import { VoiceCard } from "./VoiceCard";
import { Waveform, type TrimRange } from "./Waveform";
import { Button } from "./ui/Button";
import { Input, Textarea } from "./ui/Input";

interface RecorderState {
  recording: boolean;
  elapsedSec: number;
  level: number; // 0–1 RMS for the meter
  clipped: boolean;
  noisy: boolean;
}

const INITIAL_REC: RecorderState = {
  recording: false,
  elapsedSec: 0,
  level: 0,
  clipped: false,
  noisy: false,
};

export function VoiceLab() {
  const voices = useApp((s) => s.voices);
  const addVoice = useApp((s) => s.addVoice);
  const backendUrl = useApp((s) => s.backendUrl);
  const connected = useApp((s) => s.backend.connected);

  const [rec, setRec] = useState<RecorderState>(INITIAL_REC);
  const [pcm, setPcm] = useState<PcmAudio | null>(null);
  const [trim, setTrim] = useState<TrimRange>({ start: 0, end: 0 });
  const [transcript, setTranscript] = useState("");
  const [name, setName] = useState("My voice");
  const [cloning, setCloning] = useState(false);

  const mediaRef = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    ctx: AudioContext;
    raf: number;
  } | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const clippedRef = useRef(false);
  const minRmsRef = useRef(1);
  const startedAtRef = useRef(0);

  useEffect(() => () => stopTracks(), []);

  function stopTracks() {
    const m = mediaRef.current;
    if (!m) return;
    cancelAnimationFrame(m.raf);
    if (m.recorder.state !== "inactive") m.recorder.stop();
    m.stream.getTracks().forEach((t) => t.stop());
    void m.ctx.close();
    mediaRef.current = null;
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, channelCount: 1 },
      });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);

      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      clippedRef.current = false;
      minRmsRef.current = 1;
      startedAtRef.current = performance.now();

      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        try {
          const decoded = await decodeAudioBlob(blob);
          setPcm(decoded);
          setTrim({ start: 0, end: decoded.samples.length / decoded.sampleRate });
        } catch {
          toast("Couldn't decode the recording. Try again or upload a file.", "error");
        }
      };
      recorder.start();

      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        let peak = 0;
        for (const v of buf) {
          sum += v * v;
          const a = Math.abs(v);
          if (a > peak) peak = a;
        }
        const rms = Math.sqrt(sum / buf.length);
        if (peak >= 0.98) clippedRef.current = true;
        if (rms < minRmsRef.current) minRmsRef.current = rms;
        setRec({
          recording: true,
          elapsedSec: (performance.now() - startedAtRef.current) / 1000,
          level: Math.min(1, rms * 3),
          clipped: clippedRef.current,
          noisy: minRmsRef.current > 0.02 && performance.now() - startedAtRef.current > 3000,
        });
        if (mediaRef.current) mediaRef.current.raf = requestAnimationFrame(tick);
      };

      mediaRef.current = { recorder, stream, ctx, raf: 0 };
      mediaRef.current.raf = requestAnimationFrame(tick);
      setRec({ ...INITIAL_REC, recording: true });
    } catch {
      toast("Microphone access was denied. Upload a file instead.", "error");
    }
  }

  function stopRecording() {
    stopTracks();
    setRec((r) => ({ ...r, recording: false, level: 0 }));
  }

  async function onFile(file: File) {
    try {
      const decoded = await decodeAudioBlob(file);
      setPcm(decoded);
      setTrim({ start: 0, end: decoded.samples.length / decoded.sampleRate });
      setRec(INITIAL_REC);
    } catch {
      toast(`Couldn't decode ${file.name}. Use .wav, .mp3 or .m4a.`, "error");
    }
  }

  async function onClone() {
    if (!pcm) return;
    setCloning(true);
    try {
      const trimmed = trimAudio(pcm, trim.start, trim.end);
      const wav = encodeWavPcm16(trimmed);
      const durationSec = trimmed.samples.length / trimmed.sampleRate;
      const res = await cloneVoice(backendUrl, wav, transcript.trim());
      const voice: Voice = {
        id: crypto.randomUUID(),
        remoteId: res.voice_id,
        name: name.trim() || "My voice",
        createdAt: Date.now(),
        sampleBlob: wav,
        sampleMime: "audio/wav",
        transcript: transcript.trim(),
        durationSec,
      };
      await addVoice(voice);
      setPcm(null);
      setTranscript("");
      toast(`Voice "${voice.name}" cloned and saved.`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Clone failed.", "error");
    } finally {
      setCloning(false);
    }
  }

  const trimmedSec = pcm ? trim.end - trim.start : 0;
  const canClone =
    !!pcm && !cloning && connected && transcript.trim().length > 0 && trimmedSec >= SAMPLE_MIN_SEC;

  return (
    <div className="flex flex-col gap-4">
      {/* record / upload */}
      {!pcm && !rec.recording ? (
        <div className="rounded-md border border-dashed border-rule p-4 text-center">
          <p className="mb-3 text-sm text-muted">
            Record 15 seconds in a quiet room. Read anything — a paragraph from an
            article works.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={() => void startRecording()}>
              <span aria-hidden className="text-muted">●</span> Record
            </Button>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-rule bg-panel px-3.5 py-2 text-sm hover:border-muted">
              Upload
              <input
                type="file"
                accept=".wav,.mp3,.m4a,audio/*"
                className="visually-hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted/80">
            Aim for {SAMPLE_IDEAL_MIN_SEC}–{SAMPLE_IDEAL_MAX_SEC} seconds · natural
            reading pace · no music
          </p>
        </div>
      ) : null}

      {/* live recording */}
      {rec.recording ? (
        <div className="rounded-md border border-signal/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="inline-flex items-center gap-2 text-sm text-signal">
              <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-signal signal-pulse" />
              Recording
            </span>
            <span className="font-mono text-sm tabular-nums">
              {rec.elapsedSec.toFixed(1)}s
            </span>
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-rule"
            role="meter"
            aria-label="Input level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(rec.level * 100)}
          >
            <div
              className={`h-full ${rec.clipped ? "bg-signal" : "bg-ready"}`}
              style={{ width: `${rec.level * 100}%` }}
            />
          </div>
          {rec.clipped ? (
            <p className="mt-2 text-xs text-signal">
              ⚠ Clipping — move back from the mic or lower the input gain.
            </p>
          ) : null}
          {rec.noisy && !rec.clipped ? (
            <p className="mt-2 text-xs text-muted">
              The room sounds noisy — a quieter take clones better.
            </p>
          ) : null}
          {rec.elapsedSec > SAMPLE_IDEAL_MAX_SEC + 5 ? (
            <p className="mt-2 text-xs text-muted">
              That&apos;s plenty — {SAMPLE_IDEAL_MIN_SEC}–{SAMPLE_IDEAL_MAX_SEC}s is the
              sweet spot.
            </p>
          ) : null}
          <Button className="mt-3 w-full" onClick={stopRecording}>
            Stop
          </Button>
        </div>
      ) : null}

      {/* trim + clone */}
      {pcm ? (
        <div className="flex flex-col gap-3">
          <Waveform pcm={pcm} trim={trim} onTrimChange={setTrim} />
          {rec.clipped ? (
            <p className="text-xs text-signal">
              ⚠ This take clipped. It may still work, but a cleaner take clones better.
            </p>
          ) : null}
          {trimmedSec < SAMPLE_MIN_SEC ? (
            <p className="text-xs text-muted">
              Keep at least {SAMPLE_MIN_SEC}s — shorter samples clone poorly.
            </p>
          ) : null}
          <div>
            <label htmlFor="voice-name" className="mb-1 block text-xs font-medium text-muted">
              Voice name
            </label>
            <Input
              id="voice-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
            />
          </div>
          <div>
            <label htmlFor="transcript" className="mb-1 block text-xs font-medium text-muted">
              Transcript <span className="text-signal">*</span> — type exactly what you
              said in the recording
            </label>
            <Textarea
              id="transcript"
              rows={3}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="Word for word. The clone gets noticeably worse without it."
            />
          </div>
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1" disabled={!canClone} onClick={() => void onClone()}>
              {cloning ? "Cloning…" : "Clone"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPcm(null);
                setRec(INITIAL_REC);
              }}
            >
              Discard
            </Button>
          </div>
          {!connected ? (
            <p className="text-[11px] text-muted">Connect the backend to clone.</p>
          ) : null}
        </div>
      ) : null}

      {/* saved voices */}
      {voices.length > 0 ? (
        <div>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted">
            Saved voices
          </h3>
          <div className="flex flex-col gap-2">
            {voices.map((v) => (
              <VoiceCard key={v.id} voice={v} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
