/**
 * Cart Init — entry point.
 *
 * Bootstraps the cart system: initializes store and UI,
 * applies cold-fetch guard, sets up event delegation,
 * bridges to theme navigation, and loads extension modules.
 */

import * as store from './cart-store.js';
import * as ui from './cart-ui.js';
import * as add from './cart-add.js';

const config = window.leanCartConfig;

// ── 1. Initialize UI (cache mount points, subscribe to events) ──

ui.init();
add.init();

// ── 2. Instant count + cold-fetch guard ─────────────────────────
//
// The page HTML is cart-agnostic (it may come from a shared page cache),
// so count mount points start empty. A { hash, count } snapshot in
// localStorage paints the count before the network fetch. It is only
// trusted while its hash equals the woocommerce_cart_hash cookie, which
// WooCommerce rewrites on every cart change and deletes when the cart
// empties (order placed, logout, session expiry) — so a stale count
// never paints. The Store API fetch then reconciles.
//
// The fetch itself only runs if WooCommerce has set a cart cookie,
// avoiding a round-trip on first visit for new users.

const SNAPSHOT_KEY = 'leanCart';

function cookie( name ) {
	return document.cookie.match( new RegExp( '(?:^|; )' + name + '=([^;]*)' ) )?.[ 1 ] || '';
}

function readSnapshot() {
	try {
		return JSON.parse( localStorage.getItem( SNAPSHOT_KEY ) );
	} catch {
		return null; // Storage disabled or corrupt — just wait for the fetch.
	}
}

function writeSnapshot( count ) {
	try {
		const hash = cookie( 'woocommerce_cart_hash' );
		if ( hash && count ) {
			localStorage.setItem( SNAPSHOT_KEY, JSON.stringify( { hash, count } ) );
		} else {
			localStorage.removeItem( SNAPSHOT_KEY );
		}
	} catch {}
}

const cached = readSnapshot();
const cartHash = cookie( 'woocommerce_cart_hash' );

if ( cached && cached.hash === cartHash ) {
	ui.paintCount( cached.count );
} else if ( cached ) {
	writeSnapshot( 0 );
}

document.addEventListener( 'lean-cart:updated', ( e ) => {
	writeSnapshot( e.detail.state.itemCount );
} );

// Another tab changed the cart — refetch so items and count follow.
window.addEventListener( 'storage', ( e ) => {
	if ( e.key === SNAPSHOT_KEY ) {
		store.fetchCart();
	}
} );

const hasSession =
	document.cookie.includes( 'wp_woocommerce_session' ) ||
	document.cookie.includes( 'woocommerce_items_in_cart' );

if ( hasSession ) {
	store.fetchCart();
}

// ── 3. Event delegation for cart actions ────────────────────────
//
// All interactive cart elements use data-cart-action attributes.
// A single delegated listener on document handles everything.

document.addEventListener( 'click', ( e ) => {
	const btn = e.target.closest( '[data-cart-action]' );
	if ( ! btn ) return;

	const action = btn.dataset.cartAction;
	const row = btn.closest( '[data-cart-item-key]' );
	const key = row?.dataset.cartItemKey;

	switch ( action ) {
		case 'remove':
			if ( key ) store.removeItem( key, { trigger: btn } );
			break;

		case 'increase':
			if ( key ) store.changeQuantity( key, 1 );
			break;

		case 'decrease':
			if ( key ) store.changeQuantity( key, -1 );
			break;

		case 'add':
			// Add-to-cart from archive/product pages (Stage 1.5).
			{
				const id = Number( btn.dataset.productId );
				const qty = Number( btn.dataset.cartQty || 1 );
				if ( id ) {
					e.preventDefault();
					store.addItem( { id, quantity: qty }, { trigger: btn, openDrawer: true } );
				}
			}
			break;
	}
} );

// Checkout links: leaving the page drops queued cart writes, so wait until
// they have landed (8 s at most) before navigating.
document.addEventListener( 'click', ( e ) => {
	const link = e.target.closest( '[data-lean-cart="checkout-url"]' );
	if ( ! link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey ) return;
	e.preventDefault();
	link.setAttribute( 'aria-busy', 'true' );
	Promise.race( [ store.whenIdle(), new Promise( r => setTimeout( r, 8000 ) ) ] ).then( () => {
		link.removeAttribute( 'aria-busy' );
		window.location.href = link.href;
	} );
} );

// Back from checkout restores this page from the back/forward cache as it was left.
window.addEventListener( 'pageshow', () => {
	document.querySelectorAll( '[data-lean-cart="checkout-url"][aria-busy]' ).forEach( el => el.removeAttribute( 'aria-busy' ) );
} );

// ── 4. Bridge to theme navigation ──────────────────────────────
//
// The lean-cart:open event requests the cart drawer to open.
// If the theme's numenu system is available, bridge to it.
// Otherwise, themes can listen to this event directly.

document.addEventListener( 'lean-cart:open', () => {
	if ( window.numenu ) {
		window.numenu.open( 'cart' );
	}
} );

// ── 5. Load extension modules conditionally ─────────────────────

if ( config.modules.subscriptions ) {
	import( './modules/subscriptions.js' ).then( m => m.init( store ) );
}

if ( config.modules.mixAndMatch ) {
	import( './modules/mix-and-match.js' ).then( m => m.init( store ) );
}

if ( config.modules.allProductsSubs ) {
	import( './modules/all-products-subs.js' ).then( m => m.init( store ) );
}

if ( config.modules.subliumSubscriptions ) {
	import( './modules/sublium-subscriptions.js' ).then( m => m.init( store ) );
}

// WooCommerce's classic cart page and shortcode checkout run their own jQuery
// cart requests; the bridge keeps them and the drawer in step. Loaded where
// cart.js or checkout.js runs; the module checks the page markup itself.
if ( window.jQuery && ( window.wc_checkout_params || window.wc_cart_params ) ) {
	import( './modules/classic-pages.js' ).then( m => m.init( store, window.jQuery, { cartUrl: config.cartUrl } ) );
}

// ── 6. Public API ───────────────────────────────────────────────

window.leanCart = {
	store,
	refresh: () => store.fetchCart(),
	open:    () => document.dispatchEvent( new CustomEvent( 'lean-cart:open' ) ),
	close:   () => document.dispatchEvent( new CustomEvent( 'lean-cart:close' ) ),
};
