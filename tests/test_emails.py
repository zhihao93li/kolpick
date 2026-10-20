from kolpick import emails


def test_extracts_from_chinese_bio():
    bio = "合作📧teresalin51320@gmail.com\n生活日常帳：@Teresa"
    assert emails.extract(bio) == ["teresalin51320@gmail.com"]


def test_full_width_at_and_dedupe():
    assert emails.extract("聯絡：abc＠gmail．com / ABC@gmail.com") == ["abc@gmail.com"]


def test_drops_placeholders_and_images():
    assert emails.extract("example@mail.com logo@2x.png real@shan.art") == ["real@shan.art"]


def test_split_field_handles_strings_and_lists():
    assert emails.split_field("a@b.co, c@d.tw") == ["a@b.co", "c@d.tw"]
    assert emails.split_field(["a@b.co", ""]) == ["a@b.co"]
    assert emails.split_field(None) == []


def test_load_dotenv(tmp_path, monkeypatch):
    from kolpick.apify import load_dotenv
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    env = tmp_path / ".env"
    env.write_text('# comment\nAPIFY_TOKEN="abc123"\n', encoding="utf-8")
    load_dotenv(str(env))
    import os
    assert os.environ["APIFY_TOKEN"] == "abc123"
