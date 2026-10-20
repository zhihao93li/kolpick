// Pull contact emails out of free text (bios, channel descriptions).

const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}/g;

// Placeholders and addresses that are never a creator's contact.
const JUNK_DOMAINS = new Set([
  "example.com", "example.org", "mail.com", "domain.com", "email.com",
  "sentry.io", "wixpress.com", "sentry-next.wixpress.com",
]);
const JUNK_SUFFIXES = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

export function isValid(email: string): boolean {
  email = email.toLowerCase();
  if (JUNK_SUFFIXES.some((s) => email.endsWith(s))) return false;
  const domain = email.split("@").pop() ?? "";
  return !JUNK_DOMAINS.has(domain);
}

/** Unique valid emails in order of appearance. */
export function extract(text: string | null | undefined): string[] {
  if (!text) return [];
  // Full-width @ and dots show up in Chinese bios.
  text = text.replaceAll("＠", "@").replaceAll("．", ".");
  const seen: string[] = [];
  for (const match of text.match(EMAIL_RE) ?? []) {
    const email = match.replace(/^[.\-_]+|[.\-_]+$/g, "");
    if (isValid(email) && !seen.some((s) => s.toLowerCase() === email.toLowerCase())) seen.push(email);
  }
  return seen;
}

/** Normalize an actor field that may be a string, list, or comma-separated string. */
export function splitField(value: unknown): string[] {
  if (!value) return [];
  const parts = typeof value === "string" ? value.split(/[,;\s]+/) : Array.isArray(value) ? value : [];
  return parts
    .map((x) => String(x).trim())
    .filter((v) => v && v.includes("@") && isValid(v));
}
