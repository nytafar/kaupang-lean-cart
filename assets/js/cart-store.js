/**
 * Cart Store — single source of truth for cart state.
 *
 * Owns the canonical cart object, one queue that sends every
 * Store API call in order, optimistic mutations replayed over the
 * server's latest answer, a normalizer pipeline for extension
 * modules, and an EventTarget-based event bus on `document`.
 */

import * as api from './cart-api.js';

const config = window.leanCartConfig;

// ── Currency formatter ──────────────────────────────────────────

const formatter = new Intl.NumberFormat( config.currency.locale, {
	style: 'currency',
	currency: config.currency.code,
	minimumFractionDigits: 0,
	maximumFractionDigits: config.currency.minorUnit,
} );

export function formatPrice( minorUnitValue ) {
	const divisor = Math.pow( 10, config.currency.minorUnit );
	return formatter.format( minorUnitValue / divisor );
}

// ── Form extractor pipeline ─────────────────────────────────────

const formExtractors = [];

/**
 * Register a form extractor function.
 * Extension modules call this to contribute extra fields to the
 * Store API add-to-cart payload (e.g., mnm_config for MnM products).
 *
 * @param {function} fn - Receives (formElement) and returns an object or null.
 */
export function addFormExtractor( fn ) {
	formExtractors.push( fn );
}

/**
 * Run all registered form extractors and merge their results.
 *
 * @param {HTMLFormElement} form - The form being submitted.
 * @returns {object} Merged extra fields for the Store API body.
 */
export function runFormExtractors( form ) {
	const extras = {};
	for ( const fn of formExtractors ) {
		try {
			const result = fn( form );
			if ( result && typeof result === 'object' ) {
				Object.assign( extras, result );
			}
		} catch ( _ ) {
			// A misbehaving module must not block add-to-cart.
		}
	}
	return extras;
}

// ── Normalizer pipeline ─────────────────────────────────────────

const normalizers = [];
const cartNormalizers = [];

/**
 * Register an item normalizer function.
 * Extension modules call this to enrich normalized items.
 *
 * @param {function} fn - Receives (normalizedItem, rawItem) and returns normalizedItem.
 */
export function addNormalizer( fn ) {
	normalizers.push( fn );
}

/**
 * Register a cart normalizer function.
 * Extension modules call this to enrich the full normalized cart.
 *
 * @param {function} fn - Receives (normalizedCart, rawCart) and returns normalizedCart.
 */
export function addCartNormalizer( fn ) {
	cartNormalizers.push( fn );
}

/* Store API strings arrive HTML-encoded (&#8217; etc.); the UI escapes on
   render, so decode exactly once here or entities show up literally. */
const entityDecoder = document.createElement( 'textarea' );
function decodeEntities( s ) {
	entityDecoder.innerHTML = s ?? '';
	return entityDecoder.value;
}

/**
 * Normalize a raw Store API cart item into the lean-cart display model.
 */
function normalizeItem( raw ) {
	const name = decodeEntities( raw.name );
	let item = {
		key:            raw.key,
		id:             raw.id,
		type:           raw.type || 'simple',
		title:          name,
		image:          raw.images?.[0] ? { src: raw.images[0].src, alt: raw.images[0].alt || name } : null,
		quantity:       raw.quantity,
		quantityLimits: raw.quantity_limits || { minimum: 1, maximum: 9999, multiple_of: 1 },
		unitPrice:      formatPrice( parseInt( raw.prices?.price || 0, 10 ) ),
		lineTotal:      formatPrice( parseInt( raw.totals?.line_total || 0, 10 ) + parseInt( raw.totals?.line_total_tax || 0, 10 ) ),
		permalink:      raw.permalink || '',
		badges:         [],
		children:       [],
		isChild:        false,
		parentKey:      null,
		purchaseMode:   null,
		subscriptionSummary: null,
		metaRows:       [
			...( raw.variation || [] ).map( v => ({ key: v.attribute, value: v.value, type: 'text' }) ),
			...( raw.item_data || [] ).map( d => ({ key: d.name, value: d.display || d.value, type: 'text' }) ),
		],
		extensions:     raw.extensions || {},
	};

	// Run extension normalizers.
	for ( const fn of normalizers ) {
		item = fn( item, raw );
	}

	return item;
}

