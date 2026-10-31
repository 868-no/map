# Basemap builder: Planetiler plus a loop that keeps /data/basemap.pmtiles
# present and fresh (basemap/run.sh). Mount the same volume read-only into
# the web service at /srv/tiles.
FROM ghcr.io/onthegomap/planetiler:0.10.1
COPY run.sh /usr/local/bin/basemap
VOLUME /data
ENTRYPOINT ["/usr/local/bin/basemap"]
