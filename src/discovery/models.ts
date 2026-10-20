export type Platform = "instagram" | "youtube" | "tiktok";
export const PLATFORMS: Platform[] = ["instagram", "youtube", "tiktok"];

/** Where an email was found, from most to least trustworthy. */
export type EmailSource = "platform_field" | "bio" | "link_page" | "youtube_hidden";

/** One creator as the discovery pipeline sees it, before it is saved to the database. */
export class Creator {
  profileUrl = "";
  name = "";
  followers: number | null = null;
  isBusiness: boolean | null = null;
  isPrivate: boolean | null = null;
  bio = "";
  externalUrl = "";
  discoveredBy = ""; // e.g. "related", "search:新秘", "input"
  email = "";
  emailSource: EmailSource | "" = "";
  /** Every address found, with the source it was first seen in. */
  emails: { email: string; source: EmailSource }[] = [];
  note = "";

  constructor(
    public platform: Platform,
    public handle: string,
    init: Partial<Omit<Creator, "platform" | "handle" | "emails" | "addEmail" | "key">> = {},
  ) {
    Object.assign(this, init);
  }

  get key(): string {
    return `${this.platform}:${normalizeHandle(this.handle)}`;
  }

  get allEmails(): string[] {
    return this.emails.map((e) => e.email);
  }

  addEmail(email: string, source: EmailSource): void {
    email = email.trim();
    if (!email) return;
    if (!this.emails.some((e) => e.email.toLowerCase() === email.toLowerCase())) {
      this.emails.push({ email, source });
    }
    if (!this.email) {
      this.email = email;
      this.emailSource = source;
    }
  }
}

export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}