/**
 * Normalize the full cart response.
 */
function normalizeCart( raw ) {
	let cart = {
		items:         ( raw.items || [] ).map( normalizeItem ),
		coupons:       raw.coupons || [],
		totals: {
			subtotal:      formatPrice( parseInt( raw.totals?.total_items || 0, 10 ) + parseInt( raw.totals?.total_items_tax || 0, 10 ) ),
			total:         formatPrice( parseInt( raw.totals?.total_price || 0, 10 ) ),
			tax:           formatPrice( parseInt( raw.totals?.total_tax || 0, 10 ) ),
			shipping:      formatPrice( parseInt( raw.totals?.total_shipping || 0, 10 ) + parseInt( raw.totals?.total_shipping_tax || 0, 10 ) ),
			shippingRaw:   parseInt( raw.totals?.total_shipping || 0, 10 ) + parseInt( raw.totals?.total_shipping_tax || 0, 10 ),
		},
		itemCount:     ( raw.items || [] ).reduce( ( sum, i ) => sum + i.quantity, 0 ),
		needsShipping: raw.needs_shipping || false,
		extensions:    raw.extensions || {},
		recurringTotals: [],
	};

	for ( const fn of cartNormalizers ) {
		cart = fn( cart, raw );
	}

	return cart;
}

// ── State ───────────────────────────────────────────────────────
//
// WooCommerce saves the cart session as one row per request, so two
// overlapping Store API writes overwrite each other. Every call therefore
// runs through one queue: the server sees one cart request at a time, in
// order. `confirmed` is the server's latest answer; `state` is that answer
// with every still-pending optimistic change replayed on top, so an earlier
// write's response never erases a newer change, and a failure drops only
// its own change.

let state = null;
let confirmed = null;
const pending = new Map(); // op id → fn( draft ) applying that op optimistically
let lastId = 0;
let queue = Promise.resolve();

export function getState() {
	return state;
}

function emit( name, detail = {} ) {
	document.dispatchEvent( new CustomEvent( name, { detail } ) );
}

function commit( newState ) {
	state = newState;
	emit( 'lean-cart:updated', { state } );
}

function publish() {
	if ( ! confirmed ) return;
	const draft = structuredClone( confirmed );
	for ( const apply of pending.values() ) {
		apply( draft );
	}
	commit( draft );
}

/**
 * Run one Store API call in the queue. Its answer becomes the confirmed cart.
 * On failure the confirmed cart is the server's real one: from the error
 * (WooCommerce attaches it on 409) or a fresh fetch, never a snapshot.
 */
function send( id, call ) {
	const run = queue.then( async () => {
		try {
			const raw = await call();
			confirmed = normalizeCart( raw );
			return raw;
		} catch ( err ) {
			const cart = err?.data?.cart || await api.getCart().catch( () => null );
			if ( cart ) {
				confirmed = normalizeCart( cart );
			}
			throw err;
		} finally {
			pending.delete( id );
			publish();
		}
	} );
	queue = run.catch( () => {} );
	return run;
}

// ── Debounce map (per item key) ─────────────────────────────────

const debounced = new Map(); // item key → { id, timer, waiters }
const DEBOUNCE_MS = 400;

/**
 * Debounce a quantity write per line. A newer call on the same key replaces
 * the quantity, and every superseded call settles with the write that
 * carried it.
 */
function debouncedUpdate( key, quantity ) {
	let entry = debounced.get( key );
	if ( entry ) {
		clearTimeout( entry.timer );
	} else {
		entry = { id: ++lastId, waiters: [] };
		debounced.set( key, entry );
	}

	// Optimistic update.
	pending.set( entry.id, ( draft ) => {
		const item = draft.items.find( i => i.key === key );
		if ( ! item ) return;
		draft.itemCount += quantity - item.quantity;
		item.quantity = quantity;
		item.lineTotal = '...'; // Will be replaced by server response.
	} );
	publish();

	return new Promise( ( resolve ) => {
		entry.waiters.push( resolve );
		entry.timer = setTimeout( () => {
			debounced.delete( key );
			send( entry.id, () => api.updateItem( { key, quantity } ) )
				.catch( err => emit( 'lean-cart:error', err ) )
				.finally( () => entry.waiters.forEach( settle => settle() ) );
		}, DEBOUNCE_MS );
	} );
}

