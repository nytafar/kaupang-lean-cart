# Changelog

All notable changes to this plugin are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

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
