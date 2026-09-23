#!/usr/bin/env python3
"""把 CS15 历史整包裁成浏览器真正会用的公共包 + 单地图包，再做 Brotli 11。"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import shutil
import struct
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PACKS = ROOT / "public/web/cs15/packs"
CS_MAPS = ("de_dust2", "de_dust", "cs_office")
HL_MAPS = ("crossfire", "boot_camp", "c0a0")
SKY_SIDES = ("bk", "dn", "ft", "lf", "rt", "up")
NATIVE_EXTENSIONS = {".dll", ".dylib", ".exe", ".icns", ".so"}
COMMON_WADS = {
    "cstrike/cached.wad", "cstrike/cstrike.wad", "cstrike/decals.wad",
    "valve/cached.wad", "valve/decals.wad", "valve/fonts.wad", "valve/gfx.wad",
    "valve/halflife.wad", "valve/liquids.wad", "valve/spraypaint.wad",
}
VALVE_CS_SOUND_DIRS = {"buttons", "common", "debris", "doors", "items", "plats", "player", "ui", "weapons"}
CS_SOUND_DIRS = {"ambience", "buttons", "common", "debris", "doors", "events", "hostage", "items", "misc", "plats", "player", "radio", "weapons"}
CS_TOP_DIRS = {"cl_dlls", "dlls", "events", "gfx", "logos", "manual", "maps", "models", "overviews", "resource", "sound", "sprites"}


@dataclass(frozen=True)
class Source:
    name: str
    size: int
    kind: str
    payload: object


def safe_name(value: str) -> str:
    name = value.replace("\\", "/").rstrip("/")
    parts = name.split("/")
    if not name or name.startswith("/") or any(not part or part in {".", ".."} for part in parts):
        raise ValueError(f"ZIP/PAK 含不安全路径：{value}")
    if any(ord(char) < 32 or char == ":" for char in name):
        raise ValueError(f"ZIP/PAK 含不安全路径：{value}")
    return name


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def common_reject(name: str) -> bool:
    lower = name.lower()
    suffix = Path(lower).suffix
    return (
        suffix in NATIVE_EXTENSIONS
        or "/maps/" in lower
        or "/overviews/" in lower
        or "/gfx/env/" in lower
        or lower.endswith(".nav")
        or lower.endswith(".dem")
        or "/replay/" in lower
        or (lower.endswith(".wad") and lower not in COMMON_WADS)
        or "/resource/background/" in lower
        or lower.startswith("valve/media/")
    )


def is_cs_common(name: str) -> bool:
    lower = name.lower()
    if not (lower.startswith("cstrike/") or lower.startswith("valve/")) or common_reject(lower):
        return False
    # CS 服务端启动时仍会统一 precache GoldSrc 的电池、弹壳、武器箱和碎块模型；
    # 删掉 valve/models 虽然能进图，但每轮都会刷 Could not load model，且掉落物可能不可见。
    if lower.startswith(("valve/sprites/1280/", "valve/sprites/2560/")):
        return False
    if lower.startswith("valve/sound/"):
        parts = lower.split("/")
        if len(parts) > 3 and parts[2] not in VALVE_CS_SOUND_DIRS:
            return False
    if not lower.startswith("cstrike/"):
        return True

    parts = lower.split("/")
    if len(parts) > 2 and parts[1] not in CS_TOP_DIRS:
        return False
    if lower.startswith("cstrike/sound/") and len(parts) > 3 and parts[2] not in CS_SOUND_DIRS:
        return False
    # 默认三张图不引用这些按自定义地图分目录放入的模型；保留根目录武器/人质和 player/shield。
    if lower.startswith("cstrike/models/"):
        relative = lower[len("cstrike/models/"):]
        if "/" in relative and relative.split("/")[0] not in {"player", "shield"}:
            return False
    if lower.startswith("cstrike/gfx/detail/"):
        return False
    return True


def is_hl_common(name: str) -> bool:
    lower = name.lower()
    return lower.startswith("valve/") and not common_reject(lower)


def pak_sources(path: Path) -> list[Source]:
    sources: list[Source] = []
    with path.open("rb") as pak:
        header = pak.read(12)
        if len(header) != 12 or header[:4] != b"PACK":
            raise ValueError("valve/pak0.pak 不是合法 Quake PAK")
        directory_at, directory_size = struct.unpack("<II", header[4:])
        if directory_size % 64:
            raise ValueError("valve/pak0.pak 目录长度损坏")
        pak.seek(0, os.SEEK_END)
        total = pak.tell()
        if directory_at + directory_size > total:
            raise ValueError("valve/pak0.pak 目录越界")
        pak.seek(directory_at)
        for _ in range(directory_size // 64):
            entry = pak.read(64)
            raw_name = entry[:56].split(b"\0", 1)[0].decode("utf-8", "strict")
            offset, size = struct.unpack("<II", entry[56:])
            if offset + size > total:
                raise ValueError(f"PAK 条目越界：{raw_name}")
            name = safe_name("valve/" + raw_name)
            sources.append(Source(name, size, "pak", (offset, size)))
    return sources


class PackBuilder:
    def __init__(self, outer: zipfile.ZipFile, pak_path: Path, sources: dict[str, Source]):
        self.outer = outer
        self.pak_path = pak_path
        self.sources = sources

    def copy(self, source: Source, target: BinaryIO) -> None:
        if source.kind == "bytes":
            target.write(source.payload)  # type: ignore[arg-type]
            return
        if source.kind == "zip":
            with self.outer.open(source.payload) as body:  # type: ignore[arg-type]
                shutil.copyfileobj(body, target, 1024 * 1024)
            return
        offset, size = source.payload  # type: ignore[misc]
        with self.pak_path.open("rb") as pak:
            pak.seek(offset)
            remaining = size
            while remaining:
                chunk = pak.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise EOFError(f"PAK 条目提前结束：{source.name}")
                target.write(chunk)
                remaining -= len(chunk)

    def read(self, source: Source) -> bytes:
        out = io.BytesIO()
        self.copy(source, out)
        return out.getvalue()

    def find(self, name: str) -> Source | None:
        return self.sources.get(name.lower())

    def find_basename(self, basename: str) -> Source | None:
        suffix = "/" + basename.lower()
        matches = [source for key, source in self.sources.items() if key.endswith(suffix)]
        matches.sort(key=lambda source: (not source.name.lower().startswith("cstrike/"), source.name.lower()))
        return matches[0] if matches else None


def bsp_dependencies(body: bytes) -> tuple[set[str], set[str]]:
    if len(body) < 124 or struct.unpack_from("<i", body, 0)[0] != 30:
        raise ValueError("地图不是 GoldSrc BSP v30")
    entity_at, entity_size = struct.unpack_from("<ii", body, 4)
    if entity_at < 0 or entity_size < 0 or entity_at + entity_size > len(body):
        raise ValueError("BSP entity lump 越界")
    text = body[entity_at:entity_at + entity_size].decode("latin-1")
    wads: set[str] = set()
    skies: set[str] = set()
    import re
    for value in re.findall(r'"wad"\s+"([^"]*)"', text, re.IGNORECASE):
        for item in value.replace("\\", "/").split(";"):
            basename = item.rsplit("/", 1)[-1].lower()
            if basename.endswith(".wad"):
                wads.add(basename)
    for value in re.findall(r'"skyname"\s+"([^"]*)"', text, re.IGNORECASE):
        if value and all(char.isalnum() or char in "_-" for char in value):
            skies.add(value.lower())
    return wads, skies


def map_entries(builder: PackBuilder, game: str, map_name: str) -> dict[str, Source]:
    directory = "cstrike" if game == "cs" else "valve"
    selected: dict[str, Source] = {}
    map_prefix = f"{directory}/maps/{map_name}".lower()
    for key, source in builder.sources.items():
        # c0a0a…c0a0e 是开篇连续换图；装在同一包里才不会走到第一扇门就缺图。
        family = game == "hl" and map_name == "c0a0"
        if (family and key.startswith(map_prefix)) or key.startswith(map_prefix + "."):
            selected[key] = source
        if game == "cs" and key.startswith(f"cstrike/overviews/{map_name}.".lower()):
            selected[key] = source

    bsps = [source for key, source in selected.items() if key.endswith(".bsp")]
    if not bsps:
        raise FileNotFoundError(f"源包缺少 {directory}/maps/{map_name}.bsp")
    for bsp in bsps:
        wads, skies = bsp_dependencies(builder.read(bsp))
        for wad in wads:
            found = builder.find_basename(wad)
            if found and found.name.lower() not in COMMON_WADS:
                selected[found.name.lower()] = found
        for sky in skies:
            for side in SKY_SIDES:
                for extension in ("tga", "bmp"):
                    for root in (directory, "valve", "cstrike"):
                        found = builder.find(f"{root}/gfx/env/{sky}{side}.{extension}")
                        if found:
                            selected[found.name.lower()] = found
                            break
    return selected


def zip_info(name: str, size: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.file_size = size
    info.external_attr = 0o100644 << 16
    info.create_system = 3
    return info


def write_store_zip(path: Path, entries: dict[str, Source], builder: PackBuilder) -> tuple[int, int]:
    files = 0
    size = 0
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for source in sorted(entries.values(), key=lambda item: item.name.lower()):
            with archive.open(zip_info(source.name, source.size), "w", force_zip64=False) as target:
                builder.copy(source, target)
            files += 1
            size += source.size
    # 流式加载器不能处理 descriptor；输出后直接检查第一条，防止 Python 行为变化后产出毒包。
    with path.open("rb") as source:
        head = source.read(30)
    if len(head) < 30 or head[:4] != b"PK\x03\x04" or struct.unpack_from("<H", head, 6)[0] & 0x08:
        raise ValueError(f"{path.name} 不是无 descriptor 的 store ZIP")
    return files, size


def gzip_file(source: Path, target: Path) -> None:
    with source.open("rb") as src, target.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as zipped:
            shutil.copyfileobj(src, zipped, 8 * 1024 * 1024)


def finalize_hashed(temp: Path, output: Path, key: str, suffix: str) -> tuple[str, str, int]:
    digest = sha256(temp)
    name = f"{key}.{digest[:12]}.{suffix}"
    target = output / name
    os.replace(temp, target)
    return name, digest, target.stat().st_size


def compress_pack(
    key: str,
    entries: dict[str, Source],
    builder: PackBuilder,
    temp_root: Path,
    output: Path,
    brotli: str,
    quality: int,
    gzip_fallback: bool,
    keep_zip: bool,
) -> dict[str, object]:
    raw = temp_root / f"{key}.zip"
    files, bytes_count = write_store_zip(raw, entries, builder)
    archive_sha = sha256(raw)

    br_temp = temp_root / f"{key}.zip.br"
    subprocess.run([brotli, "-q", str(quality), "-w", "24", "-f", "-o", str(br_temp), str(raw)], check=True)
    br_name, br_sha, br_bytes = finalize_hashed(br_temp, output, key, "zip.br")
    item: dict[str, object] = {
        "file": br_name,
        "contentEncoding": "br",
        "files": files,
        "bytes": bytes_count,
        "archiveBytes": raw.stat().st_size,
        "archiveSha256": archive_sha,
        "encodedBytes": br_bytes,
        "sha256": br_sha,
    }

    if gzip_fallback:
        gz_temp = temp_root / f"{key}.zip.gz"
        gzip_file(raw, gz_temp)
        gz_name, gz_sha, gz_bytes = finalize_hashed(gz_temp, output, key, "zip.gz")
        item.update({"fallback": gz_name, "fallbackBytes": gz_bytes, "fallbackSha256": gz_sha})
    if keep_zip:
        os.replace(raw, output / f"{key}.zip")
    raw_mb = bytes_count / 1048576
    print(f"  {key}: {files} 个文件 / {raw_mb:.1f} MB 原始 / {br_bytes / 1048576:.1f} MB Brotli")
    return item


def map_overrides(pack_dir: Path) -> dict[str, Source]:
    overrides: dict[str, Source] = {}
    for map_name in CS_MAPS:
        path = pack_dir / f"map-{map_name}.zip.gz"
        if not path.is_file():
            continue
        with gzip.open(path, "rb") as compressed:
            raw = compressed.read()
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            for entry in archive.infolist():
                if entry.is_dir():
                    continue
                name = safe_name(entry.filename)
                body = archive.read(entry)
                overrides[name.lower()] = Source(name, len(body), "bytes", body)
    return overrides


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_PACKS / "base.zip.gz")
    parser.add_argument("--output", type=Path, default=DEFAULT_PACKS)
    parser.add_argument("--include-hl", action="store_true", help="同时生成 Half-Life 精简包")
    parser.add_argument("--quality", type=int, default=11, choices=range(0, 12))
    parser.add_argument("--no-gzip-fallback", action="store_true")
    parser.add_argument("--keep-zip", action="store_true")
    args = parser.parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    if not source.is_file():
        raise FileNotFoundError(f"找不到输入包：{source}")
    brotli = shutil.which("brotli")
    if not brotli:
        raise RuntimeError("缺少 brotli CLI；macOS 用 `brew install brotli`，Ubuntu 用 `apt install brotli`")
    output.mkdir(parents=True, exist_ok=True)

    # 大包在系统临时目录里压十多分钟时，实测出现过 SHA 读完、os.replace 前源文件消失。
    # 暂存改到目标卷并做同目录原子改名，避免系统临时目录生命周期与跨目录移动这两个变量；
    # 不要和 Vite build 并行（构建会暂时搬走整个 packs 目录）。
    with tempfile.TemporaryDirectory(prefix=".repack-", dir=output) as directory:
        temp_root = Path(directory)
        raw_zip = temp_root / "source.zip"
        pak_path = temp_root / "pak0.pak"
        print("1/3 流式解开历史 gzip（只写临时文件，不进内存）…")
        with gzip.open(source, "rb") as src, raw_zip.open("wb") as dst:
            shutil.copyfileobj(src, dst, 8 * 1024 * 1024)

        with zipfile.ZipFile(raw_zip) as outer:
            pak_info = next((entry for entry in outer.infolist() if entry.filename.lower().rstrip("/") == "valve/pak0.pak"), None)
            if not pak_info:
                raise FileNotFoundError("历史包缺 valve/pak0.pak，无法还原其中的 Half-Life 公共素材")
            print("2/3 展开 pak0.pak 索引并建立去重视图…")
            with outer.open(pak_info) as src, pak_path.open("wb") as dst:
                shutil.copyfileobj(src, dst, 8 * 1024 * 1024)

            merged: dict[str, Source] = {item.name.lower(): item for item in pak_sources(pak_path)}
            for entry in outer.infolist():
                if entry.is_dir():
                    continue
                name = safe_name(entry.filename)
                if name.lower() == "valve/pak0.pak":
                    continue
                merged[name.lower()] = Source(name, entry.file_size, "zip", entry)
            merged.update(map_overrides(source.parent))
            builder = PackBuilder(outer, pak_path, merged)

            print(f"3/3 写入精简 store ZIP，并用 Brotli {args.quality} 做 HTTP 内容编码…")
            packs: dict[str, dict[str, object]] = {}
            profiles: dict[str, dict[str, object]] = {}
            cs_base = {key: item for key, item in merged.items() if is_cs_common(item.name)}
            packs["base-cs"] = compress_pack(
                "base-cs", cs_base, builder, temp_root, output, brotli, args.quality,
                not args.no_gzip_fallback, args.keep_zip,
            )
            cs_map_keys: dict[str, str] = {}
            for map_name in CS_MAPS:
                key = f"map-cs-{map_name}"
                packs[key] = compress_pack(
                    key, map_entries(builder, "cs", map_name), builder, temp_root, output, brotli,
                    args.quality, not args.no_gzip_fallback, args.keep_zip,
                )
                cs_map_keys[map_name] = key
            profiles["cs"] = {"base": "base-cs", "maps": cs_map_keys}

            if args.include_hl:
                hl_base = {key: item for key, item in merged.items() if is_hl_common(item.name)}
                packs["base-hl"] = compress_pack(
                    "base-hl", hl_base, builder, temp_root, output, brotli, args.quality,
                    not args.no_gzip_fallback, args.keep_zip,
                )
                hl_map_keys: dict[str, str] = {}
                for map_name in HL_MAPS:
                    key = f"map-hl-{map_name}"
                    packs[key] = compress_pack(
                        key, map_entries(builder, "hl", map_name), builder, temp_root, output, brotli,
                        args.quality, not args.no_gzip_fallback, args.keep_zip,
                    )
                    hl_map_keys[map_name] = key
                profiles["hl"] = {"base": "base-hl", "maps": hl_map_keys}

        manifest = {"schema": 2, "profiles": profiles, "packs": packs}
        index_temp = temp_root / "index.json"
        index_temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(index_temp, output / "index.json")
        print(f"完成：{output / 'index.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
