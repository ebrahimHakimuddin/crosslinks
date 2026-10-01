# CrossLinks privacy policy template

_Replace the operator and contact placeholders before publishing._

CrossLinks transfers web addresses between devices chosen by the user. CrossLinks
server stores submitted URLs, device names, delivery status, and delivery timestamps
for the retention period configured by the server owner. Undelivered items expire
after seven days by default, and delivery history is retained for 30 days by default.

CrossLinks does not fetch the contents of submitted URLs, create remote previews,
sell data, serve advertising, or include analytics. Device credentials are generated
during pairing and stored as one-way hashes on the server. Android stores its device
credential encrypted with Android Keystore. Chrome stores its credential in local
extension storage.

When the user saves a page to the Chrome reading library, the extension reads the
current page's URL, title, scroll percentage, and an editable snippet of visible
text to restore the reading position later. This runs only on the tab the user
explicitly saves. The canonical library is kept in the Chrome profile's local
extension storage. Saved metadata may be mirrored to `chrome.storage.sync` when
Chrome profile sync is enabled and quota permits; mirror failures retry
automatically while local browsing, export, and deletion remain available.
Android's pending shares and local state stay in the phone's app storage. If the user explicitly enables shared sync in both
Chrome and Android, the editable metadata, snippets, reading positions, and
tombstones are sent to the CrossLinks server so paired devices can share the
library. CrossLinks never fetches the page or URL metadata, and deletion
tombstones contain no URL or title.

The Android app uses Google Play services Code Scanner to scan a CrossLinks pairing
QR code without requesting camera permission. Google Play services supplies the
scanner interface; image processing occurs on the device. Consult Google's privacy
documentation for the behavior of Google Play services on the user's device.

All application traffic must use HTTPS. A self-hosted CrossLinks operator controls
the server, its logs, backups, retention setting, and network infrastructure. Users
may delete individual history entries or completed history through the owner console,
and may revoke any paired device. Receipt records retain minimal delivery IDs by
default for 37 days to support idempotent retries; full URL and history metadata
are retained for 30 days by default. Clearing history strips URL and failure
details while preserving terminal deduplication state. Removing a device revokes
its credential while retaining delivery history.

Operator: **[name]**  
Contact: **[email or support URL]**  
Effective date: **[date]**
