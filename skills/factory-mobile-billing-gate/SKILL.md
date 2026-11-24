---
name: factory-mobile-billing-gate
description: Mandatory gate whenever a registered Factory City mobile app (Android, iOS, Unity, Flutter, React Native) sells subscriptions or in-app products, grants rewards for ads, offers direct payments, or ships to more than one store. All money flows go through the central Billing Center; this gate lists the required build, client, backend and release rules, the release checklist with the evidence that proves each item, and the Worlio reference implementation.
---

# Factory mobile billing gate (mandatory)

Applies to every registered child app that touches money. It complements `factory-mobile-platform-gate` (platform evidence) and uses
`billing-center` for the service itself (every detail lives in its `references/`: architecture, manifest, API, backend and mobile integration,
stores and providers, operations, extending, testing, FAQ). A step may be `N/A` only with a written reason (for example: the app sells nothing and
shows no ads).

- Release checklist with the command or file proving every item: [checklist.md](references/checklist.md)
- Service documentation: [mobile-integration.md](../billing-center/references/mobile-integration.md),
  [backend-integration.md](../billing-center/references/backend-integration.md), [manifest.md](../billing-center/references/manifest.md),
  [api.md](../billing-center/references/api.md), [stores-and-providers.md](../billing-center/references/stores-and-providers.md),
  [faq.md](../billing-center/references/faq.md)

## When to Use

- The app adds or changes a purchase, subscription, consumable, rewarded ad, paywall or web payment.
- The app is published, or will be, in more than one store (Google Play, RuStore, Huawei AppGallery, Samsung, Apple, Amazon) or as an APK/web build.
- A release candidate of an app that already monetizes.
- A store, ad network or gateway is about to be enabled for a production app (the sandbox proof is part of this gate).

## How It Works

### 1. Server side: only through the Billing Center

- Register the app with a manifest (`billingctl apply -f <app>.yaml`); products use the same ids in every store console when possible (or `store_ids`);
  `routing` lists countries and a default channel. Check it offline first: `billingctl manifest check -f <app>.yaml`.
- The app backend never calls store, ad-network or gateway server APIs and never holds their credentials. It calls the Billing Center (`verify`, `sync`,
  `entitlements`, `binding`, `rewards:claim`, `payments`) with a per-app API key from a secret file (0400), and consumes signed entitlement webhooks
  (Standard Webhooks over the raw bytes, current + previous secret, 5 minute tolerance, per-account sequence guard) plus the `/v1/events` catch-up at
  start and about every minute.
- Access is decided by Billing Center entitlements checked by grant **name** (`premium`, `coins`) with the expiry re-checked, never by the client and
  never by a store receipt the client shows. Any unavailable Billing Center answer grants nothing.
- Every store, ad network and gateway stays disabled until a real sandbox purchase is recorded with `billingctl stores|ads|payments enable ... --evidence`
  (a production app gets `403 provider_not_bound` until then). The shop switch `purchase_button` is set to true only after that.

### 2. One build per store

- A `store` flavor (Android) or equivalent build variant per store. A store build contains only that store's billing SDK, permissions and code (store
  review rules); enforce it with a dependency and source boundary check, a merged-manifest policy and a packaged-class artifact check per lane.
- Store ids (install source): Google Play `com.android.vending`, RuStore `ru.vk.store`, Huawei `com.huawei.appmarket`, Samsung
  `com.sec.android.app.samsungapps`, Amazon `com.amazon.venezia`. The flavor decides the store; the installer is a routing hint and a diagnostic.
- Huawei builds must not depend on Google services (FCM, Google sign-in, Maps, Play Billing); RuStore checkout handles "RuStore not installed"; Huawei
  checkout handles missing HMS Core, each as a dedicated outcome with an install prompt.

### 3. Transparent channel choice (ADR-0002 of the Billing Center)

- At start the client calls `GET /public/v1/route/{app}?installer=<installingPackageName>&country=<locale>` and verifies `Config-Signature` (Ed25519, over the
  exact body bytes) with the app's embedded public key (printed by `billingctl apply` and `billingctl apps show` as `config_public_key`) **before** using or
  caching anything. Priority: install source, then the edge's country, then the default channel. The last verified copy is cached with its ETag and
  re-verified on every use.
- Products, ad units, caps, allowed payment methods and switches (`purchase_button`) come from that signed document, not from build constants. No purchase
  action is shown unless the verified channel names this build's store **and** `purchase_button` is true **and** the product is in the store map; every
  failure means "nothing for sale".

### 4. Purchase flow

- Before checkout the client gets the account binding from its backend (which calls `GET /v1/accounts/{id}/binding`; neither client nor backend can compute
  it) and passes it unchanged to the store: Google `setObfuscatedAccountId`, RuStore and Huawei `developerPayload`; memory-only, never logged. A token
  presented for another account is rejected (`account_mismatch`).
- The client sends the store token to its backend, which calls `verify` with an `Idempotency-Key`. Tokens: Google `purchaseToken`; RuStore subscription
  `purchaseId` (UUID) and one-time product `invoiceId`; Huawei subscription `subscriptionId~purchaseToken` and one-time `purchaseToken`.
- Consumables are consumed/confirmed at the store (and `:consume` called at the Billing Center) only **after** the backend confirmed the grant; purchases
  that finished while the process died are drained on start and reconciled.
- Rewarded ads: server-verified networks (AdMob SSV: user id = account id, custom data = binding) grant through callbacks; networks without server
  verification (Yandex) only via `client_attested` placements with a daily cap and low-value grants that no product sells (ADR-0003) through the backend's
  `POST /v1/rewards:claim`. The client shows "reward pending" until the backend reports the grant.
- Direct payments only where store rules allow (web, outside stores) through hosted gateway pages; card data never touches the app or its backend.

### 5. Evidence required before a release

| Evidence | How |
|---|---|
| Boundary | per-store release artifact check passes for every store lane (Worlio: `verifyStoreBoundary<Flavor>`, `verifyReleaseManifestPolicy<Flavor>`, `verifyReleaseArtifact<Flavor>`) |
| Routing | client test: unsigned, tampered or foreign-key config is refused; signed config selects the right store; offer is empty for another store, switch off or unmapped product |
| Binding | client passes the backend binding to the store SDK (unit test with a fake gateway); token shapes per store tested |
| Backend | verify/restore/webhook/catch-up tests against a fake Billing Center (every error code, stale and duplicate events, outage); live profile against a running one |
| Sandbox | one real sandbox purchase per enabled store with recorded `--evidence` (order id and date, never a token) |
| Store consoles | product ids, server notification URLs (`https://pay.<domain>/v1/notifications/<provider>/<app>`), keys, push audience and service account |
| Privacy | data-safety and privacy declarations cover each store SDK (RuStore tracer, HMS components) |

Run the whole list as [checklist.md](references/checklist.md) and record the result in the release record.

## Examples

- New game with a subscription on Google Play and RuStore: manifest with both stores and `routing: {countries: {RU: rustore-android}, default: google-android}`; two
  flavors; client route call with the embedded key; backend `verify` + webhook route + catch-up; sandbox purchase in each store; enable both stores with
  evidence; then `purchase_button: true` per channel.
- Adding rewarded hints on Huawei builds: Yandex placement with `verification: client_attested`, `daily_cap`, a hints-only grant; backend `POST /v1/rewards:claim`;
  client shows the reward after the backend grant.
- Reference implementation: Worlio (`worlio-v1`: backend ADR-0090, platform ADR-0089, Android flavors ADR-0091) in the private product repository
