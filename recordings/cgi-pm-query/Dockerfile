# The same pinned Debian/Perl base as the XML-RPC recordings, with CGI.pm's query parser.
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
RUN apt-get update \
 && apt-get install -y --no-install-recommends libcgi-pm-perl=4.55-1 libhttp-daemon-perl=6.16-1+deb13u1~deb12u1 \
 && rm -rf /var/lib/apt/lists/*
COPY query.pl /srv/query.pl
EXPOSE 8080
CMD ["perl", "/srv/query.pl"]
