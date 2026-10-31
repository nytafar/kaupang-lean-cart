# Kaupang Lean Cart

A modern, performant, and themable cart for WooCommerce — built on first principles and the direction of WooCommerce core.

Lean Cart replaces the legacy cart-fragments system with a vanilla JS state layer powered by the WooCommerce Store API. No jQuery, no build step, no PHP-rendered HTML blobs. Just ES modules, JSON, and events.

---

## Why Lean Cart

WooCommerce's default cart relies on **cart fragments** — a system that re-renders HTML on the server and ships it back via AJAX on every page load. It holds a PHP session lock that blocks concurrent requests, adds 200–400ms of latency to every navigation, and forces themes to template cart markup in PHP.

Lean Cart takes a different approach:

- **Store API native** — reads and writes cart state through `wc/store/v1/`, the same API that powers WooCommerce Blocks and the Checkout Block. No admin-ajax, no `wc-ajax`, no fragments.
- **Vanilla ES modules** — zero dependencies, no build step, no jQuery. Ships as WordPress core script modules: core prints the one import map, versions each file and preloads the static imports.
- **Event-driven architecture** — the store emits `lean-cart:updated`, `lean-cart:open`, `lean-cart:error` events on `document`. Themes subscribe to render however they want.
- **Cold-fetch guard** — skips the initial cart fetch entirely for visitors without a WooCommerce session cookie. First-time visitors pay zero cart overhead.
- **Optimistic UI, serialised writes** — quantity changes, additions, and removals update the UI instantly. Every Store API call goes through one queue, so writes reach the server one at a time and in order (WooCommerce saves the cart session whole, so overlapping writes lose updates). The state is the server's latest answer with pending changes replayed on top, and a failed write rolls back to the server's real cart.
- **Skeleton CSS with theme tokens** — ships a functional layout that maps to CSS custom properties. Themes override visuals; the plugin handles structure.

## Description

Lean Cart is a drop-in WooCommerce cart replacement built for developers who want full control over the cart experience without fighting legacy infrastructure.

It intercepts native add-to-cart forms and loop links, converts them into Store API calls, and maintains a single source of truth in a JS state store. The UI layer finds `[data-lean-cart]` mount points in your theme's markup and hydrates them — no shortcodes, no widgets, no blocks required.

### Architecture

```
cart-init.js          Entry point — boots store, UI, modules
  ├── cart-config.js  The settings PHP passes in (core's script module data)
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
```

### Key design decisions

- **No build step.** The JS ships as authored. Each file is a core script module with the id `@kaupang/lean-cart/<name>` (`wp_register_script_module()`); modules import each other by id, never by relative path (a relative path would load a second copy of the store). Core prints the import map, the `modulepreload` links for the static imports and the entry point in the footer (classic themes). The extension and classic-page modules are dynamic imports, mapped but fetched only when `cart-init.js` imports them. Each URL is versioned with its file's modification time.
- **Styling lives in the theme.** The plugin ships skeleton CSS scoped under `.lean-cart` that maps to CSS custom properties (`--lc-text`, `--lc-border`, `--lc-accent`, etc.) with standalone fallbacks. Themes set these tokens or dequeue the stylesheet entirely via `add_filter('kaupang/lean-cart/disable_styles', '__return_true')`.
- **Modular plugin compatibility.** Extension modules are loaded conditionally based on class existence checks — zero overhead when the parent plugin isn't active.
- **Form extractor pipeline.** Modules can register functions via `store.addFormExtractor()` that read plugin-specific form inputs and inject extra fields into the Store API add-to-cart body. This keeps core generic while supporting complex product types.
- **Normalizer pipeline.** Modules register normalizers via `store.addNormalizer()` to enrich the display model with badges, subscription summaries, parent-child grouping, and purchase mode indicators.

### Plugin compatibility

Lean Cart includes native modular support for:

- **WooCommerce Subscriptions** — billing period summaries, signup fee and trial period meta rows, subscription badges.
- **WooCommerce Mix and Match Products** — form extractor for `mnm_config`, parent-child grouping in the cart, container badges. Includes a server-side guard that rejects misconfigured containers.
- **All Products for WooCommerce Subscriptions** — custom Store API extension exposing active subscription schemes, purchase mode display (one-time vs. subscription).

Adding support for a new plugin means creating one PHP class in `includes/modules/` and one JS module in `assets/js/modules/` — no core changes required.

### Theme integration

Lean Cart doesn't render a drawer, panel, or page. It hydrates mount points your theme provides:

