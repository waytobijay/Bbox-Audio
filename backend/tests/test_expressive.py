"""
Expressive Nepali narration: tone tags, Nepali + English code-switching,
hallucinated-tail trimming and speed.

The decisions are tested directly. The worker is tested end to end with the
models stubbed out, so CI (no torch, no GPU) still proves which model voices
which words, with which settings, and that nothing changes for a request that
did not opt in.
"""

import os
import sys
import types

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from backend.voiceforge_lang import (  # noqa: E402
    TONES,
    change_rate,
    english_for_tts,
    estimate_syllables,
    gap_after,
    max_speech_seconds,
    parse_prosody,
    split_runs,
    strip_tags,
    tone_settings,
    transliterate_latin,
    trim_speech,
    wants_expressive,
)

SR = 24000


def tone(seconds: float, amp: float = 0.5) -> np.ndarray:
    t = np.linspace(0, seconds, int(SR * seconds), endpoint=False)
    return (np.sin(2 * np.pi * 220 * t) * amp).astype(np.float32)


def quiet(seconds: float) -> np.ndarray:
    return np.zeros(int(SR * seconds), dtype=np.float32)


# --- opt-in ----------------------------------------------------------------

class TestOptIn:
    def test_nothing_set_means_plain_path(self):
        assert not wants_expressive({})
        assert not wants_expressive({"language": "ne", "speed": 1.0})

    @pytest.mark.parametrize(
        "params",
        [{"code_switch": True}, {"prosody_tags": "true"}, {"speed": 1.1}],
    )
    def test_any_flag_opts_in(self, params):
        assert wants_expressive(params)


# --- tags --------------------------------------------------------------------

class TestProsody:
    TEXT = (
        "[excited] तपाईंको laptop को IP कसैले देख्न सक्छ? "
        "[serious] Hacker ले तपाईंको account मा login गर्न सक्छ। "
        "[calm] Settings मा गएर Account option खोल्नुहोस्, "
        "[pause] Two-step verification On गर्नुहोस्।"
    )

    def test_tags_are_never_spoken(self):
        sentences, _ = parse_prosody(self.TEXT)
        for s in sentences:
            assert "[" not in s["text"] and "calm" not in s["text"]
        assert "[" not in strip_tags(self.TEXT)

    def test_each_sentence_carries_its_tone(self):
        sentences, final = parse_prosody(self.TEXT)
        assert [s["tone"] for s in sentences] == ["excited", "serious", "calm", "calm"]
        assert final == "calm"

    def test_pause_lands_before_the_key_step(self):
        sentences, _ = parse_prosody(self.TEXT)
        assert sentences[-1]["pause_before"] is True
        assert sentences[-1]["text"].startswith("Two-step")

    def test_tone_carries_across_chunks(self):
        _, final = parse_prosody("[serious] यो धेरै खतरनाक छ, ध्यान दिनुहोस्।")
        sentences, _ = parse_prosody("अब पासवर्ड तुरुन्त बदल्नुहोस् है साथी।", final)
        assert sentences[0]["tone"] == "serious"

    def test_short_sentences_merge_so_they_end_cleanly(self):
        sentences, _ = parse_prosody("ठिक छ। अब हामी सेटिङ खोलेर हेर्छौं।")
        assert len(sentences) == 1

    def test_pause_that_would_leave_a_fragment_is_dropped(self):
        sentences, _ = parse_prosody("अब [pause] सेटिङ खोल्नुहोस् र पासवर्ड बदल्नुहोस्।")
        assert len(sentences) == 1
        assert not sentences[0]["pause_before"]

    def test_tone_settings(self):
        base = {"exaggeration": 0.65, "cfg": 0.35, "temperature": 0.8}
        assert tone_settings(None, base)["exaggeration"] == 0.65
        assert tone_settings("excited", base) == TONES["excited"]
        assert tone_settings("excited", base)["exaggeration"] > tone_settings("calm", base)["exaggeration"]

    def test_questions_breathe_longer(self):
        assert gap_after("के छ?") > gap_after("ठिक छ।")


# --- code-switching ----------------------------------------------------------