function cancelDebounce( key ) {
	const entry = debounced.get( key );
	if ( ! entry ) return;
	clearTimeout( entry.timer );
	debounced.delete( key );
	pending.delete( entry.id );
	entry.waiters.forEach( settle => settle() );
}

// ── Public actions ──────────────────────────────────────────────

/**
 * Fetch the full cart from the Store API and commit it.
 */
export async function fetchCart() {
	emit( 'lean-cart:loading', { operation: 'fetch' } );
	try {
		await send( 0, () => api.getCart() );
	} catch ( err ) {
		emit( 'lean-cart:error', err );
	}
}

/**
 * Add an item to the cart.
 *
 * @param {object} payload  - { id, quantity, variation }.
 * @param {object} options  - { trigger, openDrawer }.
 */
export async function addItem( payload, { trigger = null, openDrawer = true } = {} ) {
	const id = ++lastId;
	setLoading( trigger, true );

	// Optimistic badge increment.
	pending.set( id, ( draft ) => {
		draft.itemCount += payload.quantity || 1;
	} );
	publish();

	try {
		const raw = await send( id, () => api.addItem( payload ) );
		emit( 'lean-cart:item-added', { item: normalizeItem( raw.items?.[ raw.items.length - 1 ] ) } );
		if ( openDrawer ) {
			emit( 'lean-cart:open' );
		}
	} catch ( err ) {
		emit( 'lean-cart:error', err );
	} finally {
		setLoading( trigger, false );
	}
}

/**
 * Change an item's quantity by a delta (+1 or -1).
 *
 * Uses debounced API calls per item key.
 */
export async function changeQuantity( key, delta ) {
	if ( ! state ) return;

	// Find the item and compute new quantity.
	const item = state.items.find( i => i.key === key );
	if ( ! item ) return;

	const newQty = Math.max( item.quantityLimits.minimum || 1, item.quantity + delta );
	if ( newQty === item.quantity ) return;

	await debouncedUpdate( key, newQty );
}

/**
 * Remove an item from the cart.
 */
export async function removeItem( key, { trigger = null } = {} ) {
	if ( ! state ) return;

	// The line is going; a quantity change still waiting for it would only fail.
	cancelDebounce( key );
	const id = ++lastId;
	setLoading( trigger, true );

	// Optimistic removal.
	pending.set( id, ( draft ) => {
		const item = draft.items.find( i => i.key === key );
		if ( ! item ) return;
		draft.items = draft.items.filter( i => i !== item );
		draft.itemCount -= item.quantity + item.children.reduce( ( s, c ) => s + c.quantity, 0 );
	} );
	publish();

	try {
		await send( id, () => api.removeItem( { key } ) );
		emit( 'lean-cart:item-removed', { key } );
	} catch ( err ) {
		emit( 'lean-cart:error', err );
	} finally {
		setLoading( trigger, false );
	}
}

/**
 * Apply a coupon code.
 */
export async function applyCoupon( code ) {
	try {
		await send( 0, () => api.applyCoupon( { code } ) );
	} catch ( err ) {
		emit( 'lean-cart:error', err );
	}
}

/**
 * Remove a coupon.
 */
export async function removeCoupon( code ) {
	try {
		await send( 0, () => api.removeCoupon( { code } ) );
	} catch ( err ) {
		emit( 'lean-cart:error', err );
	}
}

// ── Helpers ─────────────────────────────────────────────────────

function setLoading( el, loading ) {
	if ( ! el ) return;
	el.disabled = loading;
	el.setAttribute( 'aria-busy', String( loading ) );
}
