"""
Language handling for VoiceForge: engine selection and Nepali text prep.

Deliberately imports no torch and loads no model, so CI can test it on a
plain runner — the same reason voiceforge_render.py is its own file. The
server passes in a callable that says whether an engine is loadable; this
module decides what that means for a job.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional

# What every language has always run on.
DEFAULT_ENGINE = "chatterbox-mtl"

# Engine names that mean "the stock multilingual checkpoint".
STOCK_ENGINES = {DEFAULT_ENGINE, "chatterbox", ""}


def plan_engine(
    engine: Optional[str],
    fallback: Optional[Dict[str, Any]],
    params: Dict[str, Any],
    available: Callable[[str], bool],
    defaults: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """Decide what actually runs, and what to call it in the result.

    `engine_used` is the point of the whole exercise: when a Nepali job
    quietly runs on Hindi because no Nepali checkpoint is configured, that has
    to be visible in the result rather than only audible in the output.
    """
    d = defaults or {}
    wanted = (engine or DEFAULT_ENGINE).strip() or DEFAULT_ENGINE

    chosen: Dict[str, Any] = {
        "engine": wanted,
        "language": str(params.get("language", "en") or "en"),
        "exaggeration": float(params.get("exaggeration", d.get("exaggeration", 0.4))),
        "cfg": float(params.get("cfg", d.get("cfg", 0.5))),
        "temperature": float(params.get("temperature", d.get("temperature", 0.7))),
        "engine_used": wanted,
    }

    if wanted in STOCK_ENGINES or available(wanted):
        return chosen

    if not fallback:
        # Nothing to fall back to. Run the stock engine on the language as
        # given rather than failing a job that would otherwise have worked.
        chosen["engine"] = DEFAULT_ENGINE
        chosen["engine_used"] = DEFAULT_ENGINE
        return chosen

    lang = str(
        fallback.get("modelLanguage") or fallback.get("language") or chosen["language"]
    )
    chosen["engine"] = str(fallback.get("engine") or DEFAULT_ENGINE)
    chosen["language"] = lang
    if fallback.get("cfg") is not None:
        chosen["cfg"] = float(fallback["cfg"])
    if fallback.get("exaggeration") is not None:
        chosen["exaggeration"] = float(fallback["exaggeration"])
    chosen["engine_used"] = f"fallback-{lang}"
    return chosen


# ---------------------------------------------------------------------------
# Nepali text preparation
# ---------------------------------------------------------------------------

_NE_DIGITS = {
    "0": "सुन्ना", "1": "एक", "2": "दुई", "3": "तीन", "4": "चार",
    "5": "पाँच", "6": "छ", "7": "सात", "8": "आठ", "9": "नौ",
    "०": "सुन्ना", "१": "एक", "२": "दुई", "३": "तीन", "४": "चार",
    "५": "पाँच", "६": "छ", "७": "सात", "८": "आठ", "९": "नौ",
}


def ne_spell_number(token: str) -> str:
    """Read a number digit by digit, speaking the decimal point.

    Deliberately not a full Nepali number grammar: digits plus "दशमलव" is
    always understandable, whereas a half-right lakh/crore rule is not, and a
    TTS model cannot ask what you meant.
    """
    out: List[str] = []
    for ch in token:
        if ch in _NE_DIGITS:
            out.append(_NE_DIGITS[ch])
        elif ch == ".":
            out.append("दशमलव")
        elif ch == ",":
            continue
        else:
            out.append(ch)
    return " ".join(x for x in out if x)


def ne_expand_digits(text: str) -> str:
    """Replace every run of digits — ASCII or Devanagari — with spoken words."""
    return re.sub(
        r"[0-9०-९][0-9०-९.,]*",
        lambda m: ne_spell_number(m.group(0)),
        text or "",
    )


def ne_chunks(text: str, max_chars: int = 240) -> List[str]:
    """Split Nepali text where it is actually spoken.

    Devanagari sentences end at the danda, not the full stop, so splitting on
    "." leaves one enormous chunk and the model rushes it. Long sentences are
    then broken at commas, which are real breath points in Devanagari prose.
    """
    text = " ".join((text or "").split())
    if not text:
        return []

    out: List[str] = []
    for sentence in re.split(r"(?<=[।॥?!])\s*", text):
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) <= max_chars:
            out.append(sentence)
            continue
        buf = ""
        for part in re.split(r"(?<=,)\s*", sentence):
            part = part.strip()
            if not part:
                continue
            if buf and len(buf) + len(part) + 1 > max_chars:
                out.append(buf)
                buf = part
            else:
                buf = f"{buf} {part}" if buf else part
        if buf:
            out.append(buf)
    return [c for c in out if c]


def ne_prepare(text: str, max_chars: int = 240) -> List[str]:
    """Spoken numbers, then sentence and breath chunking."""
    return ne_chunks(ne_expand_digits(text or ""), max_chars)
