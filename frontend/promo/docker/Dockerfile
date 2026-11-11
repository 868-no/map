# The promo recorder: Playwright's image plus Mesa, so Chrome draws on the
# host's GPU (/dev/dri) instead of in software. PLAYWRIGHT_VERSION is the
# pinned one from versions.env (equal to @playwright/test).
ARG PLAYWRIGHT_VERSION
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
RUN apt-get update && apt-get install -y --no-install-recommends mesa-vulkan-drivers libgl1-mesa-dri libegl1 && rm -rf /var/lib/apt/lists/*
