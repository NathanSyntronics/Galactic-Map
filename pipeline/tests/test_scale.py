"""The out-of-core writer's memory does not grow with the number of stars (galmap.scale_test)."""

import json
import subprocess
import sys
from pathlib import Path

from galmap.ooc import all_rows


def run(tmp_path: Path, stars: int) -> dict:
    out = tmp_path / f"out-{stars}"
    cmd = [
        sys.executable, "-m", "galmap.scale_test", "--stars", str(stars), "--out", str(out), "--work-dir", str(tmp_path / "work"),
        "--max-bucket", "60000", "--chunk", "50000", "--capacity", "64", "--subtree-nodes", "500", "--keep",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True, cwd=Path(__file__).resolve().parents[1])
    result = json.loads(res.stdout.strip().splitlines()[-1])
    manifest = json.loads((out / "manifest.json").read_text())
    rows = list(all_rows(out, manifest))
    assert len(rows) == result["nodes"] == manifest["nodeCount"]
    assert sum(r[1] for r in rows) == stars
    return result


def test_memory_does_not_grow_with_the_stars(tmp_path: Path):
    small = run(tmp_path, 250_000)
    large = run(tmp_path, 1_000_000)
    assert large["subManifests"] > small["subManifests"] > 0
    # four times the stars: the same buckets, the same memory (a few MB for the node list)
    assert large["peakRssMB"] < small["peakRssMB"] + 60, (small, large)
