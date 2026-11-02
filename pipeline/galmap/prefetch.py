"""Downloads every catalogue into the cache, each on its own (docs/README "Deployment").

The website workflow runs this before the build: a server that is down does not stop the others,
whatever arrives is cached (the workflow saves the cache also when the build fails), and the next
run fetches only what is still missing. The build itself still stops on any missing source.

    cd pipeline && python -m galmap.prefetch
"""

from __future__ import annotations

import gc
import logging
import time
from typing import Callable

log = logging.getLogger(__name__)


def steps() -> list[tuple[str, Callable[[], object]]]:
    from . import binaries, galaxies, planets
    from .sources import athyg, census20, gaia, gcns, hyg, iau, simbad, wikidata

    def gaia_core() -> None:
        # the cross-matches and the stars AT-HYG names by Gaia id, as the build asks for them
        a = athyg.load()
        gaia.load(extra_ids=a["gaia"].dropna().astype("int64").to_numpy())

    return [
        ("AT-HYG", athyg.load),
        ("Gaia DR3 cross-matches (ESA)", gaia_core),
        ("Gaia DR3 field 100-200 pc (ESA)", gaia.load_field),
        ("Hipparcos 2007 (ESA)", gaia.load_hipparcos),
        ("HYG", hyg.load),
        ("GCNS (CDS)", gcns.load),
        ("20 pc census (NASA)", census20.load),
        ("SIMBAD (CDS)", simbad.load),
        ("ORB6 (GSU)", binaries.load),
        ("Wikidata stars", wikidata.load),
        ("IAU names", iau.load),
        ("NASA Exoplanet Archive", planets.load),
        ("Cosmicflows-4", galaxies.load_cf4),
        ("UNGC", galaxies.load_ungc),
        ("LVDB", galaxies.load_lvdb),
        ("2MASS XSC (IRSA)", galaxies.load_xsc),
        ("Wikidata galaxies", galaxies.load_wikidata),
    ]


def prefetch(todo: list[tuple[str, Callable[[], object]]] | None = None) -> list[str]:
    """Runs every download step; returns the names of those that failed (logged, not raised)."""
    failed = []
    for name, fn in todo if todo is not None else steps():
        t0 = time.time()
        try:
            fn()
            log.info("prefetch %s: ok (%.0f s)", name, time.time() - t0)
        except Exception as err:  # noqa: BLE001 - any failure: the next run tries again
            failed.append(name)
            log.warning("prefetch %s: FAILED after %.0f s (%s)", name, time.time() - t0, err)
        gc.collect()
    return failed


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    failed = prefetch()
    if failed:
        log.warning("prefetch: %d source(s) not available now: %s", len(failed), ", ".join(failed))
    else:
        log.info("prefetch: all sources cached")


if __name__ == "__main__":
    main()
