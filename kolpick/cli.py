"""Command line entry point: python -m kolpick --platform instagram --keywords 新秘 婚禮攝影 ..."""
from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

from . import pipeline
from .apify import Apify, BudgetExceeded
from .filters import keep
from .models import Creator, normalize_handle

log = logging.getLogger("kolpick")

COLUMNS = ["platform", "handle", "profile_url", "name", "followers", "is_business", "email", "email_source",
           "all_emails", "status", "discovered_by", "external_url", "bio"]


def read_handles(path: str | None, platform: str) -> list[str]:
    """One handle per line, or a CSV with a `handle` column (rows for other platforms are skipped)."""
    if not path:
        return []
    text = Path(path).read_text(encoding="utf-8-sig")
    first = text.splitlines()[0] if text else ""
    if "handle" in first.split(","):
        rows = csv.DictReader(text.splitlines())
        return [r["handle"].strip() for r in rows
                if r.get("handle") and (not r.get("platform") or r["platform"].strip().lower() == platform)]
    return [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]


def read_exclusions(paths: list[str]) -> tuple[set[str], set[str]]:
    """Handles and emails already contacted; any CSV with `handle` and/or `email` columns, or plain lines."""
    handles, mails = set(), set()
    for path in paths or []:
        text = Path(path).read_text(encoding="utf-8-sig")
        lines = text.splitlines()
        if lines and ("handle" in lines[0] or "email" in lines[0]):
            for r in csv.DictReader(lines):
                for key in ("handle", "username"):
                    if r.get(key):
                        handles.add(normalize_handle(r[key]))
                for key in ("email", "known_email"):
                    if r.get(key):
                        mails.add(r[key].strip().lower())
        else:
            for line in lines:
                line = line.strip()
                if "@" in line and "." in line.split("@")[-1]:
                    mails.add(line.lower())
                elif line:
                    handles.add(normalize_handle(line))
    return handles, mails


def run(args: argparse.Namespace) -> list[tuple[Creator, str]]:
    api = Apify(max_spend=args.max_spend, dry_run=args.dry_run)
    platform = args.platform
    given = [Creator(platform, h, discovered_by="input") for h in read_handles(args.handles_file, platform)]
    given += [Creator(platform, h, discovered_by="input") for h in args.handles]
    excluded_handles, excluded_emails = read_exclusions(args.exclude)
    filt = dict(min_followers=args.min_followers, max_followers=args.max_followers, chinese_only=args.chinese_only)

    creators: list[Creator] = []
    try:
        if platform == "instagram":
            found = pipeline.ig_discover(api, args.seeds, args.keywords, args.per_seed, args.per_keyword)
            creators = _dedupe(given + found)
            creators = _drop_excluded(creators, excluded_handles)
            pipeline.ig_lookup(api, creators)
            if args.link_pages:
                pipeline.link_pages_lookup(api, [c for c in creators if keep(c, **filt)[0]])
        elif platform == "youtube":
            found = pipeline.yt_discover(api, args.keywords, args.per_keyword, args.min_followers,
                                         args.max_followers, args.country, args.language)
            creators = _drop_excluded(_dedupe(given + found), excluded_handles)
            pipeline.yt_lookup(api, creators)
            kept = [c for c in creators if keep(c, **filt)[0]]
            if args.link_pages:
                pipeline.link_pages_lookup(api, kept)
            if args.youtube_hidden:
                pipeline.yt_hidden_lookup(api, kept)
        elif platform == "tiktok":
            found = pipeline.tt_discover(api, args.keywords, args.per_keyword)
            creators = _drop_excluded(_dedupe(given + found), excluded_handles)
            pipeline.tt_lookup(api, creators)
            if args.link_pages:
                pipeline.link_pages_lookup(api, [c for c in creators if keep(c, **filt)[0]])
    except BudgetExceeded as exc:
        log.warning("%s; writing what was found so far", exc)

    results = []
    for c in creators:
        ok, reason = keep(c, **filt)
        if not ok:
            status = f"filtered:{reason}"
        elif c.email and c.email.lower() in excluded_emails:
            status = "excluded:email_already_contacted"
        elif c.email:
            status = "has_email"
        else:
            status = "no_email"
        results.append((c, status))
    _write(args, api, results)
    return results


