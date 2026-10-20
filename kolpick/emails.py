"""Pull contact emails out of free text (bios, channel descriptions)."""
from __future__ import annotations

import re

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")

# Placeholders and addresses that are never a creator's contact.
JUNK_DOMAINS = {
    "example.com", "example.org", "mail.com", "domain.com", "email.com",
    "sentry.io", "wixpress.com", "sentry-next.wixpress.com",
}
JUNK_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg")


def is_valid(email: str) -> bool:
    email = email.lower()
    if email.endswith(JUNK_SUFFIXES):
        return False
    domain = email.rsplit("@", 1)[-1]
    return domain not in JUNK_DOMAINS


def extract(text: str | None) -> list[str]:
    """Return unique valid emails in order of appearance."""
    if not text:
        return []
    # Full-width @ and dots show up in Chinese bios.
    text = text.replace("＠", "@").replace("．", ".")
    seen: list[str] = []
    for match in EMAIL_RE.findall(text):
        email = match.strip(".-_")
        if is_valid(email) and email.lower() not in (s.lower() for s in seen):
            seen.append(email)
    return seen


def split_field(value) -> list[str]:
    """Normalize an actor field that may be a string, list, or comma-separated string."""
    if not value:
        return []
    if isinstance(value, str):
        value = re.split(r"[,;\s]+", value)
    return [v for v in (str(x).strip() for x in value) if v and is_valid(v) and "@" in v]
