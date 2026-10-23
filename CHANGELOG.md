# Changelog

All notable changes to this plugin are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

### Fixed
- WooCommerce's classic cart page and shortcode checkout now cooperate with the drawer. WooCommerce's own cart and checkout requests (its classic `wc-ajax` endpoints, and cart.js's form posts and remove/undo links on the cart page) take turns in the cart's queue with the drawer's writes, so `update_order_review` no longer saves its older cart over a drawer change. The bridge holds the request's `XMLHttpRequest.send()` until its turn, so callers keep jQuery's real jqXHR: `readyState`, `status`, response headers, `abort()` and the global ajax events behave as jQuery's own (Vipps' "checkout totals are updating" check passes once an update has settled). A classic request keeps its turn while it is out, up to 65 s (nginx answers 504 at 60 s); one aborted in flight keeps it until the server has answered, and one aborted before its turn is never sent.
- A drawer change refreshes the page once its writes have landed (checkout: `update_checkout`; cart page: `wc_update_cart`, the cart form blocked meanwhile so "Update cart" cannot post stale quantities; the empty-cart page is left alone instead of reloading). A classic request (Update cart, coupon, remove link, shipping, order review) makes the drawer re-read the cart once.
- The order submit (`wc-ajax=checkout`) waits for pending drawer changes and holds the queue until it settles. While an order is being placed (`form.checkout.processing`, also through a 3-D Secure or Vipps step) the page is not refreshed and the drawer does not re-read; when the order fails and the form is handed back, the page catches up once.
- The bridge (`modules/classic-pages.js`) loads where cart.js or checkout.js runs and acts only on the classic cart page and the shortcode checkout form.

### Added
- `lean-cart:updated` carries `detail.source`: `'optimistic'`, `'write'` or `'read'` (`fetchCart`). Additive.

## [0.2.1] - 2026-10-23

### Fixed
- Cart writes no longer lose updates. Every Store API call (add, quantity, remove, coupons, fetch) now goes through one queue, so WooCommerce's read-modify-write cart session sees one request at a time, in order. Before, two overlapping writes overwrote each other: on Wholesale's order table, `+` twice and then a variation left the line at 2, not 4 (crm plan D-121).
- The state is the server's latest answer with still-pending optimistic changes replayed on top. An earlier write's response no longer overwrites a newer change.
- A failed write restores the server's real cart (the cart in a 409 error, otherwise a fresh fetch), not a snapshot from before the op that also undid writes that succeeded meanwhile.
- A `changeQuantity()` promise superseded by a newer change on the same line now settles with the write that carries it; it used to hang. Removing a line cancels its pending quantity write.
- Quantity changes are kept as a delta and turned into an absolute quantity when the write takes its turn, from the server's latest cart (within the line's min/max). An add that merged into a line followed by `+` on it no longer loses the add.
- Every Store API request times out after 20 s. A request that never answers no longer freezes the queue; the store re-fetches the real cart and moves on.
- Queued calls run under the Web Lock `kaupang-lean-cart` where available, so two tabs of the same shop serialise their writes too.
- `[data-lean-cart="checkout-url"]` links wait for queued writes (8 s at most) before navigating, so a burst of changes is not lost on the way to checkout.
- Waiting for the Web Lock is limited to 25 s; after that, or when the lock is refused (e.g. SecurityError), the write runs without it. A tab suspended while holding the lock (iOS Safari) no longer freezes the other tabs' carts.
- `fetchCart()` no longer takes the Web Lock (it stays in the tab's queue): a held lock disables the back/forward cache on older Chromium (Samsung Internet).
- A write cut off by the 20 s timeout may still finish on the server: the store now waits 10 s, holding its turn, before re-reading the cart. The shopper sees the write if it landed, and nothing queued overlaps the still-running request.
- A pending `+`/`−` on a line that disappeared (another tab, re-keyed) now raises the update error and shows the real cart; it used to snap back silently.
- The checkout link's `aria-busy` is cleared before navigating and on `pageshow`, so Back from checkout no longer leaves it marked busy.

### Added
- `store.whenIdle()` (resolves once queued writes and debounced changes have landed) and `store.enqueue( fn, { timeout } )` (run your own Store API call in the cart's queue; `timeout: Infinity` holds the turn until it settles, for an order submit). Additive; the rest of the contract is unchanged.
- `tools/check-cart-queue.mjs`: drives the store against a fake Store API with WooCommerce's lost-update session, and sets latency, failures, hangs and network errors per request; exits non-zero on failure. Run it with `/root/.nvm/versions/node/v22.21.0/bin/node tools/check-cart-queue.mjs` on the server (any Node 18+). An exception to the suite's PHP-native check rule (conventions §10): the store is browser JavaScript and cannot be driven from PHP.

## [0.2.0] - 2026-09-29

Renamed WooCommerce Lean Cart → **Kaupang Lean Cart** before first production deploy. Identity moved, the
front-end contract stays frozen. No back-compat aliases (all consumers are in-house and ship in the same change).

### Changed
- **Breaking — moved:** folder/main file/text domain `kaupang-lean-cart`, constants `KAUPANG_LEAN_CART_*`,
  public hooks `lean_cart_*` → `kaupang/lean-cart/*` (`show_variation_labels`, `i18n`, `config`,
  `importmap_imports`, `disable_styles`, `live_notices`, `notice_cookie`, `apfs_scheme_description`,
  `enqueue_scripts`, `loaded`), script/style handles `kaupang-lean-cart-{init,styles}`, Store API extension
  namespaces `kaupang_lean_cart_{apfs,sublium}`, internal cart-item key and Store API error code
  `kaupang_lean_cart_*`. Header per suite standard (GitHub Plugin URI, `@package Kaupang\LeanCart`).
- **Kept (frozen contract):** `window.leanCart`, `window.leanCartConfig`, `lean-cart:*` events,
  `[data-lean-cart*]`, `.lean-cart*`, `--lc-*` tokens, cookie `lc_notice`, localStorage key `leanCart`,
  classes `Lean_Cart_*` (namespace move is a later change).

## [0.1.1] - 2026-09-29

### Added
- Sublium Subscriptions integration with recurring totals display.
- `lean_cart_importmap_imports` filter so sibling plugins dock into the single import map.
- Cacheable pages for cart-holders: header count painted from a localStorage snapshot, WooCommerce notices wrapped in `<noscript>` off cart/checkout/account (`lean_cart_live_notices`, `lean_cart_notice_cookie`).
- All Products for Subscriptions: the chosen subscription scheme is carried through the Store API add and shown in the panel with its cadence (`lean_cart_apfs_scheme_description`).

### Changed
- Mix and Match child nesting moved from the `lean-cart:updated` listener into the cart normalizer.
- Adopted suite kit v1: header `Version:` is the single source of truth (synced by `tools/pre-commit`), this CHANGELOG replaces the README changelog, standard plugin header, HPOS and cart/checkout blocks compatibility declared.
- Suite kit v2.1 (tooling, generated readme.txt); no runtime change.
- Skeleton CSS fallbacks are palette-neutral (currentColor/Canvas); themes are the only source of colour.
- Extension modules get versioned URLs in the import map, so module edits bust the browser cache.

### Fixed
- Cart cookies are re-set after Store API requests so the cart hash matches page loads.
- Product titles with HTML entities (e.g. apostrophes) no longer show literally in the cart.
- Duplicate subscription badges collapse to one.

## [0.1.0] - 2026-04-14

- Initial release.
- Store API cart state layer with optimistic updates and rollback.
- Native ES module architecture with import map cache busting.
- Skeleton CSS with CSS custom property token mapping.
- Cold-fetch guard — zero cart overhead for new visitors.
- Legacy cart fragments disabled automatically.
- Form interception for simple, variable, grouped, and subscription products.
- Loop/widget link interception for archive pages.
- Module: WooCommerce Subscriptions — billing summaries, badges, meta rows.
- Module: Mix and Match Products — `mnm_config` form extraction, parent-child nesting, server-side validation guard.
- Module: All Products for Subscriptions — Store API extension, purchase mode display.
- Event-driven theme integration via `lean-cart:*` custom events.
- Public JS API (`window.leanCart`).
- `data-lean-cart` attribute-based mount point system.
- Delegated click handler for cart actions (`data-cart-action`).
- Bridge to `window.numenu` navigation system.
