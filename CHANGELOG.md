# Changelog

All notable changes to this plugin are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

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
