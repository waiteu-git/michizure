> # ⚠ DRAFT — not for publication
> Submission-facing README draft.
>
> **Cleared (2026-09-05):**
> ✅ Repo-proof audit — BH checked every claim against code; sizes independently recomputed from the
> committed `public/` artifacts and matched exactly (3,416 + 6,018 + 1,430 = 10,864 B). No false claims.
> ✅ Copy — tagline and the naming of competitors decided with the user.
>
> **Still required before this replaces `README.md` or goes public:**
> 1. **Fill the Demo placeholders** (video link + 1–2 screenshots) — the section ships blank otherwise.
> 2. **Re-measure every number.** Measured 2026-09-05 with `gzip -9`, except the KDF timing (2026-08-14).
> 3. **Pre-publication scrub audit.**
> 4. ⚠ Making the repository public is a **human-only** action and is not implied by any of the above.
>
> RevenueCat is **not integrated** — see the marked section. Keep that marking until it actually is.
>
> 🔴 **Correction carried in this draft:** the "9.3KB / 9,441 B initial load" figure quoted before
> 2026-09-05 is **wrong**. It counted `index.html + app.js` and assumed all four esbuild chunks were
> lazy; one of them (`chunk-IWUKCSCV.js`, the shared crypto/state core, 1,430 B) is a **static** import
> and loads on first paint. Correct figure: **10,864 B**. Dependent documents were updated (the derived
> "24×" ratio became "~21×" — derived values do not contain the original number, so they cannot be
> found by searching for it).

---

# Michizure

**Splitting trip costs, for the trip you are actually on.**
No accounts. Works with no signal. The server stores only ciphertext and thin metadata.

## The problem is not the arithmetic

Dividing a restaurant bill is easy. What breaks on an actual trip is everything around it:

- **Signal is worst exactly where you need to record.** Mountains, ferries, basements, abroad on
  a bad roaming plan. You note "¥4,200, Sato paid" *then*, or you never note it.
- **Asking five friends to sign up ends the conversation.** By the time everyone has made an
  account, someone has given up and you are back to a group chat and a notes app.

## Demo

<!-- ⚠ DRAFT PLACEHOLDERS — must be filled before publication. Do not ship this section as-is. -->

**Video:** _TODO: demo video link_
**Screenshots:** _TODO: 1–2 images — (a) recording an expense offline, (b) the settlement view_

A 60-second walkthrough: create a room, share the URL and the passphrase separately, add an
expense with the network off, reload, watch it sync when the network returns.

## What this is not

There are good split-billing apps. **This one does not beat them on features.** Ten existing
services were surveyed while designing it — Walica, Splitwise, タテカリ, レコペイ, groupay, Nowa,
Walimo, FAMI-KAN, ワリナビ, TATEKA — and every feature first considered "our differentiator"
already shipped somewhere.

So this is not a better spreadsheet. It is a **narrower tool that gives up different things.**

## What we gave up, and what that bought

| Given up | Bought |
|---|---|
| Accounts, sign-up, password reset | A room is a URL plus a passphrase. Nothing to create, nothing to lose but the passphrase |
| The server being able to read your data | It is also **unable to help you recover it**. A lost passphrase is unrecoverable |
| Reading IP addresses in our own code | Abuse has to be throttled at the platform layer instead of in code. **This does not mean no IP is recorded anywhere** — see below |
| A framework | **10,864 bytes gzipped** on first load, for the whole app |
| Automatic merge of conflicting edits | Conflicts are **shown to you**, never silently resolved |

## What the server actually holds

We would rather be precise here than reassuring.

- **The room's ciphertext and its IV.** Encryption and decryption happen in your browser; the key
  is derived from the passphrase and never sent.
- **Plaintext metadata:** room ID, created/last-accessed timestamps, the KDF salt, a hash of the
  auth key, and the KDF parameters. Room size and how often it changes are therefore visible.
- **Application logs are off** — `[observability] enabled = false`, enforced by a check that runs
  before every test run.
- **Our code never reads any IP header** (`CF-Connecting-IP` and friends), also enforced by that check.
- **But the platform does.** Cloudflare retains request data including IP addresses — Security
  Events for 24 hours and Security Analytics for 7 days on the free plan, plus its own edge logs
  for a period Cloudflare does not publish. We cannot switch this off, and we will not imply we have.

## Design choices, and why

**Local-first, not offline-as-a-feature.** Every change commits to the device *first*; the network
is attempted afterwards. Reversing that order is the difference between "the app is slow on bad
signal" and "the entry you typed is gone after a reload". Reloading mid-flight keeps your data, and
the pending change syncs itself when signal returns.

**Conflicts are surfaced, not merged.** Two people editing offline is normal on a trip. The app
shows both versions and says plainly that the one you don't pick will be lost, because silently
overwriting someone's evening of receipts is worse than asking.

