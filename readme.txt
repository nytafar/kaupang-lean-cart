=== Kaupang Lean Cart ===
Contributors: lassejellum
Tags: woocommerce, store-api, cart, mini-cart, developer-friendly
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 8.0
Stable tag: 0.2.2
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A modern, performant, and themable WooCommerce cart built on the Store API. Replaces legacy cart fragments with vanilla JS, ES modules, and events.

== Description ==

Lean Cart is a drop-in WooCommerce cart replacement built for developers who want full control over the cart experience without fighting legacy infrastructure.

It intercepts native add-to-cart forms and loop links, converts them into Store API calls, and maintains a single source of truth in a JS state store. The UI layer finds `[data-lean-cart]` mount points in your theme's markup and hydrates them — no shortcodes, no widgets, no blocks required.

= Architecture =

    cart-init.js          Entry point — boots store, UI, modules
      ├── cart-store.js   State management, normalizer pipeline, form extractors
      ├── cart-api.js     All Store API network calls, nonce management
      ├── cart-add.js     Intercepts form.cart submits and loop links
      ├── cart-ui.js      Pure renderer — subscribes to events, writes to DOM
      └── modules/        Conditionally loaded extensions
          ├── subscriptions.js
          ├── mix-and-match.js
          ├── all-products-subs.js
          ├── classic-pages.js   WooCommerce classic cart page / shortcode checkout bridge
          └── checkout-lines.js  Lean Cart's item lines in the shortcode checkout's order review

= Key design decisions =

- **No build step.** The JS ships as authored. ES module imports resolve at runtime via an import map printed in `<head>`. Cache busting uses file modification timestamps.
- **Styling lives in the theme.** The plugin ships skeleton CSS scoped under `.lean-cart` that maps to CSS custom properties (`--lc-text`, `--lc-border`, `--lc-accent`, etc.) with standalone fallbacks. Themes set these tokens or dequeue the stylesheet entirely via `add_filter('kaupang/lean-cart/disable_styles', '__return_true')`.
- **Modular plugin compatibility.** Extension modules are loaded conditionally based on class existence checks — zero overhead when the parent plugin isn't active.
- **Form extractor pipeline.** Modules can register functions via `store.addFormExtractor()` that read plugin-specific form inputs and inject extra fields into the Store API add-to-cart body. This keeps core generic while supporting complex product types.
- **Normalizer pipeline.** Modules register normalizers via `store.addNormalizer()` to enrich the display model with badges, subscription summaries, parent-child grouping, and purchase mode indicators.

= Plugin compatibility =

Lean Cart includes native modular support for:

- **WooCommerce Subscriptions** — billing period summaries, signup fee and trial period meta rows, subscription badges.
- **WooCommerce Mix and Match Products** — form extractor for `mnm_config`, parent-child grouping in the cart, container badges. Includes a server-side guard that rejects misconfigured containers.
- **All Products for WooCommerce Subscriptions** — custom Store API extension exposing active subscription schemes, purchase mode display (one-time vs. subscription).

Adding support for a new plugin means creating one PHP class in `includes/modules/` and one JS module in `assets/js/modules/` — no core changes required.

= Theme integration =

Lean Cart doesn't render a drawer, panel, or page. It hydrates mount points your theme provides:

    <!-- Anywhere in your theme -->
    <div class="lean-cart">
      <div data-lean-cart="items"></div>
      <div data-lean-cart="totals"></div>
      <div data-lean-cart="empty" hidden>Your cart is empty.</div>
      <div data-lean-cart="error" hidden></div>
      <a data-lean-cart="checkout-url" href="#">Checkout</a>
    </div>

    <!-- Badge on a menu icon -->
    <span data-lean-cart="count">0</span>
    <span data-lean-cart="label">0 items</span>

