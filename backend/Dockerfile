# syntax=docker/dockerfile:1.7
# Generated protobuf bindings are committed, so the build needs only Go.
# The Go version is a copy of versions.env, kept equal by scripts/check-versions.sh.
FROM --platform=$BUILDPLATFORM golang:1.26.11-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG TARGETOS TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/meshmap ./cmd/meshmap

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/meshmap /usr/local/bin/meshmap
USER nonroot:nonroot
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/meshmap"]
CMD ["serve"]
