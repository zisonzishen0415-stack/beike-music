#!/usr/bin/env python3
"""裁掉品牌 logo 的白边并把白色背景转成透明，保留黄橙红渐变和黑字。"""

from pathlib import Path

from PIL import Image, ImageChops, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "brand-logo-original.png"
TARGET = ROOT / "assets" / "brand-logo.png"
MARK = ROOT / "assets" / "brand-mark.png"


def main() -> None:
    image = Image.open(SOURCE).convert("RGBA")
    r, g, b, _ = image.split()
    lightness = ImageChops.darker(ImageChops.darker(r, g), b)
    alpha = ImageOps.invert(lightness)

    # 裁掉接近纯白的边，留 8px 呼吸
    solid = alpha.point(lambda value: 255 if value > 10 else 0)
    bbox = solid.getbbox()
    if bbox:
        left, top, right, bottom = bbox
        pad = 8
        bbox = (
            max(0, left - pad),
            max(0, top - pad),
            min(image.width, right + pad),
            min(image.height, bottom + pad),
        )
        image = image.crop(bbox)
        alpha = alpha.crop(bbox)

    image.putalpha(alpha)
    image.save(TARGET)

    # logo 上半部分是音符标记，单独切出来做 favicon
    mark_height = int(image.height * 0.64)
    mark = image.crop((0, 0, image.width, mark_height))
    mark.save(MARK)
    print(f"{TARGET} {image.size}, {MARK} {mark.size}")


if __name__ == "__main__":
    main()