The plugin emits a `lean-cart:open` event when an item is added. If your theme exposes `window.numenu`, it bridges automatically. Otherwise, listen to the event directly:

    document.addEventListener('lean-cart:open', () => {
      document.querySelector('.my-cart-drawer').classList.add('open');
    });

= Public JS API =

    window.leanCart.store    // Full store access (getState, addItem, removeItem, etc.)
    window.leanCart.refresh() // Re-fetch cart from Store API
    window.leanCart.open()    // Dispatch lean-cart:open event
    window.leanCart.close()   // Dispatch lean-cart:close event

    window.leanCart.store.whenIdle()     // Resolves once queued writes and debounced changes have landed
    window.leanCart.store.enqueue( fn, { timeout } )  // Run your own Store API call (fn returns its promise) in the cart's queue
    window.leanCart.store.invalidate()   // The cart changed outside the store: the next quantity change re-reads it first

**One write queue.** WooCommerce saves the cart session whole per request, so overlapping Store API writes lose updates. Every store call goes through one queue. Writes also run under the Web Lock `kaupang-lean-cart` where the browser has it (tabs of a shop share one session); after 25 s without the lock, or if it is refused, they run without it. Reads (`fetchCart`) skip the lock. Each request times out after 20 s, so the queue always moves on. A write that timed out may still finish in PHP, so the store waits 10 s before re-reading the cart. Code that writes to the Store API itself should pass the call through `store.enqueue()` and then `refresh()`. An enqueued call gives up its turn after `timeout` ms (default 20000); `timeout: Infinity` holds it until the call settles (an order submit), so the call must time out by itself. Before leaving the page with pending changes (e.g. to checkout), await `store.whenIdle()` with a deadline. Lean Cart's own `[data-lean-cart="checkout-url"]` links already do.

== Installation ==

1. Upload the `kaupang-lean-cart` folder to `wp-content/plugins/`.
2. Activate the plugin in **Plugins → Installed Plugins**.
3. Add `[data-lean-cart]` mount points to your theme templates.
4. Optionally set CSS custom properties to match your theme tokens.

No configuration page. No settings screen. It works on activation.

== Usage ==

= Disabling the default stylesheet =

    add_filter( 'kaupang/lean-cart/disable_styles', '__return_true' );

= Customizing i18n strings =

    add_filter( 'kaupang/lean-cart/i18n', function( $strings ) {
        $strings['emptyCart'] = __( 'Nothing here yet!', 'my-theme' );
        return $strings;
    } );

= Extending the config object =

    add_filter( 'kaupang/lean-cart/config', function( $config ) {
        $config['myCustomKey'] = 'value';
        return $config;
    } );

= Adding a custom module =

**PHP** (`includes/modules/class-my-plugin.php`):

    class Lean_Cart_My_Plugin {
        public function __construct() {
            add_filter( 'kaupang/lean-cart/config', [ $this, 'extend_config' ] );
        }

        public function extend_config( array $config ): array {
            $config['modules']['myPlugin'] = true;
            return $config;
        }
    }

**JS** (`assets/js/modules/my-plugin.js`):

    export function init( store ) {
        store.addNormalizer( ( item, raw ) => {
            // Enrich items based on Store API extension data.
            return item;
        } );

        store.addFormExtractor( ( form ) => {
            // Return extra fields for the add-to-cart API call.
            return null;
        } );
    }

= Full-page caching =

Lean Cart is built so every page can be served from a shared page cache, cart or no cart:

