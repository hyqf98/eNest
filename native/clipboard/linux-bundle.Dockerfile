# Build/run from the repository root:
# docker build -f native/clipboard/linux-bundle.Dockerfile -t enest-clipboard-bundle-test native/clipboard
# printf '%s\n' '{"id":1,"command":"capabilities"}' | docker run --rm -i enest-clipboard-bundle-test
FROM node:22-bookworm-slim AS dependencies
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    gcc pkg-config patchelf libglib2.0-dev libjson-glib-dev libx11-dev libxtst-dev \
    && rm -rf /var/lib/apt/lists/*
FROM dependencies AS build
WORKDIR /build
COPY linux.c linux-build.mjs ./
RUN node --input-type=module -e "import { buildLinuxHelper } from './linux-build.mjs'; await buildLinuxHelper({ source: './linux.c', outputDir: './bundle' });"

FROM dependencies AS verify
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    xvfb xauth python3-xlib python3-dbus python3-gi dbus-x11 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY --from=build /build/bundle /build/bundle
COPY linux-smoke.py linux-portal-smoke.py ./
RUN xvfb-run -a python3 linux-smoke.py /build/bundle/clipboard-helper \
    && dbus-run-session -- python3 linux-portal-smoke.py /build/bundle/clipboard-helper

# No apt install: the release payload must supply every non-glibc dependency.
FROM debian:bookworm-slim
COPY --from=verify /build/bundle /opt/enest-native
ENV LANG=C.UTF-8
CMD ["/opt/enest-native/clipboard-helper"]
