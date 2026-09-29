# Build brief: subscription designation UX for lean-cart (APfS items)

*A ready-to-run prompt for a build session. Written 2026-07-08 after a
spine-to-chrome audit of the SATT seam in the ousia/nyta-deus themes.
Paste the prompt below into a fresh session, or hand it to an agent.*

> **STATUS 2026-07-08 (same day, urgent fix):** steps 1–3 shipped ahead
> of schedule — the panel add was silently dropping the chosen scheme
> (checkout produced non-subscription orders). Now live: the form
> extractor (`assets/js/modules/all-products-subs.js`), the
> `$_REQUEST` relay + populated extension data
> (`includes/modules/class-all-products-subs.php`, filter
> `lean_cart_apfs_scheme_description` in place), and versioned module
> URLs in the import map (edits never cache-busted before). Verified
> end-to-end on astragalus 2_month: panel badge + "Hver 2. måned" +
> recurring price, checkout shows first-renewal date. Remaining from
> this brief: theme-side re-voice hookup (step 2's ousia filter),
> verification across flat/variable modes (step 5), raw-face check,
> and any brand styling of the badge in nyta-deus.

---

## The prompt

Build the subscription designation UX in the **woocommerce-lean-cart**
plugin (`/var/www/staging.nyta.no/htdocs/wp-content/plugins/woocommerce-lean-cart/`,
local git) for items carrying an **All Products for Subscriptions
(WCS_ATT)** scheme. The scaffolding already exists — this is a
finish-the-module task, not a green-field one.

### What already exists (verified 2026-07-08)

- **PHP module stub**: `includes/modules/class-all-products-subs.php` —
  loaded conditionally by `includes/class-lean-cart.php` when WCS_ATT is
  active. It registers Store API endpoint data (namespace
  `lean_cart_apfs`) with three fields — `active_scheme_key` (string),
  `is_subscription` (bool), `scheme_description` (string) — **but the
  `data_callback` returns empty defaults; nothing is populated.** This is
  the one real gap.
- **JS normalizer, fully built**: `assets/js/modules/all-products-subs.js`
  reads `raw.extensions?.lean_cart_apfs`, sets `item.purchaseMode`
  (`'subscription'`/`'one-time'`), populates `item.subscriptionSummary`
  from `scheme_description`, and pushes an `'Abonnement'` badge
  (i18n key `purchaseSubscribe`). It activates the moment the extension
  carries real data.
- **Render slots, fully built**: `assets/js/cart-ui.js` renders
  `.cart-item-badges > .cart-badge` and `.cart-item-subscription`
  (the summary row) per item; CSS for both exists in
  `assets/css/lean-cart.css` (token-mapped: `--lc-*` custom properties
  with plain fallbacks — keep new CSS on that pattern).
- **i18n**: the PHP module already feeds `purchaseOneTime` →
  `'Engangskjøp'` and `purchaseSubscribe` → `'Abonnement'` through the
  `lean_cart_config` filter.

### The work

1. **Populate the Store API extension** in
   `class-all-products-subs.php`: in the `data_callback`, read the cart
   item's scheme via `WCS_ATT_Cart::get_subscription_scheme( $cart_item )`
   (and `WCS_ATT_Product_Schemes` for the scheme object). Return the real
   `active_scheme_key`, `is_subscription`, and a human `scheme_description`.
2. **Speak the theme's cadence language.** The scheme description must
   match the product page's plan headlines. The contract, from the ousia
   side (`themes/ousia/inc/woocommerce-subscription-plans.php`): headline
   = `sprintf( _x( 'Every %s', 'plan option headline', 'ousia' ),
   wcs_get_subscription_period_strings( $interval, $period ) )` — WCS
   localizes the whole cadence (nb_NO: "2. måned" → "Hver 2. måned").
   Do NOT duplicate that string-building in the plugin: build a default
   description from `wcs_get_subscription_period_strings()` and expose it
   through a filter — `lean_cart_apfs_scheme_description( $description,
   $scheme_key, $cart_item )` — so the theme can re-point it to
   `ousia_satt_plan_name()` for exact parity. The theme-side hookup is a
   follow-up in ousia's module (one filter, ~5 lines).
3. **Verify the add-to-cart path first.** Items reach the cart through
   the Store API (`cart/add-item` via `assets/js/cart-api.js`), and
   WCS_ATT's own Store API class only *validates* — check whether the
   chosen scheme (the `convert_to_sub_{id}` radio from the product form)
   actually survives an add through the panel. If it does not, add a
   **form extractor** (pattern: `assets/js/modules/mix-and-match.js`
   lines 18–36) that lifts the checked `convert_to_sub_*` value into the
   add-item payload, and apply it server-side the way
   `class-sublium-subscriptions.php` does (`woocommerce_store_api_add_to_cart_data`
   + apply-scheme on `woocommerce_add_to_cart`). Test with:
   astragalus (grouped mode), cordyceps (flat), lions-mane (variable).
4. **Designation, not ceremony.** The panel shows: the `Abonnement`
   badge + the cadence summary row ("Hver 2. måned") on subscription
   items; one-time items stay unmarked (no badge noise on the default
   case). No in-panel scheme *switching* in this pass — the cart page
   and product page own that. Keep markup to the existing slots; if the
   badge needs brand styling, that lands in nyta-deus
   (`scss/plugins/`), not in the plugin CSS.
5. **Verify end-to-end** on staging.nyta.no with the agent-browser
   skill: add each SATT mode's product with a subscription plan chosen,
   open the panel, confirm badge + cadence line + correct recurring
   price; add a one-time item and confirm it stays quiet. Check the
   `?ousia_view=raw` face too — the badge/summary must read structurally
   (the plugin CSS fallbacks are Canvas/currentColor per the lean-cart
   token doctrine, commit `fdc0139`).

### Constraints

- Compile nothing — the plugin ships plain CSS/ES modules; no build step.
- Follow the plugin's conventions: conditional module loading, Store API
  extensions over AJAX, normalizers over template overrides.
- Commits in the plugin repo: lowercase, no co-author footer.
- The seam rule from the theme work applies here too: **structure in the
  plugin, brand in the child theme, voice through filters.** The plugin
  must read acceptably with zero theme CSS.

---

*Context docs: `themes/ousia/inc/woocommerce-subscription-plans.php`
(the SATT presentation module and its filters),
`themes/CLAUDE.md` (environment + build rules), and the exploration
report that produced this brief (Store API extension stub at
`includes/modules/class-all-products-subs.php:33-56`, JS normalizer at
`assets/js/modules/all-products-subs.js:11-30`, render slots at
`assets/js/cart-ui.js:45-95`).*
