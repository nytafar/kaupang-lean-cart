=== Kaupang Lean Cart ===
Contributors: lassejellum
Tags: woocommerce, store-api, cart, mini-cart, developer-friendly
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 8.0
Stable tag: 0.2.0
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
          └── all-products-subs.js

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

Self-check: `wp eval-file wp-content/plugins/kaupang-lean-cart/tools/check-notices.php`

= Write queue check =

    node tools/check-cart-queue.mjs   # Node 18+, no dependencies; exits non-zero on failure

It drives `cart-store.js` against a fake Store API with WooCommerce's lost-update session and controllable latency. It covers: overlapping writes, older responses, rollback after a failure, and superseded quantity promises.

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
