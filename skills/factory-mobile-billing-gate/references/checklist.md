# Mobile billing release checklist (copy-paste)

Copy this block into the release record of the app. Every line is a gate item with the command or file that proves it. Mark an item
`N/A` only with a written reason (for example: "the app sells nothing and shows no ads" makes the whole checklist `N/A`; "no rewarded
ads" makes section E `N/A`). `APP` is the Billing Center app id, `BC` the repository
`app_entry_root/billing-center/billing-center-v1`, `billingctl` runs through `kubectl -n billing exec deploy/billing -c billing -- billingctl`
in production or `docker compose -f $BC/deploy/compose.yaml --profile tools run --rm billingctl` locally. Never `cd` in Bash: use absolute paths
or `( cd X && ... )`. Details of every item: skill `billing-center` (`references/*.md`).

Result legend: PASS with the artifact or output, FAIL blocks the release, N/A with reason.

```text
App: ______  Release: ______  Date: ______  Stores in this release: ______  Verified by: ______
```

## A. Registration and server side (Billing Center)

- [ ] **A1 Manifest valid.** `billingctl manifest check -f app.yaml` exits 0 and `billingctl apply -f app.yaml --dry-run` shows the expected diff.
      Proof: command output attached; file `app.yaml` in the app's `factory/` or ops folder (never with secrets).
- [ ] **A2 Product ids** are identical in every store console, or mapped with `store_ids`. Proof: manifest `products` + the console product lists;
      `billingctl apps show APP` and the signed config `store.products` for each channel.
- [ ] **A3 Routing.** `routing.countries` and `routing.default` set when the app ships in more than one store or as APK/web; resolved routes
      printed by `manifest check` match the intended table (installer, then country, then default). Proof: `manifest check` output.
- [ ] **A4 Webhook decision.** Either `webhook:` points at the backend (https public host or in-cluster `*.svc` http) and passes `apply --dry-run`
      (`webhook_target_not_allowed` absent), or the app deliberately uses the pull feed only. Proof: dry-run output; backend route file.
- [ ] **A5 API key and secrets.** `billingctl keys create APP --scopes purchases:write,entitlements:read,events:read` done; key and webhook secret
      live only in secret files (0400); `git grep -nE "bc_(live|test)_[a-z0-9]{12}_|whsec_" -- .` finds nothing in the app repository. Proof: grep output; `billingctl keys list APP`.
- [ ] **A6 Config public key** (`billingctl apps show APP` -> `config_public_key`, `config_key_id`) is the value embedded in every store build.
      Proof: build property / `BuildConfig` value equals the command output.
- [ ] **A7 Credentials uploaded** for every store in the release. Proof: `billingctl apps show APP` shows `has_credentials: true` per binding.
- [ ] **A8 Store consoles configured** with the URLs printed by `billingctl apply`: Google RTDN Pub/Sub push (audience and service account equal the manifest),
      RuStore server notifications (+ notification key uploaded), Huawei notification URL v2 (+ IAP public key uploaded). Proof: console screenshots or the
      owner's record; `billing_notifications_total{outcome="accepted"}` rising after a test notification.
- [ ] **A9 Sandbox proof per enabled store**, recorded with evidence: `billingctl stores enable APP PROVIDER --evidence "..."`. Proof: audit entry
      (`stores enable`), `billingctl apps show APP` -> `enabled: true`, evidence text; procedure in `stores-and-providers.md` section 9.
- [ ] **A10 Ad networks and gateways** used by the app are enabled with evidence (`ads enable`, `payments enable`); client-attested placements have `daily_cap`.
      Proof: `apps show APP`.
- [ ] **A11 Purchase switch.** `purchase_button: true` is set for a store channel only after A9 for that store. Proof: manifest diff; signed config `switches`.

## B. App backend

- [ ] **B1 No store, ad or gateway server calls or credentials in the backend.** `git grep -nE "androidpublisher\.googleapis|public-api\.rustore|iap\.cloud\.huawei|oauth-login\.cloud\.huawei|api\.stripe\.com|api\.yookassa|api\.cloudpayments" -- backend` finds nothing; no store credential files in the repo. Proof: grep output.
- [ ] **B2 Verify.** Calls `POST /v1/purchases:verify` with **its own** product id, the player's account id and a stable `Idempotency-Key`; never trusts a client-sent
      state. Proof: test file (Worlio: `adapter/billing/BillingCenterSubscriptionVerifierTest.kt`).
- [ ] **B3 Error mapping.** Every code of `api.md` section 4 maps to a defined outcome (retryable vs permanent vs conflict vs operator). Proof: test table.
- [ ] **B4 Access decision** is by entitlement **grant name** from active items with the expiry re-checked; nothing is unlocked from a client claim or store receipt shown by the client. Proof: code + test.
- [ ] **B5 Binding endpoint** returns `GET /v1/accounts/{id}/binding` for the **authenticated** player only. Proof: route test (Worlio: `GET /v2/commerce/account-binding`).
- [ ] **B6 Restore** = `POST /v1/accounts/{id}:sync` then entitlements; a retryable partial failure fails the restore. Proof: test.
- [ ] **B7 Webhook route** verifies the **raw bytes** (Standard Webhooks, current + previous secret, 5 min tolerance), drops stale/duplicate sequences (per account), answers 2xx fast, 401 for untrusted. Proof: tests with the reference vector
      (`whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw`, `msg_p5jXN8AQM9LWM0D4loKWxJek`, `1614265330`, `{"test": 2432232314}` -> `v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=`) and an independent signer.
- [ ] **B8 Catch-up** from `GET /v1/events` at start and about every minute; cursor advances only past applied pages. Proof: test (paging, failure keeps the cursor).
- [ ] **B9 Consumables** call `:consume` after delivery with a stable key (or the app documents why the client path is enough). Proof: test or written reason.
- [ ] **B10 Outage behaviour.** With the Billing Center unreachable: purchases and restore fail closed, nothing is granted, readiness is not affected. Proof: test with a fake BC returning 503 and a closed port.
- [ ] **B11 Secrets handling.** API key and webhook secret read from files, never logged or rendered by `toString`; secret-leak test. Proof: test.
- [ ] **B12 Live profile** against a running Billing Center (sandbox twin) with a throw-away account. Proof: command output (Worlio: `gradlew billingCenterLiveTest` with `BILLING_CENTER_LIVE_URL`, `BILLING_CENTER_LIVE_API_KEY_FILE`, optional `BILLING_CENTER_LIVE_TOKEN`).

## C. One build per store

- [ ] **C1 A flavor (or equivalent variant) per store**; no universal artifact. Proof: Gradle `productFlavors` (`store` dimension) / project files.
- [ ] **C2 Boundary.** Each store build holds only its own billing SDK, permissions and code: dependency and source boundary check passes for every lane. Proof: Worlio `verifyStoreBoundary<Flavor>`
      (`StoreBoundaryPolicy`), packaged-class check `verifyReleaseArtifact<Flavor>`, merged-manifest policy `verifyReleaseManifestPolicy<Flavor>`.
- [ ] **C3 Huawei build has no Google services** (no `com.google.android.gms`, `com.google.firebase`, billing client, FCM, Google sign-in, Maps) and uses HMS equivalents where needed. Proof: boundary check output.
- [ ] **C4 Store identities.** Installer packages `com.android.vending`, `ru.vk.store`, `com.huawei.appmarket` (Samsung `com.sec.android.app.samsungapps`, Amazon `com.amazon.venezia`) used for diagnostics and routing only. Proof: constants + `InstallSource` test.
- [ ] **C5 RuStore not installed** is handled with an install prompt and **HMS Core missing** with its resolution dialog (a dedicated "store missing" outcome, not a generic failure). Proof: adapter tests.
- [ ] **C6 SBOM and locks** per flavor are current. Proof: `verifyAndroidCycloneDxParity` (or equivalent) PASS.
- [ ] **C7 Public build inputs** set: Billing Center base URL (https), config public key, app id, RuStore Console app id and pay scheme, AppGallery Connect app id (no placeholder `0`). Proof: release input check.

## D. Routing, purchase and recovery in the client

- [ ] **D1 Route call with signature verification.** At start `GET /public/v1/route/{app}?installer=..&country=..`; `Config-Signature` (Ed25519) verified over the exact bytes with the embedded key **before** use or caching;
      cached with ETag and re-verified; offline fallback to the last verified copy. Proof: tests refusing unsigned, tampered, foreign-key and wrong-app documents, a tampered cache, and covering 304 and offline.
- [ ] **D2 Fail-closed offer.** No purchase action unless the verified channel names **this build's store**, `purchase_button` is true and the product is in `store.products`; every failure means "nothing for sale"; plain HTTP only in debuggable builds. Proof: offer-projection tests.
- [ ] **D3 Binding to the store SDK.** The backend binding is passed unchanged: Google `setObfuscatedAccountId` (<= 64), RuStore and Huawei `developerPayload` (<= 250 / 128); memory-only, never logged. Proof: adapter tests with a fake gateway.
- [ ] **D4 Token shapes.** Google `purchaseToken`; RuStore subscription `purchaseId` (UUID) and one-time `invoiceId` (digits); Huawei subscription `subscriptionId~purchaseToken` and one-time `purchaseToken`. Proof: adapter tests.
- [ ] **D5 Settle after the backend confirmed.** Consume/acknowledge/confirm only after the grant; pending states stay pending; purchases that completed while the process died are drained on start and reconciled. Proof: coordinator/adapter tests.
- [ ] **D6 Restore** goes through the backend and shows the backend's result. Proof: shop/restore test.
- [ ] **D7 Rewarded ads** (if any). Server-verified networks (AdMob SSV): user id = account id, custom data = binding; client-attested networks (Yandex): placement `verification: client_attested` with `daily_cap`, backend `POST /v1/rewards:claim`; the client shows "reward pending" and grants nothing locally. Proof: manifest + tests.
- [ ] **D8 Direct payments** only in web/outside-store channels through hosted pages; card data never touches the app or backend. Proof: manifest (`store_channel_payments` would fail) + code review.
- [ ] **D9 Device contract tests** per flavor run on a device or emulator. Proof: `androidTest<Flavor>` results.

## E. Release evidence

- [ ] **E1 One real sandbox purchase per enabled store** with recorded evidence (order id and date, never a token). Proof: the `--evidence` text of A9.
- [ ] **E2 Store console values** (product ids, server notification URLs `https://pay.<domain>/v1/notifications/<provider>/<app>`, keys) match the manifest. Proof: console record vs `billingctl apply` output.
- [ ] **E3 Privacy and data-safety declarations** cover every store SDK (RuStore tracer component, HMS components, Play Billing). Proof: store declaration records.
- [ ] **E4 Billing Center health at release time.** `billingctl status` shows no dead inbox/outbox rows and no unacknowledged purchases; no active billing alerts. Proof: output.
- [ ] **E5 Rollback plan** written: disable switch (`purchase_button: false` + `apply`) and `billingctl stores disable APP PROVIDER --evidence "reason"` (only for wrong data or compromised credentials, not for a store outage). Proof: release record.
- [ ] **E6 Docs and memory** updated (`docs/operations/MEMORY.md`, checkpoints, ADR when the contract changed). Proof: factory docs-sync.

## Quick commands

```sh
billingctl manifest check -f app.yaml
billingctl apply -f app.yaml --dry-run
billingctl apps show APP                              # bindings, enabled flags, evidence, credentials present, config_public_key
billingctl status                                     # queues, dead rows, unacknowledged
billingctl stores enable APP google_play --evidence "sandbox 2026-10-10 order GPA.xxxx verify ack RTDN cancel refund passed"
curl -sD - "https://pay.example.com/public/v1/route/APP?installer=ru.vk.store&country=RU" -o /dev/null   # Billing-Channel, Billing-Matched-By, Config-Signature
git grep -nE "bc_(live|test)_[a-z0-9]{12}_|whsec_" -- .                                                    # must find nothing
```
