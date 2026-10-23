/**
 * Checkout lines: on WooCommerce's shortcode checkout the order review's item
 * lines are Lean Cart's, with the drawer's line markup, quantity buttons and
 * remove, all through the store. Everything else in the review (subtotal,
 * coupons, shipping, fees, VAT, total, payment) stays WooCommerce's and keeps
 * refreshing through update_order_review; the classic-pages bridge, which
 * loads this, triggers that refresh after every drawer change.
 *
 * The mount ([data-lean-cart="checkout-lines"], printed by PHP before the
 * review table) sits outside the fragment update_order_review replaces, so a
 * refresh never re-renders it. It stays hidden until it has shown lines;
 * until then WooCommerce's own rows are what the shopper sees, and the CSS
 * hides those only next to a visible mount.
 */

import { renderItem } from '../cart-ui.js';

const { i18n } = window.leanCartConfig;
const CONTROL = { increase: '[data-cart-action="increase"]', decrease: '[data-cart-action="decrease"]', remove: '[data-cart-action="remove"]', title: '.cart-item-title' };

/**
 * Where focus goes after the lines re-render, given the control that had it
 * ({ key, action, index }) and the new top-level lines: the same control if it
 * can still take focus, else the line's other enabled control; for a line that
 * is gone, the remove button of the line now in its place (or the last one).
 * Null when no line is left.
 */
export function focusTarget( had, items ) {
	const item = items.find( i => i.key === had.key );
	if ( ! item ) {
		const next = items[ Math.min( had.index, items.length - 1 ) ];
		return next ? { key: next.key, action: 'remove' } : null;
	}
	const { minimum, maximum } = item.quantityLimits;
	const enabled = { decrease: item.quantity > ( minimum || 1 ), increase: item.quantity < ( maximum || 9999 ), remove: true, title: true };
	const action = [ had.action, had.action === 'increase' ? 'decrease' : 'increase', 'remove' ].find( a => enabled[ a ] );
	return { key: item.key, action };
}

// What the review's totals have to agree with: the lines and their quantities.
const linesOf = ( state ) => JSON.stringify( state.items.map( i => [ i.key, i.quantity, i.children.map( c => [ c.key, c.quantity ] ) ] ) );

const format = ( s, ...args ) => args.reduce( ( out, a, n ) => out.replace( `%${ n + 1 }$s`, a ).replace( '%s', a ), s );

/**
 * @param {object} store - The cart store (getState).
 * @param {object} $     - jQuery, with blockUI.
 */
export function init( store, $ ) {
	const root = document.querySelector( '[data-lean-cart="checkout-lines"]' );
	const list = root?.querySelector( '[data-lean-cart="checkout-items"]' );
	if ( ! list ) return;
	const status = root.querySelector( '[data-lean-cart="checkout-status"]' );
	const form = root.closest( 'form.checkout' );
	list.setAttribute( 'aria-label', i18n.checkoutLines || 'Varer i bestillingen' );
	let html = null;
	let last = null;  // the state shown before this one
	let asked = null; // the summary control the shopper used last: { key, action, title }

	function render( state ) {
		const items = state.items.filter( i => ! i.isChild );
		const next = items.map( i => renderItem( i, i.lineSubtotal ) ).join( '' );
		if ( next === html ) return; // nothing to repaint; focus stays put
		const at = document.activeElement;
		const row = at && list.contains( at ) ? at.closest( '[data-cart-item-key]' ) : null;
		const had = row && { key: row.dataset.cartItemKey, action: at.dataset.cartAction || 'title', index: [ ...list.children ].indexOf( row ) };
		list.innerHTML = html = next;
		if ( items.length ) root.hidden = false; // from now on the lines are Lean Cart's, empty or not
		if ( had ) {
			const to = focusTarget( had, items );
			( to ? list.querySelector( `[data-cart-item-key="${ CSS.escape( to.key ) }"] ${ CONTROL[ to.action ] }` ) : root )?.focus();
		}
	}

	function announce( state ) {
		if ( ! asked || ! status ) return;
		const item = state.items.find( i => i.key === asked.key );
		status.textContent = item && asked.action !== 'remove'
			? format( i18n.lineQuantity || '%1$s, antall %2$s', item.title, item.quantity )
			: format( i18n.lineRemoved || '%s er fjernet', asked.title );
		asked = null;
	}

	list.addEventListener( 'click', ( e ) => {
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
			// shows the same lines, so this stops there.
			if ( last && linesOf( last ) !== linesOf( state ) && ! form?.classList.contains( 'processing' ) ) {
				$( document.body ).trigger( 'update_checkout' );
			}
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