**The passphrase is generated, not chosen.** Five words from a 1,024-word list (~50 bits). Doubling
the KDF iteration count buys 1 bit; adding one word buys 10. Strength has to come from the
passphrase, so we generate it. The list is derived from BIP-39's Japanese word list (MIT) and
filtered so no two words collide when spoken aloud — shared first three characters, identical shape
without voicing marks, or the same sound after common mishearings.

**The passphrase is normalized before it becomes a key.** Japanese voicing marks have two encodings
that look identical on screen. Without normalization the same passphrase typed on two devices
derives two different keys — a failure whose symptom ("wrong passphrase") points nowhere near its
cause. Normalization is therefore part of the key contract, not a convenience.

**Key-derivation parameters are stored per room.** Iteration count and normalization version live
with the room, so changing the defaults later cannot lock anyone out of a room created today.

**The API origin is read from a `<meta>` tag, not baked in at build time.** You can open the shipped
artifact and see where it talks to. A build-time constant would be invisible.

## Monetization — ⚠ DESIGNED, NOT BUILT

**RevenueCat is not integrated.** Only the dependency is installed; no purchase flow, no
entitlement check, and no paid feature exists in this repository today. This section is the
intended design, written so it can be reviewed — not something you can run.

The hard part is not checkout. It is that **this app has no accounts**, so there is no user to
attach an entitlement to. Three options exist, and each costs something real:

- **Attach to the room** — the server would have to store "this room is paid", which adds a field
  to what the server retains and moves the ground under the privacy policy.
- **Introduce accounts** — undoes the premise of the product.
- **Attach to the device** (chosen) — keeps the server ignorant, at the cost of purchases not
  surviving a device change and not following a shared room.

Because the server must stay ignorant of payment, **paid features are constrained to things
decidable entirely on the device**: export, local summaries, presentation. Anything requiring the
server to behave differently for a paying user is excluded by construction, not by preference.

The part worth building carefully is **entitlement while offline**: an app designed to work with no
signal must decide what a paying user sees when RevenueCat cannot be reached.

## Measured numbers

| | |
|---|---|
| **First load** | **10,864 B** gzipped — HTML 3,416 + app 6,018 + shared crypto/state core 1,430 |
| Loaded only when creating a room | 4,556 B (word list + passphrase generation) |
| Loaded only when importing old data | 1,021 B |
| Key derivation, 600,000 PBKDF2 iterations | **70 ms** — one Android device, Chrome 151, median of 3 (2026-08-14) |
| Tests | **112** |
| Room auto-deletion | 365 days after last access |
| Ciphertext ceiling enforced by the server | 256 KiB |

The KDF timing is **one device**. It is fast enough that no per-device tuning was needed, but it is
not a claim about phones in general.

## Run locally

Requires Node and a Cloudflare Workers toolchain (`wrangler`, installed as a dev dependency).

```bash
npm install
npm run dev      # builds the client bundle, then starts wrangler dev
```

`npm run dev` prints the local URL. Open it, create a room, and the app is fully usable
offline from that point — nothing else needs to be running.

```bash
npm test         # 112 tests; the pretest step also checks the privacy config and the word list
npm run typecheck
npm run build:wordlist   # regenerates the word list and its bundled copy from one source pass
```

The token-signing secret in `wrangler.toml` under `[vars]` is a **development value only**.
A deployment sets the real one with `wrangler secret put TOKEN_SECRET`; leaving the dev value
in place would let anyone forge an access token.

## Limitations

- **A lost passphrase means the data is gone.** We cannot recover it. This is structural, not a
  missing feature.
- **Anyone with the URL and the passphrase can read everything in that room.** Send them through
  different channels; both in one message means one leak opens the room.
- **This encryption is not verifiable by you.** We serve the JavaScript that does the encrypting.
  We design it so we cannot read your data, and we will not claim more than that.
- **Metadata is not encrypted** — see "What the server actually holds".
- **Anyone who knows a room's URL can temporarily lock it** by failing the passphrase. Backoff
  starts at the 5th failure (1 minute) and doubles to at most 1 hour, clearing after 24 hours
  without failures. Because our code cannot tell clients apart, the block lands on the room rather
  than on whoever caused it.
- **Room creation is unauthenticated and unthrottled in code.** Throttling depends on a platform
  rule configured outside this repository.
- **The 20-member cap is enforced only in this client.** The server cannot check it.

## 日本語（要約）

旅先で使う前提の割り勘アプリです。**アカウントを作らず**、合言葉つきの部屋を URL で共有します。
**電波が無くても動き**、入力はまず端末に確定してから通信します。サーバーが持つのは暗号文と、
部屋ID・時刻などの平文のメタデータだけです。

機能で既存サービスに勝つものではありません。**捨てたものと引き換えに得たもの**で作られています。
合言葉を失うとデータは戻りません。IP アドレスについては、アプリは読みませんが**基盤側（Cloudflare）
には残ります**。詳しくは上の「What the server actually holds」と Limitations を読んでください。
