#!/usr/bin/env python3
"""按文件名从站点索引中移除指定曲谱，并删除对应的站点副本和缩略图。

只处理 data/scores.json 和 scores/、thumbs/，不碰源目录。
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGETS = {
    "最近3.png",
    "心墙.png",
    "值得1.jpg",
    "猪都笑了.jpg",
    "游乐场1.png",
    "雨蝶.jpg",
    "追梦人.jpg",
    "雨夜的浪漫.jpg",
    "01.png",
    "02.png",
    "03.png",
    "04.png",
    "06.png",
}


def main() -> int:
    data_path = ROOT / "data" / "scores.json"
    data = json.loads(data_path.read_text(encoding="utf-8"))
    items = data.get("items", [])

    removed = [item for item in items if Path(item["source"]).name in TARGETS]
    kept = [item for item in items if Path(item["source"]).name not in TARGETS]

    if not removed:
        print("没有匹配到目标文件，索引未改。")
        return 1

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = ROOT / "data" / ".backup"
    backup_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(data_path, backup_dir / f"scores-before-drum-removal-{stamp}.json")

    for item in removed:
        score_dir = ROOT / "scores" / item["id"]
        if score_dir.exists():
            shutil.rmtree(score_dir)
        thumb = ROOT / "thumbs" / f"{item['id']}.webp"
        if thumb.exists():
            thumb.unlink()

    data["items"] = kept
    data["generatedAt"] = datetime.now(timezone.utc).isoformat()
    stats = data.setdefault("stats", {})
    stats["count"] = len(kept)
    stats["bytes"] = sum(item.get("bytes", 0) for item in kept)
    stats["categories"] = sorted({item["category"] for item in kept if item.get("category")})
    stats["instruments"] = sorted({item["instrument"] for item in kept if item.get("instrument")})

    temp = data_path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temp.replace(data_path)

    report_dir = ROOT / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "removedAt": data["generatedAt"],
        "targets": sorted(TARGETS),
        "removed": [
            {
                "title": item["title"],
                "source": item["source"],
                "id": item["id"],
                "bytes": item.get("bytes", 0),
            }
            for item in removed
        ],
        "remaining": len(kept),
    }
    (report_dir / "deleted-scores.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"站点移除 {len(removed)} 份：")
    for item in removed:
        print(f"  {item['title']}  <-  {item['source']}")
    print(f"剩余：{len(kept)} 份")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
