# Store release checklist

## Shared

- Replace the privacy-policy operator/contact placeholders and publish it at HTTPS.
- Choose final support and homepage URLs.
- Exercise Android → server → Chrome against the production HTTPS endpoints.
- Verify LAN-first fallback both on and away from the local network.
- Test revoked credentials, expired pairing codes, offline queues, and duplicate delivery recovery.
- Explain that optional shared library sync sends only article metadata and exact
  reading positions; the server never downloads page content or URL metadata.

## Chrome Web Store

- Produce a clean `pnpm build:extension` output and zip only `apps/extension/dist`.
- Capture listing screenshots and provide the published privacy-policy URL.
- Explain `tabs`: it is used only to create the user-requested received tab.
- Explain `notifications`: it implements the user's notification-only delivery mode.
- Explain `storage`: it stores pairing settings, pause state, recent local activity, and handled delivery IDs.
- Explain optional host permissions: the extension requests only the chosen LinkSync server origin.
- Verify the service worker reconnects after browser restart and network changes.

## Google Play

- Register `dev.linksync.app` to the verified developer account or change the final application ID before the first release.
- Create and protect a Play App Signing upload key; never commit it.
- Build and inspect a release AAB with `./gradlew bundleRelease`.
- Complete Data safety using the published policy and the actual hosting model.
- Declare Google Play services Code Scanner accurately in the SDK disclosure.
- Confirm the browser role and generic HTTP/HTTPS intent filters match the store listing: LinkSync forwards links to the user's paired Chrome device and does not render pages locally.
- Supply phone screenshots for pairing, target selection, send confirmation, and history.
- Run the pre-launch report and test share/open intents on Android 8 through the current release.
