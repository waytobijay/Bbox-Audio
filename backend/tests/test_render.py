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


# ---------------------------------------------------------------------------
# Framed scenes: a branded 1920x1080 PNG with a window cut out of it, and the
# picture moving inside that window only.
# ---------------------------------------------------------------------------

from backend.voiceforge_render import (  # noqa: E402
    _clip_plan,
    _frame_of,
    _timeline,
)

FRAME = {"overlay_url": "https://cdn.test/frame.png",
         "rect": {"x": 160, "y": 150, "w": 1600, "h": 760}}


def framed_scene(**patch):
    base = {
        "index": 0,
        "type": "image",
        "visual": "/tmp/src0",
        "audio": None,
        "seconds": 5.0,
        "caption": "",
        "frame": {"overlay_url": FRAME["overlay_url"],
                  "x": 160, "y": 150, "w": 1600, "h": 760,
                  "overlay": "/tmp/overlay0.png"},
    }
    base.update(patch)
    return base


class TestFrameValidation:
    def test_absent_frame_is_simply_none(self):
        assert _frame_of({}, 1920, 1080) is None

    def test_a_good_rect_passes_through(self):
        got = _frame_of({"frame": FRAME}, 1920, 1080)
        assert got == {"overlay_url": "https://cdn.test/frame.png",
                       "x": 160, "y": 150, "w": 1600, "h": 760}

    def test_zero_sized_window_is_rejected(self):
        for bad in ({"x": 0, "y": 0, "w": 0, "h": 100},
                    {"x": 0, "y": 0, "w": 100, "h": -5}):
            try:
                _frame_of({"frame": {"overlay_url": "u", "rect": bad}}, 1920, 1080)
            except ValueError as e:
                assert "positive" in str(e)
            else:
                raise AssertionError("accepted " + str(bad))

    def test_a_window_hanging_off_the_canvas_is_rejected(self):
        try:
            _frame_of({"frame": {"overlay_url": "u",
                                 "rect": {"x": 1000, "y": 0, "w": 1600, "h": 760}}},
                      1920, 1080)
        except ValueError as e:
            assert "does not fit" in str(e)
        else:
            raise AssertionError("accepted a rect wider than the canvas")

    def test_the_overlay_url_is_required(self):
        try:
            _frame_of({"frame": {"rect": {"x": 0, "y": 0, "w": 10, "h": 10}}},
                      1920, 1080)
        except ValueError as e:
            assert "overlay_url" in str(e)
        else:
            raise AssertionError("accepted a frame with no overlay")


class TestFramedSceneChain:
    def test_the_picture_moves_but_the_frame_does_not(self):
        chains = _scene_chain(framed_scene(), 0, 1920, 1080, 30, 5.0,
                              "classic", False, None, "/tmp", 4)
        joined = ";".join(chains)
        # The pan renders at the window's size, not the canvas's...
        assert "s=1600x760" in joined
        # ...is dropped at the window's corner...
        assert "overlay=160:150" in joined
        # ...and the frame PNG goes over the whole canvas, unmoving.
        assert "[4:v]scale=1920:1080" in joined
        assert "overlay=0:0" in joined

    def test_the_canvas_is_the_full_video_size(self):
        joined = ";".join(_scene_chain(framed_scene(), 0, 1920, 1080, 30, 5.0,
                                       "classic", False, None, "/tmp", 4))
        assert "color=c=black:s=1920x1080" in joined

    def test_a_framed_clip_is_cropped_to_the_window(self):
        scene = framed_scene(type="clip", source_seconds=30.0)
        joined = ";".join(_scene_chain(scene, 0, 1920, 1080, 30, 5.0,
                                       "classic", False, None, "/tmp", 4))
        assert "crop=1600:760" in joined
        assert "zoompan" not in joined
        assert "overlay=160:150" in joined

    def test_an_unframed_scene_is_untouched(self):
        # The whole promise of the feature: no frame, no change.
        before = _scene_chain(
            {"index": 0, "type": "image", "visual": "/tmp/a", "audio": None,
             "seconds": 5.0, "caption": ""},
            0, 1920, 1080, 30, 5.0, "classic", False, None, "/tmp")
        joined = ";".join(before)
        assert "color=c=black" not in joined
        assert "s=1920x1080" in joined

    def test_the_chain_still_ends_normalised(self):
        chains = _scene_chain(framed_scene(caption="Hi"), 1, 1920, 1080, 30, 5.0,
                              "classic", True, 9, "/tmp", 4)
        assert chains[-1].endswith("[v1]")
        assert "format=yuv420p" in chains[-1]

    def test_captions_are_drawn_over_the_frame_not_under_it(self):
        chains = _scene_chain(framed_scene(caption="Hello"), 0, 1920, 1080, 30, 5.0,
                              "classic", True, None, "/tmp", 4)
        joined = ";".join(chains)
        assert joined.index("overlay=0:0") < joined.index("drawtext")


class TestNoOverlaysAtAll:
    """captions:false + banner:false must leave the picture completely bare."""

    def test_nothing_is_drawn_or_overlaid(self):
        scene = {"index": 0, "type": "image", "visual": "/tmp/a", "audio": None,
                 "seconds": 5.0, "caption": "Some caption text"}
        joined = ";".join(_scene_chain(scene, 0, 1920, 1080, 30, 5.0,
                                       "classic", False, None, "/tmp"))
        assert "drawtext" not in joined
        assert "overlay" not in joined


