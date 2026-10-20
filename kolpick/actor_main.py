"""Apify actor entry point: same pipeline as the CLI, driven by the Console input form."""
from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path

from apify import Actor

from .cli import COLUMNS, build_parser, row, run


def _lines(value) -> list[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [v.strip() for v in str(value or "").replace(",", "\n").splitlines() if v.strip()]


def args_from_input(inp: dict, workdir: Path):
    argv = ["--platform", inp.get("platform", "instagram"),
            "--per-seed", str(inp.get("perSeed", 150)),
            "--per-keyword", str(inp.get("perKeyword", 50)),
            "--max-spend", str(inp.get("maxSpendUsd", 10)),
            "--out", str(workdir / "results.csv")]
    for flag, key in (("--keywords", "keywords"), ("--seeds", "seeds"), ("--handles", "handles")):
        values = _lines(inp.get(key))
        if values:
            argv += [flag, *values]
    excluded = _lines(inp.get("exclude"))
    if excluded:
        path = workdir / "exclude.txt"
        path.write_text("\n".join(excluded), encoding="utf-8")
        argv += ["--exclude", str(path)]
    for flag, key in (("--min-followers", "minFollowers"), ("--max-followers", "maxFollowers")):
        if inp.get(key):
            argv += [flag, str(inp[key])]
    if inp.get("chineseOnly"):
        argv.append("--chinese-only")
    if inp.get("linkPages") is False:
        argv.append("--no-link-pages")
    if inp.get("youtubeHidden"):
        argv.append("--youtube-hidden")
    return build_parser().parse_args(argv)


async def main() -> None:
    async with Actor:
        logging.basicConfig(level=logging.INFO, format="%(message)s")
        inp = await Actor.get_input() or {}
        with tempfile.TemporaryDirectory() as tmp:
            args = args_from_input(inp, Path(tmp))
            if not (args.keywords or args.seeds or args.handles):
                await Actor.fail(status_message="请至少填写关键词、种子账号或账号名单中的一项")
                return
            results, csv_path = await asyncio.to_thread(run, args)
            await Actor.push_data([dict(zip(COLUMNS, row(c, status))) for c, status in results])
            await Actor.set_value("results.csv", csv_path.read_bytes(), content_type="text/csv; charset=utf-8")
            with_email = sum(1 for _, s in results if s == "has_email")
            await Actor.set_status_message(f"共 {len(results)} 人，其中 {with_email} 人有邮箱")


if __name__ == "__main__":
    asyncio.run(main())
