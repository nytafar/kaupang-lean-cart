/**
 * Classic pages bridge: the drawer beside WooCommerce's jQuery cart page
 * (cart.js) and shortcode checkout (checkout.js).
 *
 * Both edit the same cart session, which WooCommerce saves whole at the end of
 * every request, so neither may run while the other is out. Loaded by
 * cart-init only on those pages.
 *
 * - No overlap: their cart and checkout requests take turns in the store's
 *   queue. The order submit first waits for pending drawer changes to land,
 *   then holds the queue until it settles.
 * - Page → drawer: when a burst of classic requests has finished, the drawer
 *   re-reads the cart once.
 * - Drawer → page: when a burst of drawer changes has landed, the page
 *   refreshes once (checkout: update_checkout; cart page: wc_update_cart).
 *   The re-read after it is a 'read', which never triggers a refresh: no loop.
 */

// WooCommerce core's classic cart and checkout endpoints. Every one of them
// loads the cart session and saves it when done.
const ENDPOINT = /[?&]wc-ajax=(update_order_review|checkout|apply_coupon|remove_coupon|update_shipping_method|get_cart_totals|add_to_cart|remove_from_cart)(?:[&#]|$)/;

/**
 * @param {object} store - The cart store (whenIdle, enqueue, fetchCart).
 * @param {object} $     - jQuery.
 * @param {object} opts  - { page: 'cart'|'checkout', cartUrl }.
 */
export function init( store, $, { page, cartUrl } ) {
	const cartPath = new URL( cartUrl, location.href ).pathname;
	const ajax = $.ajax;
	let open = 0;       // classic requests queued or out
	let stale = false;  // a classic request finished since the drawer last re-read
	let refreshing = false;

	// Which classic request this is, or null for any other request. The cart
	// page's own form posts and remove/undo links go to the cart URL.
	function classify( url ) {
		url = String( url ?? location.href );
		const match = url.match( ENDPOINT );
		if ( match ) return match[ 1 ];
		try {
			return new URL( url, location.href ).pathname === cartPath ? 'cart' : null;
		} catch {
			return null;
		}
	}

	function finished( kind ) {
		open--;
		// A failed submit changes no cart; a successful one leaves the page.
		if ( kind !== 'checkout' ) stale = true;
		// Follow-ups start in the finished request's callbacks (apply_coupon →
		// update_cart), so look once they have run: one re-read per burst.
		setTimeout( () => {
			if ( open || ! stale ) return;
			stale = false;
			store.fetchCart();
		} );
	}

	/**
	 * Send a classic request in its turn and return a jqXHR stand-in. The turn
	 * lasts until the server has answered, even when the caller aborts
	 * (checkout.js aborts update_order_review on every new field change): PHP
	 * keeps running and saves the session at the end. An abort settles the
	 * caller at once, as jQuery would, and mutes the late answer; a request
	 * aborted before its turn is never sent.
	 */
	function queued( settings, kind ) {
		const dfd = $.Deferred();
		const context = settings.context || settings;
		let cancelled = false;
		const live = ( fns ) => fns && [].concat( fns ).map( fn => function () {
			if ( ! cancelled ) return fn.apply( this, arguments );
		} );
		const run = () => {
			if ( cancelled ) return null;
			const xhr = ajax.call( $, { ...settings, success: live( settings.success ), error: live( settings.error ), complete: live( settings.complete ) } );
			xhr.done( function () { if ( ! cancelled ) dfd.resolveWith( this, arguments ); } );
			xhr.fail( function () { if ( ! cancelled ) dfd.rejectWith( this, arguments ); } );
			return new Promise( r => xhr.always( r ) );
		};
		const proxy = dfd.promise( {
			abort( statusText = 'canceled' ) {
				if ( cancelled || dfd.state() !== 'pending' ) return proxy;
				cancelled = true;
				[].concat( settings.error || [] ).forEach( fn => fn.call( context, proxy, 'abort', statusText ) );
				dfd.rejectWith( context, [ proxy, 'abort', statusText ] );
				[].concat( settings.complete || [] ).forEach( fn => fn.call( context, proxy, 'abort' ) );
				return proxy;
			},
		} );

		open++;
		const turn = kind === 'checkout'
			// The submit goes once pending drawer changes have landed, and holds
			// the queue until it settles: nothing may bring the cart back while
			// the order is being placed. The request has no limit of its own
			// beyond the browser's; a failed or aborted one releases the queue.
			? store.whenIdle().then( () => store.enqueue( run, { timeout: Infinity } ) )
			: store.enqueue( run );
		turn.catch( () => {} ).finally( () => finished( kind ) );
		return proxy;
	}

	$.ajax = function ( url, options ) {
		const settings = url && typeof url === 'object' ? url : { ...options, url };
		const kind = classify( settings.url );
		return kind ? queued( settings, kind ) : ajax.apply( this, arguments );
	};

	// checkout.js sends update_order_review at DOM ready, before this module
	// loaded: let anything already out finish before the next turn.
	if ( $.active ) {
		store.enqueue( () => new Promise( r => $( document ).one( 'ajaxStop', r ) ) );
	}

	function refreshPage() {
		if ( page === 'checkout' ) {
			$( document.body ).trigger( 'update_checkout' );
			return;
		}
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
			refreshPage();
		} );
	} );
}
