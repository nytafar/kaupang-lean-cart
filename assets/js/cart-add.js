/**
 * Cart Add — intercepts native WooCommerce add-to-cart triggers.
 *
 * Converts the default form POST / loop link navigation into
 * Store API calls through the cart store, so adding an item
 * never leaves the current page.
 *
 * Handles:
 *   - form.cart              (simple products, grouped, subs)
 *   - form.variations_form   (variable products)
 *   - form.cart.mnm_form     (mix and match, if its own JS lets submit bubble)
 *   - a.add_to_cart_button   (loop / widget "add to cart" links)
 *   - [data-cart-action="add"] is still handled by cart-init.js
 */

import * as store from '@kaupang/lean-cart/store';

// ── Form submit ────────────────────────────────────────────────

function extractVariation( form ) {
	const variation = [];
	form.querySelectorAll( '[name^="attribute_"]' ).forEach( ( el ) => {
		// Radios: only count the checked one.
		if ( el.type === 'radio' && ! el.checked ) return;
		// Unchecked checkboxes: skip.
		if ( el.type === 'checkbox' && ! el.checked ) return;
		const value = ( el.value || '' ).trim();
		if ( ! value ) return;
		variation.push( { attribute: el.name, value } );
	} );
	return variation;
}

function extractProductId( form ) {
	// Variable-product forms expose data-product_id on the form.
	if ( form.dataset.product_id ) {
		const id = Number( form.dataset.product_id );
		if ( id ) return id;
	}

	// Simple products: hidden <button name="add-to-cart" value="ID">
	// or <input type="hidden" name="add-to-cart" value="ID">.
	const addField = form.querySelector(
		'button[name="add-to-cart"], input[name="add-to-cart"]'
	);
	if ( addField && Number( addField.value ) > 0 ) {
		return Number( addField.value );
	}

	return 0;
}

function extractQuantity( form ) {
	const qty = form.querySelector( 'input[name="quantity"]' );
	const n = qty ? Number( qty.value ) : 1;
	return Number.isFinite( n ) && n > 0 ? n : 1;
}

function handleFormSubmit( e ) {
	const form = e.target.closest( 'form.cart' );
	if ( ! form ) return;

	// Allow other scripts to opt out (e.g., a custom module that
	// already handled the submit).
	if ( e.defaultPrevented ) return;

	const id = extractProductId( form );
	if ( ! id ) return; // Unknown form — let it submit normally.

	const quantity  = extractQuantity( form );
	const variation = extractVariation( form );
	const extras    = store.runFormExtractors( form );
	const trigger   = form.querySelector(
		'button[type="submit"], [name="add-to-cart"]'
	);

	e.preventDefault();
	store.addItem(
		{ id, quantity, variation, ...extras },
		{ trigger, openDrawer: true }
	);
}

// ── Loop / widget links ────────────────────────────────────────

function handleLoopClick( e ) {
	const link = e.target.closest( 'a.add_to_cart_button' );
	if ( ! link || e.defaultPrevented ) return;

	// Skip links that are really "view product" fallbacks.
	if ( link.classList.contains( 'product_type_variable' ) ) return;
	if ( link.classList.contains( 'product_type_grouped' ) ) return;
	if ( link.classList.contains( 'product_type_external' ) ) return;

	let id = Number( link.dataset.product_id || 0 );
	if ( ! id && link.href ) {
		try {
			const url = new URL( link.href, window.location.origin );
			id = Number( url.searchParams.get( 'add-to-cart' ) || 0 );
		} catch ( _ ) {
			// Ignore malformed URLs.
		}
	}
	if ( ! id ) return;

	const quantity = Number( link.dataset.quantity || 1 ) || 1;

	e.preventDefault();
	store.addItem(
		{ id, quantity },
		{ trigger: link, openDrawer: true }
	);
}

// ── Init ───────────────────────────────────────────────────────

export function init() {
	// `submit` doesn't bubble through shadow DOM but does bubble in
	// the light DOM, so a single document-level listener suffices.
	document.addEventListener( 'submit', handleFormSubmit );
	document.addEventListener( 'click', handleLoopClick );
}