- **Cart-agnostic HTML.** Render `[data-lean-cart]` mount points in their empty state (count `0` with `hidden`, empty state visible). Count mounts are hidden at zero and shown by Lean Cart.
- **Instant count.** A `{ hash, count }` snapshot in `localStorage` paints the count before the Store API fetch. It is only used while its hash matches the `woocommerce_cart_hash` cookie, so a count never outlives the cart it came from (order placed, logout, session expiry, a change made elsewhere).
- **Notices.** On GET requests outside cart, checkout and account, WooCommerce notices print inside `<noscript>`: no-JS visitors still see them, JS visitors get Lean Cart's own feedback. While session notices are pending, an `lc_notice` cookie is set. Configure your page cache to bypass entirely (no read, no store) when it is present.

    // Print notices normally on more pages.
    add_filter( 'kaupang/lean-cart/live_notices', fn( $live ) => $live || is_page( 'contact' ) );

    // Rename the pending-notice cookie.
    add_filter( 'kaupang/lean-cart/notice_cookie', fn() => 'my_notice' );

**Events.** `lean-cart:updated` carries `{ state, source }`. `source` is `'optimistic'` (a change not yet sent), `'write'` (a write's turn ended: the server's answer, or the real cart after a failure) or `'read'` (`fetchCart`). React to cart writes by skipping `'read'`, or a refresh that re-reads will loop.

**Classic cart and checkout pages.** On WooCommerce's classic cart page and `[woocommerce_checkout]` page, cart.js and checkout.js edit the same cart session as the drawer. `modules/classic-pages.js` is imported by `cart-init.js` where `wc_checkout_params` or `wc_cart_params` exists and acts only on a `form.checkout` (checkout) or the classic cart form or empty-cart message (cart page); `classicPage()` is that test. It queues WooCommerce's own requests: its classic endpoints (`update_order_review`, `checkout`, coupons, `update_shipping_method`, `get_cart_totals`, `add_to_cart`, `remove_from_cart`) and, on the cart page URL, the remove/undo links and posts carrying the cart form's or shipping calculator's nonce. A `$.ajaxPrefilter` wraps `settings.xhr()` so the request's `send()` waits for its turn in `store.enqueue()`; the caller keeps jQuery's own jqXHR. A request keeps its turn until it has ended, at most 65 s (nginx gives up at 60 s); an aborted one keeps its turn until the server has answered (PHP still saves the session), and one aborted before its turn is never sent. Requests jQuery already had out when the module loaded hold the first turn the same way: while they are out, `XMLHttpRequest.prototype.abort` leaves an XHR opened before the module loaded running once jQuery has detached its handlers, and is restored afterwards. A caller's `timeout` counts from the turn. The submit waits for `whenIdle()` and holds the queue until it settles. When drawer changes have landed, the page refreshes once (`update_checkout` / `wc_update_cart`, not on the empty-cart page); on the cart page the form is kept blocked until a refresh made after the last drawer change has replaced it. When classic requests have finished, the drawer re-reads once, unless the page has no `[data-lean-cart]` markup. On the shortcode checkout `cart-init.js` skips its cold read and the bridge reads after checkout.js's page-load `update_order_review` instead. Neither happens while `form.checkout` has `.processing` (an order is being placed); the page catches up when the form is handed back. Other plugins' own `wc-ajax` endpoints are not queued.

When a classic request ends the bridge calls `store.invalidate()`, so a drawer `+`/`−` whose write takes its turn after, say, an Update cart re-reads the cart in that turn and counts from the updated quantity (not after the order submit).

