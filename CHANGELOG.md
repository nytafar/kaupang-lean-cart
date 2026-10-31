# Changelog

All notable changes to this plugin are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

### Fixed
- The cart's shipping row no longer reads "Gratis" before a shipping rate is chosen (a new session with no address: the Store API's shipping total is 0 then). It reads "Beregnes i kassen" (new string `shippingPending`) until each package has a selected rate, "Gratis" for a selected rate costing 0, and is left out when nothing ships. Normalized carts carry `shippingState` (`none`, `pending`, `free`, `paid`); the checkout seed carries each rate's `selected`.

### Changed
- check.php runs the load budget audit.
- The cart's JS loads as WordPress core script modules (`@kaupang/lean-cart/<name>`). Core prints the page's one import map, so pages with Interactivity blocks (the FAQ accordion) no longer carry two maps, and it preloads the static imports (`config`, `api`, `store`, `ui`, `add`), so the three-level import chain becomes one round. Extension and classic-page modules are dynamic imports (preloaded on the shortcode checkout, as before). Each file is versioned with its own modification time.
- The config is core's script module data (`script_module_data_@kaupang/lean-cart/config`, read by the new `cart-config.js`); the `kaupang/lean-cart/config` filter is unchanged. The shortcode checkout's cart seed goes into it when core prints it in the footer.
- `lean-cart.css` is no longer render-blocking: it styles only the drawer and the checkout lines, so `cart-init.js` adds it on the first interaction (`pointerdown`, `keydown`, `lean-cart:open`), before the page's other stylesheets so theme overrides still win. It stays in `<head>` on the shortcode checkout and lean-checkout's page. `kaupang/lean-cart/disable_styles` still turns it off; `wp_dequeue_style()` alone no longer does.

### Removed
- Lean Cart's own import map, its `script_loader_tag` rewrite to `type="module"` and the `kaupang/lean-cart/importmap_imports` filter (its one user, lean-checkout, registers its own modules with core now).
- `window.leanCartConfig`. No reader outside the plugin was found (themes on the myrvann, nyta and zenso sites, kaupang-wholesale, kaupang-crm, lean-checkout, server scripts). `window.leanCart` and the `lean-cart:*` events are unchanged.

### Added
- `tools/check.php` (`wp eval-file`): one import map, the static imports preloaded, dynamic ones only mapped, config as module data, where the stylesheet loads, every JS import a registered id, and the hooks that work outside page views. `tools/load-budget.php` and a README load map.

## [0.2.3] - 2026-10-24

