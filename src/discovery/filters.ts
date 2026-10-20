import type { Creator } from "./models.js";

const HAN_RE = /[一-鿿]/;
const KANA_RE = /[぀-ヿ]/;

/** Han characters and no Japanese kana: drops the Japanese results TikTok search mixes in. */
export function looksChinese(text: string): boolean {
  return HAN_RE.test(text) && !KANA_RE.test(text);
}

export interface FilterOptions {
  minFollowers?: number | null;
  maxFollowers?: number | null;
  chineseOnly?: boolean;
}

/** Returns [keep, reason]; reason is empty when kept. */
export function keep(c: Creator, opts: FilterOptions): [boolean, string] {
  if (c.isPrivate) return [false, "private"];
  if (c.followers !== null) {
    if (opts.minFollowers != null && c.followers < opts.minFollowers) return [false, "below_min_followers"];
    if (opts.maxFollowers != null && c.followers > opts.maxFollowers) return [false, "above_max_followers"];
  }
  if (opts.chineseOnly && !looksChinese(`${c.name}\n${c.bio}`)) return [false, "not_chinese"];
  return [true, ""];
}