**Checkout lines.** On the shortcode checkout the order review's item lines are Lean Cart's: the drawer's line markup (images, variation and add-on rows, subscription badges and cadence, Mix-and-Match box contents without controls, sold-individually and stock limits as disabled buttons), with `+`, `−` and remove through the store. The price shown per line is its subtotal before coupons, like WooCommerce's own rows, so the lines add up to the classic subtotal row. PHP prints the mount (`[data-lean-cart="checkout-lines"]`, with its own error and screen-reader status) on `woocommerce_checkout_order_review` at priority 5, before the review table and outside the fragment `update_order_review` replaces; not on FunnelKit checkout pages. With it, PHP prints the two state rules (the mount hidden until painted; WooCommerce's `thead` and `tr.cart_item` rows hidden next to a painted mount), so they hold with `kaupang/lean-cart/disable_styles` too. The page carries the cart as `leanCartConfig.cart`: a Store API cart response made in-process through WooCommerce's own hydration (as its block checkout does: extensions' hydration hooks run), added to the config script in the footer, once the shortcode has calculated the cart, and trimmed to what the store's normalizers read (no addresses, shipping rates, payment methods, cross-sells or descriptions). It leaves the classic checkout as without it, on WooCommerce 10.x and 11.x: it is only read from a cart the page has calculated (the route would otherwise calculate it in block mode, with another default shipping method and shipping hidden until an address is entered), and the cart context, shipping packages, session (notices, chosen shipping method) and the Store API nonce check are put back on every exit (before 11.1 WooCommerce leaves the context on `store-api`, and an `\Error` in the route leaves notices cleared and the nonce check off); `tools/check-seed.php` proves it. The modules are `modulepreload`ed. `cart-init.js` imports the bridge and the lines side by side and starts the lines once the bridge runs; neither imports anything itself (`cart-init.js` passes what they need), so each dynamic import resolves in one step, before the checkout's DOM-ready scripts, and a module that fails to load (404, network, content blocker) leaves the drawer and WooCommerce's rows. It seeds the store (`store.seed()`) once the extension modules' normalizers are registered, so the lines paint as the modules run instead of after the first read. Until then, or without JS, WooCommerce's rows are the summary. Everything else in the review stays WooCommerce's: coupons, shipping (Bring), fees, VAT, totals and payment keep refreshing through `update_order_review`, which the bridge triggers after each change; the totals table is blocked as updating from the change until that refresh lands. A read that shows other lines (another tab) triggers one refresh, and the read after that refresh triggers none, so a plugin that changes lines on every totals calculation cannot loop. Focus stays on the control used, or moves to the nearest one that can take it (the other quantity button, the next line's remove); the drawer keeps focus the same way. While the order is being placed, a press on a line's button (Enter or Space reach it through blockUI's overlay) is stopped. When a change leaves the cart empty, or a read finds it emptied (another tab, an order placed there), the checkout is replaced by the cart page (`location.replace( cartUrl )`, not while an order is being placed): a reload would re-run an `?add-to-cart=` in the checkout's URL, and no history entry leads back to the stale checkout. Turn it off with `add_filter( 'kaupang/lean-cart/checkout_lines', '__return_false' );`.

What it does not cover: PHP that runs on after nginx's 504 (the browser has its answer, PHP may still save the session later), session writes from other plugins' endpoints, and a request jQuery had out before the module loaded beyond the same 65 s.

Self-checks: `wp eval-file wp-content/plugins/kaupang-lean-cart/tools/check-notices.php`, and for the checkout's cart seed `wp eval-file wp-content/plugins/kaupang-lean-cart/tools/check-seed.php` (run it on each WooCommerce major in use)

= Write queue check =

    # on the GridPane server (Node 22, outside the web root); any Node 18+ works, no dependencies
    /root/.nvm/versions/node/v22.21.0/bin/node tools/check-cart-queue.mjs

