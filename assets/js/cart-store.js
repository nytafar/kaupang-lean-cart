/**
 * Cart Store — single source of truth for cart state.
 *
 * Owns the canonical cart object, one queue that sends every
 * Store API call in order, optimistic mutations replayed over the
 * server's latest answer, a normalizer pipeline for extension
 * modules, and an EventTarget-based event bus on `document`.
 */

import * as api from '@kaupang/lean-cart/api';
import config from '@kaupang/lean-cart/config';

// ── Currency formatter ──────────────────────────────────────────

// Whole amounts stay short ("179 kr"); any other shows every decimal ("178,20 kr"), as WooCommerce does.
const formatter = ( digits ) => new Intl.NumberFormat( config.currency.locale, {
	style: 'currency',
	currency: config.currency.code,
	minimumFractionDigits: digits,
	maximumFractionDigits: digits,
} );
const whole = formatter( 0 );
const exact = formatter( config.currency.minorUnit );

export function formatPrice( minorUnitValue ) {
	const divisor = Math.pow( 10, config.currency.minorUnit );
	return ( minorUnitValue % divisor ? exact : whole ).format( minorUnitValue / divisor );
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
		// Before coupons, as WooCommerce's own order review rows (its subtotal row adds these up).
		// ponytail: incl. tax like every Lean Cart price; a shop displaying cart prices excl. tax would need the display mode here.
		lineSubtotal:   formatPrice( parseInt( raw.totals?.line_subtotal || 0, 10 ) + parseInt( raw.totals?.line_subtotal_tax || 0, 10 ) ),
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
let outdated = false; // the server's cart changed outside the store since `confirmed`
const LOCK = 'kaupang-lean-cart'; // Web Lock: tabs of the same shop share one cart session
const LOCK_WAIT_MS = 25000;       // a tab suspended while holding the lock must not freeze this one
const WRITE_SETTLE_MS = 10000;    // a timed-out write may still finish in PHP; let it before re-reading

const sleep = ( ms ) => new Promise( r => setTimeout( r, ms ) );

export function getState() {
	return state;
}

function emit( name, detail = {} ) {
	document.dispatchEvent( new CustomEvent( name, { detail } ) );
}

/**
 * `source` says what changed the state: 'optimistic' (a change not yet sent),
 * 'write' (a write's turn ended: the server's answer, or the real cart after a
 * failure) or 'read' (fetchCart). Listeners that react to cart writes, such as
 * the classic-page bridge, skip 'read' so a refresh never loops.
 */
function commit( newState, source ) {
	state = newState;
	emit( 'lean-cart:updated', { state, source } );
}

function publish( source = 'optimistic' ) {
	if ( ! confirmed ) return;
	const draft = structuredClone( confirmed );
	for ( const apply of pending.values() ) {
		apply( draft );
	}
	commit( draft, source );
}

/**
 * Run `job` under the cross-tab lock. If the lock is not granted within
 * LOCK_WAIT_MS, or the request is refused (no Web Locks, SecurityError), run it
 * without the lock rather than freeze the cart.
 */
function withLock( job ) {
	if ( ! navigator.locks?.request ) return job();
	let ran = false;
	return navigator.locks.request( LOCK, { signal: api.timeoutSignal( LOCK_WAIT_MS ) }, () => {
		ran = true;
		return job();
	} ).catch( ( err ) => {
		if ( ran ) throw err; // the job's own failure
		return job();
	} );
}

/**
 * Give `job` the next turn: after every earlier turn in this tab and, unless
 * `lock` is false, under the cross-tab lock. Reads skip the lock: they cannot
 * lose a write, and a held Web Lock disables the back/forward cache on older
 * Chromium.
 */
function takeTurn( job, { lock = true } = {} ) {
	const turn = queue.then( () => lock ? withLock( job ) : job() );
	queue = turn.catch( () => {} );
	return turn;
}

/**
 * Run a Store API call made outside the store (e.g. by a checkout) in the same
 * queue, so it never overlaps a cart write. Resolves or rejects with the call's
 * own result. A call that never settles gives up its turn after `timeout` ms,
 * so it cannot hold the queue. Pass `timeout: Infinity` to hold the turn until
 * the call settles (an order submit); the call must then time out by itself.
 *
 * @param {function} call    - Returns a promise (the request).
 * @param {object}   options - { timeout } in ms, default 20000.
 */
export function enqueue( call, { timeout = api.REQUEST_TIMEOUT_MS } = {} ) {
	return new Promise( ( resolve, reject ) => {
		takeTurn( () => {
			const result = Promise.resolve().then( call );
			result.then( resolve, reject );
			const settled = result.catch( () => {} );
			return Number.isFinite( timeout ) ? Promise.race( [ settled, api.wait( timeout ) ] ) : settled;
		} );
	} );
}

/**
 * Resolves once every queued write has settled and no debounced change is
 * waiting. Await it before leaving the page, or queued writes are lost.
 */
export async function whenIdle() {
	for ( ;; ) {
		const tail = queue;
		await tail;
		if ( tail !== queue ) continue; // more was queued meanwhile
		if ( ! debounced.size ) return;
		await sleep( 50 );
	}
}

/**
 * Run one store call in the queue. Its answer becomes the confirmed cart (a
 * call may answer null: nothing to send). On failure the confirmed cart is the
 * server's real one: from the error (WooCommerce attaches it on 409) or a
 * fresh fetch, never a snapshot. A write that timed out may still finish in
 * PHP, so the re-read waits WRITE_SETTLE_MS first (held turn, no overlap).
 * Every request here times out (cart-api.js), so a turn always ends.
 */
function send( id, call, { read = false } = {} ) {
	return takeTurn( async () => {
		try {
			const raw = await call();
			if ( raw ) {
				confirmed = normalizeCart( raw );
				outdated = false;
			}
			return raw;
		} catch ( err ) {
			if ( ! read && err?.code === 'request_timeout' ) {
				await api.wait( WRITE_SETTLE_MS );
			}
			const cart = err?.data?.cart || await api.getCart().catch( () => null );
			if ( cart ) {
				confirmed = normalizeCart( cart );
				outdated = false;
			}
			throw err;
		} finally {
			pending.delete( id );
			publish( read ? 'read' : 'write' );
		}
	}, { lock: ! read } );
}

/**
 * Say the server's cart may have changed outside the store (the classic cart
 * page's form post, a coupon). The next quantity change re-reads the cart in
 * its own turn before turning its delta into a quantity.
 */
export function invalidate() {
	outdated = true;
}

/**
 * Start from a cart the page was rendered with (a Store API cart response,
 * the config's `cart`), so the lines paint without waiting for a read. Only
 * while no answer has come yet; published as a 'read'. Call it once extension
 * modules have registered their normalizers. The page's own requests may
 * change the cart after it was rendered, so the next quantity change re-reads.
 */
export function seed( raw ) {
	if ( confirmed || ! raw?.items ) return;
	confirmed = normalizeCart( raw );
	outdated = true;
	publish( 'read' );
}

// ── Debounce map (per item key) ─────────────────────────────────

const debounced = new Map(); // item key → { id, delta, timer, waiters }
const DEBOUNCE_MS = 400;

function clampQuantity( item, quantity ) {
	const { minimum, maximum } = item.quantityLimits;
	return Math.min( maximum || 9999, Math.max( minimum || 1, quantity ) );
}

/**
 * Debounce quantity changes per line. Changes add up as a delta, and the
 * absolute quantity is computed when the write takes its turn, from the
 * server's latest cart, so a write queued ahead of it (an add that merged into
 * this line) is kept. Every superseded call settles with the write that
 * carried it.
 */
function debouncedUpdate( key, delta ) {
	let entry = debounced.get( key );
	if ( entry ) {
		clearTimeout( entry.timer );
	} else {
		entry = { id: ++lastId, delta: 0, waiters: [] };
		debounced.set( key, entry );

		// Optimistic update.
		pending.set( entry.id, ( draft ) => {
			const item = draft.items.find( i => i.key === key );
			if ( ! item ) return;
			const quantity = clampQuantity( item, item.quantity + entry.delta );
			draft.itemCount += quantity - item.quantity;
			item.quantity = quantity;
			item.lineTotal = item.lineSubtotal = '...'; // Will be replaced by server response.
		} );
	}
	entry.delta += delta;
	publish();

	return new Promise( ( resolve ) => {
		entry.waiters.push( resolve );
		entry.timer = setTimeout( () => {
			send( entry.id, async () => {
				if ( outdated ) {
					// A classic page request changed the cart meanwhile: count from it, not from before it.
					// If that read fails, count from the cart we have and send the change all the same.
					const raw = await api.getCart().catch( () => null );
					if ( raw ) {
						confirmed = normalizeCart( raw );
						outdated = false;
					}
				}
				const item = confirmed?.items.find( i => i.key === key );
				if ( ! item ) {
					// The line is gone or re-keyed: say so, and the failure path re-reads the cart.
					throw { code: 'kaupang_lean_cart_line_gone', message: '', data: null };
				}
				const quantity = clampQuantity( item, item.quantity + entry.delta );
				return quantity === item.quantity ? null : api.updateItem( { key, quantity } );
			} )
				.catch( err => emit( 'lean-cart:error', err ) )
				.finally( () => entry.waiters.forEach( settle => settle() ) );
			debounced.delete( key );
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
		await send( 0, () => api.getCart(), { read: true } );
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

	// Find the item and compute the step within its limits.
	const item = state.items.find( i => i.key === key );
	if ( ! item ) return;

	const step = clampQuantity( item, item.quantity + delta ) - item.quantity;
	if ( ! step ) return;

	await debouncedUpdate( key, step );
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
