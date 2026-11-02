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
    s = _Session([_Resp(503)] * 17)
    pauses = []
    monkeypatch.setattr(download, "session", lambda: s)
    monkeypatch.setattr(download.time, "sleep", pauses.append)
    with pytest.raises(requests.HTTPError):
        download.tap_sync("https://example.org/tap", "SELECT 1")
    assert s.calls == 17
    assert max(pauses) == download.MAX_RETRY_DELAY
    # rides out an outage of about 50 minutes, well within the job's 6 hours
    assert 45 * 60 < sum(pauses) < 55 * 60


class _ReqSession(_Session):
    def request(self, method, url, **kw):
        self.kw = kw
        return self.post()


def test_plain_requests_are_tried_again_and_notice_a_dead_server_quickly(monkeypatch):
    s = _ReqSession([_Resp(503), _Resp(502), _Resp(200, "ok")])
    pauses = []
    monkeypatch.setattr(download, "session", lambda: s)
    monkeypatch.setattr(download.time, "sleep", pauses.append)
    r = download.request("GET", "https://example.org/x", timeout=300)
    assert r.content == b"ok"
    assert pauses == [2, 4]
    # connection and read time limits: a server that does not answer is noticed after 30 s
    assert s.kw["timeout"] == (download.CONNECT_TIMEOUT, 300)


def test_tap_queries_take_turns_with_a_mirror(monkeypatch):
    urls = []

    class S(_Session):
        def post(self, url, **kw):
            urls.append(url)
            return super().post()

    s = S([_Resp(503), _Resp(200, "n\n7\n")])
    monkeypatch.setattr(download, "session", lambda: s)
    monkeypatch.setattr(download.time, "sleep", lambda _: None)
    df = download.tap_sync("https://main.example/tap", "SELECT 1", mirrors=("https://mirror.example/tap",))
    assert df["n"].iloc[0] == "7"
    assert urls == ["https://main.example/tap/sync", "https://mirror.example/tap/sync"]
