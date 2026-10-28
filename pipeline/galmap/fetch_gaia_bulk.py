"""Downloads the Gaia DR3 bulk files (gaia_source) for the bulk path (galmap.bulk.files_source).

    python -m galmap.fetch_gaia_bulk --dest /data/gaia_source [--limit 10] [--dry-run]

The full set is 3,386 files of gzipped CSV, about 650 GB; the build reads only 14 of their
columns. The step is separate from the build and resumable: a partial download continues where
it stopped (HTTP Range), finished files are checked against the published MD5 sums and skipped on
the next run. The build itself never downloads them:

    python -m galmap.build --bulk-files /data/gaia_source --work-dir /data/tmp

(docs/SCALING.md).
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import requests

log = logging.getLogger("galmap.fetch_gaia_bulk")

BASE_URL = "https://cdn.gea.esac.esa.int/Gaia/gdr3/gaia_source/"
MD5_FILE = "_MD5SUM.txt"
NAME_RE = re.compile(r"GaiaSource_[0-9]+-[0-9]+\.csv\.gz")
BLOCK = 1 << 20


@dataclass
class Remote:
    name: str
    md5: str | None


def list_files(session, base_url: str = BASE_URL) -> list[Remote]:
    """The bulk files with their MD5 sums (from the MD5 list; else the directory listing)."""
    r = session.get(base_url + MD5_FILE, timeout=120)
    if r.status_code == 200:
        out = []
        for line in r.text.splitlines():
            parts = line.split()
            if len(parts) == 2 and NAME_RE.fullmatch(parts[1].lstrip("*")):
                out.append(Remote(parts[1].lstrip("*"), parts[0].lower()))
        if out:
            return sorted(out, key=lambda f: f.name)
    r = session.get(base_url, timeout=120)
    r.raise_for_status()
    return [Remote(n, None) for n in sorted(set(NAME_RE.findall(r.text)))]


def md5_of(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(BLOCK), b""):
            h.update(block)
    return h.hexdigest()


def download(session, remote: Remote, dest: Path, base_url: str = BASE_URL) -> str:
    """Downloads one file (resuming a partial one); returns 'skipped', 'done' or 'resumed'."""
    final = dest / remote.name
    if final.exists() and (remote.md5 is None or md5_of(final) == remote.md5):
        return "skipped"
    part = dest / (remote.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    with session.get(base_url + remote.name, headers=headers, stream=True, timeout=600) as r:
        if r.status_code == 416:  # the part is complete already
            pass
        else:
            r.raise_for_status()
            mode = "ab" if have and r.status_code == 206 else "wb"
            with open(part, mode) as fh:
                for block in r.iter_content(BLOCK):
                    fh.write(block)
    if remote.md5 is not None and md5_of(part) != remote.md5:
        part.unlink()
        raise IOError(f"{remote.name}: MD5 mismatch, the partial file was removed")
    part.replace(final)
    return "resumed" if have else "done"


def fetch(dest: Path, limit: int | None = None, dry_run: bool = False, base_url: str = BASE_URL, session=None) -> dict:
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    session = session or requests.Session()
    files = list_files(session, base_url)
    if limit:
        files = files[:limit]
    counts = {"files": len(files), "skipped": 0, "done": 0, "resumed": 0, "failed": 0}
    if dry_run:
        log.info("%d files would be fetched to %s", len(files), dest)
        return counts
    for k, f in enumerate(files):
        try:
            counts[download(session, f, dest, base_url)] += 1
        except (requests.RequestException, IOError) as err:
            counts["failed"] += 1
            log.warning("%s: %s (run again to resume)", f.name, err)
        if (k + 1) % 10 == 0:
            log.info("%d/%d files", k + 1, len(files))
    log.info("bulk files: %s", counts)
    return counts


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dest", type=Path, required=True, help="directory for the GaiaSource_*.csv.gz files")
    ap.add_argument("--limit", type=int, default=None, help="only the first N files (for a trial)")
    ap.add_argument("--dry-run", action="store_true", help="list the files only")
    ap.add_argument("--base-url", default=BASE_URL)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    counts = fetch(args.dest, args.limit, args.dry_run, args.base_url)
    sys.exit(1 if counts["failed"] else 0)


if __name__ == "__main__":
    main()