It drives `cart-store.js` against a fake Store API with WooCommerce's lost-update session, and sets latency, failures, hangs and network errors per request. It exits non-zero on failure. It covers: overlapping writes, older responses, add-merge then `+`, remove during a pending change, rollback (409 cart, fresh fetch, failed fetch, network error), timeouts, coupon/fetch order, a Mix-and-Match box, the event contract and `source`, two tabs, `whenIdle()` and `enqueue()`, and the classic pages bridge against a fake jQuery that follows jQuery 3.7's `$.ajax` (page gating; no overlap with `update_order_review`; one refresh per burst of drawer changes and one re-read per burst of classic requests, no loop; the caller's jqXHR against Vipps' `readyState` check; stale cart-form posts; the empty-cart page; which cart-page requests are queued; the submit hold, nothing after a placed order, catch-up after a failed one; aborts and jQuery's global events; the 65 s turn cap; a request out before the module loaded, and one aborted then; a caller's `timeout`; the form cart.js swaps in while a drawer change is pending; the checkout's page-load read order; no reads without Lean Cart markup; a drawer `+` whose write waits behind Update cart), and the checkout lines (where focus goes after a re-render, and that a repaint returns it to the new control, never takes it from outside the list, and skips unchanged markup; shown once painted, box contents without controls, `type="button"`, the line's displayed price, the totals blocked on a change, one refresh per change, a cross-tab read refreshes once and not during an order, no refresh loop, the screen-reader status and a failed remove, a press during the order, leaving an emptied checkout for the cart page after a change, from an `?add-to-cart=` URL and after a read, but not under a pending remove that fails), the price format, attribute escaping, the drawer's focus and where an error shows, a failed in-turn re-read, the seed (`store.seed()`, and `cart-init.js` applying it after the extension modules), and the module loading (the lines start once the bridge runs; a missing `classic-pages.js` or `checkout-lines.js` leaves the drawer and, for the lines, the bridge; neither imports anything).

This is an exception to the suite rule of one PHP-native check (conventions §10): the store is browser JavaScript and cannot be driven from PHP. `tools/check-notices.php` and `tools/check-seed.php` remain the PHP checks.

== Frequently Asked Questions ==

= Does this replace the WooCommerce cart page? =

No. Lean Cart replaces the cart *fragments* system and the add-to-cart AJAX flow. The `/cart/` page still works — Lean Cart operates alongside it, powering drawers, mini-carts, and any custom mount point.

= Does it work with WooCommerce Blocks? =

Lean Cart targets the same Store API that Blocks uses. They can coexist, but Lean Cart is designed for themes that want full control over cart markup rather than using the Cart Block.

= What happens if JavaScript is disabled? =

Forms fall through to their native POST behavior. The standard WooCommerce add-to-cart flow takes over and the `/cart/` page works as usual.

= Can I use this without any CSS? =

Yes. Either dequeue the stylesheet with `kaupang/lean-cart/disable_styles` or simply don't add the `.lean-cart` wrapper class and write your own styles targeting `[data-lean-cart]` attributes.

= How do I add support for another WooCommerce extension? =

Create a PHP module class in `includes/modules/` that hooks into `kaupang/lean-cart/config`, and a JS module in `assets/js/modules/` that registers normalizers and/or form extractors. Gate the PHP module on `class_exists()` in `Lean_Cart::load_modules()`. See the Subscriptions or Mix and Match modules for reference.

== Screenshots ==

No screenshots. Lean Cart is a headless cart layer with no admin interface — all visual output is controlled by your theme.

== Changelog ==

= 0.2.2 – 2026-10-23 =

