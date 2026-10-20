#!/usr/bin/env python3
"""一次性升级现有索引：清理标题前缀数字，并加入简体/繁体搜索变体。"""

from __future__ import annotations

import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest import S2T, T2S, clean_title, pinyin_text  # noqa: E402


def main() -> int:
    path = ROOT / "data" / "scores.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("items", [])

    backup = ROOT / "data" / ".backup" / f"scores-before-retitle-{datetime.now():%Y%m%d-%H%M%S}.json"
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup)

    changed = []
    for item in items:
        old_title = item.get("title", "")
        title = clean_title(old_title)
        item["title"] = title
        if title != old_title:
            changed.append((old_title, title))

        bits = [
            title,
            item.get("composer", ""),
            item.get("instrument", ""),
            item.get("category", ""),
            item.get("folder", ""),
            " ".join(item.get("tags", [])),
            " ".join(item.get("aliases", [])),
            Path(item.get("source", "")).name,
        ]
        plain = " ".join(bit for bit in bits if bit)
        py, pyi = pinyin_text(plain)
        title_py, title_pyi = pinyin_text(title)
        item["search"] = {
            "py": py,
            "pyi": pyi,
            "titlePy": title_py,
            "titlePyi": title_pyi,
            "simp": T2S.convert(plain),
            "trad": S2T.convert(plain),
            "titleSimp": T2S.convert(title),
            "titleTrad": S2T.convert(title),
        }

    data["generatedAt"] = datetime.now(timezone.utc).isoformat()
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temp.replace(path)

    print(f"升级 {len(items)} 条，标题清理 {len(changed)} 条")
    for old, new in changed[:20]:
        print(f"  {old}  ->  {new}")
    print(f"备份：{backup}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
