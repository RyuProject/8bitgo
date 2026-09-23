#!/usr/bin/env python3
"""把历史的整包 ZIP+gzip 转成「公共运行时 + 单地图」的流式 USTAR 包。"""

from __future__ import annotations

import gzip
import io
import os
import shutil
import sys
import tarfile
import tempfile
import zipfile
from contextlib import ExitStack, contextmanager
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "public/web/cs16/packs/base.zip.gz"
DEFAULT_OUTPUT = ROOT / "public/web/cs16/packs"
MAPS = (
    "de_dust2",
    "de_dust",
    "de_inferno",
    "de_nuke",
    "de_aztec",
    "de_train",
    "de_cbble",
    "cs_office",
    "cs_italy",
    "cs_assault",
    "cs_militia",
    "de_vertigo",
)
NATIVE_EXTENSIONS = {".dll", ".dylib", ".exe", ".icns", ".so"}
COMMON_WADS = {
    "cstrike/cached.wad", "cstrike/cstrike.wad", "cstrike/decals.wad",
    "valve/cached.wad", "valve/decals.wad", "valve/fonts.wad", "valve/gfx.wad",
    "valve/halflife.wad", "valve/liquids.wad", "valve/spraypaint.wad",
}
VALVE_SOUND_DIRS = {"buttons", "common", "debris", "doors", "items", "plats", "player", "ui", "weapons"}
VALVE_MODELS = {
    "agibs.mdl", "grenade.mdl", "hgibs.mdl", "mil_crategibs.mdl", "shotgunshell.mdl",
    # inferno 的可破坏金属物体会直接生成这三种碎片；漏掉时地图能进，但控制台持续报模型缺失。
    "metalplategibs.mdl", "metalplategibs_dark.mdl", "metalplategibs_green.mdl",
    # GoldSrc 的 *t.mdl 是外置纹理伴随文件；只保留主体会让每次开图都报 missing textures。
    "w_9mmclip.mdl", "w_9mmclipt.mdl", "w_antidote.mdl", "w_antidotet.mdl",
    "w_battery.mdl", "w_batteryt.mdl", "w_longjump.mdl", "w_longjumpt.mdl",
    "w_security.mdl", "w_securityt.mdl", "w_shotbox.mdl", "w_shotboxt.mdl",
    "w_weaponbox.mdl",
}
MAP_SKIES = {
    "de_dust2": "des", "de_dust": "des", "de_inferno": "green", "de_nuke": "desert",
    "de_aztec": "doom1", "de_train": "trainyard", "de_cbble": "green", "cs_office": "office",
    "cs_italy": "green", "cs_assault": "city1", "cs_militia": "cliff", "de_vertigo": "tsccity_",
}
MAP_WADS = {
    "de_dust2": {"cs_dust.wad"},
    "de_dust": {"cs_dust.wad"},
    "de_inferno": {"chateau.wad", "cs_bdog.wad", "cs_havana.wad", "cs_office.wad", "de_airstrip.wad", "de_aztec.wad", "de_piranesi.wad"},
    "de_nuke": set(),
    "de_aztec": {"chateau.wad", "cs_bdog.wad", "cs_havana.wad", "cs_office.wad", "de_airstrip.wad", "de_aztec.wad", "de_piranesi.wad"},
    "de_train": {"cs_bdog.wad"},
    "de_cbble": {"cs_cbble.wad"},
    "cs_office": {"cs_bdog.wad", "cs_office.wad"},
    "cs_italy": {"itsitaly.wad"},
    "cs_assault": {"cs_assault.wad"},
    "cs_militia": set(),
    "de_vertigo": {"de_vertigo.wad"},
}


def safe_name(value: str) -> str:
    name = value.replace("\\", "/").rstrip("/")
    parts = name.split("/")
    if not name or name.startswith("/") or any(not part or part in {".", ".."} for part in parts):
        raise ValueError(f"ZIP 含不安全路径：{value}")
    if any(ord(char) < 32 or char == ":" for char in name):
        raise ValueError(f"ZIP 含不安全路径：{value}")
    return name


