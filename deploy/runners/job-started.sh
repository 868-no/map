#!/bin/sh
# Runs before each job (ACTIONS_RUNNER_HOOK_JOB_STARTED) on the runner's own
# Docker daemon: clears what an earlier job left behind (it may have been
# cancelled before cleaning up), while the caches jobs share stay warm:
# tagged images, named volumes (the toolchains' caches) and the build cache,
# which is trimmed to BUILD_CACHE_MAX, least recently used first.
docker rm -f $(docker ps -aq) >/dev/null 2>&1
docker network prune -f >/dev/null 2>&1
docker volume prune -f >/dev/null 2>&1 # anonymous volumes only
docker image prune -f >/dev/null 2>&1  # untagged images only (replaced builds)
docker builder prune -af --max-used-space "${BUILD_CACHE_MAX:-20gb}" >/dev/null 2>&1
exit 0