```html
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
```

The totals mount's shipping row follows the cart's shipping state (`state.shippingState`): `pending` while a package has no rate selected, as in a new session before the shopper has given an address (`i18n.shippingPending`, "Beregnes i kassen"; the total excludes shipping then), `free` for a selected rate costing 0 (`i18n.freeShipping`, "Gratis"), `paid` for the shipping total, and no row at all when nothing in the cart ships (`none`).

Line images are the catalog thumbnail with its `srcset`, `width`/`height` 56 and `loading="lazy"`, never the original upload. `sizes` is the config's `imageSizes` (`56px`, the stylesheet's box); a theme that draws the box larger sets it, e.g. `add_filter( 'kaupang/lean-cart/config', fn( $c ) => [ 'imageSizes' => '70px' ] + $c );`.

The plugin emits a `lean-cart:open` event when an item is added. If your theme exposes `window.numenu`, it bridges automatically. Otherwise, listen to the event directly:

```js
document.addEventListener('lean-cart:open', () => {
  document.querySelector('.my-cart-drawer').classList.add('open');
});
```

### Public JS API

```js
window.leanCart.store    // Full store access (getState, addItem, removeItem, etc.)
window.leanCart.refresh() // Re-fetch cart from Store API
window.leanCart.open()    // Dispatch lean-cart:open event
window.leanCart.close()   // Dispatch lean-cart:close event

window.leanCart.store.whenIdle()     // Resolves once queued writes and debounced changes have landed
window.leanCart.store.enqueue( fn, { timeout } )  // Run your own Store API call (fn returns its promise) in the cart's queue
window.leanCart.store.invalidate()   // The cart changed outside the store: the next quantity change re-reads it first
```

**One write queue.** WooCommerce saves the cart session whole per request, so overlapping Store API writes lose updates. Every store call goes through one queue. Writes also run under the Web Lock `kaupang-lean-cart` where the browser has it (tabs of a shop share one session); after 25 s without the lock, or if it is refused, they run without it. Reads (`fetchCart`) skip the lock. Each request times out after 20 s, so the queue always moves on. A write that timed out may still finish in PHP, so the store waits 10 s before re-reading the cart. Code that writes to the Store API itself should pass the call through `store.enqueue()` and then `refresh()`. An enqueued call gives up its turn after `timeout` ms (default 20000); `timeout: Infinity` holds it until the call settles (an order submit), so the call must time out by itself. Before leaving the page with pending changes (e.g. to checkout), await `store.whenIdle()` with a deadline. Lean Cart's own `[data-lean-cart="checkout-url"]` links already do.

## Load map

Guest storefront, measured with `wp kaupang-assets audit --plugins=kaupang-lean-cart` (budget: `tools/load-budget.php`).

