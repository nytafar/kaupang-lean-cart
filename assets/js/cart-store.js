/**
 * Cart Store — single source of truth for cart state.
 *
 * Owns the canonical cart object, optimistic mutations with
 * rollback, a normalizer pipeline for extension modules, and
 * an EventTarget-based event bus dispatched on `document`.
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

let state = null;
let snapshot = null;

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

function takeSnapshot() {
	snapshot = state ? structuredClone( state ) : null;
}

function rollback() {
	if ( snapshot ) {
		commit( snapshot );
		snapshot = null;
	}
}

// ── Debounce map (per item key) ─────────────────────────────────

const debounceTimers = new Map();
const DEBOUNCE_MS = 400;

function debouncedUpdate( key, quantity ) {
	if ( debounceTimers.has( key ) ) {
		clearTimeout( debounceTimers.get( key ) );
	}

	return new Promise( ( resolve, reject ) => {
		const timer = setTimeout( async () => {
			debounceTimers.delete( key );
			try {
				const raw = await api.updateItem( { key, quantity } );
				resolve( raw );
			} catch ( err ) {
				reject( err );
			}
		}, DEBOUNCE_MS );

		debounceTimers.set( key, timer );
	} );
}

// ── Public actions ──────────────────────────────────────────────

/**
 * Fetch the full cart from the Store API and commit it.
 */
export async function fetchCart() {
	emit( 'lean-cart:loading', { operation: 'fetch' } );
	try {
		const raw = await api.getCart();
		commit( normalizeCart( raw ) );
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
	takeSnapshot();
	setLoading( trigger, true );

	// Optimistic badge increment.
	if ( state ) {
		const optimistic = structuredClone( state );
		optimistic.itemCount += payload.quantity || 1;
		commit( optimistic );
	}

	try {
		const raw = await api.addItem( payload );
		commit( normalizeCart( raw ) );
		emit( 'lean-cart:item-added', { item: normalizeItem( raw.items?.[ raw.items.length - 1 ] ) } );
		if ( openDrawer ) {
			emit( 'lean-cart:open' );
		}
	} catch ( err ) {
		rollback();
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

	takeSnapshot();

	// Find the item and compute new quantity.
	const item = state.items.find( i => i.key === key );
	if ( ! item ) return;

	const newQty = Math.max( item.quantityLimits.minimum || 1, item.quantity + delta );
	if ( newQty === item.quantity ) return;

	// Optimistic update.
	const optimistic = structuredClone( state );
	const optItem = optimistic.items.find( i => i.key === key );
	optItem.quantity = newQty;
	optItem.lineTotal = '...'; // Will be replaced by server response.
	optimistic.itemCount = optimistic.items.reduce( ( s, i ) => s + i.quantity, 0 );
	commit( optimistic );

	try {
		const raw = await debouncedUpdate( key, newQty );
		commit( normalizeCart( raw ) );
	} catch ( err ) {
		rollback();
		emit( 'lean-cart:error', err );
	}
}

/**
 * Remove an item from the cart.
 */
export async function removeItem( key, { trigger = null } = {} ) {
	if ( ! state ) return;

	takeSnapshot();
	setLoading( trigger, true );

	// Optimistic removal.
	const optimistic = structuredClone( state );
	optimistic.items = optimistic.items.filter( i => i.key !== key );
	optimistic.itemCount = optimistic.items.reduce( ( s, i ) => s + i.quantity, 0 );
	commit( optimistic );

	try {
		const raw = await api.removeItem( { key } );
		commit( normalizeCart( raw ) );
		emit( 'lean-cart:item-removed', { key } );
	} catch ( err ) {
		rollback();
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
		const raw = await api.applyCoupon( { code } );
		commit( normalizeCart( raw ) );
	} catch ( err ) {
		emit( 'lean-cart:error', err );
	}
}

/**
 * Remove a coupon.
 */
export async function removeCoupon( code ) {
	try {
		const raw = await api.removeCoupon( { code } );
		commit( normalizeCart( raw ) );
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
