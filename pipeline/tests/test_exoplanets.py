"""Matching planet hosts of the NASA Exoplanet Archive to the star table."""

import numpy as np
import pandas as pd

from galmap.sources.exoplanets import attach


def _stars():
    return pd.DataFrame({
        "gaia": pd.array([100, None, None, None, 200], dtype="Int64"),
        "hip": pd.array([None, 7, None, None, None], dtype="Int64"),
        "hd": pd.array([None, None, 42, None, None], dtype="Int64"),
        "ra": [10.0, 20.0, 30.0, 40.0, 50.0],
        "dec": [0.0, 10.0, 20.0, 30.0, 40.0],
        "pmra": [0.0, 0.0, 0.0, 0.0, 0.0],
        "pmdec": [0.0, 0.0, 0.0, 0.0, 0.0],
        "epoch": [2016.0, 2000.0, 2000.0, 2000.0, 2016.0],
        "dist_pc": [10.0, 20.0, 30.0, 40.0, 50.0],
    })


def test_hosts_are_matched_by_identifier_then_position():
    hosts = pd.DataFrame({
        "hostname": ["a", "b", "c", "d", "e", "f"],
        "planets": [3, 1, 2, 4, 5, 6],
        "gaia": pd.array([100, None, None, None, None, None], dtype="Int64"),
        "hip": pd.array([None, 7, None, None, None, None], dtype="Int64"),
        "hd": pd.array([None, None, 42, None, None, None], dtype="Int64"),
        # d: 1" off star 3 at the right distance; e: on star 4 but at twice the distance;
        # f: nowhere near any star
        "ra": [10.0, 20.0, 30.0, 40.0 + 1 / 3600 / np.cos(np.radians(30)), 50.0, 60.0],
        "dec": [0.0, 10.0, 20.0, 30.0, 40.0, 0.0],
        "dist_pc": [10.0, 20.0, 30.0, 41.0, 100.0, 5.0],
    })
    assert attach(_stars(), hosts).tolist() == [3, 1, 2, 4, 0]
