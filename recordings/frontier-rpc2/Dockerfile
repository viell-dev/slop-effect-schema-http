# Frontier::RPC2 0.07b4 under Frontier::Daemon (HTTP::Daemon), from Debian 12's packages.
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
RUN apt-get update \
 && apt-get install -y --no-install-recommends libfrontier-rpc-perl=0.07b4-7.1 \
 && rm -rf /var/lib/apt/lists/*
# Perl writes a struct's members in hash order, which changes with every process unless the seed
# is fixed; a fixed seed makes a re-recording reproducible.
ENV PERL_HASH_SEED=0 PERL_PERTURB_KEYS=0
COPY data.json frontier.pl /srv/
EXPOSE 8080
CMD ["perl", "/srv/frontier.pl"]
