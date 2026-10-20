"""Per-platform discovery and email lookup.

Each platform follows the order verified on the 150-KOL benchmark (2026-10-20):
  Instagram: related accounts + keyword search -> old email actor (reads the business
             "public_email" field) -> link-in-bio pages for the rest.
  YouTube:   channel keyword search (description already included) -> hidden business
             email for the rest, only when asked (12 US cents per email found).
  TikTok:    user keyword search -> bio text.
"""
from __future__ import annotations

import logging
from urllib.parse import urlparse

from . import emails
from .apify import Apify
from .models import Creator, normalize_handle

log = logging.getLogger(__name__)

# Link-in-bio targets that never carry a contact email (social sites, chat apps, shops).
SKIP_LINK_DOMAINS = (
    "instagram.com", "facebook.com", "fb.com", "youtube.com", "youtu.be", "tiktok.com",
    "line.me", "lin.ee", "wa.me", "whatsapp.com", "threads.net", "x.com", "twitter.com",
    "shopee.tw", "shopee.com", "myship.7-11.com.tw", "gbf.tw", "momoshop.com.tw",
    "pse.is", "apps.apple.com", "play.google.com",
)


def _get(item: dict, path: str, default=None):
    """Read a dotted path from an actor item."""
    cur = item
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return item.get(path, default) if isinstance(item, dict) else default
        cur = cur[part]
    return cur if cur is not None else default


def _int(value) -> int | None:
    try:
        return int(value) if value is not None and value != "" else None
    except (TypeError, ValueError):
        return None


def _merge(pool: dict[tuple[str, str], Creator], c: Creator) -> None:
    if not c.handle:
        return
    existing = pool.get(c.key)
    if existing is None:
        pool[c.key] = c
        return
    for attr in ("profile_url", "name", "bio", "external_url"):
        if not getattr(existing, attr) and getattr(c, attr):
            setattr(existing, attr, getattr(c, attr))
    for attr in ("followers", "is_business", "is_private"):
        if getattr(existing, attr) is None and getattr(c, attr) is not None:
            setattr(existing, attr, getattr(c, attr))
    for e in c.all_emails:
        existing.add_email(e, c.email_source)


# ---------------------------------------------------------------- Instagram

def ig_discover(api: Apify, seeds: list[str], keywords: list[str],
                per_seed: int, per_keyword: int) -> list[Creator]:
    pool: dict[tuple[str, str], Creator] = {}
    if seeds:
        items = api.run("ig_related", {"username": seeds, "maxItem": per_seed, "enrichProfile": False},
                        expected_items=len(seeds) * per_seed)
        for it in items:
            handle = it.get("username") or ""
            _merge(pool, Creator("instagram", handle, f"https://www.instagram.com/{handle}/",
                                 name=it.get("full_name") or "", is_private=it.get("is_private"),
                                 discovered_by="related"))
    if keywords:
        items = api.run("ig_search", {"search": ", ".join(keywords), "searchType": "user",
                                      "searchLimit": per_keyword},
                        expected_items=len(keywords) * per_keyword)
        for it in items:
            handle = it.get("username") or ""
            _merge(pool, Creator("instagram", handle, f"https://www.instagram.com/{handle}/",
                                 name=it.get("fullName") or "", followers=_int(it.get("followersCount")),
                                 is_business=it.get("isBusinessAccount"), is_private=it.get("private"),
                                 bio=it.get("biography") or "", external_url=it.get("externalUrl") or "",
                                 discovered_by=f"search:{it.get('searchTerm', '')}"))
    return list(pool.values())


def ig_lookup(api: Apify, creators: list[Creator]) -> None:
    """Fill followers, account type, bio and email from the old actor (the one that reads public_email)."""
    todo = [c for c in creators if not c.is_private]
    if not todo:
        return
    items = api.run("ig_email", {"instagram_ids": [c.handle for c in todo], "verify_email": False},
                    expected_items=len(todo))
    by_handle = {normalize_handle(it.get("username") or ""): it for it in items}
    for c in todo:
        it = by_handle.get(normalize_handle(c.handle))
        if not it:
            c.note = c.note or "not_returned"
            continue
        c.followers = _int(it.get("follower_count")) if it.get("follower_count") is not None else c.followers
        c.is_business = it.get("is_business", c.is_business)
        c.is_private = it.get("is_private", c.is_private)
        c.name = it.get("full_name") or c.name
        c.bio = it.get("biography") or c.bio
        c.external_url = it.get("external_url") or c.external_url
        if it.get("public_email"):
            c.add_email(it["public_email"], "platform_field")
        for e in emails.split_field(it.get("ExtractedEmails")) + emails.extract(c.bio):
            c.add_email(e, "bio")


# ---------------------------------------------------------------- Link-in-bio pages

def crawlable(url: str) -> bool:
    if not url:
        return False
    host = (urlparse(url if "://" in url else f"https://{url}").hostname or "").lower()
    return bool(host) and not any(host == d or host.endswith("." + d) for d in SKIP_LINK_DOMAINS)


def link_pages_lookup(api: Apify, creators: list[Creator]) -> None:
    targets: dict[str, list[Creator]] = {}
    for c in creators:
        if not c.email and crawlable(c.external_url):
            url = c.external_url if "://" in c.external_url else f"https://{c.external_url}"
            targets.setdefault(url, []).append(c)
    if not targets:
        return
    items = api.run("link_pages", {
        "startUrls": [{"url": u} for u in targets],
        "maxDepth": 1, "maxRequestsPerStartUrl": 5, "maxRequests": len(targets) * 5,
        "sameDomain": True, "mergeContacts": True, "proxyConfig": {"useApifyProxy": True},
    }, expected_items=len(targets))
    for it in items:
        found = emails.split_field(it.get("emails"))
        # A page listing many addresses is usually a shop or platform, not the creator.
        if not found or len(found) > 2:
            continue
        for c in targets.get(it.get("originalStartUrl") or "", []):
            for e in found:
                c.add_email(e, "link_page")


