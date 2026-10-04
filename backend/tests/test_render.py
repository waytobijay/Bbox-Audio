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

    def test_clip_scene_clones_rather_than_looping_one_frame(self):
        # "loop" repeats a single frame; tpad clones the last frame to fill.
        chains = _scene_chain(self.scene("clip"), 0, 1920, 1080, 30, 5.0,
                              "classic", False, None, "/tmp")
        joined = ";".join(chains)
        assert "tpad=stop_mode=clone" in joined
        assert "zoompan" not in joined

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