def _dedupe(creators: list[Creator]) -> list[Creator]:
    pool: dict = {}
    for c in creators:
        pipeline._merge(pool, c)
    return list(pool.values())


def _drop_excluded(creators: list[Creator], handles: set[str]) -> list[Creator]:
    kept = [c for c in creators if normalize_handle(c.handle) not in handles]
    if len(kept) != len(creators):
        log.info("skipped %d already-contacted handles", len(creators) - len(kept))
    return kept


def _write(args, api: Apify, results: list[tuple[Creator, str]]) -> None:
    out = Path(args.out or f"output/{args.platform}-{datetime.now():%Y%m%d-%H%M}.csv")
    out.parent.mkdir(parents=True, exist_ok=True)
    order = {"has_email": 0, "no_email": 1}
    results = sorted(results, key=lambda r: (order.get(r[1], 2), -(r[0].followers or 0)))
    # utf-8-sig so Excel opens Chinese text correctly.
    with out.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(COLUMNS)
        for c, status in results:
            w.writerow([c.platform, c.handle, c.profile_url, c.name, c.followers if c.followers is not None else "",
                        "" if c.is_business is None else c.is_business, c.email, c.email_source,
                        "; ".join(c.all_emails), status, c.discovered_by, c.external_url,
                        c.bio.replace("\n", " ")[:300]])
    counts: dict[str, int] = {}
    for _, status in results:
        counts[status] = counts.get(status, 0) + 1
    summary = {"output": str(out), "total": len(results), "by_status": counts,
               "estimated_spend_usd": round(api.spent, 2), "runs": api.runs}
    out.with_suffix(".runs.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    if api.dry_run:
        log.info("dry run: estimated cost ~$%.2f (placeholder rows written to %s)", api.spent, out)
    else:
        log.info("wrote %s: %s, ~$%.2f spent", out, counts, api.spent)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="kolpick", description="Find KOLs and their contact emails via Apify.")
    p.add_argument("--platform", required=True, choices=["instagram", "youtube", "tiktok"])
    p.add_argument("--keywords", nargs="*", default=[], help="short search words, e.g. 新秘 婚禮攝影")
    p.add_argument("--seeds", nargs="*", default=[], help="Instagram only: accounts to expand via similar accounts")
    p.add_argument("--handles", nargs="*", default=[], help="handles to look up directly")
    p.add_argument("--handles-file", help="txt (one per line) or CSV with a handle column")
    p.add_argument("--exclude", nargs="*", default=[], help="CSV/txt of handles or emails already contacted")
    p.add_argument("--per-seed", type=int, default=150, help="similar accounts per seed (Instagram)")
    p.add_argument("--per-keyword", type=int, default=50, help="results per keyword")
    p.add_argument("--min-followers", type=int)
    p.add_argument("--max-followers", type=int)
    p.add_argument("--chinese-only", action="store_true", help="drop accounts whose name/bio has no Chinese")
    p.add_argument("--no-link-pages", dest="link_pages", action="store_false",
                   help="skip crawling link-in-bio pages for creators still missing an email")
    p.add_argument("--youtube-hidden", action="store_true",
                   help="YouTube: look up the hidden business email for channels still missing one (~$0.12 each)")
    p.add_argument("--country", default="TW", help="YouTube search country")
    p.add_argument("--language", default="zh", help="YouTube page language")
    p.add_argument("--max-spend", type=float, default=10.0, help="stop starting new actor runs past this (USD)")
    p.add_argument("--out", help="output CSV path (default output/<platform>-<time>.csv)")
    p.add_argument("--dry-run", action="store_true", help="print the plan and cost estimate without calling Apify")
    return p


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    args = build_parser().parse_args(argv)
    if not (args.keywords or args.seeds or args.handles or args.handles_file):
        print("give at least one of --keywords, --seeds, --handles, --handles-file", file=sys.stderr)
        return 2
    if args.seeds and args.platform != "instagram":
        print("--seeds only works for Instagram", file=sys.stderr)
        return 2
    run(args)
    return 0
