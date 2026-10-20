"""Thin wrapper around apify-client: runs an actor with a spend cap and returns its items."""
from __future__ import annotations

import logging
import os
from decimal import Decimal

from apify_client import ApifyClient

log = logging.getLogger(__name__)

# Actors used by the pipeline, with BRONZE-tier prices checked on 2026-10-20 (USD).
# "per_item" is what one output row roughly costs; "start" is a fixed per-run fee.
ACTORS = {
    "ig_related": {"id": "thenetaji/instagram-related-user-scraper", "per_item": 0.003, "start": 0.0},
    "ig_search": {"id": "apify/instagram-search-scraper", "per_item": 0.0026, "start": 0.0},
    "ig_email": {"id": "devil_port369-owner/instagram-email-phone-scraper-pay-per-result", "per_item": 0.0045, "start": 0.04},
    "link_pages": {"id": "vdrmota/contact-info-scraper", "per_item": 0.01, "start": 0.0},
    "yt_search": {"id": "maximedupre/youtube-channel-search-scraper", "per_item": 0.0007, "start": 0.0},
    "yt_profile": {"id": "flash_scraper/creator-leads-scraper", "per_item": 0.0018, "start": 0.0},
    "yt_hidden": {"id": "dataovercoffee/Youtube-Channel-Business-Email-Scraper", "per_item": 0.12, "start": 0.0},
    "tt_search": {"id": "clockworks/tiktok-user-search-scraper", "per_item": 0.005, "start": 0.0},
    "tt_profile": {"id": "clockworks/tiktok-profile-scraper", "per_item": 0.002, "start": 0.0},
}


def load_dotenv(path: str = ".env") -> None:
    """Read KEY=VALUE lines from a .env file into os.environ (existing variables win)."""
    try:
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


class BudgetExceeded(RuntimeError):
    pass


class Apify:
    def __init__(self, token: str | None = None, max_spend: float = 20.0, dry_run: bool = False):
        load_dotenv()
        token = token or os.environ.get("APIFY_TOKEN")
        if not token and not dry_run:
            raise SystemExit("找不到 APIFY_TOKEN。把 .env.example 复制成 .env，填上 Apify 令牌"
                             "（Apify Console > Settings > API & Integrations）。")
        self.client = ApifyClient(token) if token else None
        self.max_spend = max_spend
        self.spent = 0.0
        self.dry_run = dry_run
        self.runs: list[dict] = []

    def estimate(self, key: str, expected_items: int) -> float:
        a = ACTORS[key]
        return a["start"] + a["per_item"] * expected_items

    def run(self, key: str, run_input: dict, expected_items: int) -> list[dict]:
        """Run ACTORS[key]; the charge cap is the estimate plus 30% headroom, clipped to what's left."""
        actor = ACTORS[key]["id"]
        left = self.max_spend - self.spent
        cap = min(self.estimate(key, expected_items) * 1.3 + 0.05, left)
        if cap <= 0.01:
            raise BudgetExceeded(f"budget of ${self.max_spend:.2f} used up before {actor}")
        log.info("run %s (~%d items, cap $%.2f)", actor, expected_items, cap)
        if self.dry_run:
            self.spent += self.estimate(key, expected_items)
            self.runs.append({"actor": actor, "dry_run": True, "cap": round(cap, 2)})
            return _placeholders(key, expected_items)
        run = self.client.actor(actor).call(
            run_input=run_input, max_total_charge_usd=Decimal(str(round(cap, 2))), logger=None
        )
        if run is None:
            raise RuntimeError(f"{actor} did not return a run")
        items = list(self.client.dataset(run.default_dataset_id).iterate_items(clean=True))
        # usage_total_usd may leave out pay-per-event charges, so keep the larger of it and
        # the price-table estimate as a conservative running total.
        cost = max(float(run.usage_total_usd or 0), self.estimate(key, len(items)))
        self.spent += cost
        self.runs.append({"actor": actor, "run_id": run.id, "status": str(run.status),
                          "dataset": run.default_dataset_id, "items": len(items), "est_cost": round(cost, 3)})
        log.info("  %s: %d items, ~$%.3f (total ~$%.2f)", run.status, len(items), cost, self.spent)
        return items


def _placeholders(key: str, n: int) -> list[dict]:
    """Fake discovery rows for --dry-run so the later lookup steps get costed too."""
    if key in ("ig_related", "ig_search"):
        return [{"username": f"dry_{key}_{i}"} for i in range(n)]
    if key == "tt_search":
        return [{"name": f"dry_tt_{i}"} for i in range(n)]
    if key == "yt_search":
        # Search rows carry the description; leave one in ten without an email so the
        # optional hidden-email step is costed for them (the benchmark saw ~90% in bios).
        return [{"channel": {"handle": f"@dry_yt_{i}", "description": "" if i % 10 == 0 else "x@dry.tw"}}
                for i in range(n)]
    return []
