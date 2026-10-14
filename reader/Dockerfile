# Fermata reader: Audiveris 5.11 (music recognition) + ImageMagick (straightening) + Node.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl imagemagick libfreetype6 fontconfig fonts-dejavu-core \
      libasound2t64 libbsd0 libmd0 libx11-6 libxau6 libxcb1 libxdmcp6 libxext6 libxi6 libxrender1 libxtst6 zlib1g libgtk-3-0t64 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && curl -fsSL -o /tmp/audiveris.deb https://github.com/Audiveris/audiveris/releases/download/5.11.0/Audiveris-5.11.0-ubuntu24.04-x86_64.deb \
    # Unpack Audiveris (it brings its own Java). Its package setup script only adds a desktop
    # menu entry, which fails in a server container, so we skip it.
    && dpkg-deb -x /tmp/audiveris.deb / \
    && test -x /opt/audiveris/bin/Audiveris \
    && rm -rf /var/lib/apt/lists/* /tmp/audiveris.deb

# Ubuntu ships ImageMagick 6 (convert/identify); the reader calls ImageMagick 7's `magick`.
RUN printf '#!/bin/sh\nif [ "$1" = "identify" ]; then shift; exec identify "$@"; fi\nexec convert "$@"\n' > /usr/local/bin/magick \
    && chmod +x /usr/local/bin/magick \
    && sed -i 's/<policy domain="resource" name="\(memory\|map\|area\|disk\)" value="[^"]*"/<policy domain="resource" name="\1" value="4GiB"/' /etc/ImageMagick-6/policy.xml || true

# Run as an ordinary user (Ubuntu 24.04's built-in "ubuntu" user, id 1000). Audiveris needs a
# writable home for its settings.
RUN mkdir -p /home/ubuntu && chown -R 1000:1000 /home/ubuntu
WORKDIR /app
COPY --chown=1000 . /app
RUN npm install --omit=dev --no-audit --no-fund
USER 1000
# Cloud Run sets PORT (8080); 8080 is also the default here.
ENV HOME=/home/ubuntu AUDIVERIS_PATH=/opt/audiveris/bin/Audiveris PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
