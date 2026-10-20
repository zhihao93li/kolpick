from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Creator:
    platform: str  # instagram | youtube | tiktok
    handle: str
    profile_url: str = ""
    name: str = ""
    followers: int | None = None
    is_business: bool | None = None
    is_private: bool | None = None
    bio: str = ""
    external_url: str = ""
    discovered_by: str = ""  # e.g. "related:fly_to_tang", "search:新秘", "input"
    email: str = ""
    email_source: str = ""  # platform_field | bio | link_page | youtube_hidden
    all_emails: list[str] = field(default_factory=list)
    note: str = ""

    @property
    def key(self) -> tuple[str, str]:
        return (self.platform, normalize_handle(self.handle))

    def add_email(self, email: str, source: str) -> None:
        email = email.strip()
        if not email:
            return
        if email.lower() not in (e.lower() for e in self.all_emails):
            self.all_emails.append(email)
        if not self.email:
            self.email, self.email_source = email, source


def normalize_handle(handle: str) -> str:
    return handle.strip().lstrip("@").lower()
