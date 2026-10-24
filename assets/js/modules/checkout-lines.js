/**
 * Checkout lines: on WooCommerce's shortcode checkout the order review's item
 * lines are Lean Cart's, with the drawer's line markup, quantity buttons and
 * remove, all through the store. Everything else in the review (subtotal,
 * coupons, shipping, fees, VAT, total, payment) stays WooCommerce's and keeps
 * refreshing through update_order_review; the classic-pages bridge (cart-init
 * starts this once the bridge runs) triggers that refresh after every change.
 *
 * The mount ([data-lean-cart="checkout-lines"], printed by PHP before the
 * review table) sits outside the fragment update_order_review replaces, so a
 * refresh never re-renders it. It stays hidden until it has shown lines;
 * until then WooCommerce's own rows are what the shopper sees, and the CSS
 * hides those only next to a visible mount.
 */

// What the review's totals have to agree with: the lines and their quantities.
const linesOf = ( state ) => JSON.stringify( state.items.map( i => [ i.key, i.quantity, i.children.map( c => [ c.key, c.quantity ] ) ] ) );

const format = ( s, ...args ) => args.reduce( ( out, a, n ) => out.replace( `%${ n + 1 }$s`, a ).replace( '%s', a ), s );

/**
 * No imports of its own (see classic-pages.js): cart-init passes cart-ui's.
 *
 * @param {object} store - The cart store (getState).
 * @param {object} $     - jQuery, with blockUI.
 * @param {object} ui    - cart-ui's { renderItem, paintLines, i18n }.
 */
export function init( store, $, { renderItem, paintLines, i18n } ) {
	const root = document.querySelector( '[data-lean-cart="checkout-lines"]' );
	const list = root?.querySelector( '[data-lean-cart="checkout-items"]' );
	if ( ! list ) return;
	const status = root.querySelector( '[data-lean-cart="checkout-status"]' );
	const form = root.closest( 'form.checkout' );
	list.setAttribute( 'aria-label', i18n.checkoutLines || 'Varer i bestillingen' );
	let last = null;    // the state shown before this one
	let asked = null;   // the summary control the shopper used last: { key, action, title }
	let chased = false; // the last read triggered a refresh

	function render( state ) {
		const items = state.items.filter( i => ! i.isChild );
		if ( paintLines( list, items.map( i => renderItem( i, i.lineSubtotal ) ).join( '' ), items, root ) && items.length ) {
			root.hidden = false; // from now on the lines are Lean Cart's, empty or not
		}
	}

	function announce( state ) {
		if ( ! asked || ! status ) return;
		const item = state.items.find( i => i.key === asked.key );
		// A remove that failed says nothing here: the error alert says it.
		status.textContent = ! item
			? format( i18n.lineRemoved || '%s er fjernet', asked.title )
			: asked.action === 'remove' ? '' : format( i18n.lineQuantity || '%1$s, antall %2$s', item.title, item.quantity );
		asked = null;
	}

	list.addEventListener( 'click', ( e ) => {
		// While the order is being placed, nothing may change the cart. The form's
		// blockUI overlay stops the mouse, not Enter or Space on a focused button.
		if ( form?.classList.contains( 'processing' ) ) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		const btn = e.target.closest( '[data-cart-action]' );
		const row = btn?.closest( '[data-cart-item-key]' );
		if ( row ) asked = { key: row.dataset.cartItemKey, action: btn.dataset.cartAction, title: row.querySelector( '.cart-item-title' )?.textContent || '' };
	} );

	document.addEventListener( 'lean-cart:updated', ( e ) => {
		const { state, source } = e.detail;
		render( state );
		if ( source === 'read' ) {
			// The lines changed under a read (another tab): bring the totals in
			// step. Not while an order is being placed. The refresh's own re-read
			// shows the same lines; if it does not (a plugin that changes lines on
			// every totals calculation), it triggers nothing: one refresh per run.
			// Not for an empty cart: the bridge leaves the checkout for the cart page.
			const changed = state.items.length && last && linesOf( last ) !== linesOf( state ) && ! form?.classList.contains( 'processing' );
			if ( changed && ! chased ) $( document.body ).trigger( 'update_checkout' );
			chased = changed && ! chased;
		} else {
			// The totals describe the lines from before this change until the
			// bridge's update_order_review replaces them: mark them as updating,
			// as checkout.js does during its own update.
			$( '.woocommerce-checkout-review-order-table' ).block( { message: null, overlayCSS: { background: '#fff', opacity: 0.6 }, ignoreIfBlocked: true } );
			if ( source === 'write' ) announce( state );
		}
		last = state;
	} );

	const state = store.getState();
	if ( state ) {
		render( state );
		last = state;
	}
}
