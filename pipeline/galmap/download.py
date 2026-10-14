"""Cached downloads and TAP queries."""

from __future__ import annotations

import hashlib
import io
import logging
import time
from pathlib import Path

import pandas as pd
import requests

log = logging.getLogger(__name__)

USER_AGENT = "GalacticMap/0.1 (https://github.com/nathansyntronics/galactic-map)"
CACHE_DIR = Path(__file__).resolve().parents[1] / "cache"


def session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    return s


def fetch(
    url: str,
    dest: Path,
    *,
    sha256: str | None = None,
    refresh: bool = False,
    timeout: float = 600,
    retries: int = 4,
    method: str = "GET",
    data: dict | None = None,
) -> Path:
    """Download url to dest unless it already exists (and matches sha256 if given)."""
    dest = Path(dest)
    if dest.exists() and not refresh:
        if sha256 is None or _sha256(dest) == sha256:
            return dest
        log.warning("checksum mismatch for %s, downloading again", dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    delay = 2.0
    for attempt in range(retries + 1):
        try:
            log.info("downloading %s", url)
            with session().request(method, url, data=data, stream=True, timeout=timeout) as r:
                r.raise_for_status()
                with open(tmp, "wb") as fh:
                    for chunk in r.iter_content(1 << 20):
                        fh.write(chunk)
            if sha256 is not None and _sha256(tmp) != sha256:
                raise RuntimeError(f"checksum mismatch for {url}")
            tmp.replace(dest)
            return dest
        except (requests.RequestException, RuntimeError) as err:
            if attempt == retries:
                raise
            log.warning("download failed (%s), retrying in %.0f s", err, delay)
            time.sleep(delay)
            delay *= 2
    raise AssertionError("unreachable")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tap_sync(endpoint: str, query: str, *, fmt: str = "csv", maxrec: int | None = None, timeout: float = 600, retries: int = 3) -> pd.DataFrame:
    """Run a synchronous ADQL query against a TAP service and return a DataFrame (CSV transport)."""
    data = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": fmt, "QUERY": query}
    if maxrec is not None:
        data["MAXREC"] = str(maxrec)
    delay = 3.0
    for attempt in range(retries + 1):
        try:
            r = session().post(endpoint.rstrip("/") + "/sync", data=data, timeout=timeout)
            r.raise_for_status()
            text = r.content.decode("utf-8")
            if text.lstrip().startswith("<?xml") or "<VOTABLE" in text[:500]:
                raise RuntimeError(f"TAP error: {text[:500]}")
            return pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False)
        except (requests.RequestException, RuntimeError) as err:
            if attempt == retries:
                raise
            log.warning("TAP query failed (%s), retrying in %.0f s", err, delay)
            time.sleep(delay)
            delay *= 2
    raise AssertionError("unreachable")


def cached_tap(endpoint: str, query: str, dest: Path, *, refresh: bool = False, **kw) -> pd.DataFrame:
    """tap_sync with the result cached as CSV (keyed by the caller-chosen file name)."""
    dest = Path(dest)
    if dest.exists() and not refresh:
        return pd.read_csv(dest, dtype=str, keep_default_na=False)
    df = tap_sync(endpoint, query, **kw)
    dest.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(dest, index=False)
    return df


def exact_int64(s: pd.Series) -> pd.Series:
    """Parse integer strings (e.g. 19-digit Gaia source_ids) exactly into nullable Int64.

    pd.to_numeric silently goes through float64 when values are missing, which corrupts
    integers above 2**53.
    """

    def conv(v):
        if v is None or v is pd.NA or (isinstance(v, float) and v != v):
            return pd.NA
        t = str(v).strip()
        return int(t) if t.lstrip("-").isdigit() else pd.NA

    return pd.Series([conv(v) for v in s], index=s.index, dtype="Int64")
