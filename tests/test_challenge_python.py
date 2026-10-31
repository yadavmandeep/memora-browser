"""Python SDK challenge handling. Driven by tests/test-challenge.ts, which starts the daemons:

    python tests/test_challenge_python.py <report-daemon-url> <stop-daemon-url> <site-base-url>
"""
import os
import sys
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

from orbis import OrbisAgent, ChallengeDetectedError, ChallengeCooldownError  # noqa: E402

report_url, stop_url, site = sys.argv[1:4]

# report mode: navigation succeeds, snapshot carries the signal
report = OrbisAgent(report_url)
snap = report.goto(f"{site}/challenge")
assert snap.blocked, snap.challenge
assert snap.challenge["vendor"] == "cloudflare", snap.challenge
assert snap.challenge_cooldown_sec == 60, snap.challenge_cooldown_sec
assert report.snapshot().challenge["kind"] == "interstitial"
print("  [OK] report mode: goto() returns snapshot.challenge / blocked")

# host now in cooldown: typed error, still an HTTPError for existing except clauses
try:
    report.goto(f"{site}/")
    raise AssertionError("expected ChallengeCooldownError")
except ChallengeCooldownError as err:
    assert isinstance(err, urllib.error.HTTPError)
    assert err.code == 429 and err.remaining_sec > 0, (err.code, err.remaining_sec)
    assert err.headers.get("Retry-After") == str(err.remaining_sec)
print("  [OK] cooldown: ChallengeCooldownError (HTTP 429, Retry-After)")

stop = OrbisAgent(stop_url)

# embedded widget: not blocked, still reported, never raises (checked before the challenge,
# which puts the host into cooldown)
widget = stop.goto(f"{site}/login")
assert not widget.blocked and widget.challenge["kind"] == "captcha", widget.challenge
print("  [OK] embedded widget: reported, not blocked")

# stop mode: typed error with the signal
try:
    stop.goto(f"{site}/challenge")
    raise AssertionError("expected ChallengeDetectedError")
except ChallengeDetectedError as err:
    assert isinstance(err, urllib.error.HTTPError)
    assert err.code == 409
    assert err.challenge["vendor"] == "cloudflare"
    assert "CHALLENGE DETECTED" in str(err.reason)
print("  [OK] stop mode: ChallengeDetectedError (HTTP 409)")
print("PYTHON_OK")
