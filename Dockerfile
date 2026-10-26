# chit serve, with the web app, in one image:
#   docker build -t chit .
#   docker run -p 8787:8787 chit --rpc http://user:pass@your-zebra:8232
FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends clang curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs \
 && rustup target add wasm32-unknown-unknown && rustup component add llvm-tools \
 && cargo install wasm-pack --locked
WORKDIR /src
COPY . .
RUN ./scripts/build.sh && cargo build -p chit-cli --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 chit
COPY --from=build /src/target/release/chit /usr/local/bin/chit
COPY --from=build /src/web/dist /srv/chit
USER chit
EXPOSE 8787
ENTRYPOINT ["chit", "serve", "--listen", "0.0.0.0:8787", "--web", "/srv/chit"]
