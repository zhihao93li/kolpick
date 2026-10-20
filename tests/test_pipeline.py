from kolpick import pipeline
from kolpick.apify import Apify
from kolpick.filters import keep, looks_chinese
from kolpick.models import Creator


class FakeApify(Apify):
    """Returns canned items per actor key instead of calling Apify."""

    def __init__(self, items):
        super().__init__(max_spend=5, dry_run=True)
        self.items = items
        self.calls = []

    def run(self, key, run_input, expected_items):
        self.calls.append((key, run_input))
        return self.items.get(key, [])


def test_ig_lookup_prefers_public_email_field():
    api = FakeApify({"ig_email": [
        {"username": "silviali2014", "public_email": "silvialiblogger@gmail.com", "ExtractedEmails": "",
         "is_business": True, "follower_count": 12000, "biography": "合作 other@gmail.com"},
        {"username": "nobody", "public_email": None, "ExtractedEmails": "", "biography": "私訊小盒子"},
    ]})
    a, b = Creator("instagram", "silviali2014"), Creator("instagram", "nobody")
    pipeline.ig_lookup(api, [a, b])
    assert (a.email, a.email_source) == ("silvialiblogger@gmail.com", "platform_field")
    assert a.all_emails == ["silvialiblogger@gmail.com", "other@gmail.com"]
    assert a.followers == 12000
    assert b.email == ""


def test_link_pages_skips_social_links_and_shop_pages():
    api = FakeApify({"link_pages": [
        {"originalStartUrl": "https://portaly.cc/huto4869", "emails": ["huto4869@gmail.com"]},
        {"originalStartUrl": "https://example-shop.tw/", "emails": ["cs@x.com", "info@x.com", "b@x.com"]},
    ]})
    a = Creator("instagram", "huto4869", external_url="https://portaly.cc/huto4869")
    b = Creator("instagram", "shop", external_url="https://example-shop.tw/")
    c = Creator("instagram", "fb", external_url="https://www.facebook.com/foo")
    pipeline.link_pages_lookup(api, [a, b, c])
    urls = [u["url"] for u in api.calls[0][1]["startUrls"]]
    assert "https://www.facebook.com/foo" not in urls
    assert a.email == "huto4869@gmail.com" and a.email_source == "link_page"
    assert b.email == ""


def test_yt_discover_reads_description_email():
    api = FakeApify({"yt_search": [{
        "channel": {"handle": "@greenphoto2010", "url": "https://www.youtube.com/@greenphoto2010",
                    "title": "綠攝", "description": "合作信箱：greenphoto27270867@gmail.com"},
        "metrics": {"subscribers": None}, "discoverySource": {"value": "婚禮攝影"},
    }]})
    [c] = pipeline.yt_discover(api, ["婚禮攝影"], 20, None, None, "TW", "zh")
    assert c.email == "greenphoto27270867@gmail.com"
    assert "minSubscribers" not in api.calls[0][1]


def test_yt_hidden_only_for_missing():
    api = FakeApify({"yt_hidden": [{"Query": "@moneyweeklylife", "Email": "x@gmail.com", "Status": "EMAIL_AVAILABLE"}]})
    has = Creator("youtube", "@a"); has.add_email("a@a.com", "bio")
    missing = Creator("youtube", "moneyweeklylife")
    pipeline.yt_hidden_lookup(api, [has, missing])
    assert api.calls[0][1]["channels"] == ["@moneyweeklylife"]
    assert missing.email_source == "youtube_hidden"


def test_tiktok_search_bio_email():
    api = FakeApify({"tt_search": [
        {"name": "bobbypombo", "fans": 2500000, "signature": "📧  teambobbyp@underscoretalent.com", "searchQuery": "x"},
        {"searchQuery": "x"},
    ]})
    [c] = pipeline.tt_discover(api, ["x"], 10)
    assert c.email == "teambobbyp@underscoretalent.com" and c.followers == 2500000


def test_filters():
    assert looks_chinese("親子日常") and not looks_chinese("親子の遊び方") and not looks_chinese("hello")
    c = Creator("tiktok", "a", followers=500, bio="新秘")
    assert keep(c, min_followers=1000, max_followers=None, chinese_only=False) == (False, "below_min_followers")
    assert keep(c, min_followers=None, max_followers=None, chinese_only=True) == (True, "")
