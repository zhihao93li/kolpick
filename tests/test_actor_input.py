from pathlib import Path

import pytest

pytest.importorskip("apify")
from kolpick.actor_main import args_from_input  # noqa: E402


def test_input_form_maps_to_cli_args(tmp_path: Path):
    args = args_from_input({
        "platform": "youtube", "keywords": ["新秘", "婚禮攝影"], "handles": "a\nb",
        "exclude": ["old_one", "x@y.com"], "minFollowers": 3000, "youtubeHidden": True, "linkPages": False,
    }, tmp_path)
    assert args.platform == "youtube" and args.keywords == ["新秘", "婚禮攝影"]
    assert args.handles == ["a", "b"] and args.min_followers == 3000
    assert args.youtube_hidden and not args.link_pages
    assert (tmp_path / "exclude.txt").read_text(encoding="utf-8") == "old_one\nx@y.com"