# ---------------------------------------------------------------- YouTube

def _yt_handle(value: str) -> str:
    value = (value or "").strip()
    if "youtube.com/" in value:
        value = value.rstrip("/").rsplit("/", 1)[-1]
    return value if value.startswith("@") else f"@{value}"


def yt_discover(api: Apify, keywords: list[str], per_keyword: int,
                min_followers: int | None, max_followers: int | None,
                country: str, language: str) -> list[Creator]:
    if not keywords:
        return []
    run_input = {"discoveryMode": "both", "searchTerms": keywords, "maxChannelsPerSearchTerm": per_keyword,
                 "countryHint": country, "languageHint": language}
    # The actor drops channels with a hidden subscriber count when a min/max is set, so
    # only pass the bounds through when the caller asked for them.
    if min_followers:
        run_input["minSubscribers"] = min_followers
    if max_followers:
        run_input["maxSubscribers"] = max_followers
    items = api.run("yt_search", run_input, expected_items=len(keywords) * per_keyword)
    pool: dict[tuple[str, str], Creator] = {}
    for it in items:
        handle = _get(it, "channel.handle") or ""
        c = Creator("youtube", handle, _get(it, "channel.url") or "", name=_get(it, "channel.title") or "",
                    followers=_int(_get(it, "metrics.subscribers")), bio=_get(it, "channel.description") or "",
                    discovered_by=f"search:{_get(it, 'discoverySource.value', '')}")
        links = _get(it, "profile.externalLinks") or []
        if links:
            first = links[0]
            c.external_url = first.get("url", "") if isinstance(first, dict) else str(first)
        for e in emails.split_field(_get(it, "profile.emails")) + emails.extract(c.bio):
            c.add_email(e, "bio")
        _merge(pool, c)
    return list(pool.values())


def yt_lookup(api: Apify, creators: list[Creator]) -> None:
    """Profile + bio email for channels given by handle (search results already have this)."""
    todo = [c for c in creators if not c.bio and not c.email]
    if not todo:
        return
    items = api.run("yt_profile", {"platforms": ["youtube"], "channels": [_yt_handle(c.handle) for c in todo],
                                   "maxCreators": len(todo), "enrichEmails": True},
                    expected_items=len(todo))
    by_handle = {normalize_handle(it.get("handle") or ""): it for it in items}
    for c in todo:
        it = by_handle.get(normalize_handle(c.handle))
        if not it:
            continue
        c.name = it.get("name") or c.name
        c.followers = _int(it.get("followers")) if it.get("followers") is not None else c.followers
        c.bio = it.get("bio") or c.bio
        c.profile_url = it.get("profile_url") or c.profile_url
        c.external_url = it.get("website") or c.external_url
        if it.get("email"):
            # Its "website" source crawls the channel's site, which is the same as our link step.
            c.add_email(it["email"], "link_page" if it.get("email_source") == "website" else "bio")
        for e in emails.extract(c.bio):
            c.add_email(e, "bio")


def yt_hidden_lookup(api: Apify, creators: list[Creator]) -> None:
    todo = [c for c in creators if not c.email]
    if not todo:
        return
    items = api.run("yt_hidden", {"channels": [_yt_handle(c.handle) for c in todo], "scrape_fresh_emails": False},
                    expected_items=len(todo))
    by_handle = {normalize_handle(it.get("Query") or ""): it for it in items}
    for c in todo:
        it = by_handle.get(normalize_handle(_yt_handle(c.handle)))
        if it and it.get("Email") and emails.is_valid(it["Email"]):
            c.add_email(it["Email"], "youtube_hidden")


# ---------------------------------------------------------------- TikTok

def _tt_creator(meta: dict, discovered_by: str) -> Creator:
    handle = meta.get("name") or ""
    c = Creator("tiktok", handle, f"https://www.tiktok.com/@{handle}", name=meta.get("nickName") or "",
                followers=_int(meta.get("fans")), is_private=meta.get("privateAccount"),
                bio=meta.get("signature") or "", external_url=meta.get("bioLink") or "",
                discovered_by=discovered_by)
    for e in emails.extract(c.bio):
        c.add_email(e, "bio")
    return c


def tt_discover(api: Apify, keywords: list[str], per_keyword: int) -> list[Creator]:
    if not keywords:
        return []
    items = api.run("tt_search", {"searchQueries": keywords, "maxProfilesPerQuery": per_keyword},
                    expected_items=len(keywords) * per_keyword)
    pool: dict[tuple[str, str], Creator] = {}
    for it in items:
        if it.get("name"):
            _merge(pool, _tt_creator(it, f"search:{it.get('searchQuery', '')}"))
    return list(pool.values())


def tt_lookup(api: Apify, creators: list[Creator]) -> None:
    todo = [c for c in creators if not c.bio and not c.email]
    if not todo:
        return
    items = api.run("tt_profile", {"profiles": [normalize_handle(c.handle) for c in todo], "resultsPerPage": 1},
                    expected_items=len(todo))
    by_handle = {}
    for it in items:
        meta = it.get("authorMeta") or {}
        if meta.get("name"):
            by_handle.setdefault(normalize_handle(meta["name"]), meta)
    for c in todo:
        meta = by_handle.get(normalize_handle(c.handle))
        if meta:
            fresh = _tt_creator(meta, c.discovered_by)
            for attr in ("name", "followers", "is_private", "bio", "external_url"):
                setattr(c, attr, getattr(fresh, attr))
            for e in fresh.all_emails:
                c.add_email(e, "bio")