### Added
- The shortcode checkout's order review shows Lean Cart's item lines: the drawer's line markup with `+`, `−` and remove, all through the cart's queue, so the shopper can edit the order where they review it. Coupons, shipping, fees, VAT, totals and payment stay WooCommerce's and refresh through `update_order_review` after each change; the totals are marked as updating until then. Lines show their subtotal before coupons, as WooCommerce's rows do. WooCommerce's own rows stay until Lean Cart has painted its lines (and without JS). Focus stays on the control used (or the nearest one that can take it), and a screen-reader status reads the new quantity or the removal. Mix-and-Match box contents are listed under the box without controls. Not on FunnelKit checkout pages, which have their own summary. On by default; `add_filter( 'kaupang/lean-cart/checkout_lines', '__return_false' )` keeps WooCommerce's rows. New strings `checkoutLines`, `lineQuantity`, `lineRemoved` in `kaupang/lean-cart/i18n`.
- `store.invalidate()`: the cart changed outside the store; the next quantity change re-reads it in its own turn. Additive. Normalized items carry `lineSubtotal`.
- Lean Cart's line buttons are `type="button"`, so a line inside a form never submits it.
- The shortcode checkout carries the cart (`leanCartConfig.cart`, WooCommerce's own Store API hydration as its block checkout uses), and the store starts from it (`store.seed()`, additive), so the checkout lines paint as soon as Lean Cart's modules run, about 30 ms after DOMContentLoaded on staging, instead of after the first cart read 2–3 s in. The modules are `modulepreload`ed on that page. The seed is read in the footer, from the cart the shortcode has calculated, and leaves the classic checkout as without it on WooCommerce 10.x and 11.x: it never calculates the cart itself (that would be in block mode: another default shipping method saved to the session, shipping hidden until an address is entered), and it puts back the cart context (WooCommerce before 11.1 leaves it on `store-api`), the shipping packages, the session (notices, chosen shipping method) and the Store API nonce check on every exit, also when the route throws an `\Error`. It carries only what the store's normalizers read: no addresses, shipping rates, payment methods, cross-sells or descriptions. `tools/check-seed.php` (`wp eval-file`) proves it.
- The drawer keeps keyboard focus across a repaint, as the checkout lines do: on the control used, or the nearest one that can take it; with no line left, the empty state's link. A list whose markup did not change is not repainted.

### Changed
- `modules/classic-pages.js` and `modules/checkout-lines.js` take what they used to import from `cart-init.js` (`classic-pages` `init()`'s `wait` option, `checkout-lines` `init()`'s third argument), and `cart-init.js` imports them side by side and starts the lines once the bridge runs. A dynamic import of a module that imports others resolved behind the checkout's DOM-ready scripts (0.2 s later); without imports both resolve in one step, with the seed. Both stay dynamic imports, so one that fails to load (404, network, content blocker) leaves the drawer working on every page, and the checkout keeps WooCommerce's rows (and, without the lines module, the bridge).

### Fixed
- Prices with øre show both decimals ("178,20 kr", was "178,2 kr"); whole amounts stay short ("179 kr"). Drawer, checkout lines and totals.
- Product text in the drawer's and checkout lines' markup is escaped for attributes too (quotes in `aria-label`, `alt`, `href`): a name with `"` could break the markup or add an attribute.
- The cart script loads as a module also when the inline config contains `type=` (a product description in the checkout's cart, or an i18n string); only the entry point's own tag gets `type="module"`.
- Shortcode checkout: a change from the summary or the drawer that empties the cart, or a read that finds it emptied (another tab, an order placed there), replaces the checkout with the cart page (`location.replace()`); it used to end in "Beklager, økten din har utløpt" with no form left. Not a reload, which re-ran an `?add-to-cart=` in the checkout's URL and put the product back, and no history entry leads back to the stale checkout.
- Classic cart page: when the in-turn re-read of an invalidated cart fails, the quantity change is sent from the cart the store has (as before), instead of being dropped after holding the queue for the 10 s write-settle wait.
- Checkout lines: Enter or Space on a focused line button while the order is being placed does nothing (blockUI's overlay stops only the mouse); a failed remove is no longer announced as removed; an error shows only in the region (drawer or summary) that has focus, so it is announced once; a read that changes the lines triggers one totals refresh and the read after it none, so a plugin that changes lines on every calculation cannot loop; the hide rule for WooCommerce's rows is printed with the mount, so it holds with `kaupang/lean-cart/disable_styles` (items were listed twice).
- Classic cart page: a drawer `+`/`−` whose write took its turn after a cart-changing classic request (Update cart 2→3, then `+` within the debounce) counted from the cart read before that request and lost the change (ended at 3, not 4). The bridge now invalidates the store's cart when a classic request ends, and the write re-reads the cart in its turn first.

## [0.2.2] - 2026-10-23

### Fixed
- WooCommerce's classic cart page and shortcode checkout now cooperate with the drawer. WooCommerce's own cart and checkout requests (its classic `wc-ajax` endpoints, and cart.js's form posts and remove/undo links on the cart page) take turns in the cart's queue with the drawer's writes, so `update_order_review` no longer saves its older cart over a drawer change. The bridge holds the request's `XMLHttpRequest.send()` until its turn, so callers keep jQuery's real jqXHR: `readyState`, `status`, response headers, `abort()` and the global ajax events behave as jQuery's own (Vipps' "checkout totals are updating" check passes once an update has settled). A classic request keeps its turn while it is out, up to 65 s (nginx answers 504 at 60 s); one aborted in flight keeps it until the server has answered, and one aborted before its turn is never sent. A request jQuery already had out when the bridge loaded is waited for the same way, also when checkout.js aborts it meanwhile. A caller's jQuery `timeout` counts from the request's turn, not while it waits for one.
- A drawer change refreshes the page once its writes have landed (checkout: `update_checkout`; cart page: `wc_update_cart`; the empty-cart page is left alone instead of reloading). On the cart page the form stays blocked from the drawer change until a refresh made after it has replaced the form, including a form cart.js swaps in from an earlier Update cart meanwhile, so "Update cart" or Enter cannot post older quantities over the drawer's. A classic request (Update cart, coupon, remove link, shipping, order review) makes the drawer re-read the cart once; not on a page without Lean Cart markup (FunnelKit's checkout pages). On the shortcode checkout the drawer's first read of the page is the one after checkout.js's page-load `update_order_review`, which no longer waits behind a separate read.
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
