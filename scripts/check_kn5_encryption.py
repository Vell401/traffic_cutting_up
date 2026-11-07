#!/usr/bin/env python3
"""Check Assetto Corsa KN5 files for the CSP encryption trailer."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ENCRYPTION_MARKER = b"__AC_SHADERS_PATCH_KN5ENC_v1__"
KN5_SIGNATURE = b"sc6969"
ARCHIVE_SUFFIXES = {".7z", ".arj", ".bz2", ".cab", ".chm", ".cpio", ".cramfs", ".deb", ".dmg", ".fat", ".gz", ".iso", ".lzh", ".lzma", ".rar", ".rpm", ".squashfs", ".tar", ".taz", ".tbz", ".tbz2", ".tgz", ".tlz", ".txz", ".vhd", ".wim", ".xar", ".xz", ".zip", ".zst"}
SEVEN_ZIP = shutil.which("7z") or shutil.which("7zz") or shutil.which("7za")
UNRAR = shutil.which("unrar")


def check_file(path: Path) -> tuple[str, str]:
    """Return (status, details) for one candidate KN5 file."""
    try:
        data = path.read_bytes()
    except OSError as error:
        return "ERROR", str(error)

    if len(data) < 10 or data[: len(KN5_SIGNATURE)] != KN5_SIGNATURE:
        return "NOT_KN5", "signature is not sc6969"

    version = int.from_bytes(data[6:10], byteorder="little")
    marker_count = data.count(ENCRYPTION_MARKER)
    encrypted = marker_count > 0
    status = "ENCRYPTED" if encrypted else "UNENCRYPTED"
    details = f"version={version}, marker_count={marker_count}"
    return status, details


def find_candidates(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    if root.is_dir():
        return sorted(path for path in root.rglob("*") if path.is_file() and path.suffix.lower() == ".kn5")
    return []


def list_archive_kn5(archive: Path) -> tuple[list[str], str | None]:
    if archive.suffix.lower() == ".rar" and UNRAR:
        result = subprocess.run(
            [UNRAR, "lb", "--", str(archive)],
            capture_output=True,
            text=True,
            errors="replace",
        )
        if result.returncode:
            return [], result.stderr.strip() or result.stdout.strip() or f"unrar exited with {result.returncode}"
        return [name for name in result.stdout.splitlines() if Path(name).suffix.lower() == ".kn5"], None

    if not SEVEN_ZIP:
        return [], "7z, 7zz, or 7za is required to inspect archives"
    result = subprocess.run(
        [SEVEN_ZIP, "l", "-slt", "--", str(archive)],
        capture_output=True,
        text=True,
        errors="replace",
    )
    if result.returncode:
        return [], result.stderr.strip() or result.stdout.strip() or f"7z exited with {result.returncode}"

    entries: list[str] = []
    for block in re.split(r"\r?\n\r?\n", result.stdout):
        properties = dict(line.split(" = ", 1) for line in block.splitlines() if " = " in line)
        name = properties.get("Path")
        if name and not name.endswith(("/", "\\")) and Path(name).suffix.lower() == ".kn5":
            entries.append(name)
    return entries, None


def check_archive(archive: Path) -> tuple[list[tuple[str, str, str]], str | None]:
    entries, error = list_archive_kn5(archive)
    if error:
        return [], error

    results: list[tuple[str, str, str]] = []
    with tempfile.TemporaryDirectory(prefix="kn5-check-") as temporary:
        for index, entry in enumerate(entries):
            if archive.suffix.lower() == ".rar" and UNRAR:
                result = subprocess.run(
                    [UNRAR, "p", "-inul", "--", str(archive), entry],
                    capture_output=True,
                )
            else:
                result = subprocess.run(
                    [SEVEN_ZIP or "7z", "e", "-so", "--", str(archive), entry],
                    capture_output=True,
                )
            if result.returncode:
                detail = result.stderr.decode(errors="replace").strip() or f"7z exited with {result.returncode}"
                results.append((entry, "ERROR", detail))
                continue

            path = Path(temporary) / f"{index}.kn5"
            path.write_bytes(result.stdout)
            status, details = check_file(path)
            results.append((entry, status, details))
    return results, None


def find_inputs(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    if root.is_dir():
        return sorted(path for path in root.rglob("*") if path.is_file())
    return []


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check Assetto Corsa .kn5 files for CSP encryption in folders and archives."
    )
    parser.add_argument("path", type=Path, nargs="?", default=Path("mods"), help="mods folder, archive, folder, or .kn5 file (default: mods)")
    args = parser.parse_args()

    inputs = find_inputs(args.path)
    if not inputs:
        print(f"No files found: {args.path}", file=sys.stderr)
        return 2

    counts = {"ENCRYPTED": 0, "UNENCRYPTED": 0, "NOT_KN5": 0, "ERROR": 0}
    archives_found = False
    for path in inputs:
        if path.suffix.lower() in ARCHIVE_SUFFIXES:
            archives_found = True
            print(f"\nArchive: {path}")
            results, error = check_archive(path)
            if error:
                counts["ERROR"] += 1
                print(f"{'ERROR':10} {error}")
            elif not results:
                print("No .kn5 files found")
            for name, status, details in results:
                counts[status] += 1
                print(f"{status:10} {name} ({details})")
        else:
            candidates = find_candidates(path)
            if candidates:
                print(f"\nFolder/file: {path}")
            for candidate in candidates:
                status, details = check_file(candidate)
                counts[status] += 1
                print(f"{status:10} {candidate} ({details})")

    if not any(counts.values()) and not archives_found:
        print(f"No .kn5 files or supported archives found: {args.path}", file=sys.stderr)
        return 2

    print()
    print(
        "Summary: "
        f"encrypted={counts['ENCRYPTED']}, "
        f"unencrypted={counts['UNENCRYPTED']}, "
        f"not_kn5={counts['NOT_KN5']}, "
        f"errors={counts['ERROR']}"
    )
    return 1 if counts["ERROR"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