**Fixed**
* WooCommerce's classic cart page and shortcode checkout now cooperate with the drawer. WooCommerce's own cart and checkout requests (its classic `wc-ajax` endpoints, and cart.js's form posts and remove/undo links on the cart page) take turns in the cart's queue with the drawer's writes, so `update_order_review` no longer saves its older cart over a drawer change. The bridge holds the request's `XMLHttpRequest.send()` until its turn, so callers keep jQuery's real jqXHR: `readyState`, `status`, response headers, `abort()` and the global ajax events behave as jQuery's own (Vipps' "checkout totals are updating" check passes once an update has settled). A classic request keeps its turn while it is out, up to 65 s (nginx answers 504 at 60 s); one aborted in flight keeps it until the server has answered, and one aborted before its turn is never sent. A request jQuery already had out when the bridge loaded is waited for the same way, also when checkout.js aborts it meanwhile. A caller's jQuery `timeout` counts from the request's turn, not while it waits for one.
* A drawer change refreshes the page once its writes have landed (checkout: `update_checkout`; cart page: `wc_update_cart`; the empty-cart page is left alone instead of reloading). On the cart page the form stays blocked from the drawer change until a refresh made after it has replaced the form, including a form cart.js swaps in from an earlier Update cart meanwhile, so "Update cart" or Enter cannot post older quantities over the drawer's. A classic request (Update cart, coupon, remove link, shipping, order review) makes the drawer re-read the cart once; not on a page without Lean Cart markup (FunnelKit's checkout pages). On the shortcode checkout the drawer's first read of the page is the one after checkout.js's page-load `update_order_review`, which no longer waits behind a separate read.
* The order submit (`wc-ajax=checkout`) waits for pending drawer changes and holds the queue until it settles. While an order is being placed (`form.checkout.processing`, also through a 3-D Secure or Vipps step) the page is not refreshed and the drawer does not re-read; when the order fails and the form is handed back, the page catches up once.
* The bridge (`modules/classic-pages.js`) loads where cart.js or checkout.js runs and acts only on the classic cart page and the shortcode checkout form.

**Added**
* `lean-cart:updated` carries `detail.source`: `'optimistic'`, `'write'` or `'read'` (`fetchCart`). Additive.

= 0.2.1 – 2026-10-23 =

**Fixed**
* Cart writes no longer lose updates. Every Store API call (add, quantity, remove, coupons, fetch) now goes through one queue, so WooCommerce's read-modify-write cart session sees one request at a time, in order. Before, two overlapping writes overwrote each other: on Wholesale's order table, `+` twice and then a variation left the line at 2, not 4 (crm plan D-121).
* The state is the server's latest answer with still-pending optimistic changes replayed on top. An earlier write's response no longer overwrites a newer change.
* A failed write restores the server's real cart (the cart in a 409 error, otherwise a fresh fetch), not a snapshot from before the op that also undid writes that succeeded meanwhile.
* A `changeQuantity()` promise superseded by a newer change on the same line now settles with the write that carries it; it used to hang. Removing a line cancels its pending quantity write.
* Quantity changes are kept as a delta and turned into an absolute quantity when the write takes its turn, from the server's latest cart (within the line's min/max). An add that merged into a line followed by `+` on it no longer loses the add.
* Every Store API request times out after 20 s. A request that never answers no longer freezes the queue; the store re-fetches the real cart and moves on.
* Queued calls run under the Web Lock `kaupang-lean-cart` where available, so two tabs of the same shop serialise their writes too.
* `[data-lean-cart="checkout-url"]` links wait for queued writes (8 s at most) before navigating, so a burst of changes is not lost on the way to checkout.
* Waiting for the Web Lock is limited to 25 s; after that, or when the lock is refused (e.g. SecurityError), the write runs without it. A tab suspended while holding the lock (iOS Safari) no longer freezes the other tabs' carts.
* `fetchCart()` no longer takes the Web Lock (it stays in the tab's queue): a held lock disables the back/forward cache on older Chromium (Samsung Internet).
* A write cut off by the 20 s timeout may still finish on the server: the store now waits 10 s, holding its turn, before re-reading the cart. The shopper sees the write if it landed, and nothing queued overlaps the still-running request.
* A pending `+`/`−` on a line that disappeared (another tab, re-keyed) now raises the update error and shows the real cart; it used to snap back silently.
* The checkout link's `aria-busy` is cleared before navigating and on `pageshow`, so Back from checkout no longer leaves it marked busy.

**Added**
* `store.whenIdle()` (resolves once queued writes and debounced changes have landed) and `store.enqueue( fn, { timeout } )` (run your own Store API call in the cart's queue; `timeout: Infinity` holds the turn until it settles, for an order submit). Additive; the rest of the contract is unchanged.
* `tools/check-cart-queue.mjs`: drives the store against a fake Store API with WooCommerce's lost-update session, and sets latency, failures, hangs and network errors per request; exits non-zero on failure. Run it with `/root/.nvm/versions/node/v22.21.0/bin/node tools/check-cart-queue.mjs` on the server (any Node 18+). An exception to the suite's PHP-native check rule (conventions §10): the store is browser JavaScript and cannot be driven from PHP.

= 0.2.0 – 2026-09-29 =

Renamed WooCommerce Lean Cart → **Kaupang Lean Cart** before first production deploy. Identity moved, the
front-end contract stays frozen. No back-compat aliases (all consumers are in-house and ship in the same change).

**Changed**
* **Breaking — moved:** folder/main file/text domain `kaupang-lean-cart`, constants `KAUPANG_LEAN_CART_*`,
  public hooks `lean_cart_*` → `kaupang/lean-cart/*` (`show_variation_labels`, `i18n`, `config`,
  `importmap_imports`, `disable_styles`, `live_notices`, `notice_cookie`, `apfs_scheme_description`,
  `enqueue_scripts`, `loaded`), script/style handles `kaupang-lean-cart-{init,styles}`, Store API extension
  namespaces `kaupang_lean_cart_{apfs,sublium}`, internal cart-item key and Store API error code
  `kaupang_lean_cart_*`. Header per suite standard (GitHub Plugin URI, `@package Kaupang\LeanCart`).
* **Kept (frozen contract):** `window.leanCart`, `window.leanCartConfig`, `lean-cart:*` events,
  `[data-lean-cart*]`, `.lean-cart*`, `--lc-*` tokens, cookie `lc_notice`, localStorage key `leanCart`,
  classes `Lean_Cart_*` (namespace move is a later change).

= 0.1.1 – 2026-09-29 =

**Added**
* Sublium Subscriptions integration with recurring totals display.
* `lean_cart_importmap_imports` filter so sibling plugins dock into the single import map.
* Cacheable pages for cart-holders: header count painted from a localStorage snapshot, WooCommerce notices wrapped in `<noscript>` off cart/checkout/account (`lean_cart_live_notices`, `lean_cart_notice_cookie`).
* All Products for Subscriptions: the chosen subscription scheme is carried through the Store API add and shown in the panel with its cadence (`lean_cart_apfs_scheme_description`).

**Changed**
* Mix and Match child nesting moved from the `lean-cart:updated` listener into the cart normalizer.
* Adopted suite kit v1: header `Version:` is the single source of truth (synced by `tools/pre-commit`), this CHANGELOG replaces the README changelog, standard plugin header, HPOS and cart/checkout blocks compatibility declared.
* Suite kit v2.1 (tooling, generated readme.txt); no runtime change.
* Skeleton CSS fallbacks are palette-neutral (currentColor/Canvas); themes are the only source of colour.
* Extension modules get versioned URLs in the import map, so module edits bust the browser cache.

**Fixed**
* Cart cookies are re-set after Store API requests so the cart hash matches page loads.
* Product titles with HTML entities (e.g. apostrophes) no longer show literally in the cart.
* Duplicate subscription badges collapse to one.

= 0.1.0 – 2026-04-14 =

* Initial release.
* Store API cart state layer with optimistic updates and rollback.
* Native ES module architecture with import map cache busting.
* Skeleton CSS with CSS custom property token mapping.
* Cold-fetch guard — zero cart overhead for new visitors.
* Legacy cart fragments disabled automatically.
* Form interception for simple, variable, grouped, and subscription products.
* Loop/widget link interception for archive pages.
* Module: WooCommerce Subscriptions — billing summaries, badges, meta rows.
* Module: Mix and Match Products — `mnm_config` form extraction, parent-child nesting, server-side validation guard.
* Module: All Products for Subscriptions — Store API extension, purchase mode display.
* Event-driven theme integration via `lean-cart:*` custom events.
* Public JS API (`window.leanCart`).
* `data-lean-cart` attribute-based mount point system.
* Delegated click handler for cart actions (`data-cart-action`).
* Bridge to `window.numenu` navigation system.
