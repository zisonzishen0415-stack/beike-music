#!/usr/bin/env python3
"""把一批本地曲谱文件整理成静态站点数据。

只读源目录：复制文件到 scores/，生成缩略图到 thumbs/，索引写到 data/scores.json。
不会删除源文件；默认也不会删除已生成的站点文件（需要 --prune 才清理孤儿文件）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

from PIL import Image, ImageOps
import fitz  # PyMuPDF
from opencc import OpenCC
from pypinyin import lazy_pinyin

T2S = OpenCC("t2s")
S2T = OpenCC("s2t")

PDF_EXTS = {".pdf"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
OUTPUT_DIR_NAMES = {"scores", "thumbs", "data", "node_modules", ".git", "scripts", "demo", "reports", "source-extracted"}

INSTRUMENTS: list[tuple[str, tuple[str, ...]]] = [
    ("钢琴", ("钢琴", "piano", "键盘")),
    ("吉他", ("吉他", "guitar", "指弹", "弹唱")),
    ("尤克里里", ("尤克里里", "ukulele", "uke")),
    ("小提琴", ("小提琴", "violin")),
    ("大提琴", ("大提琴", "cello")),
    ("古筝", ("古筝", "guzheng")),
    ("古琴", ("古琴", "guqin")),
    ("二胡", ("二胡", "erhu")),
    ("琵琶", ("琵琶", "pipa")),
    ("笛子", ("笛子", "竹笛", "长笛", "flute")),
    ("萨克斯", ("萨克斯", "saxophone", "sax")),
    ("架子鼓", ("架子鼓", "鼓谱", "drums")),
    ("电子琴", ("电子琴", "合成器", "synth")),
    ("手风琴", ("手风琴", "accordion")),
    ("口琴", ("口琴", "harmonica")),
    ("小号", ("小号", "trumpet")),
    ("单簧管", ("单簧管", "clarinet")),
    ("声乐", ("声乐", "合唱", "美声", "民歌", "通俗")),
    ("乐队总谱", ("总谱", "乐队", "band score", "full score")),
]

TAG_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("流行", ("流行", "pop", "热歌", "抖音")),
    ("古典", ("古典", "classical", "奏鸣曲", "协奏曲", "练习曲")),
    ("动漫", ("动漫", "二次元", "anime", "acg")),
    ("影视", ("影视", "电影", "电视", "ost", "原声")),
    ("游戏", ("游戏", "game", "bgm")),
    ("考级", ("考级", "grade", "等级")),
    ("儿歌", ("儿歌", "儿童", "童谣")),
    ("爵士", ("爵士", "jazz")),
    ("摇滚", ("摇滚", "rock")),
    ("民谣", ("民谣", "folk")),
    ("伴奏", ("伴奏", "accompaniment")),
    ("独奏", ("独奏", "solo")),
    ("指弹", ("指弹", "fingerstyle")),
]

PAGE_SUFFIX_PATTERNS = [
    re.compile(r"^(?P<base>.+?)[\s_\-—]*第\s*(?P<num>\d{1,3})\s*页$"),
    re.compile(r"^(?P<base>.+?)[\s_\-.]+(?:p|page|pg)[\s_\-.]*(?P<num>\d{1,3})$", re.IGNORECASE),
    re.compile(r"^(?P<base>.+?)[\s_\-.]+[(（]?(?P<num>\d{1,3})[)）]?$"),
    # 网盘里常见的「一万次悲伤1.jpg / 以父之名2.jpg」：末尾 1-3 位数字直接当页码
    re.compile(r"^(?P<base>.*\D)(?P<num>\d{1,3})$"),
]

LEADING_NUMBER_RE = re.compile(r"^(?:\s*\d{1,4}\s*[.、_\-—\s]+\s*)+")
BRACKET_COMPOSER_RE = re.compile(r"^[【\[［(（]\s*(?P<composer>[^】\]］)）]{1,24})\s*[】\]］)）]\s*(?P<title>.+)$")


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def rel_posix(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def natural_key(value: str) -> list[Any]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def strip_page_suffix(stem: str) -> tuple[str, int | None]:
    for pattern in PAGE_SUFFIX_PATTERNS:
        match = pattern.match(stem)
        if match and match.group("base").strip():
            return match.group("base").strip(), int(match.group("num"))
    return stem.strip(), None


def clean_title(value: str) -> str:
    title = unicodedata.normalize("NFKC", value).strip()
    title = LEADING_NUMBER_RE.sub("", title)
    title = re.sub(r"\s+", " ", title).strip(" ._-—·")
    return title or value.strip()


def parse_title(text: str) -> tuple[str, str]:
    """从文件名里分离出可能的作曲者和曲名，识别不了就把整串当曲名。"""
    normalized = unicodedata.normalize("NFKC", text).strip()
    match = BRACKET_COMPOSER_RE.match(normalized)
    if match:
        return clean_title(match.group("title")), match.group("composer").strip()
    return clean_title(normalized), ""


def infer_by_keywords(text: str, table: Iterable[tuple[str, tuple[str, ...]]]) -> list[str]:
    lowered = text.lower()
    found = []
    for label, keywords in table:
        if any(keyword.lower() in lowered for keyword in keywords):
            found.append(label)
    return found


def pinyin_text(text: str) -> tuple[str, str]:
    normalized = unicodedata.normalize("NFKC", text)
    syllables = [s for s in lazy_pinyin(normalized) if s.strip()]
    full = "".join(syllables).lower()
    initials = "".join(s[0] for s in syllables if s).lower()
    return full, initials


def file_id(rel: str) -> str:
    return hashlib.sha1(rel.encode("utf-8")).hexdigest()[:12]


def load_overrides(project_root: Path) -> dict[str, dict[str, Any]]:
    path = project_root / "meta" / "overrides.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"meta/overrides.json 不是合法 JSON：{exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit("meta/overrides.json 顶层必须是对象（键是路径或文件名）。")
    return data


def apply_override(entry: dict[str, Any], overrides: dict[str, dict[str, Any]]) -> dict[str, Any]:
    candidates = [entry["source"], Path(entry["source"]).name, entry["id"]]
    for key in candidates:
        if key in overrides:
            patch = overrides[key]
            if not isinstance(patch, dict):
                raise SystemExit(f"overrides 里 {key!r} 的值必须是对象。")
            for field in ("title", "composer", "category", "instrument"):
                if patch.get(field):
                    entry[field] = str(patch[field]).strip()
            if isinstance(patch.get("tags"), list):
                entry["tags"] = [str(tag).strip() for tag in patch["tags"] if str(tag).strip()]
            if isinstance(patch.get("aliases"), list):
                entry["aliases"] = [str(alias).strip() for alias in patch["aliases"] if str(alias).strip()]
            if patch.get("hide") is True:
                entry["hidden"] = True
            entry["overriddenBy"] = key
            break
    return entry


def collect_entries(source_root: Path, project_root: Path, prefix: str = "") -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    entries: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    output_paths = {(project_root / name).resolve() for name in OUTPUT_DIR_NAMES}

    for dirpath, dirnames, filenames in os.walk(source_root):
        current = Path(dirpath)
        # 跳过站点自己的输出目录，避免把生成物当源文件再次入库
        dirnames[:] = sorted(
            name for name in dirnames
            if (current / name).resolve() not in output_paths and not name.startswith(".")
        )
        pdfs: list[Path] = []
        images: list[Path] = []
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            path = current / name
            suffix = path.suffix.lower()
            if suffix in PDF_EXTS:
                pdfs.append(path)
            elif suffix in IMAGE_EXTS:
                images.append(path)
            else:
                rel = rel_posix(path, source_root)
                skipped.append({
                    "path": f"{prefix}/{rel}" if prefix else rel,
                    "reason": f"不支持的格式：{suffix or '无扩展名'}",
                })

        entries.extend(group_pdfs(pdfs, source_root, prefix))
        entries.extend(group_images(images, current, source_root, prefix))

    return entries, skipped


def base_entry(path: Path, source_root: Path, prefix: str = "") -> dict[str, Any]:
    local = rel_posix(path, source_root)
    rel = f"{prefix}/{local}" if prefix else local
    return {
        "id": file_id(rel),
        "source": rel,
        "folder": path.parent.relative_to(source_root).as_posix() if path.parent != source_root else "",
        "title": "",
        "composer": "",
        "category": "",
        "instrument": "",
        "tags": [],
        "aliases": [],
        "format": "",
        "pages": 0,
        "bytes": path.stat().st_size,
        "files": [],
        "thumb": "",
        "added": datetime.fromtimestamp(path.stat().st_ctime, tz=timezone.utc).isoformat(),
        "modified": datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat(),
        "_sourcePath": str(path),
    }


def make_pdf_entry(path: Path, source_root: Path, prefix: str = "") -> dict[str, Any]:
    entry = base_entry(path, source_root, prefix)
    title, composer = parse_title(path.stem)
    meta_title, meta_author = "", ""
    try:
        doc = fitz.open(path)
        info = doc.metadata or {}
        doc.close()
        meta_title = (info.get("title") or "").strip()
        meta_author = (info.get("author") or "").strip()
    except Exception:  # noqa: BLE001 - 元数据读不到不影响入库
        pass

    generic = re.compile(r"^(untitled|无标题|microsoft word|document\d*|.*\.(docx?|pdf|indd))$", re.IGNORECASE)
    if meta_title and not generic.match(meta_title) and meta_title != title:
        entry["aliases"] = [meta_title]
    if not composer and meta_author and not generic.match(meta_author):
        composer = meta_author

    entry.update({"title": title, "composer": composer, "format": "pdf", "files": [], "pages": None})
    return entry


def group_pdfs(pdfs: list[Path], source_root: Path, prefix: str = "") -> list[dict[str, Any]]:
    """把同一目录下的 xx1.pdf / xx2.pdf 按页码合成一份谱。"""
    groups: dict[str, list[tuple[int, Path]]] = {}
    standalone: list[Path] = []
    for path in pdfs:
        base, number = strip_page_suffix(path.stem)
        if number is None:
            standalone.append(path)
        else:
            groups.setdefault(base or path.stem, []).append((number, path))

    entries = [make_pdf_entry(path, source_root, prefix) for path in standalone]

    for base, items in groups.items():
        items.sort(key=lambda item: (item[0], natural_key(item[1].name)))
        paths = [path for _, path in items]
        entry = make_pdf_entry(paths[0], source_root, prefix)
        title, composer = parse_title(base)
        entry["title"] = title
        if composer:
            entry["composer"] = composer
        if len(paths) > 1:
            entry["_pdfPaths"] = [str(path) for path in paths]
            entry["bytes"] = sum(path.stat().st_size for path in paths)
            total_pages = 0
            for path in paths:
                try:
                    doc = fitz.open(path)
                    total_pages += doc.page_count
                    doc.close()
                except Exception:  # noqa: BLE001 - 单页读不到不影响合并
                    pass
            entry["pages"] = total_pages or None
        entries.append(entry)

    return entries


def group_images(images: list[Path], directory: Path, source_root: Path, prefix: str = "") -> list[dict[str, Any]]:
    if not images:
        return []

    stem_info = {path: strip_page_suffix(path.stem) for path in images}
    groups: dict[str, list[Path]] = {}

    # 纯数字文件名（1.jpg / 02.png）只有在整个文件夹都是数字时才当成一份谱；
    # 混杂在大量散谱里的 01.png 更可能是单独截图，按单张处理，避免拼成假条目。
    numeric_paths = [path for path in images if path.stem.strip().isdigit()]
    if numeric_paths:
        if len(numeric_paths) == len(images):
            groups[directory.name or "未命名"] = numeric_paths
        else:
            for path in numeric_paths:
                groups[path.stem] = [path]

    for path in images:
        if path.stem.strip().isdigit():
            continue
        base, _ = stem_info[path]
        key = base or directory.name or path.stem
        groups.setdefault(key, []).append(path)

    entries = []
    for key, paths in groups.items():
        paths = sorted(paths, key=lambda p: (stem_info[p][1] if stem_info[p][1] is not None else 0, natural_key(p.name)))
        first = paths[0]
        entry = base_entry(first, source_root, prefix)
        title, composer = parse_title(key)
        entry.update({"title": title, "composer": composer, "format": "image", "pages": len(paths)})
        entry["bytes"] = sum(path.stat().st_size for path in paths)
        entries.append(entry)
        for path in paths:
            entry.setdefault("_imagePaths", []).append(path)
    return entries


def enrich(entry: dict[str, Any]) -> dict[str, Any]:
    folder_text = entry.get("folder", "")
    if not entry.get("category"):
        entry["category"] = folder_text.split("/")[0] if folder_text else "未分类"
    if not entry.get("instrument"):
        instruments = infer_by_keywords(folder_text + " " + entry["title"], INSTRUMENTS)
        entry["instrument"] = instruments[0] if instruments else "其他"
    if not entry.get("tags"):
        entry["tags"] = infer_by_keywords(folder_text + " " + entry["title"], TAG_KEYWORDS)

    search_bits = [entry["title"], entry.get("composer", ""), entry.get("instrument", ""),
                   entry.get("category", ""), folder_text, " ".join(entry.get("tags", [])),
                   " ".join(entry.get("aliases", [])), Path(entry["source"]).name]
    plain = " ".join(bit for bit in search_bits if bit)
    py, pyi = pinyin_text(plain)
    title_py, title_pyi = pinyin_text(entry["title"])
    entry["search"] = {
        "py": py,
        "pyi": pyi,
        "titlePy": title_py,
        "titlePyi": title_pyi,
        "simp": T2S.convert(plain),
        "trad": S2T.convert(plain),
        "titleSimp": T2S.convert(entry["title"]),
        "titleTrad": S2T.convert(entry["title"]),
    }
    return entry


def thumbnail_from_pdf(path: Path, dest: Path, width: int = 420) -> int:
    doc = fitz.open(path)
    try:
        if doc.page_count == 0:
            raise ValueError("PDF 没有页面")
        page = doc.load_page(0)
        rect = page.rect
        zoom = width / max(rect.width, 1)
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        image.save(dest, "WEBP", quality=78, method=6)
        return doc.page_count
    finally:
        doc.close()


def thumbnail_from_image(path: Path, dest: Path, width: int = 420) -> None:
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        if image.width > width:
            height = round(image.height * width / image.width)
            image = image.resize((width, height), Image.LANCZOS)
        image.save(dest, "WEBP", quality=78, method=6)


def save_web_image(source: Path, target: Path, max_side: int = 1800, quality: int = 82) -> None:
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened)
        if image.mode in {"RGBA", "LA", "P"}:
            rgba = image.convert("RGBA")
            background = Image.new("RGB", rgba.size, "white")
            background.paste(rgba, mask=rgba.split()[-1])
            image = background
        else:
            image = image.convert("RGB")
        scale = min(1.0, max_side / max(image.width, image.height))
        if scale < 1:
            image = image.resize(
                (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
                Image.LANCZOS,
            )
        image.save(target, "WEBP", quality=quality, method=6)


def file_digest(path: Path) -> str:
    digest = hashlib.sha1()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def entry_digest(entry: dict[str, Any]) -> str:
    if entry.get("_imagePaths"):
        paths = [Path(path) for path in entry["_imagePaths"]]
    elif entry.get("_pdfPaths"):
        paths = [Path(path) for path in entry["_pdfPaths"]]
    else:
        paths = [Path(entry["_sourcePath"])]
    digest = hashlib.sha1()
    for path in paths:
        digest.update(file_digest(path).encode("ascii"))
    return digest.hexdigest()


def copy_score_files(entry: dict[str, Any], project_root: Path, dry_run: bool) -> list[str]:
    score_dir = project_root / "scores" / entry["id"]
    urls: list[str] = []

    if entry["format"] == "pdf":
        paths = [Path(path) for path in entry.get("_pdfPaths", [entry["_sourcePath"]])]
        target = score_dir / "score.pdf"
        urls.append(f"scores/{entry['id']}/score.pdf")
        if not dry_run:
            score_dir.mkdir(parents=True, exist_ok=True)
            if len(paths) > 1:
                try:
                    merged = fitz.open()
                    try:
                        for path in paths:
                            source = fitz.open(path)
                            try:
                                merged.insert_pdf(source)
                            finally:
                                source.close()
                        merged.save(target, garbage=3, deflate=True)
                    finally:
                        merged.close()
                except Exception as exc:  # noqa: BLE001 - 合并失败时至少保留第一份
                    entry.setdefault("_warnings", []).append(
                        f"PDF 合并失败，仅保留第一页文件 {entry['source']}: {exc}"
                    )
                    shutil.copy2(paths[0], target)
            else:
                shutil.copy2(paths[0], target)
            entry["bytes"] = target.stat().st_size
        return urls

    paths = entry.pop("_imagePaths", [])
    written: list[Path] = []
    if not dry_run:
        score_dir.mkdir(parents=True, exist_ok=True)
    for index, source in enumerate(paths, start=1):
        filename = f"page-{index:03d}.webp"
        url = f"scores/{entry['id']}/{filename}"
        if not dry_run:
            target = score_dir / filename
            target.unlink(missing_ok=True)
            try:
                save_web_image(source, target)
            except Exception as exc:  # noqa: BLE001 - 转码失败时退回原图
                target.unlink(missing_ok=True)
                suffix = source.suffix.lower()
                if suffix == ".jpeg":
                    suffix = ".jpg"
                filename = f"page-{index:03d}{suffix}"
                target = score_dir / filename
                url = f"scores/{entry['id']}/{filename}"
                shutil.copy2(source, target)
                entry.setdefault("_warnings", []).append(
                    f"图片转 WebP 失败，保留原图 {entry['source']}: {exc}"
                )
            written.append(target)
        urls.append(url)
    if not dry_run and written:
        entry["bytes"] = sum(path.stat().st_size for path in written)
    return urls


def make_thumbnail(entry: dict[str, Any], project_root: Path, dry_run: bool) -> list[str]:
    warnings: list[str] = []
    dest = project_root / "thumbs" / f"{entry['id']}.webp"
    if not dry_run:
        dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        if entry["format"] == "pdf":
            pages = thumbnail_from_pdf(Path(entry["_sourcePath"]), dest) if not dry_run else None
            if pages is not None and entry.get("pages") is None:
                entry["pages"] = pages
        else:
            first = entry["_imagePaths"][0]
            if not dry_run:
                thumbnail_from_image(first, dest)
    except Exception as exc:  # noqa: BLE001 - 单个文件失败不能拖垮整批
        warnings.append(f"缩略图失败 {entry['source']}: {exc}")
    entry["thumb"] = f"thumbs/{entry['id']}.webp"
    return warnings


def human_bytes(value: int) -> str:
    size = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{value} B"


def safe_dir_name(stem: str) -> str:
    cleaned = re.sub(r"[^\w一-鿿.-]+", "_", stem)
    return (cleaned[:60].strip("._") or "archive")


def zip_member_name(info: zipfile.ZipInfo) -> str:
    """修复 Windows 压缩包里没打 UTF-8 标记的中文文件名。"""
    name = info.filename
    if info.flag_bits & 0x800:
        return name
    try:
        repaired = name.encode("cp437").decode("utf-8")
        if repaired != name:
            return repaired
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    try:
        return name.encode("cp437").decode("gbk")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name


def extract_zips(source_root: Path, project_root: Path) -> tuple[list[tuple[Path, str]], list[dict[str, Any]], list[str]]:
    """把源目录里的 zip 解到 source-extracted/，返回 (解压目录, 报告, 警告)。

    解压目录按 zip 路径 + 大小 + 修改时间做缓存；不会写源目录，也不会覆盖源文件。
    """
    cache_root = project_root / "source-extracted"
    extracted: list[tuple[Path, str]] = []
    reports: list[dict[str, Any]] = []
    warnings: list[str] = []

    zips = sorted(
        path for path in source_root.rglob("*")
        if path.is_file() and path.suffix.lower() == ".zip"
    )
    if not zips:
        return extracted, reports, warnings

    for zip_path in zips:
        display = rel_posix(zip_path, source_root)
        try:
            stat = zip_path.stat()
            key = hashlib.sha1(
                f"{zip_path}|{stat.st_size}|{stat.st_mtime_ns}".encode("utf-8")
            ).hexdigest()[:10]
        except OSError as exc:
            warnings.append(f"读取压缩包失败 {display}: {exc}")
            continue

        dest = cache_root / f"{safe_dir_name(zip_path.stem)}-{key}"
        marker = dest / ".extracted"
        report: dict[str, Any] = {"zip": display, "dest": str(dest), "files": 0, "status": ""}

        if marker.exists():
            report["status"] = "cached"
            extracted.append((dest, display))
            reports.append(report)
            continue

        temp = cache_root / f"{dest.name}.tmp"
        try:
            with zipfile.ZipFile(zip_path) as archive:
                infos = archive.infolist()
                total_size = sum(info.file_size for info in infos)
                if len(infos) > 5000 or total_size > 2 * 1024 ** 3:
                    raise ValueError(
                        f"压缩包过大：{len(infos)} 个文件 / {human_bytes(total_size)}"
                    )

                shutil.rmtree(temp, ignore_errors=True)
                temp.mkdir(parents=True, exist_ok=True)
                root = temp.resolve()
                count = 0
                for info in infos:
                    name = zip_member_name(info).replace("\\", "/")
                    if not name or name.endswith("/"):
                        continue
                    parts = PurePosixPath(name).parts
                    if name.startswith("/") or ".." in parts or "__MACOSX" in parts:
                        warnings.append(f"跳过压缩包内可疑路径 {display}: {name}")
                        continue
                    if PurePosixPath(name).name in {".DS_Store", "Thumbs.db"}:
                        continue
                    target = (root / name).resolve()
                    if target != root and root not in target.parents:
                        warnings.append(f"跳过越界路径 {display}: {name}")
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info) as src, open(target, "wb") as out:
                        shutil.copyfileobj(src, out)
                    count += 1

                (temp / ".extracted").write_text(
                    json.dumps({"zip": display, "files": count}, ensure_ascii=False),
                    encoding="utf-8",
                )
                if dest.exists():
                    shutil.rmtree(dest)
                temp.rename(dest)

            report.update({"files": count, "status": "extracted"})
            extracted.append((dest, display))
        except Exception as exc:  # noqa: BLE001 - 单个压缩包失败不影响其它
            report["status"] = f"failed: {exc}"
            warnings.append(f"解压失败 {display}: {exc}")
            shutil.rmtree(temp, ignore_errors=True)
        reports.append(report)

    return extracted, reports, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="扫描曲谱目录，生成静态站点数据。")
    parser.add_argument("--src", required=True, help="曲谱源目录（百度网盘下载到本地的文件夹）")
    parser.add_argument("--dest", default=Path(__file__).resolve().parent.parent, help="站点项目根目录")
    parser.add_argument("--dry-run", action="store_true", help="只统计，不复制文件")
    parser.add_argument("--prune", action="store_true", help="显式清理 scores/ 和 thumbs/ 里这次没生成的孤儿文件")
    parser.add_argument("--no-extract", action="store_true", help="不解压源目录里的 zip")
    parser.add_argument("--allow-empty", action="store_true", help="源目录没有可用曲谱时也生成空索引")
    args = parser.parse_args()

    source_root = Path(args.src).expanduser().resolve()
    project_root = Path(args.dest).expanduser().resolve()
    if not source_root.is_dir():
        eprint(f"源目录不存在：{source_root}")
        return 2
    if source_root == project_root:
        eprint("源目录不能等于项目根目录，请把下载的曲谱放在单独的文件夹里。")
        return 2

    print(f"扫描：{source_root}")
    extracted_roots: list[tuple[Path, str]] = []
    zip_reports: list[dict[str, Any]] = []
    warnings: list[str] = []
    if not args.no_extract:
        extracted_roots, zip_reports, zip_warnings = extract_zips(source_root, project_root)
        warnings.extend(zip_warnings)
        if extracted_roots:
            print(f"解压压缩包：{len(extracted_roots)} 个")

    entries: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    for root, prefix in [(source_root, ""), *extracted_roots]:
        root_entries, root_skipped = collect_entries(root, project_root, prefix)
        entries.extend(root_entries)
        skipped.extend(root_skipped)

    if not args.no_extract:
        skipped = [item for item in skipped if not item["path"].lower().endswith(".zip")]

    if not entries and not args.allow_empty:
        eprint("没有找到任何 PDF 或图片。请确认路径，或检查扩展名。")
        return 3

    overrides = load_overrides(project_root)
    entries = [enrich(apply_override(entry, overrides)) for entry in entries]
    hidden = [entry for entry in entries if entry.get("hidden")]
    entries = [entry for entry in entries if not entry.get("hidden")]

    # 内容完全相同的副本只保留一份（源文件不动）
    seen: dict[str, dict[str, Any]] = {}
    unique_entries: list[dict[str, Any]] = []
    duplicate_entries: list[dict[str, str]] = []
    duplicate_bytes = 0
    for entry in entries:
        try:
            signature = entry_digest(entry)
        except Exception as exc:  # noqa: BLE001 - 单个文件读失败时保留该条目
            warnings.append(f"去重读取失败，保留原条目 {entry['source']}: {exc}")
            unique_entries.append(entry)
            continue
        if signature in seen:
            duplicate_entries.append({
                "title": entry["title"],
                "kept": seen[signature]["source"],
                "dropped": entry["source"],
            })
            duplicate_bytes += entry["bytes"]
        else:
            seen[signature] = entry
            unique_entries.append(entry)
    entries = unique_entries

    for entry in entries:
        warnings.extend(make_thumbnail(entry, project_root, args.dry_run))
        entry["files"] = copy_score_files(entry, project_root, args.dry_run)
        warnings.extend(entry.pop("_warnings", []))
        entry.pop("_imagePaths", None)

    for entry in entries:
        for internal in ("hidden", "overriddenBy", "_sourcePath", "_pdfPaths"):
            entry.pop(internal, None)

    # 标题完全相同的条目提示出来，但不自动合并
    title_map: dict[str, list[str]] = {}
    for entry in entries:
        title_map.setdefault(entry["title"], []).append(entry["source"])
    duplicate_titles = {title: paths for title, paths in title_map.items() if len(paths) > 1}

    total_bytes = sum(entry["bytes"] for entry in entries)
    large_files = [
        {"source": entry["source"], "bytes": entry["bytes"]}
        for entry in entries if entry["bytes"] > 100 * 1024 * 1024
    ]

    entries.sort(key=lambda entry: (natural_key(entry["title"]), entry["source"]))
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "stats": {
            "count": len(entries),
            "bytes": total_bytes,
            "hidden": len(hidden),
            "skipped": len(skipped),
            "categories": sorted({entry["category"] for entry in entries}),
            "instruments": sorted({entry["instrument"] for entry in entries}),
        },
        "items": entries,
    }

    data_dir = project_root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    output = data_dir / "scores.json"
    if output.exists():
        backup_dir = data_dir / ".backup"
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(output, backup_dir / f"scores-{stamp}.json")

    if args.dry_run:
        print("dry-run：未写入任何文件。")
    else:
        temp = output.with_suffix(".json.tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(temp, output)

    prune_report = None
    if args.prune and not args.dry_run:
        keep_ids = {entry["id"] for entry in entries}
        removed = []
        for folder in ("scores", "thumbs"):
            root = project_root / folder
            if not root.exists():
                continue
            for child in root.iterdir():
                key = child.stem if folder == "thumbs" else child.name
                if key not in keep_ids:
                    removed.append(str(child.relative_to(project_root)))
                    if child.is_dir():
                        shutil.rmtree(child)
                    else:
                        child.unlink()
        prune_report = removed

    report_dir = project_root / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "generatedAt": payload["generatedAt"],
        "sourceRoot": str(source_root),
        "dryRun": args.dry_run,
        "stats": payload["stats"],
        "extractedZips": zip_reports,
        "duplicateTitles": duplicate_titles,
        "duplicateEntries": duplicate_entries[:500],
        "duplicateEntriesTotal": len(duplicate_entries),
        "duplicateBytes": duplicate_bytes,
        "largeFiles": large_files,
        "skipped": skipped,
        "warnings": warnings,
        "pruned": prune_report,
    }
    (report_dir / "ingest-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print()
    print(f"曲谱：{len(entries)} 份")
    print(f"输出合计：{human_bytes(total_bytes)}")
    print(f"跳过：{len(skipped)} 个文件（列表见 reports/ingest-report.json）")
    if zip_reports:
        ok = sum(1 for item in zip_reports if item["status"] in {"extracted", "cached"})
        print(f"压缩包：{ok}/{len(zip_reports)} 个已解压")
    if hidden:
        print(f"按 overrides 隐藏：{len(hidden)} 份")
    if duplicate_entries:
        print(f"完全重复：去掉 {len(duplicate_entries)} 份，省 {human_bytes(duplicate_bytes)}")
    if duplicate_titles:
        print(f"重名提示：{len(duplicate_titles)} 组标题重复，未自动合并")
    if warnings:
        print(f"警告：{len(warnings)} 条（缩略图失败等，见报告）")
    if large_files:
        print(f"注意：{len(large_files)} 个文件超过 100MB，GitHub 会拒绝推送")
    if prune_report is not None:
        print(f"已清理孤儿文件：{len(prune_report)} 个")
    if not args.dry_run:
        print(f"索引：{output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
