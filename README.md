# WooCommerce Lean Cart

A modern, performant, and themable cart for WooCommerce — built on first principles and the direction of WooCommerce core.

Lean Cart replaces the legacy cart-fragments system with a vanilla JS state layer powered by the WooCommerce Store API. No jQuery, no build step, no PHP-rendered HTML blobs. Just ES modules, JSON, and events.

---

## Why Lean Cart

WooCommerce's default cart relies on **cart fragments** — a system that re-renders HTML on the server and ships it back via AJAX on every page load. It holds a PHP session lock that blocks concurrent requests, adds 200–400ms of latency to every navigation, and forces themes to template cart markup in PHP.

Lean Cart takes a different approach:

- **Store API native** — reads and writes cart state through `wc/store/v1/`, the same API that powers WooCommerce Blocks and the Checkout Block. No admin-ajax, no `wc-ajax`, no fragments.
- **Vanilla ES modules** — zero dependencies, no build step, no jQuery. Ships as native `type="module"` scripts with an import map for cache busting.
- **Event-driven architecture** — the store emits `lean-cart:updated`, `lean-cart:open`, `lean-cart:error` events on `document`. Themes subscribe to render however they want.
- **Cold-fetch guard** — skips the initial cart fetch entirely for visitors without a WooCommerce session cookie. First-time visitors pay zero cart overhead.
- **Optimistic UI** — quantity changes, additions, and removals update the UI instantly and roll back on failure.
- **Skeleton CSS with theme tokens** — ships a functional layout that maps to CSS custom properties. Themes override visuals; the plugin handles structure.

## Description

Lean Cart is a drop-in WooCommerce cart replacement built for developers who want full control over the cart experience without fighting legacy infrastructure.

It intercepts native add-to-cart forms and loop links, converts them into Store API calls, and maintains a single source of truth in a JS state store. The UI layer finds `[data-lean-cart]` mount points in your theme's markup and hydrates them — no shortcodes, no widgets, no blocks required.

### Architecture

```
cart-init.js          Entry point — boots store, UI, modules
  ├── cart-store.js   State management, normalizer pipeline, form extractors
  ├── cart-api.js     All Store API network calls, nonce management
  ├── cart-add.js     Intercepts form.cart submits and loop links
  ├── cart-ui.js      Pure renderer — subscribes to events, writes to DOM
  └── modules/        Conditionally loaded extensions
      ├── subscriptions.js
      ├── mix-and-match.js
      └── all-products-subs.js
```

### Key design decisions

- **No build step.** The JS ships as authored. ES module imports resolve at runtime via an import map printed in `<head>`. Cache busting uses file modification timestamps.
- **Styling lives in the theme.** The plugin ships skeleton CSS scoped under `.lean-cart` that maps to CSS custom properties (`--lc-text`, `--lc-border`, `--lc-accent`, etc.) with standalone fallbacks. Themes set these tokens or dequeue the stylesheet entirely via `add_filter('lean_cart_disable_styles', '__return_true')`.
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
```

## Installation

1. Upload the `woocommerce-lean-cart` folder to `wp-content/plugins/`.
2. Activate the plugin in **Plugins → Installed Plugins**.
3. Add `[data-lean-cart]` mount points to your theme templates.
4. Optionally set CSS custom properties to match your theme tokens.

No configuration page. No settings screen. It works on activation.

## Usage

### Disabling the default stylesheet

```php
add_filter( 'lean_cart_disable_styles', '__return_true' );
```

### Customizing i18n strings

```php
add_filter( 'lean_cart_i18n', function( $strings ) {
    $strings['emptyCart'] = __( 'Nothing here yet!', 'my-theme' );
    return $strings;
} );
```

### Extending the config object

```php
add_filter( 'lean_cart_config', function( $config ) {
    $config['myCustomKey'] = 'value';
    return $config;
} );
```

### Adding a custom module

**PHP** (`includes/modules/class-my-plugin.php`):

```php
class Lean_Cart_My_Plugin {
    public function __construct() {
        add_filter( 'lean_cart_config', [ $this, 'extend_config' ] );
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
add_filter( 'lean_cart_live_notices', fn( $live ) => $live || is_page( 'contact' ) );

// Rename the pending-notice cookie.
add_filter( 'lean_cart_notice_cookie', fn() => 'my_notice' );
```

Self-check: `wp eval-file wp-content/plugins/woocommerce-lean-cart/tools/check-notices.php`

## FAQ

**Does this replace the WooCommerce cart page?**

No. Lean Cart replaces the cart *fragments* system and the add-to-cart AJAX flow. The `/cart/` page still works — Lean Cart operates alongside it, powering drawers, mini-carts, and any custom mount point.

**Does it work with WooCommerce Blocks?**

Lean Cart targets the same Store API that Blocks uses. They can coexist, but Lean Cart is designed for themes that want full control over cart markup rather than using the Cart Block.

**What happens if JavaScript is disabled?**

Forms fall through to their native POST behavior. The standard WooCommerce add-to-cart flow takes over and the `/cart/` page works as usual.

**Can I use this without any CSS?**

Yes. Either dequeue the stylesheet with `lean_cart_disable_styles` or simply don't add the `.lean-cart` wrapper class and write your own styles targeting `[data-lean-cart]` attributes.

**How do I add support for another WooCommerce extension?**

Create a PHP module class in `includes/modules/` that hooks into `lean_cart_config`, and a JS module in `assets/js/modules/` that registers normalizers and/or form extractors. Gate the PHP module on `class_exists()` in `Lean_Cart::load_modules()`. See the Subscriptions or Mix and Match modules for reference.

## Changelog

### 0.1.0

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

## License

GPL-2.0-or-later
