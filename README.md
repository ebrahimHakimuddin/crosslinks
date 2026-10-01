# CrossLinks

CrossLinks sends a URL from Android to a selected Chrome installation and opens it
as a new tab. It consists of a self-hosted server, a Chrome Manifest V3 extension,
and an Android share target/browser handler.

See [docs/architecture.md](docs/architecture.md) for the product and security
boundaries.

## Development

Requirements: Node.js 22+, pnpm 11+, JDK 17, and the Android SDK.

```sh
pnpm install
cp .env.example .env
pnpm dev:server
```

On first start, the server prints a single-use setup URL. Production deployments
must put the server behind trusted HTTPS. CrossLinks does not include or call Jev,
TypeSafe, or any other inference service at runtime.

## Run the self-hosted server

Set the HTTPS origin served by your reverse proxy, then start the container:

```sh
export LINKSYNC_PUBLIC_URL=https://links.example.com
# Optional LAN-first endpoint, also with a publicly trusted certificate:
export LINKSYNC_LAN_URL=https://links.home.example.com
docker compose up -d --build
docker compose logs linksync
```

Open the one-time setup URL from the logs. The container binds only to loopback
port `8787`; terminate TLS in Caddy, nginx, Traefik, or another reverse proxy and
proxy both ordinary HTTP requests and WebSocket upgrades. See
[docs/self-hosting.md](docs/self-hosting.md).

## Load the Chrome extension

```sh
pnpm build:extension
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
select `apps/extension/dist`. Create a Chrome pairing code in the server console,
then enter the server URL and code in the extension settings.

The Chrome extension keeps the canonical reading library in local profile
storage, and mirrors saved metadata to `chrome.storage.sync` when Chrome profile
sync is enabled and quota permits. Failed mirrors retry automatically while the
local library remains available for browsing, export, and deletion. **Save
position** in the popup, the right-click menu (select text first to pin that
exact passage), or `Alt+Shift+S` stores the page and its current position.
Articles can be organized into lists, edited, and marked as read; opening one
uses a Chrome text fragment to return to the saved passage.

Android can save a link from the system Share sheet or Open with chooser, and
the app lets you choose a paired Chrome installation. Server-accepted links
remain queued for the selected Chrome device while that device is offline.
Interrupted or offline phone submissions retain their operation identity and can
be retried from history. The Android app does not download article content. Its
separate **Open saved links** library remains available offline and before
pairing, and lets you save, edit, search, organize into lists, mark links read
or unread, and save a reading position before opening the link in an external
browser. The library stores link metadata only. Shared library sync is off by
default: enable it
explicitly in both Chrome and Android before paired devices exchange editable
metadata, snippets, reading positions, and deletion tombstones through the
server. The server stores no HTML and never fetches submitted URLs.

## Build Android

Run the Android verification tasks separately:

```sh
cd apps/android
./gradlew testDebugUnitTest
./gradlew lintDebug
```

An installable APK build is an optional future release step and is not part of
the current verification task.

Install `app/build/outputs/apk/debug/app-debug.apk`, create an Android pairing QR
in the server console, and scan it from the app. The app can then be selected from
Android's Share and Open with surfaces.