def map_targets(name: str) -> list[str]:
    parts = name.split("/")
    filename = parts[-1].lower()
    if len(parts) >= 3 and parts[:2] in (["cstrike", "maps"], ["cstrike", "overviews"]):
        return [map_name for map_name in MAPS if filename.startswith(f"{map_name}.") or filename.startswith(f"{map_name}_")]
    if len(parts) >= 4 and parts[1:3] == ["gfx", "env"]:
        sides = ("bk", "dn", "ft", "lf", "rt", "up")
        return [map_name for map_name, sky in MAP_SKIES.items() if filename in {f"{sky.lower()}{side}.tga" for side in sides}]
    if name.lower().endswith(".wad"):
        return [map_name for map_name, wads in MAP_WADS.items() if filename in wads]
    return []


def is_common(name: str) -> bool:
    # HL 单人地图、其它 CS 地图和全部雷达图占 330MB；玩家一次只会启动一张地图。
    if "/maps/" in name or "/overviews/" in name:
        return False
    # 天空盒与大部分 WAD 只跟当前地图走，避免十二张地图的纹理同时常驻内存。
    if "/gfx/env/" in name:
        return False
    if name.lower().endswith(".wad") and name.lower() not in COMMON_WADS:
        return False
    # 原生桌面动态库在 WebAssembly 里永远不会加载，留着只会多占约 44MB MEMFS。
    if Path(name).suffix.lower() in NATIVE_EXTENSIONS:
        return False
    # Half-Life 原声和启动视频不参与 CS 对局，移除约 61MB，避免浏览器 OOM。
    if name.startswith("valve/media/"):
        return False
    # 主菜单的 19MB 动态背景和 HL 单人角色模型不会在 CS 对局中使用。
    if name.startswith("valve/resource/background/"):
        return False
    if name.startswith("valve/models/") and Path(name).name.lower() not in VALVE_MODELS:
        return False
    # 只保留 CS 会复用的脚步、武器、门、按钮等基础音效，去掉 HL NPC 的大段对白。
    if name.startswith("valve/sound/"):
        parts = name.split("/")
        if len(parts) < 3 or parts[2].lower() not in VALVE_SOUND_DIRS:
            return False
    # 1280/2560 是 HL HUD 的放大副本，CS 使用自己的 sprites。
    if name.startswith("valve/sprites/1280/") or name.startswith("valve/sprites/2560/"):
        return False
    return True


@contextmanager
def deterministic_tar(path: Path):
    """tarfile 的 w:gz 会写当前时间；显式包一层 gzip 才能让产物可复现。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=6, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                yield archive


def tar_info(name: str, size: int) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = size
    info.mode = 0o644
    info.mtime = 0
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    return info


def main() -> int:
    source = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_INPUT
    output = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else DEFAULT_OUTPUT
    if not source.is_file():
        raise FileNotFoundError(f"找不到输入包：{source}")
    output.mkdir(parents=True, exist_ok=True)
    (output / "maps").mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="8bitgo-cs16-") as directory:
        temp_root = Path(directory)
        raw_zip = temp_root / "base.zip"
        print("1/2 解开历史 ZIP 的外层 gzip…")
        with gzip.open(source, "rb") as src, raw_zip.open("wb") as dst:
            shutil.copyfileobj(src, dst, length=8 * 1024 * 1024)

        print("2/2 写入公共运行时和单地图流式包…")
        counts = {"base": [0, 0], **{name: [0, 0] for name in MAPS}}
        with zipfile.ZipFile(raw_zip) as source_zip, ExitStack() as stack:
            targets = {"base": stack.enter_context(deterministic_tar(temp_root / "base.tar.gz"))}
            for name in MAPS:
                targets[name] = stack.enter_context(deterministic_tar(temp_root / "maps" / f"{name}.tar.gz"))

            for entry in source_zip.infolist():
                if entry.is_dir():
                    continue
                name = safe_name(entry.filename)
                target_names = ["base"] if is_common(name) else map_targets(name)
                if not target_names:
                    continue
                body = source_zip.read(entry)
                for target_name in target_names:
                    targets[target_name].addfile(tar_info(name, entry.file_size), io.BytesIO(body))
                    counts[target_name][0] += 1
                    counts[target_name][1] += entry.file_size

        for name in ("base", *MAPS):
            source_file = temp_root / ("base.tar.gz" if name == "base" else f"maps/{name}.tar.gz")
            target_file = output / ("base.tar.gz" if name == "base" else f"maps/{name}.tar.gz")
            os.replace(source_file, target_file)
            files, size = counts[name]
            print(f"  {name}: {files} 个文件 / {size / 1048576:.1f} MB 原始 / {target_file.stat().st_size / 1048576:.1f} MB 下载")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
