"""
Tests for the pure parts of the renderer.

There is no Python on the machine this project is developed from, so every
backend bug has historically been found by the user on a live Colab session,
minutes into a run. These tests exist so CI catches them first — they need no
GPU, no ffmpeg and no network.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from backend.voiceforge_render import (  # noqa: E402
    DEFAULT_BATCH,
    _extension_of,
    _motion,
    _scene_chain,
    _wrap,
)


class TestExtensionOf:
    def test_keeps_a_real_extension(self):
        assert _extension_of("https://blob.test/voices/me.wav") == ".wav"
        assert _extension_of("https://cdn/img/scene-1.PNG") == ".png"

    def test_ignores_a_query_string(self):
        assert _extension_of("https://blob.test/a.mp3?token=abc&x=1") == ".mp3"

    def test_returns_empty_when_there_is_none(self):
        # Better an extensionless file than a bogus suffix ffprobe has to
        # argue with.
        assert _extension_of("https://example.com/download") == ""

    def test_rejects_an_absurd_suffix(self):
        assert _extension_of("https://example.com/file.somethinglong") == ""


class TestWrap:
    def test_breaks_on_width(self):
        lines = _wrap("the quick brown fox jumps over the lazy dog", width=15)
        assert all(len(line) <= 15 for line in lines)

    def test_caps_the_line_count(self):
        # A caption that overflows the frame is worse than one that is cut.
        assert len(_wrap("word " * 200, width=10, max_lines=2)) == 2

    def test_collapses_whitespace(self):
        assert _wrap("  hello   world  ", width=40) == ["hello world"]

    def test_handles_empty_text(self):
        assert _wrap("") == []


class TestMotion:
    def test_none_is_perfectly_still(self):
        z, _, _ = _motion("none", 0, 100)
        assert z == "1"

    def test_classic_drifts_slowly(self):
        # Long-form uses a gentler push than a Short; a 20-minute video of
        # aggressive zooms is exhausting.
        z, _, _ = _motion("classic", 0, 300)
        assert "1.10" in z

    def test_dynamic_varies_by_scene(self):
        styles = {_motion("dynamic", i, 300)[0] for i in range(4)}
        assert len(styles) >= 3

    def test_dynamic_cycles_every_four_scenes(self):
        assert _motion("dynamic", 0, 300) == _motion("dynamic", 4, 300)

    def test_expressions_reference_the_frame_count(self):
        z, _, _ = _motion("dynamic", 0, 250)
        assert "250" in z


class TestSceneChain:
    @staticmethod
    def scene(kind="image", caption="", index=0):
        return {
            "index": index,
            "type": kind,
            "visual": f"/tmp/src{index}",
            "audio": None,
            "seconds": 5.0,
            "caption": caption,
        }

    def test_image_scene_uses_zoompan(self):
        chains = _scene_chain(self.scene(), 0, 1920, 1080, 30, 5.0,
                              "classic", False, None, "/tmp")
        assert any("zoompan" in c for c in chains)

    def test_clip_scene_is_trimmed_not_zoomed(self):
        # A clip plays as filmed: no zoompan, and no tpad freeze — the input
        # loops instead when the narration outlasts it (see TestClipHandling).
        chains = _scene_chain(self.scene("clip"), 0, 1920, 1080, 30, 5.0,
                              "classic", False, None, "/tmp")
        joined = ";".join(chains)
        assert "trim=duration=5.000" in joined
        assert "zoompan" not in joined
        assert "tpad" not in joined

    def test_output_label_matches_the_slot(self):
        chains = _scene_chain(self.scene(), 3, 1920, 1080, 30, 5.0,
                              "classic", False, None, "/tmp")
        assert chains[-1].endswith("[v3]")

    def test_caption_is_only_drawn_when_enabled(self):
        off = ";".join(_scene_chain(self.scene(caption="Hello"), 0, 1920, 1080, 30, 5.0,
                                    "classic", False, None, "/tmp"))
        on = ";".join(_scene_chain(self.scene(caption="Hello"), 0, 1920, 1080, 30, 5.0,
                                   "classic", True, None, "/tmp"))
        assert "drawtext" not in off
        assert "drawtext" in on

    def test_empty_caption_draws_nothing_even_when_enabled(self):
        chains = _scene_chain(self.scene(caption=""), 0, 1920, 1080, 30, 5.0,
                              "classic", True, None, "/tmp")
        assert "drawtext" not in ";".join(chains)

    def test_banner_is_overlaid_from_its_own_slot(self):
        chains = _scene_chain(self.scene(), 0, 1920, 1080, 30, 5.0,
                              "classic", False, 7, "/tmp")
        joined = ";".join(chains)
        assert "[7:v]" in joined
        assert "overlay=" in joined

    def test_every_chain_ends_pixel_format_normalised(self):
        # Batches are joined with the concat demuxer, which demands identical
        # streams; a stray pixel format breaks the join, not the render.
        chains = _scene_chain(self.scene(), 0, 1920, 1080, 30, 5.0,
                              "classic", True, 2, "/tmp")
        assert "format=yuv420p" in chains[-1]


class TestBatching:
    def test_default_batch_is_small_enough_to_stay_sane(self):
        # The whole point of batching is that the filter graph never grows
        # with the length of the video.
        assert 2 <= DEFAULT_BATCH <= 16

    def test_scenes_split_evenly(self):
        scenes = list(range(100))
        batches = [scenes[i:i + DEFAULT_BATCH] for i in range(0, len(scenes), DEFAULT_BATCH)]
        assert sum(len(b) for b in batches) == 100
        assert all(len(b) <= DEFAULT_BATCH for b in batches)


class TestBookendCaptions:
    """An intro card already carries its own title; a caption drawn over it
    reads as a mistake. The flag must win even when captions are on."""

    @staticmethod
    def scene(**patch):
        base = {
            "index": 0,
            "type": "image",
            "visual": "/tmp/src0",
            "audio": None,
            "seconds": 4.0,
            "caption": "Welcome",
        }
        base.update(patch)
        return base

    def test_no_caption_flag_suppresses_drawtext(self):
        chains = _scene_chain(self.scene(no_caption=True), 0, 1920, 1080, 30, 4.0,
                              "classic", True, None, "/tmp")
        assert "drawtext" not in ";".join(chains)

    def test_an_ordinary_scene_still_draws_one(self):
        chains = _scene_chain(self.scene(), 0, 1920, 1080, 30, 4.0,
                              "classic", True, None, "/tmp")
        assert "drawtext" in ";".join(chains)

    def test_the_flag_does_not_disturb_the_rest_of_the_chain(self):
        chains = _scene_chain(self.scene(no_caption=True), 2, 1920, 1080, 30, 4.0,
                              "classic", True, None, "/tmp")
        assert chains[-1].endswith("[v2]")
        assert "format=yuv420p" in chains[-1]


class TestPreparePrefix:
    """The intro, the outro and scene 0 each used to download to src0, so the
    last one written won and the outro appeared at the start. Separate
    prefixes are what keep them apart."""

    def test_signature_takes_a_prefix(self):
        import inspect

        from backend.voiceforge_render import _prepare

        assert "prefix" in inspect.signature(_prepare).parameters

    def test_prefixes_produce_distinct_paths(self):
        import inspect

        from backend.voiceforge_render import _prepare

        src = inspect.getsource(_prepare)
        # The filename must be built from the prefix, not from the index alone.
        assert "{prefix}-src" in src
        assert "{prefix}-aud" in src


class TestPerSceneMotion:
    @staticmethod
    def scene(**patch):
        base = {
            "index": 0,
            "type": "image",
            "visual": "/tmp/src0",
            "audio": None,
            "seconds": 5.0,
            "caption": "",
        }
        base.update(patch)
        return base

    def test_scene_motion_overrides_the_video_default(self):
        # Video-wide "dynamic", this scene "none" -> no zoompan at all.
        chains = _scene_chain(self.scene(motion="none"), 0, 1920, 1080, 30, 5.0,
                              "dynamic", False, None, "/tmp")
        assert "zoompan" not in ";".join(chains)

    def test_none_keeps_a_still_pixel_exact(self):
        # No 1.25x oversample, so frames are not resampled between each other.
        joined = ";".join(_scene_chain(self.scene(motion="none"), 0, 1920, 1080, 30, 5.0,
                                       "classic", False, None, "/tmp"))
        assert "scale=1920:1080" in joined
        assert "2400" not in joined  # 1920 * 1.25
        assert "loop=loop=-1:size=1" in joined

    def test_zoom_in_is_a_centred_push(self):
        joined = ";".join(_scene_chain(self.scene(motion="zoom_in"), 0, 1920, 1080, 30, 5.0,
                                       "none", False, None, "/tmp"))
        assert "zoompan" in joined
        assert "1+0.08*on/" in joined

    def test_falls_back_to_the_video_default_when_omitted(self):
        joined = ";".join(_scene_chain(self.scene(), 0, 1920, 1080, 30, 5.0,
                                       "zoom_in", False, None, "/tmp"))
        assert "1+0.08*on/" in joined

    def test_motion_does_not_apply_to_a_clip(self):
        joined = ";".join(_scene_chain(self.scene(type="clip", motion="zoom_in"),
                                       0, 1920, 1080, 30, 5.0, "classic", False, None, "/tmp"))
        assert "zoompan" not in joined


class TestClipHandling:
    @staticmethod
    def clip(**patch):
        base = {
            "index": 0,
            "type": "clip",
            "visual": "/tmp/src0.mp4",
            "audio": None,
            "seconds": 12.0,
            "caption": "",
        }
        base.update(patch)
        return base

    def test_scales_to_cover_then_centre_crops(self):
        joined = ";".join(_scene_chain(self.clip(), 0, 1920, 1080, 30, 12.0,
                                       "classic", False, None, "/tmp"))
        assert "force_original_aspect_ratio=increase" in joined
        assert "crop=1920:1080" in joined

    def test_no_longer_freezes_the_last_frame(self):
        # tpad=clone held the final frame when narration outlasted the clip;
        # the input now loops instead.
        joined = ";".join(_scene_chain(self.clip(), 0, 1920, 1080, 30, 12.0,
                                       "classic", False, None, "/tmp"))
        assert "tpad" not in joined

    def test_trims_to_the_narration_length(self):
        joined = ";".join(_scene_chain(self.clip(), 0, 1920, 1080, 30, 12.0,
                                       "classic", False, None, "/tmp"))
        assert "trim=duration=12.000" in joined

    def test_clips_are_looped_at_the_input(self):
        import inspect

        from backend.voiceforge_render import _render_batch

        src = inspect.getsource(_render_batch)
        assert "-stream_loop" in src
