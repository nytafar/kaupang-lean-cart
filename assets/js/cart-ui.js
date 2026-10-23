/**
 * Cart UI — pure renderer.
 *
 * Finds all [data-lean-cart] mount points in the DOM and hydrates
 * them from cart state. No fetch calls, no state mutations.
 * Subscribes to lean-cart:updated events from the store.
 */

const config = window.leanCartConfig;
const { i18n } = config;

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
 * One line's markup. `price` defaults to the line total; the checkout lines
 * show the subtotal before coupons. Buttons are type="button": a line may sit
 * inside a form (the classic checkout), where a plain button would submit it.
 */
export function renderItem( item, price = item.lineTotal ) {
	if ( item.isChild ) return ''; // Children rendered inside parent.

	const image = item.image
		? `<a href="${esc( item.permalink )}" class="cart-item-image"><img src="${esc( item.image.src )}" alt="${esc( item.image.alt )}" loading="lazy" /></a>`
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
	const image = child.image
		? `<img src="${esc( child.image.src )}" alt="${esc( child.image.alt )}" loading="lazy" />`
		: '';

	return `
		<div class="cart-item cart-item--child" data-cart-item-key="${esc( child.key )}" role="listitem">
			${ image ? `<span class="cart-item-image">${ image }</span>` : '' }
			<span class="cart-item-title">${esc( child.title )}</span>
			<span class="cart-item-qty">&times;${ child.quantity }</span>
		</div>
	`;
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
	const freeShipping = totals.shippingRaw === 0;

	return `
		<div class="totals-row">
			<span class="totals-label">${esc( i18n.subtotal )}</span>
			<span class="totals-value">${esc( totals.subtotal )}</span>
		</div>
		<div class="totals-row">
			<span class="totals-label">${esc( i18n.shipping )}</span>
			<span class="totals-value${ freeShipping ? ' totals-value--free' : '' }">${ freeShipping ? esc( i18n.freeShipping ) : esc( totals.shipping ) }</span>
		</div>
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

	// Items
	const itemsHtml = hasItems
		? topLevelItems.map( item => renderItem( item ) ).join( '' )
		: '';

	mountPoints.items.forEach( el => {
		el.innerHTML = itemsHtml;
		el.setAttribute( 'role', 'list' );
		el.setAttribute( 'aria-live', 'polite' );
	} );

	// Totals
	mountPoints.totals.forEach( el => {
		el.innerHTML = hasItems ? renderTotals( state ) : '';
	} );

	paintCount( state.itemCount );

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

function showError( message ) {
	mountPoints.error.forEach( el => {
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

function esc( str ) {
	if ( typeof str !== 'string' ) return String( str ?? '' );
	const div = document.createElement( 'div' );
	div.textContent = str;
	return div.innerHTML;
}
