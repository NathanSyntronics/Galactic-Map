"""TAP queries: an overloaded archive (503) is asked again, with growing pauses."""

import pytest
import requests

from galmap import download


class _Resp:
    def __init__(self, status: int, text: str = ""):
        self.status_code = status
        self.content = text.encode()

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Server Error")


class _Session:
    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = 0

    def post(self, *a, **kw):
        self.calls += 1
        return self.answers.pop(0)


def test_retries_until_the_archive_answers(monkeypatch):
    s = _Session([_Resp(503)] * 5 + [_Resp(200, "n\n42\n")])
    pauses = []
    monkeypatch.setattr(download, "session", lambda: s)
    monkeypatch.setattr(download.time, "sleep", pauses.append)
    df = download.tap_sync("https://example.org/tap", "SELECT 1")
    assert df["n"].iloc[0] == "42"
    assert s.calls == 6
    assert pauses == [3, 6, 12, 24, 48]


def test_pauses_are_capped_and_the_last_error_is_raised(monkeypatch):
    s = _Session([_Resp(503)] * 9)
    pauses = []
    monkeypatch.setattr(download, "session", lambda: s)
    monkeypatch.setattr(download.time, "sleep", pauses.append)
    with pytest.raises(requests.HTTPError):
        download.tap_sync("https://example.org/tap", "SELECT 1")
    assert s.calls == 9
    assert max(pauses) == download.MAX_RETRY_DELAY
    assert sum(pauses) < 15 * 60
