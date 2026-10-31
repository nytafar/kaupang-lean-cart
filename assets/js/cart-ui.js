/**
 * Cart UI — pure renderer.
 *
 * Finds all [data-lean-cart] mount points in the DOM and hydrates
 * them from cart state. No fetch calls, no state mutations.
 * Subscribes to lean-cart:updated events from the store.
 */

import config from '@kaupang/lean-cart/config';

// Exported for the checkout lines, which import nothing themselves.
export const { i18n } = config;

// ── Mount point cache ───────────────────────────────────────────

let mountPoints = {};

function cacheMountPoints() {
	mountPoints = {
		items:       document.querySelectorAll( '[data-lean-cart="items"]' ),
		totals:      document.querySelectorAll( '[data-lean-cart="totals"]' ),
		count:       document.querySelectorAll( '[data-lean-cart="count"]' ),
		label:       document.querySelectorAll( '[data-lean-cart="label"]' ),
		empty:       document.querySelectorAll( '[data-lean-cart="empty"]' ),
		error:       document.querySelectorAll( '[data-lean-cart="error"]' ),
		loading:     document.querySelectorAll( '[data-lean-cart="loading"]' ),
		checkoutUrl: document.querySelectorAll( '[data-lean-cart="checkout-url"]' ),
	};
}

// ── SVG icons ───────────────────────────────────────────────────

const removeIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

// ── Meta row rendering ─────────────────────────────────────────

function renderMetaRow( row ) {
	const label = config.showVariationLabels
		? `<dt>${esc( row.key )}</dt>`
		: `<dt class="screen-reader-text">${esc( row.key )}</dt>`;

	return `<div class="cart-item-meta-row">${ label }<dd>${esc( row.value ) }</dd></div>`;
}

// ── Item rendering ──────────────────────────────────────────────

/**
 * A line's thumbnail: `sizes` lets the browser take the smallest srcset
 * candidate for the box; width/height reserve the box (square, as the CSS)
 * before it loads.
 */
function renderImage( image, px, sizes ) {
	const srcset = image.srcset ? ` srcset="${esc( image.srcset )}" sizes="${esc( sizes )}"` : '';
	return `<img src="${esc( image.src )}"${ srcset } width="${ px }" height="${ px }" alt="${esc( image.alt )}" loading="lazy" decoding="async" />`;
}

/**
 * One line's markup. `price` defaults to the line total; the checkout lines
 * show the subtotal before coupons. Buttons are type="button": a line may sit
 * inside a form (the classic checkout), where a plain button would submit it.
 */
export function renderItem( item, price = item.lineTotal ) {
	if ( item.isChild ) return ''; // Children rendered inside parent.

	const image = item.image
		? `<a href="${esc( item.permalink )}" class="cart-item-image">${ renderImage( item.image, 56, config.imageSizes || '56px' ) }</a>`
		: '';

	const meta = item.metaRows.length
		? `<dl class="cart-item-meta">${ item.metaRows.map( renderMetaRow ).join( '' ) }</dl>`
		: '';

	// Deduped: independent modules may mark the same fact (the WCS and
	// APfS normalizers both badge a subscription item 'Abonnement').
	const badgeLabels = [ ...new Set( item.badges ) ];
	const badges = badgeLabels.length
		? `<span class="cart-item-badges">${ badgeLabels.map( b => `<span class="cart-badge">${esc( b )}</span>` ).join( '' ) }</span>`
		: '';

	const subSummary = item.subscriptionSummary
		? `<span class="cart-item-subscription">${esc( item.subscriptionSummary )}</span>`
		: '';

	const children = item.children.length
		? `<div class="cart-children">${ item.children.map( renderChildItem ).join( '' ) }</div>`
		: '';

	const { minimum, maximum } = item.quantityLimits;
	const canDecrease = item.quantity > ( minimum || 1 );
	const canIncrease = item.quantity < ( maximum || 9999 );

	return `
		<div class="cart-item${ item.children.length ? ' cart-item--container' : '' }" data-cart-item-key="${esc( item.key )}" role="listitem">
			${ image }
			<div class="cart-item-details">
				<a href="${esc( item.permalink )}" class="cart-item-title">${esc( item.title )}</a>
				${ meta }
				${ badges }
				${ subSummary }
			</div>
			<div class="cart-item-actions">
				<div class="quantity-control">
					<button type="button" data-cart-action="decrease" aria-label="${esc( `Reduser antall ${ item.title }` ) }"${ canDecrease ? '' : ' disabled' }>&minus;</button>
					<span data-cart-quantity aria-label="Antall">${ item.quantity }</span>
					<button type="button" data-cart-action="increase" aria-label="${esc( `Øk antall ${ item.title }` ) }"${ canIncrease ? '' : ' disabled' }>&plus;</button>
				</div>
				<span class="cart-item-price">${esc( price ) }</span>
				<button type="button" class="cart-item-remove" data-cart-action="remove" aria-label="${esc( i18n.remove + ' ' + item.title ) }">
					${ removeIcon }
				</button>
			</div>
			${ children }
		</div>
	`;
}