| Context | PHP files | Assets | Autoloaded options |
|---|---|---|---|
| Every storefront page | main, `Lean_Cart`, `Lean_Cart_Assets`, `Lean_Cart_Hooks`, `Lean_Cart_Notices` (5), + one class per active extension plugin (Subscriptions, Mix and Match, All Products for Subscriptions, Sublium): 8 on staging.myrvann.no. The page renders the header count and the drawer, and the notices and cookie sync run on every view | module `@kaupang/lean-cart/init`; static imports `config`, `api`, `store`, `ui`, `add` preloaded; extension modules (active ones only), `classic-pages`, `checkout-lines` mapped as dynamic imports; config as module data. No stylesheet in `<head>`: `lean-cart.css` on the first interaction | none |
| Shortcode checkout (`checkout`) | same | + `kaupang-lean-cart-styles` in `<head>` (the order review's lines show with the page); the extension and classic-page modules are preloaded too, and the config carries the cart | none |
| lean-checkout's page (`lean_checkout`) | same | + `kaupang-lean-cart-styles` (lean-checkout enqueues it for the summary) | none |
| Store API (REST) | same | — | none |
| wp-admin | same | none | none |

The header count is the theme's markup, rendered empty and hidden so the page can be cached for everyone; `cart-init.js` paints it from its localStorage snapshot, then from the Store API. It ran as a deferred module in the footer before this change too, so moving discovery to core's footer import map adds no layout shift.

## Installation

1. Upload the `kaupang-lean-cart` folder to `wp-content/plugins/`.
2. Activate the plugin in **Plugins → Installed Plugins**.
3. Add `[data-lean-cart]` mount points to your theme templates.
4. Optionally set CSS custom properties to match your theme tokens.

No configuration page. No settings screen. It works on activation.

## Usage

### Disabling the default stylesheet

```php
add_filter( 'kaupang/lean-cart/disable_styles', '__return_true' );
```

The stylesheet (`kaupang-lean-cart-styles`, `lean-cart.css`) styles the drawer and the checkout lines only, so it is not in `<head>` on most pages: `cart-init.js` adds it on the first `pointerdown`, `keydown` or `lean-cart:open`, before the page's other stylesheets (where WordPress printed it before), so theme overrides still win. It is in `<head>` where Lean Cart's lines show with the page: the shortcode checkout, and lean-checkout's page (lean-checkout enqueues the handle). Use the filter to turn it off; `wp_dequeue_style()` alone no longer does, since the sheet is added by JS.

### Customizing i18n strings

```php
add_filter( 'kaupang/lean-cart/i18n', function( $strings ) {
    $strings['emptyCart'] = __( 'Nothing here yet!', 'my-theme' );
    return $strings;
} );
```

### Extending the config object

```php
add_filter( 'kaupang/lean-cart/config', function( $config ) {
    $config['myCustomKey'] = 'value';
    return $config;
} );
```

### Adding a custom module

**PHP** (`includes/modules/class-my-plugin.php`):

```php
class Lean_Cart_My_Plugin {
    public function __construct() {
        add_filter( 'kaupang/lean-cart/config', [ $this, 'extend_config' ] );
    }

    public function extend_config( array $config ): array {
        $config['modules']['myPlugin'] = true;
        return $config;
    }
}
```

**JS** (`assets/js/modules/my-plugin.js`):

```js
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
```

### Full-page caching

Lean Cart is built so every page can be served from a shared page cache, cart or no cart:

- **Cart-agnostic HTML.** Render `[data-lean-cart]` mount points in their empty state (count `0` with `hidden`, empty state visible). Count mounts are hidden at zero and shown by Lean Cart.
- **Instant count.** A `{ hash, count }` snapshot in `localStorage` paints the count before the Store API fetch. It is only used while its hash matches the `woocommerce_cart_hash` cookie, so a count never outlives the cart it came from (order placed, logout, session expiry, a change made elsewhere).
- **Notices.** On GET requests outside cart, checkout and account, WooCommerce notices print inside `<noscript>`: no-JS visitors still see them, JS visitors get Lean Cart's own feedback. While session notices are pending, an `lc_notice` cookie is set. Configure your page cache to bypass entirely (no read, no store) when it is present.

```php
// Print notices normally on more pages.
add_filter( 'kaupang/lean-cart/live_notices', fn( $live ) => $live || is_page( 'contact' ) );

// Rename the pending-notice cookie.
add_filter( 'kaupang/lean-cart/notice_cookie', fn() => 'my_notice' );
```

**Events.** `lean-cart:updated` carries `{ state, source }`. `source` is `'optimistic'` (a change not yet sent), `'write'` (a write's turn ended: the server's answer, or the real cart after a failure) or `'read'` (`fetchCart`). React to cart writes by skipping `'read'`, or a refresh that re-reads will loop.

**Classic cart and checkout pages.** On WooCommerce's classic cart page and `[woocommerce_checkout]` page, cart.js and checkout.js edit the same cart session as the drawer. `modules/classic-pages.js` is imported by `cart-init.js` where `wc_checkout_params` or `wc_cart_params` exists and acts only on a `form.checkout` (checkout) or the classic cart form or empty-cart message (cart page); `classicPage()` is that test. It queues WooCommerce's own requests: its classic endpoints (`update_order_review`, `checkout`, coupons, `update_shipping_method`, `get_cart_totals`, `add_to_cart`, `remove_from_cart`) and, on the cart page URL, the remove/undo links and posts carrying the cart form's or shipping calculator's nonce. A `$.ajaxPrefilter` wraps `settings.xhr()` so the request's `send()` waits for its turn in `store.enqueue()`; the caller keeps jQuery's own jqXHR. A request keeps its turn until it has ended, at most 65 s (nginx gives up at 60 s); an aborted one keeps its turn until the server has answered (PHP still saves the session), and one aborted before its turn is never sent. Requests jQuery already had out when the module loaded hold the first turn the same way: while they are out, `XMLHttpRequest.prototype.abort` leaves an XHR opened before the module loaded running once jQuery has detached its handlers, and is restored afterwards. A caller's `timeout` counts from the turn. The submit waits for `whenIdle()` and holds the queue until it settles. When drawer changes have landed, the page refreshes once (`update_checkout` / `wc_update_cart`, not on the empty-cart page); on the cart page the form is kept blocked until a refresh made after the last drawer change has replaced it. When classic requests have finished, the drawer re-reads once, unless the page has no `[data-lean-cart]` markup. On the shortcode checkout `cart-init.js` skips its cold read and the bridge reads after checkout.js's page-load `update_order_review` instead. Neither happens while `form.checkout` has `.processing` (an order is being placed); the page catches up when the form is handed back. Other plugins' own `wc-ajax` endpoints are not queued.

When a classic request ends the bridge calls `store.invalidate()`, so a drawer `+`/`−` whose write takes its turn after, say, an Update cart re-reads the cart in that turn and counts from the updated quantity (not after the order submit).

**Checkout lines.** On the shortcode checkout the order review's item lines are Lean Cart's: the drawer's line markup (images, variation and add-on rows, subscription badges and cadence, Mix-and-Match box contents without controls, sold-individually and stock limits as disabled buttons), with `+`, `−` and remove through the store. The price shown per line is its subtotal before coupons, like WooCommerce's own rows, so the lines add up to the classic subtotal row. PHP prints the mount (`[data-lean-cart="checkout-lines"]`, with its own error and screen-reader status) on `woocommerce_checkout_order_review` at priority 5, before the review table and outside the fragment `update_order_review` replaces; not on FunnelKit checkout pages. With it, PHP prints the two state rules (the mount hidden until painted; WooCommerce's `thead` and `tr.cart_item` rows hidden next to a painted mount), so they hold with `kaupang/lean-cart/disable_styles` too. The page carries the cart as the config's `cart`: a Store API cart response made in-process through WooCommerce's own hydration (as its block checkout does: extensions' hydration hooks run), added to the config when core prints it in the footer, once the shortcode has calculated the cart, and trimmed to what the store's normalizers read (no addresses, payment methods, cross-sells or descriptions; of each image its `src`, `thumbnail`, `srcset` and `alt`; of the shipping rates only each rate's `selected`). It leaves the classic checkout as without it, on WooCommerce 10.x and 11.x: it is only read from a cart the page has calculated (the route would otherwise calculate it in block mode, with another default shipping method and shipping hidden until an address is entered), and the cart context, shipping packages, session (notices, chosen shipping method) and the Store API nonce check are put back on every exit (before 11.1 WooCommerce leaves the context on `store-api`, and an `\Error` in the route leaves notices cleared and the nonce check off); `tools/check-seed.php` proves it. The modules are `modulepreload`ed. `cart-init.js` imports the bridge and the lines side by side and starts the lines once the bridge runs; neither imports anything itself (`cart-init.js` passes what they need), so each dynamic import resolves in one step, before the checkout's DOM-ready scripts, and a module that fails to load (404, network, content blocker) leaves the drawer and WooCommerce's rows. It seeds the store (`store.seed()`) once the extension modules' normalizers are registered, so the lines paint as the modules run instead of after the first read. Until then, or without JS, WooCommerce's rows are the summary. Everything else in the review stays WooCommerce's: coupons, shipping (Bring), fees, VAT, totals and payment keep refreshing through `update_order_review`, which the bridge triggers after each change; the totals table is blocked as updating from the change until that refresh lands. A read that shows other lines (another tab) triggers one refresh, and the read after that refresh triggers none, so a plugin that changes lines on every totals calculation cannot loop. Focus stays on the control used, or moves to the nearest one that can take it (the other quantity button, the next line's remove); the drawer keeps focus the same way. While the order is being placed, a press on a line's button (Enter or Space reach it through blockUI's overlay) is stopped. When a change leaves the cart empty, or a read finds it emptied (another tab, an order placed there), the checkout is replaced by the cart page (`location.replace( cartUrl )`, not while an order is being placed): a reload would re-run an `?add-to-cart=` in the checkout's URL, and no history entry leads back to the stale checkout. Turn it off with `add_filter( 'kaupang/lean-cart/checkout_lines', '__return_false' );`.

