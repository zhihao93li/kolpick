from __future__ import annotations

import re

from .models import Creator

HAN_RE = re.compile(r"[一-鿿]")
KANA_RE = re.compile(r"[぀-ヿ]")


def looks_chinese(text: str) -> bool:
    """Han characters and no Japanese kana: drops the Japanese results TikTok search mixes in."""
    return bool(HAN_RE.search(text)) and not KANA_RE.search(text)


def keep(c: Creator, *, min_followers: int | None, max_followers: int | None,
         chinese_only: bool) -> tuple[bool, str]:
    if c.is_private:
        return False, "private"
    if c.followers is not None:
        if min_followers is not None and c.followers < min_followers:
            return False, "below_min_followers"
        if max_followers is not None and c.followers > max_followers:
            return False, "above_max_followers"
    if chinese_only and not looks_chinese(f"{c.name}\n{c.bio}"):
        return False, "not_chinese"
    return True, ""
