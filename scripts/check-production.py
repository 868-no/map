#!/usr/bin/env python3
"""Check a deployment's /health/ready for the production monitor (design §8, D-207).

    scripts/check-production.py [https://map.868.no]

Prints one line per problem and exits 1 if there are any, 0 if none. A problem
must be seen twice, RECHECK_S apart (default 120), so a deploy's restart does
not count. Thresholds, from the environment:

    STALE_MESSAGE_S    a broker silent for this long (default 900)
    MAINT_MAX_AGE_H    retention last ran longer ago (default 30)
    BACKUP_MAX_AGE_H   last good backup older (default 30; 0 skips the check)
    STARTUP_GRACE_S    no message checks in a process younger (default 300)
"""

import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone


def env_int(name, default):
    return int(os.environ.get(name) or default)


def parse_time(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def problems(site):
    try:
        req = urllib.request.Request(site + "/health/ready", headers={"User-Agent": "meshmap-monitor"})
        with urllib.request.urlopen(req, timeout=20) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            body = json.load(e)
        except ValueError:
            return [f"/health/ready answers HTTP {e.code}"]
    except Exception as e:  # noqa: BLE001 - any failure to reach it is the problem
        return [f"/health/ready unreachable: {e}"]

    out = []
    now = datetime.now(timezone.utc)
    status = body.get("status")
    if status != "ready":
        failed = ", ".join(f"{k}: {v.get('detail') or 'failed'}" for k, v in sorted(body.get("checks", {}).items()) if not v.get("ok"))
        out.append(f"status is {status} ({failed or 'no failed check named'})")
    brokers = body.get("brokers") or {}
    if not brokers:
        out.append("no MQTT broker reported")
    for b, state in sorted(brokers.items()):
        if state != "up":
            out.append(f"broker {b} is {state}")
    if body.get("uptime_s", 0) >= env_int("STARTUP_GRACE_S", 300):
        stale = env_int("STALE_MESSAGE_S", 900)
        last = body.get("last_message_s") or {}
        for b in sorted(brokers):
            s = last.get(b)
            if s is None:
                out.append(f"broker {b} has delivered nothing since the backend started")
            elif s >= stale:
                out.append(f"broker {b} has delivered nothing for {s // 60} minutes")
    maint = body.get("maintenance") or {}
    run = parse_time(maint.get("last_run"))
    max_maint = env_int("MAINT_MAX_AGE_H", 30)
    if run is None:
        out.append("no retention run reported")
    elif (now - run).total_seconds() > max_maint * 3600:
        out.append(f"retention last ran {run:%Y-%m-%d %H:%M} UTC, over {max_maint} h ago")
    max_backup = env_int("BACKUP_MAX_AGE_H", 30)
    if max_backup > 0:
        backup = body.get("backup")
        ok = parse_time((backup or {}).get("last_success"))
        if backup is None:
            out.append("no backup status reported (backup service down, or Redis restarted under an hour ago)")
        elif ok is None:
            out.append("no backup has succeeded yet")
        elif (now - ok).total_seconds() > max_backup * 3600:
            out.append(f"last good backup {ok:%Y-%m-%d %H:%M} UTC, over {max_backup} h ago")
        if backup and backup.get("failed"):
            out.append(f"the last backup attempt ({backup.get('last_attempt')}) failed")
    return out


def main():
    site = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SITE") or "https://map.868.no").rstrip("/")
    first = problems(site)
    if first:
        time.sleep(env_int("RECHECK_S", 120))
        # Still unwell: report the newer figures.
        first = problems(site)
    for p in first:
        print(p)
    return 1 if first else 0


if __name__ == "__main__":
    sys.exit(main())
