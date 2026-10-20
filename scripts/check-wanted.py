#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path

from opencc import OpenCC

ROOT = Path(__file__).resolve().parent.parent
T2S = OpenCC("t2s")
SOURCE = Path(r"D:\BaiduNetdiskDownload")
EXTRACTED = ROOT / "source-extracted"

WANTED = [
    ("孙燕姿", "遇见"),
    ("梁静茹", "宁夏"),
    ("莫文蔚", "这世界那么多人"),
    ("刘若英", "后来"),
    ("田馥甄", "小幸运"),
    ("陈绮贞", "旅行的意义"),
    ("孙燕姿", "我怀念的"),
    ("梁静茹", "暖暖"),
    ("莫文蔚", "慢慢喜欢你"),
    ("周杰伦", "晴天"),
    ("郭采洁", "答案"),
    ("杨丞琳", "雨爱"),
]

SEPARATORS = re.compile(r"[_\-\–\—·.,，。:：;；/\\|()（）\[\]【】]+")


def norm(value: str) -> str:
    return T2S.convert(value or "").lower()


def segments(value: str) -> set[str]:
    parts = [part for part in SEPARATORS.sub(" ", norm(value)).split() if part]
    while parts and re.fullmatch(r"\d+", parts[0]):
        parts.pop(0)
    return set(parts)


def main() -> int:
    data = json.loads((ROOT / "data" / "scores.json").read_text(encoding="utf-8"))
    items = data.get("items", [])

    files = []
    for base in (SOURCE, EXTRACTED):
        if base.exists():
            files.extend(
                path for path in base.rglob("*")
                if path.is_file() and path.suffix.lower() in {".pdf", ".jpg", ".jpeg", ".png", ".webp"}
            )

    for singer, title in WANTED:
        q_title = norm(title)
        q_singer = norm(singer)
        matches = []
        for item in items:
            item_segments = segments(item["title"]) | segments(Path(item["source"]).stem)
            if q_title not in item_segments:
                continue
            blob = norm(" ".join([item["title"], item.get("composer", ""), item["source"]]))
            score = 100
            if q_singer and q_singer in blob:
                score += 35
            matches.append((score, item))
        matches.sort(key=lambda item: -item[0])

        file_matches = [
            path for path in files
            if q_title in segments(path.stem)
        ]

        print(f"\n{singer} - {title}")
        if matches:
            for score, item in matches[:3]:
                print(f"  ✓ [{score}] {item['title']} | {item['format']} {item.get('pages') or '?'}页 | {item['source']}")
        else:
            print("  ✗ 当前索引里没找到")
        known = {Path(item["source"]).stem for _, item in matches}
        extra = [path for path in file_matches if path.stem not in known]
        for path in extra[:3]:
            print(f"  文件（未入库/未匹配）：{path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