What it does not cover: PHP that runs on after nginx's 504 (the browser has its answer, PHP may still save the session later), session writes from other plugins' endpoints, and a request jQuery had out before the module loaded beyond the same 65 s.

Self-checks: `wp eval-file wp-content/plugins/kaupang-lean-cart/tools/check.php` (module loading, one import map, preloads, the stylesheet's pages, the hooks that run outside page views), `wp eval-file wp-content/plugins/kaupang-lean-cart/tools/check-notices.php`, and for the checkout's cart seed `wp eval-file wp-content/plugins/kaupang-lean-cart/tools/check-seed.php` (run it on each WooCommerce major in use)

### Write queue check

```bash
# on the GridPane server (Node 22, outside the web root); any Node 18+ works, no dependencies
/root/.nvm/versions/node/v22.21.0/bin/node tools/check-cart-queue.mjs
```

It drives `cart-store.js` against a fake Store API with WooCommerce's lost-update session, and sets latency, failures, hangs and network errors per request. It exits non-zero on failure. It covers: overlapping writes, older responses, add-merge then `+`, remove during a pending change, rollback (409 cart, fresh fetch, failed fetch, network error), timeouts, coupon/fetch order, a Mix-and-Match box, the event contract and `source`, two tabs, `whenIdle()` and `enqueue()`, and the classic pages bridge against a fake jQuery that follows jQuery 3.7's `$.ajax` (page gating; no overlap with `update_order_review`; one refresh per burst of drawer changes and one re-read per burst of classic requests, no loop; the caller's jqXHR against Vipps' `readyState` check; stale cart-form posts; the empty-cart page; which cart-page requests are queued; the submit hold, nothing after a placed order, catch-up after a failed one; aborts and jQuery's global events; the 65 s turn cap; a request out before the module loaded, and one aborted then; a caller's `timeout`; the form cart.js swaps in while a drawer change is pending; the checkout's page-load read order; no reads without Lean Cart markup; a drawer `+` whose write waits behind Update cart), and the checkout lines (where focus goes after a re-render, and that a repaint returns it to the new control, never takes it from outside the list, and skips unchanged markup; shown once painted, box contents without controls, `type="button"`, the line's displayed price, the totals blocked on a change, one refresh per change, a cross-tab read refreshes once and not during an order, no refresh loop, the screen-reader status and a failed remove, a press during the order, leaving an emptied checkout for the cart page after a change, from an `?add-to-cart=` URL and after a read, but not under a pending remove that fails), the price format, attribute escaping, the drawer's focus and where an error shows, a failed in-turn re-read, the seed (`store.seed()`, and `cart-init.js` applying it after the extension modules), and the module loading (the lines start once the bridge runs; a missing `classic-pages.js` or `checkout-lines.js` leaves the drawer and, for the lines, the bridge; neither imports anything).

This is an exception to the suite rule of one PHP-native check (conventions §10): the store is browser JavaScript and cannot be driven from PHP. `tools/check-notices.php` and `tools/check-seed.php` remain the PHP checks.

## FAQ

### Does this replace the WooCommerce cart page?

No. Lean Cart replaces the cart *fragments* system and the add-to-cart AJAX flow. The `/cart/` page still works — Lean Cart operates alongside it, powering drawers, mini-carts, and any custom mount point.

### Does it work with WooCommerce Blocks?

Lean Cart targets the same Store API that Blocks uses. They can coexist, but Lean Cart is designed for themes that want full control over cart markup rather than using the Cart Block.

### What happens if JavaScript is disabled?

Forms fall through to their native POST behavior. The standard WooCommerce add-to-cart flow takes over and the `/cart/` page works as usual.

### Can I use this without any CSS?

Yes. Either dequeue the stylesheet with `kaupang/lean-cart/disable_styles` or simply don't add the `.lean-cart` wrapper class and write your own styles targeting `[data-lean-cart]` attributes.

### How do I add support for another WooCommerce extension?

Create a PHP module class in `includes/modules/` that hooks into `kaupang/lean-cart/config`, and a JS module in `assets/js/modules/` that registers normalizers and/or form extractors. Gate the PHP module on `class_exists()` in `Lean_Cart::load_modules()`. See the Subscriptions or Mix and Match modules for reference.

## Screenshots

No screenshots. Lean Cart is a headless cart layer with no admin interface — all visual output is controlled by your theme.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Releasing

Suite kit v2 (<https://github.com/nytafar/kaupang-docs/tree/main/kit>): the header `Version:` is the single source; `readme.txt` is generated — never edit it.
Every change adds a line under `## [Unreleased]` in CHANGELOG.md.
Release: `sudo -u myrvann tools/release patch|minor|major [--push]` (bumps, dates the changelog, commits, tags `vx.y.z`).

## License

GPL-2.0-or-later