class TestRuns:
    def test_english_words_go_to_english(self):
        runs = split_runs("तपाईंले password change गर्नुभयो?")
        assert [r["lang"] for r in runs] == ["ne", "en", "ne"]
        assert runs[1]["text"] == "password change"

    def test_postposition_rides_with_the_english_word(self):
        runs = split_runs("तपाईंको laptop को IP कसैले देख्न सक्छ?")
        assert [r["lang"] for r in runs] == ["ne", "en", "ne"]
        assert runs[1]["text"] == "laptop ko IP"

    def test_leading_postposition_of_a_longer_run_moves_too(self):
        runs = split_runs("Hacker ले तपाईंको account मा login गर्न सक्छ।")
        assert runs[0] == {"lang": "en", "text": "Hacker le"}
        assert runs[1] == {"lang": "ne", "text": "तपाईंको"}

    def test_danda_does_not_hide_an_english_word(self):
        runs = split_runs("Update गर्नुहोस् laptop।")
        assert runs[-1]["lang"] == "en"

    def test_acronyms_are_spelled(self):
        assert english_for_tts("IP") == "I P."
        assert english_for_tts("VPN ra PC") == "V P N ra P C."

    def test_mid_sentence_run_keeps_pitch_up(self):
        assert english_for_tts("laptop ko IP", final=False).endswith(",")
        assert english_for_tts("laptop।") == "laptop."

    def test_transliteration_fallback(self):
        out = transliterate_latin("तपाईंको laptop को IP र account")
        assert "laptop" not in out and "IP" not in out
        assert "ल्याप्टप्" in out and "आई पी" in out and "एकाउन्ट्" in out

    def test_custom_lexicon_wins(self):
        assert transliterate_latin("router", {"router": "रावटर्"}) == "रावटर्"


# --- clean endings -------------------------------------------------------------

class TestTails:
    def test_syllable_estimate_is_sane(self):
        assert estimate_syllables("IP") == 2
        assert 2 <= estimate_syllables("laptop") <= 3
        assert estimate_syllables("तपाईंको") >= 2

    def test_cap_grows_with_text(self):
        assert max_speech_seconds("ठिक छ।") < max_speech_seconds(
            "तपाईंको पासवर्ड कसैले चोरेको हुन सक्छ, त्यसैले तुरुन्त बदल्नुहोस्।"
        )

    def test_silence_is_trimmed(self):
        audio = np.concatenate([quiet(0.5), tone(1.0), quiet(0.8)])
        out = trim_speech(audio, SR)
        assert 1.0 <= len(out) / SR <= 1.3

    def test_hallucinated_tail_is_cut(self):
        # The words, a breath, then the model keeps talking ("saya...").
        audio = np.concatenate([quiet(0.2), tone(1.0), quiet(0.3), tone(0.6, 0.3), quiet(0.2)])
        out = trim_speech(audio, SR, max_seconds=1.1)
        assert len(out) / SR < 1.4

    def test_short_tail_after_a_breath_is_cut(self):
        # "...सक्छ" then 300 ms quiet then "saya": the classic tail.
        audio = np.concatenate([tone(2.0), quiet(0.3), tone(0.4, 0.3), quiet(0.3)])
        out = trim_speech(audio, SR, max_seconds=5.0, expected=2.0)
        assert len(out) / SR < 2.3

    def test_pause_mid_sentence_is_not_a_tail(self):
        # A comma pause half way through is real speech on both sides.
        audio = np.concatenate([tone(1.0), quiet(0.3), tone(1.0)])
        out = trim_speech(audio, SR, max_seconds=5.0, expected=2.0)
        assert len(out) / SR > 2.2

    def test_legit_second_word_is_kept(self):
        audio = np.concatenate([tone(0.5), quiet(0.15), tone(0.5)])
        out = trim_speech(audio, SR, max_seconds=2.0)
        assert len(out) / SR >= 1.1

    def test_speed_changes_length_not_nothing(self):
        out = change_rate(tone(2.0), SR, 1.25)
        if out is not None and len(out) != int(SR * 2.0):  # ffmpeg present
            assert abs(len(out) / SR - 1.6) < 0.1


# --- the worker, models stubbed ------------------------------------------------

@pytest.fixture()
def server(monkeypatch, tmp_path):
    """Import the server with torch/soundfile stubbed, models replaced."""
    if "torch" not in sys.modules:
        fake = types.ModuleType("torch")
        fake.cuda = types.SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None)
        fake.manual_seed = lambda *_a, **_k: None
        fake.is_tensor = lambda _x: False
        fake.float16 = "float16"
        monkeypatch.setitem(sys.modules, "torch", fake)
    if "soundfile" not in sys.modules:
        sfm = types.ModuleType("soundfile")

        def write(buf, audio, sr, format="WAV", subtype=None):  # noqa: A002
            buf.write(np.asarray(audio, dtype=np.float32).tobytes())

        sfm.write = write
        sfm.read = lambda *_a, **_k: (quiet(1.0), SR)
        monkeypatch.setitem(sys.modules, "soundfile", sfm)
    monkeypatch.setenv("VOICEFORGE_VOICES_DIR", str(tmp_path / "v"))
    monkeypatch.setenv("VOICEFORGE_JOBS_DIR", str(tmp_path / "j"))
    sys.modules.pop("backend.voiceforge_server", None)
    import backend.voiceforge_server as srv  # noqa: PLC0415

    calls = []

    def fake_generate(text, voice_id, model="chatterbox", seed=0, language="en",
                      engine="chatterbox-mtl", exaggeration=0.4, cfg=0.5, temperature=0.7):
        calls.append({"text": text, "voice": voice_id, "model": model, "language": language,
                      "engine": engine, "exaggeration": exaggeration, "cfg": cfg})
        # Honest speech for the words, a breath, then a short hallucinated
        # tail ("saya") — what chatterbox does on a bad take.
        words = max(0.4, estimate_syllables(text) * 0.19)
        return np.concatenate([tone(words), quiet(0.3), tone(0.5, 0.3), quiet(0.4)]), SR, 0.1

    monkeypatch.setattr(srv, "_generate_chunk", fake_generate)
    monkeypatch.setattr(srv, "engine_available", lambda e: e == "chatterbox-ne")
    srv.VOICES["bijay-ne"] = {"path": "x", "transcript": "", "language": "ne"}
    srv.VOICES["bijay-en"] = {"path": "y", "transcript": "", "language": "en"}
    srv._test_calls = calls
    return srv


