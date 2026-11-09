"""Prefetch: a source that fails does not stop the others."""

from galmap import prefetch


def test_a_failing_source_does_not_stop_the_others():
    done = []

    def boom():
        raise ConnectionError("server down")

    failed = prefetch.prefetch([("a", lambda: done.append("a")), ("down", boom), ("b", lambda: done.append("b"))])
    assert failed == ["down"]
    assert done == ["a", "b"]


def test_every_source_has_a_step():
    names = [n for n, _ in prefetch.steps()]
    assert len(names) == len(set(names)) == 23
    assert all(callable(fn) for _, fn in prefetch.steps())
