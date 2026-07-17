# VoiceForge

Clone your voice, generate hours of narration, pay nothing.

The web app runs on Vercel. The AI models run on Google Colab's free GPU. You connect the two with a URL. No subscription, no API key, no credit card.

---

## One-time setup (≈10 minutes)

### Step 1 — Deploy the web app

1. Fork this repo on GitHub.
2. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import your fork.
3. Framework preset: **Next.js**. Leave everything else default.
4. Click **Deploy**. No environment variables needed.
5. You get a URL like `voiceforge-yourname.vercel.app`. Bookmark it.

That's the app. It doesn't do anything yet — it has no engine. Next step gives it one.

---

## Every session (≈4 minutes)

### Step 2 — Start the GPU backend

1. Open [colab.research.google.com](https://colab.research.google.com).
2. **File → Upload notebook** → choose `colab/voiceforge_server.ipynb` from this repo.
3. **Runtime → Change runtime type → T4 GPU** → Save. *(This is free. If you skip it, nothing works.)*
4. **Runtime → Run all.**
5. Wait. Cell 1 installs (~2 min). Cell 2 loads the models (~2–4 min).
6. Cell 3 prints a URL in a box:

```
============================================================
  BACKEND URL — paste this into VoiceForge:
  https://random-words-here.trycloudflare.com
============================================================
```

7. **Copy that URL.**

**Leave the Colab tab open.** Close it and your backend dies. The URL is new every session — that's normal.

### Step 3 — Connect

1. Open your Vercel app.
2. Paste the URL into the field at the top. Hit **Connect**.
3. The pill turns green: **Live**. It shows your GPU (usually `Tesla T4`).

You now have a working voice studio.

---

## Making narration

### Step 4 — Clone your voice (once)

1. **Record** — 15–20 seconds. Quiet room, phone or laptop mic is fine, no music, natural pace. Read a paragraph from any article.
2. **Type the transcript** — exactly what you said, word for word. This matters more than you'd think; the clone gets noticeably worse without it.
3. **Trim** the silence off the front and back with the waveform handles.
4. **Clone.** Takes a few seconds. The voice is saved in your browser and reused forever.

**What makes a good sample:** consistent volume, no background hum, no room echo, and you speaking the way you want the narration to sound. If you read your sample flat, the narration will be flat.

### Step 5 — Add your script

Paste it, or drop a `.txt` file.

The panel immediately shows how it'll be split. Check it. Look for:
- Numbers and abbreviations — turn on **Show normalized** to see how they'll be pronounced. `15GB` should read as "fifteen gigabytes." Fix anything that looks wrong by spelling it out in your script.
- Chunk breaks landing mid-thought — put `---` on its own line to force a break where you want one.
- Blank lines between paragraphs → longer pauses. Use them for pacing.

A 20-minute video is roughly 2,800–3,000 words, which becomes 45–55 chunks.

### Step 6 — Test before you commit

Generate a single chunk first and listen before committing to a full run. (The default backend runs Chatterbox only — Qwen3-TTS's dependencies conflict with Chatterbox's and the two can't share one Colab environment. The **A/B compare** button enables itself automatically if a backend ever reports both models.)

Then nudge **Expressiveness**: 0.4 is right for factual narration. Push it to 0.7+ only if you want drama.

Twenty seconds of testing here saves you regenerating twenty minutes of audio.

### Step 7 — Generate

Hit **Generate all**. Then leave it alone.

The queue runs one chunk at a time. Each bar fills green as it lands. A 20-minute script takes roughly 8–15 minutes on a T4.

Every finished chunk is saved to your browser immediately. If Colab disconnects, if your laptop sleeps, if you close the tab — **nothing is lost**. Restart the Colab cell, reconnect, hit **Generate remaining**, and it picks up exactly where it stopped.

### Step 8 — Fix and export

Scan the queue. Play anything that looks suspicious.

Bad chunk? Two options:
- **↻ Regenerate** — same text, new seed. Usually fixes it.
- **✎ Edit** — reword the awkward sentence, then regenerate. This fixes it properly.

When you're happy: **Export WAV** (best quality, drop into your video editor) or **MP3** (smaller). You also get:
- `chunks.zip` — every chunk as its own file, if you want to edit around them
- `transcript.srt` — captions with real timings, free

---

## Troubleshooting

| What you see | What's wrong | Fix |
|---|---|---|
| `ValueError: numpy.dtype size changed... Expected 96... got 88` in Cell 2 | chatterbox-tts's compiled dependencies (transformers) don't match the base image's numpy ABI ([known chatterbox issue](https://huggingface.co/ResembleAI/chatterbox/discussions/19)) | Fixed in Cell 1, which now force-reinstalls a matching numpy automatically. Just run Cell 1 then Cell 2 in the same pass — no restart needed. |
| `ModuleNotFoundError: No module named 'chatterbox'` in Cell 2 | Cell 1 was skipped, or the runtime/session was restarted (which can wipe installed packages, especially on Kaggle) and Cell 1 wasn't re-run afterward | Run Cell 1, then Cell 2, in the current session. Never skip Cell 1 after any restart. |
| **Connect** does nothing | Colab tab closed, or the URL expired | Re-run Cell 3, paste the new URL |
| `No GPU` error in Cell 2 | Runtime is on CPU | Runtime → Change runtime type → T4 GPU → **Run all again** |
| Voice doesn't sound like you | Sample too short, noisy, or transcript missing/wrong | Re-record 20 clean seconds. Type the transcript exactly. |
| Words are slurred or rushed | Chunk too long, or unusual words | Break the sentence up. Spell tricky words phonetically in the script. |
| Random pause or wrong pronunciation | Model drift on that chunk | ↻ Regenerate. If it recurs, ✎ edit the wording. |
| Generation stops partway | Colab hit its session limit | Re-run Cell 3, reconnect, **Generate remaining**. Your finished chunks are safe. |
| Chunks are getting slower | Colab throttling a long free session | Fine. Let it finish, or restart the runtime and resume. |

---

## The honest limits

- **Colab free tier gives you a few hours per session**, and there's a rough daily cap. More than enough for a video or two a day. Not enough to run a service on.
- **The backend URL changes every session.** By design — it's a fresh tunnel each time.
- **The Colab tab must stay open** while you generate.
- **Your voice sample never leaves your control.** It goes from your browser to *your* Colab session. Not to Anthropic, not to Vercel, not to any TTS company.
- **Languages:** the backend runs Chatterbox Multilingual — 23 languages including English and Hindi (pick one in Model controls). **Nepali is not supported by the model yet**; Hindi is the closest option. Number expansion ("15GB" → "fifteen gigabytes") only applies to English scripts; other languages keep digits for the model to read in-language.

---

## Local development

```bash
npm install
npm run dev    # http://localhost:3000
npm test       # chunker + normalization unit tests
```

The app is a thin client — everything except the TTS models runs in your browser. Voice profiles, scripts, and generated audio live in IndexedDB. See `.claude_context.md` for architecture constraints.

---

## Ethics

Clone your own voice. Or clone a voice you have explicit permission to clone. That's the whole rule, and it isn't a formality — in most jurisdictions, synthesizing someone's voice without consent is now illegal, and it's a genuinely harmful thing to do regardless.