def run(srv, text, params, refs=None, mode="stitch"):
    job = {
        "job_id": "t1",
        "voice_id": "bijay-ne",
        "engine": "chatterbox-ne",
        "chunks": [text],
        "params": {"language": "ne", "exaggeration": 0.65, "cfg": 0.35, "temperature": 0.8, **params},
        "format": "wav",
        "mode": mode,
    }
    if refs:
        job["voice_refs"] = refs
    srv.JOBS["t1"] = {"status": "running"}
    srv._run_job(job)
    return srv.JOBS["t1"]


class TestWorker:
    TEXT = "[excited] तपाईंको laptop को IP कसैले देख्न सक्छ? [calm] अब सेटिङ खोलेर पासवर्ड तुरुन्त बदल्नुहोस्।"

    def test_plain_request_is_unchanged(self, server):
        result = run(server, "तपाईंको पासवर्ड कसैले चोरेको हुन सक्छ।", {})
        assert result["status"] == "done", result.get("error")
        assert "params_used" not in result
        assert all(c["engine"] == "chatterbox-ne" for c in server._test_calls)

    def test_english_words_use_english_model_and_english_voice(self, server):
        result = run(server, self.TEXT, {"code_switch": True, "prosody_tags": True},
                     refs={"en": {"voice_id": "bijay-en"}})
        assert result["status"] == "done", result.get("error")
        en = [c for c in server._test_calls if c["language"] == "en"]
        ne = [c for c in server._test_calls if c["language"] != "en"]
        assert en and ne
        assert all(c["voice"] == "bijay-en" and c["engine"] == "chatterbox-mtl" for c in en)
        assert all(c["voice"] == "bijay-ne" and c["engine"] == "chatterbox-ne" for c in ne)
        assert any("laptop ko I P" in c["text"] for c in en)
        assert result["params_used"]["en_voice"] == "bijay-en"

    def test_tones_reach_the_model(self, server):
        run(server, self.TEXT, {"prosody_tags": True})
        exag = {round(c["exaggeration"], 2) for c in server._test_calls}
        assert TONES["excited"]["exaggeration"] in exag
        assert TONES["calm"]["exaggeration"] in exag

    def test_tags_never_reach_the_model(self, server):
        run(server, self.TEXT, {"speed": 1.1})  # opted in, tags off: stripped
        assert not any("[" in c["text"] for c in server._test_calls)
        server._test_calls.clear()
        run(server, self.TEXT, {})  # plain path: stripped too
        assert not any("[" in c["text"] or "excited" in c["text"] for c in server._test_calls)

    def test_tails_are_trimmed_in_the_output(self, server):
        text = "तपाईंको पासवर्ड कसैले चोरेको हुन सक्छ।"
        result = run(server, text, {"prosody_tags": True})
        words = estimate_syllables(text) * 0.19
        # The stub adds a breath + 0.5 s "saya" + silence to every take.
        assert result["duration"] < words + 0.3

    def test_items_mode_keeps_one_file_per_line(self, server):
        job = {
            "job_id": "t1", "voice_id": "bijay-ne", "engine": "chatterbox-ne",
            "chunks": ["[excited] पहिलो लाइन यहाँ छ है साथी।", "[calm] दोस्रो लाइन पनि यहीँ छ।"],
            "params": {"language": "ne", "prosody_tags": True},
            "format": "wav", "mode": "items",
        }
        server.JOBS["t1"] = {"status": "running"}
        server._run_job(job)
        assert len(server.JOBS["t1"]["items"]) == 2

    def test_segments_report_what_ran(self, server):
        result = run(server, self.TEXT, {"code_switch": True, "prosody_tags": True})
        segs = result["segments"]
        assert segs[0]["tone"] == "excited"
        langs = [r["lang"] for r in segs[0]["runs"]]
        assert "en" in langs and "ne" in langs
        assert segs[-1]["end"] <= result["duration"] + 0.05

    def test_failure_falls_back_to_plain_render(self, server, monkeypatch):
        def boom(*_a, **_k):
            raise RuntimeError("splice exploded")

        monkeypatch.setattr(server, "_render_expressive", boom)
        result = run(server, self.TEXT, {"code_switch": True})
        assert result["status"] == "done"
        assert "splice exploded" in result["params_used"]["error"]
