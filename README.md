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

## Optional — Talking-head video (one photo → lip-synced MP4)

The **Video** tab turns a single portrait photo plus your generated narration into a lip-synced video. It runs on a **second, separate Colab backend** — the video models (SadTalker, Wav2Lip) need an older torch/numpy stack that conflicts with Chatterbox, so they can't share the TTS session. Run it *after* your speech is done, so the one free GPU is reused rather than needed twice at once.

### Step A — start the video backend

1. Open a new Colab session and upload `colab/voiceforge_video.ipynb`.
2. Runtime → **T4 GPU** → **Run all**. Cell 1 installs both engines (~8–12 min the first time — it downloads model checkpoints).
3. Cell 3 prints a `trycloudflare.com` URL, plus which engines loaded.

### Step B — render

1. In the app, switch to the **Video** tab and paste that URL into **Video backend** → Connect.
2. Upload one clear, front-facing face photo (JPG/PNG).
3. Pick an engine:
   - **SadTalker** — lip sync + eye blinking + head movement + expressions. Best for short clips (intros, hooks). Renders far slower than real time — impractical past ~1–2 min on a free T4.
   - **Wav2Lip** — accurate mouth-only lip sync on a static photo. Fast enough for your full narration, but no blinking/head motion.
4. Choose the voice: your generated narration (default) or an uploaded audio file.
5. **Generate.** Progress and elapsed time show while it renders; the finished MP4 plays inline and downloads. It's saved in your browser, so it survives a reload.

Nothing here touches the TTS flow — the Studio tab works exactly as before whether or not you ever use video.

---

## Troubleshooting

| What you see | What's wrong | Fix |
|---|---|---|
| `ValueError`/`ModuleNotFoundError` in Cell 2 importing `chatterbox`, or dozens of red `pip` "X requires Y" lines in Cell 1 | Colab/Kaggle's huge preinstalled package set drags numpy/transformers/safetensors to newer versions than chatterbox-tts declares ([known chatterbox issue](https://huggingface.co/ResembleAI/chatterbox/discussions/19)); a copy of numpy can also already be loaded in memory before Cell 1 ever runs, which a plain reinstall can't fix | Cell 1 force-pins the exact versions chatterbox-tts needs (`numpy==1.26.4`, `transformers==5.2.0`, `safetensors==0.5.3`). Always **Run All → restart when Cell 1 tells you to → Run All again from the top.** Never run cells individually or skip Cell 1 — that sequence is always correct on both platforms. The other red "requires numpy>=2" lines (jax, opencv, rasterio, etc.) are unrelated packages the backend never imports — ignore them. |
| **Connect** does nothing | Colab tab closed, or the URL expired | Re-run Cell 3, paste the new URL |
| `No GPU` error in Cell 2 | Runtime is on CPU — on Kaggle this often happens right *after* the restart the numpy fix requires, since Kaggle can silently detach the accelerator on restart | Colab: Runtime → Change runtime type → T4 GPU → **Run all again**. Kaggle: re-check the **Accelerator** setting in the session sidebar (it may have reset to **None**), set it back to GPU T4 x2/P100, confirm **Internet** is still On, then **Run all again**. |
| Voice doesn't sound like you | Sample too short, noisy, or transcript missing/wrong | Re-record 20 clean seconds. Type the transcript exactly. |
| Words are slurred or rushed | Chunk too long, or unusual words | Break the sentence up. Spell tricky words phonetically in the script. |
| Random pause or wrong pronunciation | Model drift on that chunk | ↻ Regenerate. If it recurs, ✎ edit the wording. |
| Generation stops partway | Colab hit its session limit | Re-run Cell 3, reconnect, **Generate remaining**. Your finished chunks are safe. |
| Chunks are getting slower | Colab throttling a long free session | Fine. Let it finish, or restart the runtime and resume. |
| Video tab: "not loaded" on an engine | That engine's checkpoints didn't download in the video notebook's Cell 1 | Re-run Cell 1 and watch for download errors; Cell 2 prints which engines are ready. The other engine still works. |
| Video render fails or times out | SadTalker on a long clip exceeds the free session, or a bad/multi-face photo | Use a single clear front-facing photo. For anything past ~1–2 min, switch to Wav2Lip. |

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