function renderChildItem( child ) {
	const image = child.image ? renderImage( child.image, 32, '32px' ) : '';

	return `
		<div class="cart-item cart-item--child" data-cart-item-key="${esc( child.key )}" role="listitem">
			${ image ? `<span class="cart-item-image">${ image }</span>` : '' }
			<span class="cart-item-title">${esc( child.title )}</span>
			<span class="cart-item-qty">&times;${ child.quantity }</span>
		</div>
	`;
}

// ── Painting a list of lines, keeping focus ─────────────────────

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

const painted = new WeakMap(); // list → the markup it was last given

/**
 * Put `html` (the markup of the top-level lines `items`) into `list`. Not when
 * it already shows that markup, so focus and screen readers are left alone.
 * If focus was inside the list, it goes back to the same control, or the
 * nearest one that can take it (focusTarget); with no line left, to
 * `fallback`. Returns whether it repainted.
 */
export function paintLines( list, html, items, fallback = null ) {
	if ( painted.get( list ) === html ) return false;
	const at = document.activeElement;
	const row = at && list.contains( at ) ? at.closest( '[data-cart-item-key]' ) : null;
	const had = row && { key: row.dataset.cartItemKey, action: at.dataset.cartAction || 'title', index: [ ...list.children ].indexOf( row ) };
	list.innerHTML = html;
	painted.set( list, html );
	if ( had ) {
		const to = focusTarget( had, items );
		( to ? list.querySelector( `[data-cart-item-key="${ CSS.escape( to.key ) }"] ${ CONTROL[ to.action ] }` ) : fallback )?.focus();
	}
	return true;
}

// ── Totals rendering ────────────────────────────────────────────

function renderRecurringTotals( recurringTotals = [] ) {
	if ( ! recurringTotals.length ) return '';

	return `
		<div class="totals-divider"></div>
		<div class="cart-recurring-totals">
			${ recurringTotals.map( total => `
				<div class="totals-row totals-row--recurring">
					<span class="totals-label">${esc( i18n.subliumRecurring || 'Fornyes' )}</span>
					<span class="totals-value">${esc( total.total )}</span>
				</div>
				${ total.nextPaymentDate ? `
					<div class="totals-row totals-row--meta">
						<span class="totals-label">${esc( i18n.subliumNextPayment || 'Neste betaling' )}</span>
						<span class="totals-value">${esc( total.nextPaymentDate )}</span>
					</div>
				` : '' }
			` ).join( '' ) }
		</div>
	`;
}

