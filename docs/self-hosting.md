# Self-hosting CrossLinks

## Requirements

- A machine capable of running Docker.
- A public or private DNS name with a certificate trusted by Android and Chrome.
- An HTTPS reverse proxy that supports WebSocket upgrades.

CrossLinks deliberately rejects non-loopback HTTP configuration. For LAN-first use,
configure split-horizon DNS so a trusted hostname resolves to the server's private
address on the home network. Put that origin in `LINKSYNC_LAN_URL`; clients try it
before `LINKSYNC_PUBLIC_URL`.

## Container

```sh
export LINKSYNC_PUBLIC_URL=https://links.example.com
export LINKSYNC_LAN_URL=https://links.home.example.com # optional
docker compose up -d --build
docker compose logs linksync
```

The Compose service exposes `127.0.0.1:8787` and stores SQLite state in the named
volume `linksync-data`. Back up that volume while the container is stopped, or use
SQLite's online backup facilities. Do not copy only the main database file while
WAL writes are active.

The first startup log contains a setup URL whose secret is held in the fragment,
so it is not sent in HTTP requests or proxy logs. Opening it lets the owner create
the sole account for the instance. A new unconfigured restart creates a new setup
token; after setup, no setup token is retained.

## Reverse proxy contract

Forward these request properties unchanged:

- `Host` and the HTTPS origin;
- WebSocket `Upgrade` and `Connection` headers for `/api/v1/live`;
- response streaming without buffering the WebSocket;
- request bodies up to at least 32 KiB.

If login rate limiting must distinguish users behind the proxy, set
`LINKSYNC_TRUSTED_PROXY_CIDRS` to a comma-separated list of the proxy's exact
addresses or CIDRs (for example `127.0.0.1,10.0.0.0/8`). The application trusts
`X-Forwarded-For` only when the direct peer matches this allowlist, and walks the
header from right to left to select the first untrusted address. It does not
enable blanket proxy trust by default; never include a client network in this
allowlist.

The app sets strict browser security headers itself. The proxy should add HSTS only
after the hostname and certificate are stable. Do not expose port 8787 directly to
the internet.

## Data and recovery

The SQLite database contains password/device-token hashes, full submitted URLs,
device names, delivery state, and timestamps. Treat backups as sensitive. Default
undelivered expiry is seven days; completed history is retained for 30 days, while
minimal delivery receipts retain IDs for 37 days to make retries idempotent.
Cleanup runs at startup and periodically, including expired sessions and pairing
grants. History cleanup strips receipt URLs and failure details before removing
terminal rows. Shared article sync is opt-in and metadata-only; device removal
preserves delivery history while revoking the credential and closing live sockets.

Revoking a device invalidates its credential and closes active delivery sockets.
If the owner password is lost, there is intentionally no remote reset endpoint;
restore a backup or deliberately reset the instance data and pair devices again.