class TestStaticSlidesLineUp:
    """Two consecutive "none" scenes must produce identical geometry, or a
    bullet list that reveals a line per slide visibly jitters."""

    @staticmethod
    def still(index):
        return {"index": index, "type": "image", "visual": "/tmp/s",
                "audio": None, "seconds": 4.0, "caption": "", "motion": "none"}

    def test_the_two_chains_differ_only_by_their_slot(self):
        a = ";".join(_scene_chain(self.still(0), 0, 1920, 1080, 30, 4.0,
                                  "classic", False, None, "/tmp"))
        b = ";".join(_scene_chain(self.still(1), 1, 1920, 1080, 30, 4.0,
                                  "classic", False, None, "/tmp"))
        assert a.replace("[v0", "[vN").replace("[0:v]", "[N:v]") == \
            b.replace("[v1", "[vN").replace("[1:v]", "[N:v]")

    def test_neither_is_resampled_by_a_zoom(self):
        for i in (0, 1):
            joined = ";".join(_scene_chain(self.still(i), i, 1920, 1080, 30, 4.0,
                                           "classic", False, None, "/tmp"))
            assert "zoompan" not in joined

    def test_a_per_scene_none_beats_a_moving_default(self):
        joined = ";".join(_scene_chain(self.still(0), 0, 1920, 1080, 30, 4.0,
                                       "dynamic", False, None, "/tmp"))
        assert "zoompan" not in joined


class TestClipPlan:
    @staticmethod
    def clip(src):
        return {"type": "clip", "source_seconds": src}

    def test_a_long_enough_clip_is_just_trimmed(self):
        assert _clip_plan(self.clip(30.0), 5.0) == ("trim", 1.0)

    def test_a_slightly_short_clip_is_stretched(self):
        plan, factor = _clip_plan(self.clip(10.0), 12.0)
        assert plan == "slow"
        assert abs(factor - 1.2) < 1e-9

    def test_the_stretch_never_goes_below_point_eight_speed(self):
        # 1/1.25 = 0.8x. Anything slower reads as broken playback.
        plan, factor = _clip_plan(self.clip(10.0), 12.5)
        assert plan == "slow" and factor <= 1.25

    def test_a_much_shorter_clip_loops_instead(self):
        assert _clip_plan(self.clip(4.0), 30.0) == ("loop", 1.0)

    def test_an_image_is_never_slowed_or_looped(self):
        assert _clip_plan({"type": "image", "source_seconds": 0.0}, 30.0) == ("trim", 1.0)

    def test_an_unprobeable_clip_falls_back_to_trimming(self):
        # Better a trim than a divide by something near zero.
        assert _clip_plan(self.clip(0.0), 30.0) == ("trim", 1.0)

    def test_a_stretched_clip_never_freezes_and_carries_no_audio(self):
        scene = {"index": 0, "type": "clip", "visual": "/tmp/c", "audio": None,
                 "seconds": 12.0, "caption": "", "source_seconds": 10.0}
        joined = ";".join(_scene_chain(scene, 0, 1920, 1080, 30, 12.0,
                                       "classic", False, None, "/tmp"))
        assert "setpts=PTS*1.20000" in joined
        assert "tpad" not in joined
        # The clip's own audio is never referenced; only [n:v] is.
        assert "[0:a]" not in joined


class TestTimeline:
    @staticmethod
    def scenes(*lengths):
        return [{"index": i, "seconds": s} for i, s in enumerate(lengths)]

    def test_scenes_run_back_to_back(self):
        assert _timeline(self.scenes(5.0, 7.0, 3.0)) == [
            {"index": 0, "kind": "scene", "start": 0.0, "end": 5.0},
            {"index": 1, "kind": "scene", "start": 5.0, "end": 12.0},
            {"index": 2, "kind": "scene", "start": 12.0, "end": 15.0},
        ]

    def test_it_sums_to_the_length_of_the_film(self):
        # Crossfades borrow a tail from each scene and give it straight back,
        # so the total is simply the sum — the property n8n needs for chapters.
        lengths = [4.3, 9.1, 2.75, 11.0, 6.4]
        line = _timeline(self.scenes(*lengths))
        assert abs(line[-1]["end"] - sum(lengths)) < 0.1

    def test_it_is_empty_for_no_scenes_rather_than_failing(self):
        assert _timeline([]) == []

    def test_every_entry_keeps_its_own_index(self):
        line = _timeline([{"index": 7, "seconds": 2.0}, {"index": 8, "seconds": 3.0}])
        assert [e["index"] for e in line] == [7, 8]

    def test_bookends_are_labelled_so_scenes_can_be_picked_out(self):
        # A caller matching chapter titles to the scenes it sent must be able
        # to drop the bookends. Counting entries cannot do it: one intro and
        # one outro both make the list exactly one longer.
        line = _timeline([
            {"index": 0, "seconds": 4.0, "role": "intro"},
            {"index": 1, "seconds": 6.0},
            {"index": 2, "seconds": 5.0},
            {"index": 3, "seconds": 4.0, "role": "outro"},
        ])
        assert [e["kind"] for e in line] == ["intro", "scene", "scene", "outro"]

    def test_filtering_to_scenes_lines_up_with_what_was_sent(self):
        line = _timeline([
            {"index": 0, "seconds": 4.0, "role": "intro"},
            {"index": 1, "seconds": 6.0},
            {"index": 2, "seconds": 5.0},
            {"index": 3, "seconds": 4.0, "role": "outro"},
        ])
        only = [e for e in line if e["kind"] == "scene"]
        assert len(only) == 2
        # The intro still pushes the first scene later in the finished film.
        assert only[0]["start"] == 4.0
        assert only[1]["start"] == 10.0

    def test_an_intro_alone_still_shifts_every_scene(self):
        line = _timeline([
            {"index": 0, "seconds": 3.0, "role": "intro"},
            {"index": 1, "seconds": 8.0},
        ])
        assert line[1] == {"index": 1, "kind": "scene", "start": 3.0, "end": 11.0}