function renderTotals( state ) {
	const totals = state.totals;
	const shipping = {
		free:    `<span class="totals-value totals-value--free">${esc( i18n.freeShipping )}</span>`,
		pending: `<span class="totals-value totals-value--pending">${esc( i18n.shippingPending )}</span>`,
		paid:    `<span class="totals-value">${esc( totals.shipping )}</span>`,
	}[ state.shippingState ];

	return `
		<div class="totals-row">
			<span class="totals-label">${esc( i18n.subtotal )}</span>
			<span class="totals-value">${esc( totals.subtotal )}</span>
		</div>
		${ shipping ? `<div class="totals-row">
			<span class="totals-label">${esc( i18n.shipping )}</span>
			${ shipping }
		</div>` : '' }
		<div class="totals-divider"></div>
		<div class="totals-row totals-row--total">
			<span class="totals-label">${esc( i18n.total )}</span>
			<span class="totals-value">${esc( totals.total )}</span>
		</div>
		${ renderRecurringTotals( state.recurringTotals ) }
	`;
}

// ── Full render cycle ───────────────────────────────────────────

function render( state ) {
	if ( ! state ) return;

	const hasItems = state.items.length > 0;
	const topLevelItems = state.items.filter( i => ! i.isChild );

	// Before the items: the empty state must be shown before focus can go to it.
	paintCount( state.itemCount );

	// Items
	const itemsHtml = hasItems
		? topLevelItems.map( item => renderItem( item ) ).join( '' )
		: '';

	mountPoints.items.forEach( el => {
		// With no line left, focus goes to the drawer's empty state link, if any.
		paintLines( el, itemsHtml, topLevelItems, el.parentElement?.querySelector( '[data-lean-cart="empty"] a' ) );
		el.setAttribute( 'role', 'list' );
		el.setAttribute( 'aria-live', 'polite' );
	} );

	// Totals
	mountPoints.totals.forEach( el => {
		el.innerHTML = hasItems ? renderTotals( state ) : '';
	} );

	// Loading state
	mountPoints.loading.forEach( el => {
		el.hidden = true;
	} );

	// Checkout URLs
	mountPoints.checkoutUrl.forEach( el => {
		el.href = config.checkoutUrl;
	} );
}

/**
 * Paint the count-derived mount points: count badges (hidden at zero — zero is
 * not a count), labels and the empty state. Exported so boot can paint a
 * cached count before the cart has been fetched.
 */
export function paintCount( count ) {
	mountPoints.count.forEach( el => {
		el.textContent = count;
		el.hidden = count === 0;
	} );

	const label = `${ count }\u00a0${ count === 1 ? i18n.item : i18n.items }`;
	mountPoints.label.forEach( el => {
		el.textContent = label;
	} );

	mountPoints.empty.forEach( el => {
		el.hidden = count > 0;
	} );
}

/**
 * Show an error in the Lean Cart region the shopper is in (the drawer or the
 * checkout lines: two role="alert" mounts would announce it twice); in every
 * one when focus is in none.
 */
function showError( message ) {
	const here = [ ...mountPoints.error ].filter( el => el.closest( '.lean-cart' )?.contains( document.activeElement ) );
	( here.length ? here : mountPoints.error ).forEach( el => {
		el.textContent = message;
		el.hidden = false;
		clearTimeout( el._errorTimer );
		el._errorTimer = setTimeout( () => { el.hidden = true; }, 5000 );
	} );
}

function showLoading() {
	mountPoints.loading.forEach( el => { el.hidden = false; } );
	mountPoints.items.forEach( el => { el.setAttribute( 'aria-busy', 'true' ); } );
}

// ── Init ────────────────────────────────────────────────────────

export function init() {
	cacheMountPoints();

	document.addEventListener( 'lean-cart:updated', ( e ) => {
		render( e.detail.state );
	} );

	document.addEventListener( 'lean-cart:error', ( e ) => {
		showError( e.detail.message || i18n.updateError );
	} );

	document.addEventListener( 'lean-cart:loading', () => {
		showLoading();
	} );
}

// ── Utilities ───────────────────────────────────────────────────

// For text and for attribute values alike (aria-label, alt, href, data-*).
const ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc( str ) {
	return String( str ?? '' ).replace( /[&<>"']/g, c => ENTITY[ c ] );
}
