/**
 * Cart API — all Store API network calls.
 *
 * Nothing outside this module calls fetch() for cart operations.
 * Handles nonce management, 403 retry, and error normalization.
 */

const { storeApiBase } = window.leanCartConfig;
let nonce = window.leanCartConfig.nonce;

// A request that never answers would hold the store's write queue; abort it so
// the store re-fetches the real cart and moves on.
export const REQUEST_TIMEOUT_MS = 20000;

function timeoutSignal() {
	if ( AbortSignal.timeout ) {
		return AbortSignal.timeout( REQUEST_TIMEOUT_MS );
	}
	const controller = new AbortController();
	setTimeout( () => controller.abort(), REQUEST_TIMEOUT_MS );
	return controller.signal;
}

/**
 * Update the stored nonce from a response's Nonce header.
 * The Store API returns a fresh nonce on every cart route response.
 */
function updateNonce( response ) {
	const fresh = response.headers.get( 'Nonce' ) || response.headers.get( 'X-WC-Store-API-Nonce' );
	if ( fresh ) {
		nonce = fresh;
	}
}

/**
 * Normalize any error into a consistent shape.
 */
function normalizeError( data, response ) {
	if ( data && data.code ) {
		return { code: data.code, message: data.message || '', data: data.data || null };
	}
	return {
		code: 'api_error',
		message: response?.statusText || 'Unknown error',
		data: null,
	};
}

/**
 * A failed or timed-out transport. A timeout carries no message, so the UI
 * shows its own update-error text.
 */
function networkError( err ) {
	if ( err?.name === 'TimeoutError' || err?.name === 'AbortError' ) {
		return { code: 'request_timeout', message: '', data: null };
	}
	return { code: 'network_error', message: err?.message || 'Network request failed', data: null };
}

/**
 * Core request method.
 *
 * @param {string} endpoint  - Relative to storeApiBase (e.g., 'cart').
 * @param {object} options   - { method, body }.
 * @param {boolean} isRetry  - Internal flag to prevent infinite retry loops.
 * @returns {Promise<object>} Parsed JSON response.
 */
async function request( endpoint, { method = 'GET', body = null } = {}, isRetry = false ) {
	const url = storeApiBase + endpoint;
	const headers = { 'Nonce': nonce };
	const signal = timeoutSignal();

	if ( body ) {
		headers['Content-Type'] = 'application/json';
	}

	let response;
	try {
		response = await fetch( url, {
			method,
			headers,
			credentials: 'include',
			cache: 'no-store',
			body: body ? JSON.stringify( body ) : null,
			signal,
		} );
	} catch ( err ) {
		throw networkError( err );
	}

	updateNonce( response );

	// On 403, attempt one nonce refresh via a GET to cart, then retry.
	if ( response.status === 403 && ! isRetry ) {
		try {
			const refresh = await fetch( storeApiBase + 'cart', {
				method: 'GET',
				headers: { 'Nonce': nonce },
				credentials: 'include',
				cache: 'no-store',
				signal,
			} );
			updateNonce( refresh );
		} catch {
			// Nonce refresh failed — fall through to throw below.
		}
		return request( endpoint, { method, body }, true );
	}

	let data;
	try {
		data = await response.json();
	} catch ( err ) {
		throw networkError( err );
	}

	if ( ! response.ok ) {
		throw normalizeError( data, response );
	}

	return data;
}

// ── Public API ──────────────────────────────────────────────────

export function getCart() {
	return request( 'cart' );
}

export function addItem( payload ) {
	const { id, quantity = 1, variation = [], ...rest } = payload;
	return request( 'cart/add-item', {
		method: 'POST',
		body: { id, quantity, variation, ...rest },
	} );
}

export function updateItem( { key, quantity } ) {
	return request( 'cart/update-item', {
		method: 'POST',
		body: { key, quantity },
	} );
}

export function removeItem( { key } ) {
	return request( 'cart/remove-item', {
		method: 'POST',
		body: { key },
	} );
}

export function applyCoupon( { code } ) {
	return request( 'cart/apply-coupon', {
		method: 'POST',
		body: { code },
	} );
}

export function removeCoupon( { code } ) {
	return request( 'cart/remove-coupon', {
		method: 'POST',
		body: { code },
	} );
}
