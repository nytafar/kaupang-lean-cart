/**
 * Classic pages bridge: the drawer beside WooCommerce's jQuery cart page
 * (cart.js) and shortcode checkout (checkout.js).
 *
 * Both edit the same cart session, which WooCommerce saves whole at the end of
 * every request, so neither may run while the other is out. cart-init loads
 * this where WooCommerce's cart or checkout params are on the page;
 * classicPage() decides from the markup.
 *
 * - No overlap: WooCommerce's own cart and checkout requests take turns in the
 *   store's queue. jQuery sends each through the XMLHttpRequest that
 *   `settings.xhr()` returns; the bridge holds that object's send() until the
 *   turn, so callers keep jQuery's real jqXHR (readyState, status, abort and
 *   the global events are jQuery's own). The order submit first waits for
 *   pending drawer changes to land, then holds the queue until it settles.
 * - Page → drawer: when a burst of classic requests has finished, the drawer
 *   re-reads the cart once.
 * - Drawer → page: when a burst of drawer changes has landed, the page
 *   refreshes once (checkout: update_checkout; cart page: wc_update_cart).
 *   The re-read after it is a 'read', which never triggers a refresh: no loop.
 * - Neither happens while an order is being placed; a failed one catches up.
 */

// WooCommerce core's classic cart and checkout endpoints. Every one of them
// loads the cart session and saves it when done.
const ENDPOINT = /[?&]wc-ajax=(update_order_review|checkout|apply_coupon|remove_coupon|update_shipping_method|get_cart_totals|add_to_cart|remove_from_cart)(?:[&#]|$)/;
// cart.js's own requests to the cart page: the remove and undo links, and
// posts of the cart form or the shipping calculator (each carries its nonce).
const CART_LINK = /[?&](?:remove_item|undo_item)=/;
const CART_FORM = /(?:^|&)woocommerce-(?:cart|shipping-calculator)-nonce=/;
// nginx answers 504 after fastcgi_read_timeout (60 s on these servers), so a
// classic request still out after this is a dead connection: it then gives up
// its turn. The order submit has no limit.
const TURN_CAP_MS = 65000;

/**
 * 'checkout' on the shortcode checkout, 'cart' on the classic cart page
 * (including its empty state), otherwise null: block cart and checkout, Lean
 * Checkout (form.lean-checkout-form), order-pay (form#order_review).
 */
export function classicPage() {
	return ( window.jQuery?.fn?.block && (
		( window.wc_checkout_params && document.querySelector( 'form.checkout' ) && 'checkout' ) ||
		( window.wc_cart_params && document.querySelector( '.woocommerce-cart-form, .wc-empty-cart-message' ) && 'cart' )
	) ) || null;
}

/**
 * @param {object} store - The cart store (whenIdle, enqueue, fetchCart).
 * @param {object} $     - jQuery.
 * @param {object} opts  - { cartUrl }.
 */
export function init( store, $, { cartUrl } ) {
	const page = classicPage();
	if ( ! page ) return;

	const cartPath = new URL( cartUrl, location.href ).pathname;
	const form = page === 'checkout' ? document.querySelector( 'form.checkout' ) : null;
	let open = 0;        // classic requests queued or out
	let stale = false;   // a classic request finished since the drawer last re-read
	let behind = false;  // drawer changes landed that the page has not shown yet
	let refreshing = false;

	// checkout.js and Vipps keep form.checkout.processing from Place order until
	// the order fails or the page leaves, through a 3-D Secure or Vipps step too.
	const placing = () => !! form?.classList.contains( 'processing' );

	// Which classic request this is, or null for any other request.
	function classify( s ) {
		const match = s.url.match( ENDPOINT );
		if ( match ) return match[ 1 ];
		try {
			if ( new URL( s.url, location.href ).pathname !== cartPath ) return null;
		} catch {
			return null;
		}
		return CART_LINK.test( s.url ) || CART_FORM.test( typeof s.data === 'string' ? s.data : '' ) ? 'cart' : null;
	}

	// Bring page and drawer in step, but not under an order being placed: a
	// refresh then re-renders the payment step or hits the emptied session.
	function catchUp() {
		if ( placing() ) return;
		if ( behind ) {
			behind = false;
			refreshPage(); // its request makes the drawer re-read after it
		} else if ( stale && ! open ) {
			stale = false;
			store.fetchCart();
		}
	}
	if ( form ) {
		new MutationObserver( catchUp ).observe( form, { attributes: true, attributeFilter: [ 'class' ] } );
	}

	function finished( kind ) {
		open--;
		// A failed submit changes no cart; a successful one leaves the page.
		if ( kind !== 'checkout' ) stale = true;
		// Follow-ups start in the finished request's callbacks (apply_coupon →
		// update_cart), so look once they have run: one re-read per burst.
		setTimeout( catchUp );
	}

	/**
	 * Wrap jQuery's XHR factory for one classic request. send() waits for the
	 * turn, which lasts until the request has ended (loadend). An abort has
	 * already settled the caller and detached jQuery's handlers: a request not
	 * yet sent is never sent; one already out runs on, holding the turn, since
	 * PHP saves the session at the end (checkout.js aborts update_order_review
	 * on every field change).
	 */
	function queuedXhr( make, kind ) {
		return function () {
			const xhr = make.apply( this, arguments );
			const send = xhr.send;
			let cancelled = false;
			xhr.abort = () => {
				cancelled = true;
			};
			xhr.send = ( body ) => {
				open++;
				const run = () => cancelled ? null : new Promise( ( done ) => {
					xhr.addEventListener( 'loadend', done );
					send.call( xhr, body );
				} );
				const turn = kind === 'checkout'
					// Pending drawer changes land first, and nothing may change
					// the cart while the order is placed. A failed or aborted
					// submit releases the queue.
					? store.whenIdle().then( () => store.enqueue( run, { timeout: Infinity } ) )
					: store.enqueue( run, { timeout: TURN_CAP_MS } );
				turn.catch( () => {} ).finally( () => finished( kind ) );
			};
			return xhr;
		};
	}

	// checkout.js sends update_order_review at DOM ready, which may be before
	// this module loaded: the next turn waits for what jQuery already had out.
	const later = new WeakSet();
	let earlier = $.active;
	if ( earlier ) {
		const out = new Promise( ( resolve ) => $( document ).on( 'ajaxComplete', ( e, jqXHR ) => {
			if ( ! later.has( jqXHR ) && ! --earlier ) resolve();
		} ) );
		store.enqueue( () => out, { timeout: TURN_CAP_MS } );
	}

	$.ajaxPrefilter( ( s, original, jqXHR ) => {
		later.add( jqXHR );
		const kind = s.async && classify( s );
		if ( kind ) s.xhr = queuedXhr( s.xhr, kind );
	} );

	function refreshPage() {
		if ( page === 'checkout' ) {
			$( document.body ).trigger( 'update_checkout' );
			return;
		}
		// The empty-cart page has no form to update: cart.js would reload it.
		if ( ! $( '.woocommerce-cart-form' ).length ) return;
		// cart.js's update_cart posts the whole form. Without an update_cart
		// field WooCommerce ignores its quantities; quantity_update leaves one
		// behind in the form when its request fails.
		$( '.woocommerce-cart-form input[name="update_cart"][type="hidden"]' ).remove();
		$( document.body ).trigger( 'wc_update_cart' );
	}

	document.addEventListener( 'lean-cart:updated', ( e ) => {
		if ( e.detail?.source === 'read' ) return;
		if ( page === 'cart' ) {
			// The form's quantities are stale until the refresh replaces it;
			// "Update cart" would post them over the drawer change. cart.js
			// ignores submits on a blocked form and unblocks it when update_cart ends.
			$( '.woocommerce-cart-form' ).not( '.processing' ).addClass( 'processing' ).block( { message: null, overlayCSS: { background: '#fff', opacity: 0.6 } } );
		}
		if ( refreshing ) return;
		refreshing = true;
		store.whenIdle().then( () => {
			refreshing = false;
			behind = true;
			catchUp();
		} );
	} );
}
