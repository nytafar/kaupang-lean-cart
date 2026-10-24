/**
 * Check: cart writes are serialised and the store commits the server's truth.
 *
 * Drives the real cart-store.js + cart-api.js (and the Mix-and-Match module)
 * against a fake Store API that behaves like WooCommerce's cart session: each
 * request reads the cart when it starts and saves the whole cart when it ends,
 * so overlapping writes lose updates. Latency, failures, hangs and network
 * errors are set per request. Exits non-zero on any failure.
 *
 *   /root/.nvm/versions/node/v22.21.0/bin/node tools/check-cart-queue.mjs [dir-with-cart-store.js]
 *
 * Node 18+ (structuredClone, Response, CustomEvent, AbortSignal.timeout), no dependencies.
 * JS rather than the suite's PHP check: the store is browser JS and cannot be driven from PHP.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

const jsDir = path.resolve( process.argv[ 2 ] || path.join( path.dirname( fileURLToPath( import.meta.url ) ), '../assets/js' ) );
const sleep = ( ms ) => new Promise( r => setTimeout( r, ms ) );
const settles = ( p, ms = 3000 ) => Promise.race( [ p.then( () => true, () => true ), sleep( ms ).then( () => false ) ] );

globalThis.window = globalThis;
window.leanCartConfig = {
	storeApiBase: 'https://shop.test/wp-json/wc/store/v1/',
	nonce: 'n',
	currency: { locale: 'nb-NO', code: 'NOK', minorUnit: 2 },
	i18n: {},
};

// The modules import each other by the ids WordPress maps (@kaupang/lean-cart/<name>); resolve them to the files.
// The config module is replaced by one that reads window.leanCartConfig on every access, so a scenario can swap it.
register( 'data:text/javascript,' + encodeURIComponent( `export async function resolve( specifier, context, next ) {
	const name = specifier.match( /^@kaupang\\/lean-cart\\/(.+)$/ )?.[ 1 ];
	if ( ! name ) return next( specifier, context );
	if ( name === 'config' ) return { url: 'data:text/javascript,export default new Proxy( {}, { get: ( _, k ) => window.leanCartConfig[ k ] } );', shortCircuit: true };
	const file = [ 'api', 'store', 'ui', 'add', 'init' ].includes( name ) ? 'cart-' + name + '.js' : 'modules/' + name + '.js';
	return { url: ${ JSON.stringify( pathToFileURL( jsDir ).href + '/' ) } + file, shortCircuit: true };
}` ) );
const realTimeout = AbortSignal.timeout.bind( AbortSignal );
// Production time limits (20 s request, 10 s settle, 25 s lock wait) at 1/50 speed.
async function scaledTime( fn ) {
	AbortSignal.timeout = ( ms ) => realTimeout( ms / 50 );
	try {
		return await fn();
	} finally {
		AbortSignal.timeout = realTimeout;
	}
}
// A fake navigator.locks: request( name, [options,] job ) runs `grant( job, options )`.
const fakeLocks = ( grant ) => ( { requests: 0, request( name, a, b ) { this.requests++; return grant( b || a, b ? a : {} ); } } );
const setLocks = ( locks ) => Object.defineProperty( globalThis, 'navigator', { value: { locks }, configurable: true, writable: true } );
setLocks( undefined );

// ── Fake Store API with WooCommerce's read-modify-write session ─────────────
//
// Lines: { key, id, quantity, children?: [ { key, id, quantity } ] } (children = a Mix-and-Match box).
// Options per request (route, body, srv): latency → ms, fail → HTTP status (409 replies with the cart),
// hang → never answer until aborted, netError → fetch rejects like a dropped connection.

function fakeServer( items, { latency = () => 50, fail = () => null, hang = () => false, netError = () => false } = {} ) {
	const srv = { cart: items, coupons: [], inFlight: 0, maxInFlight: 0, log: [] };
	const raw = ( cart, coupons ) => ( {
		items: cart.flatMap( i => [
			{ key: i.key, id: i.id, name: i.key, quantity: i.quantity, prices: { price: '100' }, totals: i.totals || {},
				extensions: i.children ? { mix_and_match: { child_items: i.children.map( c => c.key ) } } : {} },
			...( i.children || [] ).map( c => ( { key: c.key, id: c.id, name: c.key, quantity: c.quantity, prices: { price: '0' }, totals: {},
				extensions: { mix_and_match: { container: i.key } } } ) ),
		] ),
		coupons: coupons.map( code => ( { code } ) ), totals: {},
	} );
	const reply = ( status, body ) => new Response( JSON.stringify( body ), { status, headers: { Nonce: 'n' } } );

	globalThis.fetch = async ( url, { method = 'GET', body, signal } = {} ) => {
		const route = url.slice( window.leanCartConfig.storeApiBase.length );
		const data = body ? JSON.parse( body ) : {};
		const entry = { route, data, start: Date.now(), end: null };
		srv.log.push( entry );
		if ( netError( route, data, srv ) ) {
			entry.end = Date.now();
			throw new TypeError( 'Failed to fetch' );
		}
		srv.maxInFlight = Math.max( srv.maxInFlight, ++srv.inFlight );
		const cart = structuredClone( srv.cart ); // session read at request start
		const coupons = [ ...srv.coupons ];
		const aborted = new Promise( ( _, reject ) => signal?.addEventListener( 'abort', () => reject( signal.reason ), { once: true } ) );
		aborted.catch( () => {} );
		if ( hang( route, data, srv ) ) {
			try {
				await aborted;
			} finally {
				srv.inFlight--;
				entry.end = Date.now();
			}
		}
		// The server finishes its work even when the client has given up (PHP keeps running).
		const work = ( async () => {
			await sleep( latency( route, data, srv ) );
			srv.inFlight--;
			entry.end = Date.now();
			const failure = fail( route, data, srv );
			if ( failure ) return reply( failure, { code: 'fail', message: 'fail', data: failure === 409 ? { cart: raw( srv.cart, srv.coupons ) } : {} } );
			if ( route === 'cart/add-item' ) {
				const key = 'k' + data.id + ( data.variation?.length ? 'v' + data.variation[ 0 ].value : '' );
				const line = cart.find( i => i.key === key );
				line ? ( line.quantity += data.quantity ) : cart.push( { key, id: data.id, quantity: data.quantity } );
			} else if ( route === 'cart/update-item' ) {
				const line = cart.find( i => i.key === data.key );
				if ( ! line ) return reply( 409, { code: 'woocommerce_rest_cart_invalid_key', message: 'gone', data: { cart: raw( srv.cart, srv.coupons ) } } );
				line.quantity = data.quantity;
			} else if ( route === 'cart/remove-item' ) {
				cart.splice( cart.findIndex( i => i.key === data.key ), 1 );
			} else if ( route === 'cart/apply-coupon' ) {
				coupons.push( data.code );
			}
			if ( method !== 'GET' ) { // session saved at request end
				srv.cart = cart;
				srv.coupons = coupons;
			}
			return reply( 200, raw( cart, coupons ) );
		} )();
		return Promise.race( [ work, aborted ] );
	};
	return srv;
}

// ── Harness ─────────────────────────────────────────────────────────────────

let run = 0;
let failed = 0;
const qty = ( cart, key ) => cart?.items.find( i => i.key === key )?.quantity ?? 0;
const lines = ( items ) => items.map( i => `${ i.key }=${ i.quantity }` ).sort().join( ',' ) || '(empty)';
const routes = ( srv ) => srv.log.map( e => e.route );

function ok( cond, label ) {
	console.log( `${ cond ? 'ok  ' : 'FAIL' } ${ label }` );
	if ( ! cond ) failed++;
}

// A fresh store module (fresh state), by default on a fresh event bus, with every lean-cart:* event recorded.
async function freshStore( { mnm = false, sameBus = false } = {} ) {
	if ( ! sameBus ) {
		globalThis.document = new EventTarget();
		// decodeEntities sets innerHTML and reads value.
		document.createElement = () => ( {
			set innerHTML( v ) { this.value = v; },
		} );
		document.activeElement = null;
	}
	const store = await import( pathToFileURL( path.join( jsDir, 'cart-store.js' ) ).href + '?run=' + ++run );
	if ( mnm ) {
		( await import( pathToFileURL( path.join( jsDir, 'modules/mix-and-match.js' ) ).href ) ).init( store );
	}
	const events = [];
	const errors = [];
	const commits = [];
	for ( const name of [ 'updated', 'item-added', 'item-removed', 'error', 'open' ] ) {
		document.addEventListener( 'lean-cart:' + name, e => {
			events.push( name );
			if ( name === 'updated' ) commits.push( e.detail.state );
			if ( name === 'error' ) errors.push( e.detail );
		} );
	}
	return { store, events, errors, commits };
}

async function scenario( name, fn ) {
	console.log( `# ${ name }` );
	try {
		await fn();
	} catch ( err ) {
		ok( false, `threw: ${ err?.message || err }` );
	}
	await sleep( 600 ); // let stragglers of a broken store die before the next fake server
}

// ── Scenarios ───────────────────────────────────────────────────────────────

await scenario( 'D-121: + + then add a variation while the quantity write is in flight', async () => {
	const srv = fakeServer( [ { key: 'k10714', id: 10714, quantity: 2 } ], { latency: () => 300 } );
	const { store, commits } = await freshStore();
	await store.fetchCart();
	const p1 = store.changeQuantity( 'k10714', 1 );
	await sleep( 50 );
	const p2 = store.changeQuantity( 'k10714', 1 );
	await sleep( 500 ); // the debounced update-item is now on the wire
	const p3 = store.addItem( { id: 10, quantity: 1, variation: [ { attribute: 'attribute_pa_x', value: 'a' } ] }, { openDrawer: false } );
	ok( await settles( Promise.all( [ p1, p2, p3 ] ) ), 'every promise settles (incl. the superseded changeQuantity)' );
	ok( srv.maxInFlight === 1, `server never sees two requests at once (max ${ srv.maxInFlight })` );
	ok( lines( srv.cart ) === 'k10714=4,k10va=1', `server cart is k10714=4,k10va=1 (got ${ lines( srv.cart ) })` );
	ok( lines( store.getState().items ) === lines( srv.cart ), `state equals the server cart (got ${ lines( store.getState().items ) })` );
	const first4 = commits.findIndex( c => qty( c, 'k10714' ) === 4 );
	ok( first4 >= 0 && commits.slice( first4 ).every( c => qty( c, 'k10714' ) === 4 ), 'once shown at 4, no older response shows it lower' );
} );

await scenario( 'add that merges into a line, then + on that line', async () => {
	const srv = fakeServer( [ { key: 'k1', id: 1, quantity: 2 } ], { latency: () => 300 } );
	const { store } = await freshStore();
	await store.fetchCart();
	const p1 = store.addItem( { id: 1, quantity: 1 }, { openDrawer: false } ); // merges into k1
	await sleep( 50 );
	const p2 = store.changeQuantity( 'k1', 1 );
	ok( await settles( Promise.all( [ p1, p2 ] ) ), 'every promise settles' );
	ok( lines( srv.cart ) === 'k1=4', `server cart is k1=4 (got ${ lines( srv.cart ) })` );
	ok( lines( store.getState().items ) === 'k1=4', `state is k1=4 (got ${ lines( store.getState().items ) })` );
} );

await scenario( 'mini-cart: rapid +/- on two lines', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 3 }, { key: 'b', id: 2, quantity: 3 } ], { latency: ( r, d ) => d.key === 'a' ? 500 : 60 } );
	const { store } = await freshStore();
	await store.fetchCart();
	const ps = [];
	for ( const [ key, d ] of [ [ 'a', 1 ], [ 'b', -1 ], [ 'a', 1 ], [ 'b', -1 ] ] ) {
		ps.push( store.changeQuantity( key, d ) );
		await sleep( 30 );
	}
	await sleep( 450 ); // a's write (slow) is in flight; change b again so its write is queued behind
	ps.push( store.changeQuantity( 'b', 1 ) );
	ok( await settles( Promise.all( ps ) ), 'every promise settles' );
	ok( srv.maxInFlight === 1, `server never sees two requests at once (max ${ srv.maxInFlight })` );
	ok( lines( srv.cart ) === 'a=5,b=2', `server cart is a=5,b=2 (got ${ lines( srv.cart ) })` );
	ok( lines( store.getState().items ) === lines( srv.cart ), `state equals the server cart (got ${ lines( store.getState().items ) })` );
} );

await scenario( 'remove during a pending + sends no quantity write and raises no error', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 2 }, { key: 'b', id: 2, quantity: 1 } ] );
	const { store, events } = await freshStore();
	await store.fetchCart();
	const p1 = store.changeQuantity( 'a', 1 );
	await sleep( 100 );
	const p2 = store.removeItem( 'a' );
	ok( await settles( Promise.all( [ p1, p2 ] ) ), 'both promises settle' );
	await sleep( 500 ); // past the debounce window
	ok( ! routes( srv ).includes( 'cart/update-item' ), `no update-item sent (sent: ${ routes( srv ).join( ' ' ) })` );
	ok( ! events.includes( 'error' ), 'no error event' );
	ok( lines( srv.cart ) === 'b=1' && lines( store.getState().items ) === 'b=1', `server and state are b=1 (got ${ lines( srv.cart ) } / ${ lines( store.getState().items ) })` );
} );

await scenario( 'failed write rolls back to the real cart (fresh fetch)', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 }, { key: 'b', id: 2, quantity: 1 } ], {
		latency: ( r ) => r === 'cart/remove-item' ? 400 : 100,
		fail: ( r ) => r === 'cart/remove-item' ? 500 : null,
	} );
	const { store } = await freshStore();
	await store.fetchCart();
	const p1 = store.addItem( { id: 3, quantity: 1 }, { openDrawer: false } );
	await sleep( 20 );
	const p2 = store.removeItem( 'b' );
	ok( await settles( Promise.all( [ p1, p2 ] ) ), 'every promise settles' );
	ok( lines( srv.cart ) === 'a=1,b=1,k3=1', `server cart is a=1,b=1,k3=1 (got ${ lines( srv.cart ) })` );
	ok( lines( store.getState().items ) === lines( srv.cart ), `state equals the server cart (got ${ lines( store.getState().items ) })` );
} );

await scenario( 'failed write with a 409 uses the cart in the error', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], {
		latency: () => 100,
		// Another tab set the line to 5; the 409 carries that cart.
		fail: ( r, d, s ) => r === 'cart/update-item' ? ( s.cart = [ { key: 'a', id: 1, quantity: 5 } ], 409 ) : null,
	} );
	const { store } = await freshStore();
	await store.fetchCart();
	const gets = routes( srv ).filter( r => r === 'cart' ).length;
	ok( await settles( store.changeQuantity( 'a', 1 ) ), 'promise settles' );
	ok( qty( store.getState(), 'a' ) === 5, `state shows the error cart's quantity 5 (got ${ qty( store.getState(), 'a' ) })` );
	ok( routes( srv ).filter( r => r === 'cart' ).length === gets, 'no extra fetch when the error carries the cart' );
} );

await scenario( 'failed write whose re-fetch also fails keeps the last confirmed cart', async () => {
	let down = false;
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 }, { key: 'b', id: 2, quantity: 1 } ], {
		fail: () => down ? 500 : null,
	} );
	const { store, events } = await freshStore();
	await store.fetchCart();
	down = true;
	ok( await settles( store.removeItem( 'b' ) ), 'promise settles' );
	ok( routes( srv ).slice( -2 ).join( ' ' ) === 'cart/remove-item cart', `it tried a re-fetch (log: ${ routes( srv ).join( ' ' ) })` );
	ok( lines( store.getState().items ) === 'a=1,b=1', `state is the last confirmed cart, the optimistic removal dropped (got ${ lines( store.getState().items ) })` );
	ok( events.filter( e => e === 'error' ).length === 1, 'one error event' );
	down = false;
	await settles( store.addItem( { id: 3, quantity: 1 }, { openDrawer: false } ) );
	ok( lines( store.getState().items ) === 'a=1,b=1,k3=1', `the queue still runs afterwards (got ${ lines( store.getState().items ) })` );
} );

await scenario( 'network error rolls back via a fresh fetch', async () => {
	fakeServer( [ { key: 'a', id: 1, quantity: 1 }, { key: 'b', id: 2, quantity: 1 } ], {
		netError: ( r ) => r === 'cart/remove-item',
	} );
	const { store, errors } = await freshStore();
	await store.fetchCart();
	ok( await settles( store.removeItem( 'b' ) ), 'promise settles' );
	ok( errors[ 0 ]?.code === 'network_error', `error event is network_error (got ${ errors[ 0 ]?.code })` );
	ok( lines( store.getState().items ) === 'a=1,b=1', `state is the server cart (got ${ lines( store.getState().items ) })` );
} );

await scenario( 'a request that never answers times out and the queue moves on', async () => {
	AbortSignal.timeout = () => realTimeout( 300 ); // stands in for the 20 s production timeout
	try {
		const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], {
			hang: ( r ) => r === 'cart/update-item',
		} );
		const { store, errors } = await freshStore();
		await store.fetchCart();
		const p1 = store.changeQuantity( 'a', 1 );
		await sleep( 450 ); // update-item is hanging now
		const p2 = store.addItem( { id: 2, quantity: 1 }, { openDrawer: false } );
		ok( await settles( Promise.all( [ p1, p2 ] ), 4000 ), 'both promises settle' );
		ok( errors[ 0 ]?.code === 'request_timeout', `error event is request_timeout (got ${ errors[ 0 ]?.code })` );
		ok( lines( srv.cart ) === 'a=1,k2=1' && lines( store.getState()?.items || [] ) === 'a=1,k2=1', `server and state are a=1,k2=1 (got ${ lines( srv.cart ) } / ${ lines( store.getState()?.items || [] ) })` );
		ok( srv.maxInFlight === 1, `the add waited for the timeout (max ${ srv.maxInFlight })` );
	} finally {
		AbortSignal.timeout = realTimeout;
	}
} );

await scenario( 'coupon and fetchCart run in order', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: ( r ) => r === 'cart/apply-coupon' ? 400 : 20 } );
	const { store } = await freshStore();
	await store.fetchCart();
	const p1 = store.applyCoupon( 'x' );
	const p2 = store.fetchCart();
	ok( await settles( Promise.all( [ p1, p2 ] ) ), 'both promises settle' );
	const [ coupon, get ] = srv.log.slice( -2 );
	ok( coupon.route === 'cart/apply-coupon' && get.route === 'cart' && get.start >= coupon.end, 'the fetch started after the coupon write ended' );
	ok( store.getState().coupons.map( c => c.code ).join() === 'x', 'state carries the coupon' );
} );

await scenario( 'Mix-and-Match box: nested state, optimistic removal counts its contents', async () => {
	const srv = fakeServer( [ { key: 'box', id: 12001, quantity: 1, children: [ { key: 'c1', id: 9084, quantity: 2 }, { key: 'c2', id: 9327, quantity: 1 } ] }, { key: 'a', id: 1, quantity: 1 } ], { latency: () => 200 } );
	const { store, commits } = await freshStore( { mnm: true } );
	await store.fetchCart();
	const box = store.getState().items.find( i => i.key === 'box' );
	ok( box?.children.map( c => c.key ).join() === 'c1,c2' && store.getState().itemCount === 5, `box nests c1,c2 and the count is 5 (got ${ box?.children.map( c => c.key ) } / ${ store.getState().itemCount })` );
	const p = store.removeItem( 'box' );
	ok( commits.at( -1 ).itemCount === 1 && lines( commits.at( -1 ).items ) === 'a=1', `optimistic state is a=1, count 1 (got ${ lines( commits.at( -1 ).items ) } / ${ commits.at( -1 ).itemCount })` );
	await settles( p );
	ok( lines( srv.cart ) === 'a=1' && store.getState().itemCount === 1, `server is a=1 and the count is 1 (got ${ lines( srv.cart ) } / ${ store.getState().itemCount })` );
} );

await scenario( 'event contract: order, and one error per failed write', async () => {
	fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { fail: ( r ) => r === 'cart/update-item' ? 500 : null } );
	const { store, events } = await freshStore();
	await store.fetchCart();
	events.length = 0;
	await store.addItem( { id: 2, quantity: 1 } );
	ok( events.join( ' ' ) === 'updated updated item-added open', `addItem: updated updated item-added open (got ${ events.join( ' ' ) })` );
	events.length = 0;
	await store.removeItem( 'k2' );
	ok( events.join( ' ' ) === 'updated updated item-removed', `removeItem: updated updated item-removed (got ${ events.join( ' ' ) })` );
	events.length = 0;
	const p1 = store.changeQuantity( 'a', 1 );
	const p2 = store.changeQuantity( 'a', 1 );
	await settles( Promise.all( [ p1, p2 ] ) );
	ok( events.filter( e => e === 'error' ).length === 1, `a failed write with two callers emits error once (got ${ events.filter( e => e === 'error' ).length })` );
	ok( events.at( -1 ) === 'error' && events.at( -2 ) === 'updated' && qty( store.getState(), 'a' ) === 1, `rollback commit, then error; state back to 1 (got ${ events.join( ' ' ) })` );
} );

await scenario( 'two tabs share one cart session: the Web Lock serialises them', async () => {
	let tail = Promise.resolve();
	setLocks( fakeLocks( ( job ) => { const turn = tail.then( () => job( {} ) ); tail = turn.catch( () => {} ); return turn; } ) );
	try {
		const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 }, { key: 'b', id: 2, quantity: 1 } ], { latency: () => 200 } );
		const tab1 = ( await freshStore() ).store;
		const tab2 = ( await freshStore( { sameBus: true } ) ).store;
		await tab1.fetchCart(); // reads skip the lock (fetchCart is not a write)
		await tab2.fetchCart();
		const all = Promise.all( [ tab1.changeQuantity( 'a', 1 ), tab2.addItem( { id: 3, quantity: 1 }, { openDrawer: false } ), tab2.changeQuantity( 'b', 2 ) ] );
		ok( await settles( all ), 'every promise settles' );
		ok( srv.maxInFlight === 1, `server never sees two writes at once across tabs (max ${ srv.maxInFlight })` );
		ok( lines( srv.cart ) === 'a=2,b=3,k3=1', `server cart is a=2,b=3,k3=1 (got ${ lines( srv.cart ) })` );
	} finally {
		setLocks( undefined );
	}
} );

await scenario( 'whenIdle and enqueue', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 150 } );
	const { store } = await freshStore();
	ok( typeof store.whenIdle === 'function' && typeof store.enqueue === 'function', 'store exports whenIdle and enqueue' );
	if ( typeof store.whenIdle !== 'function' ) return;
	await store.fetchCart();
	store.changeQuantity( 'a', 1 ); // debounced: not queued yet
	const foreign = store.enqueue( async () => { await sleep( 100 ); return 'done'; } );
	await store.whenIdle();
	ok( lines( srv.cart ) === 'a=2', `whenIdle resolves after the debounced write landed (server ${ lines( srv.cart ) })` );
	ok( ( await foreign ) === 'done', 'enqueue resolves with the call\'s result' );
	const failing = store.enqueue( async () => { throw new Error( 'boom' ); } );
	ok( await failing.then( () => false, e => e.message === 'boom' ), 'enqueue rejects with the call\'s error' );
} );

await scenario( 'a lock that is never granted: the turn runs without it after the wait limit', () => scaledTime( async () => {
	// A lock held by a suspended tab: never granted, honours the abort signal.
	setLocks( fakeLocks( ( job, { signal } ) => new Promise( ( _, reject ) => signal?.addEventListener( 'abort', () => reject( signal.reason ) ) ) ) );
	try {
		const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ] );
		const { store } = await freshStore();
		ok( await settles( store.fetchCart(), 2000 ), 'fetchCart settles (reads take no lock)' );
		ok( await settles( store.changeQuantity( 'a', 1 ), 3000 ), 'the change settles' );
		ok( lines( srv.cart ) === 'a=2', `server cart is a=2 (got ${ lines( srv.cart ) })` );
	} finally {
		setLocks( undefined );
	}
} ) );

await scenario( 'a refused lock (SecurityError): the turn runs without it', async () => {
	setLocks( fakeLocks( () => Promise.reject( new DOMException( 'denied', 'SecurityError' ) ) ) );
	try {
		const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ] );
		const { store } = await freshStore();
		await store.fetchCart();
		ok( await settles( store.addItem( { id: 2, quantity: 1 }, { openDrawer: false } ) ), 'the add settles' );
		ok( lines( srv.cart ) === 'a=1,k2=1', `server cart is a=1,k2=1 (got ${ lines( srv.cart ) })` );
	} finally {
		setLocks( undefined );
	}
} );

await scenario( 'fetchCart takes no lock; writes do', async () => {
	const locks = fakeLocks( ( job ) => job( {} ) );
	setLocks( locks );
	try {
		fakeServer( [ { key: 'a', id: 1, quantity: 1 } ] );
		const { store } = await freshStore();
		await store.fetchCart();
		ok( locks.requests === 0, `fetchCart requested no lock (got ${ locks.requests })` );
		await store.addItem( { id: 2, quantity: 1 }, { openDrawer: false } );
		ok( locks.requests === 1, `the add requested the lock (got ${ locks.requests })` );
	} finally {
		setLocks( undefined );
	}
} );

await scenario( 'a write cut off by the timeout but finished by the server is seen, and nothing overlaps it', () => scaledTime( async () => {
	// Timeout 400 ms; the server needs 500 ms for the update and still saves it.
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: ( r ) => r === 'cart/update-item' ? 500 : 30 } );
	const { store, errors } = await freshStore();
	await store.fetchCart();
	const p1 = store.changeQuantity( 'a', 1 );
	await sleep( 450 ); // the update is on the wire
	const p2 = store.addItem( { id: 2, quantity: 1 }, { openDrawer: false } );
	ok( await settles( Promise.all( [ p1, p2 ] ), 4000 ), 'both promises settle' );
	ok( errors.length === 1 && errors[ 0 ].code === 'request_timeout', `one request_timeout error (got ${ errors.map( e => e.code ) })` );
	ok( srv.maxInFlight === 1, `nothing overlapped the still-running write (max ${ srv.maxInFlight })` );
	ok( lines( srv.cart ) === 'a=2,k2=1', `server cart is a=2,k2=1 (got ${ lines( srv.cart ) })` );
	ok( lines( store.getState().items ) === 'a=2,k2=1', `state shows the write that landed (got ${ lines( store.getState().items ) })` );
} ) );

await scenario( 'a pending +/- on a line that is gone: an error, and the real cart', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 }, { key: 'b', id: 2, quantity: 1 } ] );
	const { store, errors } = await freshStore();
	await store.fetchCart();
	const p = store.changeQuantity( 'a', 1 );
	srv.cart = [ { key: 'b', id: 2, quantity: 1 } ]; // another tab removed the line
	const p2 = store.addItem( { id: 3, quantity: 1 }, { openDrawer: false } ); // its answer shows the line gone
	ok( await settles( Promise.all( [ p, p2 ] ) ), 'promises settle' );
	ok( errors.length === 1, `one error event (got ${ errors.length })` );
	ok( lines( store.getState().items ) === 'b=1,k3=1', `state is the server cart b=1,k3=1 (got ${ lines( store.getState().items ) })` );
} );

await scenario( 'enqueue: the default limit releases the turn; timeout Infinity holds it', () => scaledTime( async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 30 } );
	const { store } = await freshStore();
	if ( typeof store.enqueue !== 'function' ) return ok( false, 'store exports enqueue' );
	await store.fetchCart();
	let end = 0;
	store.enqueue( () => sleep( 800 ).then( () => { end = Date.now(); } ), { timeout: Infinity } );
	await settles( store.addItem( { id: 2, quantity: 1 }, { openDrawer: false } ) );
	const add = srv.log.find( e => e.route === 'cart/add-item' );
	ok( end && add.start >= end, 'with timeout Infinity the add waited for the call (an order submit)' );
	const t0 = Date.now();
	store.enqueue( () => new Promise( () => {} ) ); // never settles
	ok( await settles( store.addItem( { id: 3, quantity: 1 }, { openDrawer: false } ), 2000 ), 'with the default limit a never-settling call releases the turn' );
	ok( Date.now() - t0 < 1500, `released at the (scaled) 20 s limit (${ Date.now() - t0 } ms)` );
} ) );

// ── Classic pages bridge (modules/classic-pages.js) ─────────────────────────
//
// A fake jQuery that follows jquery.js 3.7.1's $.ajax where the bridge depends on it: options merged
// without undefined values, prefilters, $.active and the global events, beforeSend, the timeout option
// (started before the transport sends), the XHR transport sending through `settings.xhr()` (by default
// `new window.XMLHttpRequest()`) and detaching its handlers before it aborts the XHR, abort → done( 0 ),
// readyState 0/1/4, status and headers, and $( fn ) after DOM ready. Its XMLHttpRequest works on the
// same fake session: a classic request reads
// the cart when it starts and saves its copy when it ends (update_order_review's calculate_totals →
// set_session), and the server finishes even when the browser has aborted. The cart form post applies
// its quantities only with an update_cart field, as WC_Form_Handler::update_cart_action does; a
// successful order empties the cart. Stand-ins for checkout.js and cart.js do what those do, including
// checkout.js's update at DOM ready (initCheckout) and cart.js swapping in a fresh, unblocked form.

function fakeDeferred() {
	let state = 'pending';
	let ctx;
	let args = [];
	const cbs = { resolved: [], rejected: [] };
	const add = ( s ) => function ( ...fns ) {
		for ( const fn of fns.flat() ) {
			if ( ! fn ) continue;
			if ( state === s ) fn.apply( ctx, args );
			else if ( state === 'pending' ) cbs[ s ].push( fn );
		}
		return this;
	};
	const fire = ( s ) => ( c, a = [] ) => {
		if ( state !== 'pending' ) return;
		state = s;
		ctx = c;
		args = a;
		cbs[ s ].forEach( fn => fn.apply( ctx, args ) );
	};
	const promise = {
		done: add( 'resolved' ),
		fail: add( 'rejected' ),
		always( ...fns ) { this.done( ...fns ); return this.fail( ...fns ); },
		then( ok, ko ) {
			return new Promise( ( res, rej ) => {
				this.done( ( ...a ) => res( ok ? ok( ...a ) : a[ 0 ] ) );
				this.fail( ( ...a ) => ko ? res( ko( ...a ) ) : rej( a[ 0 ] ) );
			} );
		},
		state: () => state,
		promise( target ) { return Object.assign( target || {}, promise ); },
	};
	return { ...promise, resolveWith: fire( 'resolved' ), rejectWith: fire( 'rejected' ) };
}

// An element with a classList whose changes reach MutationObservers.
function fakeElement( props = {} ) {
	const classes = new Set();
	const observers = [];
	const notify = () => observers.forEach( fn => queueMicrotask( fn ) );
	return { ...props, observers, classList: {
		contains: ( c ) => classes.has( c ),
		add( c ) { classes.add( c ); notify(); },
		remove( c ) { classes.delete( c ); notify(); },
	} };
}
globalThis.MutationObserver = class {
	constructor( fn ) { this.fn = fn; }
	observe( el ) { el.observers.push( this.fn ); }
};

const CART_URL = 'https://shop.test/handlekurv/';
const UOR = 'https://shop.test/?wc-ajax=update_order_review';
const SUBMIT = 'https://shop.test/?wc-ajax=checkout';
const NONCE = 'woocommerce-cart-nonce=n';

// page: 'checkout' | 'cart' | 'empty-cart' | other. Options per request (route, entry): latency → ms,
// fail → true (submit: result failure; others: HTTP 500), hang → never answers. Page: drawer → the page
// has Lean Cart markup; initCheckout → checkout.js sends its update at DOM ready (jq.ready()). keepCart → a
// successful submit leaves the cart (a gateway's 3-D Secure step: the cart empties once it is paid).
function fakeJQuery( srv, page, { latency = () => 50, fail = () => false, hang = () => false, drawer = true, initCheckout = false, keepCart = false } = {} ) {
	const handlers = {};
	const triggers = [];  // events triggered on document.body
	const globals = [];   // jQuery's global ajax events: { name, jq, data, t }
	const removed = [];
	const blocks = [];    // selectors blockUI was called on
	const prefilters = [];
	const fire = ( name, args = [] ) => ( handlers[ name ] || [] ).slice().forEach( fn => fn( { type: name }, ...args ) );
	const checkoutForm = page === 'checkout' ? fakeElement() : null;
	const dom = { 'form.checkout': checkoutForm, '.woocommerce-cart-form': page === 'cart' ? fakeElement( { qty: {}, hidden: false } ) : null,
		'.wc-empty-cart-message': page === 'empty-cart' ? {} : null, '[data-lean-cart]': drawer ? {} : null };
	let readyList = [];

	const $ = ( sel ) => {
		if ( typeof sel === 'function' ) {
			readyList ? readyList.push( sel ) : setTimeout( sel );
			return;
		}
		const el = typeof sel === 'string' && sel.startsWith( '.woocommerce-cart-form' ) ? dom[ '.woocommerce-cart-form' ] : null;
		const wrap = {
			length: el ? 1 : 0,
			trigger( name ) { triggers.push( name ); fire( name ); return wrap; },
			on( name, fn ) { ( handlers[ name ] ||= [] ).push( fn ); return wrap; },
			remove() { removed.push( sel ); if ( el && sel.includes( 'update_cart' ) ) el.hidden = false; return wrap; },
			not( s ) { return el?.classList.contains( s.slice( 1 ) ) ? $( null ) : wrap; },
			addClass( c ) { el?.classList.add( c ); return wrap; },
			block() { blocks.push( sel ); return wrap; },
		};
		return wrap;
	};
	$.fn = { block() {} };
	// DOM ready: the handlers run in the order they were added, one task each.
	const ready = () => {
		readyList?.forEach( fn => setTimeout( fn ) );
		readyList = null;
	};
	$.Deferred = fakeDeferred;
	$.active = 0;
	$.ajaxPrefilter = ( fn ) => prefilters.push( fn );

	class FakeXHR extends EventTarget {
		readyState = 0; status = 0; statusText = ''; responseText = '';
		onload = null; onerror = null; onabort = null;
		open( type, url ) { this.url = url; this.readyState = 1; }
		getAllResponseHeaders() { return this.readyState === 4 ? 'content-type: application/json; charset=UTF-8\r\n' : ''; }
		send( body ) {
			const route = 'classic:' + ( this.url.match( /wc-ajax=(\w+)/ )?.[ 1 ] || 'cart-page' );
			const entry = { route, url: this.url, data: new URLSearchParams( body || '' ), start: Date.now(), end: null };
			srv.log.push( entry );
			srv.maxInFlight = Math.max( srv.maxInFlight, ++srv.inFlight );
			const cart = structuredClone( srv.cart ); // session read at request start
			const coupons = [ ...srv.coupons ];
			( async () => {
				if ( hang( route, entry ) ) return;
				await sleep( latency( route, entry ) );
				srv.inFlight--;
				entry.end = Date.now();
				const failed = fail( route, entry );
				let reply = {};
				if ( route === 'classic:checkout' ) {
					reply = failed ? { result: 'failure', messages: '' } : { result: 'success', redirect: 'https://shop.test/kassen/order-received/1/' };
					if ( ! failed && ! keepCart ) srv.cart = []; // the order is placed
				} else if ( ! failed ) {
					for ( const [ k, v ] of entry.data ) {
						const line = entry.data.has( 'update_cart' ) && cart.find( i => `cart[${ i.key }][qty]` === k );
						if ( line ) line.quantity = Number( v );
					}
					const remove = new URL( this.url ).searchParams.get( 'remove_item' );
					if ( remove ) cart.splice( cart.findIndex( i => i.key === remove ), 1 );
					if ( route === 'classic:apply_coupon' ) coupons.push( entry.data.get( 'coupon_code' ) );
					srv.cart = cart; // session saved at request end, its older cart and all
					srv.coupons = coupons;
					reply = { items: cart };
				}
				if ( this.aborted ) return; // the browser dropped it; the server's work happened all the same
				Object.assign( this, { readyState: 4, status: failed && route !== 'classic:checkout' ? 500 : 200, statusText: 'OK', responseText: JSON.stringify( reply ) } );
				this.onload?.();
				this.dispatchEvent( new Event( 'loadend' ) );
			} )();
		}
		abort() {
			this.aborted = true;
			this.readyState = 0;
			this.onabort?.();
			this.dispatchEvent( new Event( 'loadend' ) );
		}
	}

	globalThis.XMLHttpRequest = FakeXHR;

	// jQuery's XHR transport (jquery.js 9822-9900).
	function xhrTransport( s ) {
		let callback;
		return {
			send( complete ) {
				const xhr = s.xhr();
				xhr.open( s.type, s.url );
				callback = ( type ) => () => {
					if ( ! callback ) return;
					callback = xhr.onload = xhr.onerror = xhr.onabort = null; // then the XHR's own abort (the prototype's)
					if ( type === 'abort' ) xhr.abort();
					else if ( type === 'error' ) complete( xhr.status, xhr.statusText );
					else complete( xhr.status, xhr.statusText, { text: xhr.responseText }, xhr.getAllResponseHeaders() );
				};
				xhr.onload = callback();
				xhr.onerror = xhr.onabort = callback( 'error' );
				callback = callback( 'abort' );
				xhr.send( s.data || null );
			},
			abort() { if ( callback ) callback(); },
		};
	}

	// jQuery.ajax (jquery.js 9180-9660), the parts the bridge meets.
	$.ajax = function ( url, options ) {
		const given = url && typeof url === 'object' ? url : { ...options, url };
		const s = { type: 'GET', async: true, global: true, timeout: 0, xhr: () => new window.XMLHttpRequest(), ...Object.fromEntries( Object.entries( given ).filter( ( [ , v ] ) => v !== undefined ) ) };
		s.url = String( s.url || location.href );
		if ( s.data && typeof s.data !== 'string' ) s.data = new URLSearchParams( s.data ).toString();
		const ctx = s.context || s;
		const dfd = fakeDeferred();
		const completes = [];
		let completed = null;
		let transport;
		let timeoutTimer;
		let strAbort = 'canceled';
		let headers = '';
		const jq = dfd.promise( {
			readyState: 0, status: 0, statusText: '',
			getResponseHeader( key ) { return completed ? headers.match( new RegExp( '^' + key + ':\\s*(.*?)\\r?$', 'im' ) )?.[ 1 ] ?? null : null; },
			getAllResponseHeaders() { return completed ? headers : null; },
			setRequestHeader() { return jq; },
			abort( text ) { transport?.abort(); done( 0, text || strAbort ); return jq; },
		} );
		const globalEvent = ( name ) => {
			if ( ! s.global ) return;
			globals.push( { name, jq, data: s.data, t: Date.now() } );
			fire( name, [ jq, s ] );
		};
		prefilters.forEach( fn => fn( s, given, jq ) );
		if ( s.global && $.active++ === 0 ) fire( 'ajaxStart' );
		s.type = s.type.toUpperCase();
		if ( /^(?:GET|HEAD)$/.test( s.type ) && s.data ) {
			s.url += ( s.url.includes( '?' ) ? '&' : '?' ) + s.data;
			delete s.data;
		}
		if ( s.beforeSend && s.beforeSend.call( ctx, jq, s ) === false ) return jq.abort();
		strAbort = 'abort';
		completes.push( ...[ s.complete ].flat().filter( Boolean ) );
		jq.done( s.success ).fail( s.error );
		transport = xhrTransport( s );
		jq.readyState = 1;
		globalEvent( 'ajaxSend' );
		if ( completed ) return jq;
		if ( s.async && s.timeout > 0 ) timeoutTimer = setTimeout( () => jq.abort( 'timeout' ), s.timeout );
		completed = false;
		transport.send( done );
		return jq;

		function done( status, nativeStatusText, responses, rawHeaders ) {
			if ( completed ) return;
			completed = true;
			clearTimeout( timeoutTimer );
			transport = undefined;
			headers = rawHeaders || '';
			jq.readyState = status > 0 ? 4 : 0;
			let ok = status >= 200 && status < 300;
			let statusText = nativeStatusText;
			let data;
			let error = statusText;
			if ( responses ) {
				jq.responseText = data = responses.text;
				if ( ok && s.dataType === 'json' ) {
					try {
						data = jq.responseJSON = JSON.parse( data );
					} catch ( e ) {
						ok = false;
						error = e;
					}
				}
			}
			if ( ok ) statusText = 'success';
			else if ( status || ! statusText ) statusText = 'error';
			jq.status = status;
			jq.statusText = nativeStatusText || statusText;
			if ( ok ) dfd.resolveWith( ctx, [ data, statusText, jq ] );
			else dfd.rejectWith( ctx, [ jq, statusText, error ] );
			globalEvent( ok ? 'ajaxSuccess' : 'ajaxError' );
			completes.forEach( fn => fn.call( ctx, jq, statusText ) );
			if ( s.global ) {
				globalEvent( 'ajaxComplete' );
				if ( ! --$.active ) fire( 'ajaxStop' );
			}
		}
	};

	// checkout.js: update_checkout → update_checkout_action 5 ms later, which aborts the previous
	// update_order_review and keeps the new one in wc_checkout_form.xhr; submit; submit_error.
	const checkout = { xhr: null, placed: false };
	if ( checkoutForm && initCheckout ) $( () => $( document.body ).trigger( 'update_checkout' ) );
	if ( checkoutForm ) {
		$( document.body ).on( 'update_checkout', () => setTimeout( () => {
			checkout.xhr?.abort();
			checkout.xhr = $.ajax( { type: 'POST', url: UOR, data: 'post_data=x', success: () => fire( 'updated_checkout' ) } );
		}, 5 ) );
		checkout.error = () => {
			checkoutForm.classList.remove( 'processing' );
			fire( 'checkout_error' );
		};
		checkout.submit = () => {
			if ( checkoutForm.classList.contains( 'processing' ) ) return;
			checkoutForm.classList.add( 'processing' );
			$.ajax( { type: 'POST', url: SUBMIT, data: 'billing_first_name=x', dataType: 'json',
				// Success: window.location = result.redirect, the form still processing.
				success: ( result ) => result.result === 'success' ? ( checkout.placed = true ) : checkout.error(),
				error: () => checkout.error() } );
		};
	}

	// cart.js: update_cart posts the form as rendered (no form on the empty-cart page: url and
	// method undefined, and update_wc_div reloads the page); "Update cart" adds the hidden
	// update_cart field first and is ignored while the form is blocked; update_wc_div swaps in the
	// answer's form, unblocked, and complete unblocks the form the request started from.
	// cart.form is the form on the page now.
	const cart = { reloads: 0, get form() { return dom[ '.woocommerce-cart-form' ]; } };
	if ( page === 'cart' || page === 'empty-cart' ) {
		const serialize = ( form ) => [ ...Object.entries( form.qty ).map( ( [ k, q ] ) => `cart[${ k }][qty]=${ q }` ), NONCE, ...( form.hidden ? [ 'update_cart=Update+Cart' ] : [] ) ].join( '&' );
		const updateWcDiv = ( html ) => {
			if ( ! cart.form ) {
				cart.reloads++;
				return;
			}
			dom[ '.woocommerce-cart-form' ] = fakeElement( { qty: Object.fromEntries( JSON.parse( html ).items.map( i => [ i.key, i.quantity ] ) ), hidden: false } );
		};
		cart.post = () => {
			const form = cart.form;
			form?.classList.add( 'processing' );
			$.ajax( { type: form ? 'post' : undefined, url: form ? CART_URL : undefined, data: form ? serialize( form ) : '', dataType: 'html',
				success: updateWcDiv, complete: () => form?.classList.remove( 'processing' ) } );
		};
		$( document.body ).on( 'wc_update_cart', cart.post );
		cart.updateCart = () => {
			if ( cart.form.classList.contains( 'processing' ) ) return false;
			cart.form.hidden = true;
			cart.post();
			return true;
		};
	}

	return { $, ready, triggers, globals, removed, blocks, dom, checkout, checkoutForm, cart };
}

// The page's globals and markup, as classicPage() reads them.
function setPage( { jQuery, checkout = false, cart = false, dom = {} } ) {
	window.jQuery = jQuery;
	window.wc_checkout_params = checkout ? {} : undefined;
	window.wc_cart_params = cart ? {} : undefined;
	document.querySelector = ( sel ) => sel.split( /,\s*/ ).map( s => dom[ s ] ).find( Boolean ) || null;
}
globalThis.location = { href: 'https://shop.test/kassen/' };
globalThis.CSS = { escape: String };
const bridgeUrl = () => pathToFileURL( path.join( jsDir, 'modules/classic-pages.js' ) ).href + '?run=' + run;
const { wait } = await import( pathToFileURL( path.join( jsDir, 'cart-api.js' ) ).href ); // the bridge's timeout helper, as cart-init passes it
// A page's location: reloads, replace() targets, and assignments to href (each a history entry).
function fakeLocation( href ) {
	const loc = { reloads: 0, replaced: [], assigned: [], reload() { loc.reloads++; }, replace( url ) { loc.replaced.push( url ); } };
	Object.defineProperty( loc, 'href', { get: () => href, set( v ) { loc.assigned.push( v ); }, enumerable: true } );
	return loc;
}

// A fresh store with the bridge on `page` (and the checkout lines where `before` put their mount, as
// cart-init starts them). `before( ctx, jq )` runs before the bridge loads; DOM ready comes after it,
// unless `before` made it come first (jq.ready()). `read`: init's option. `href`: the page's URL.
async function freshBridge( page, srv, jqOptions, { before, read, mnm, href } = {} ) {
	const ctx = await freshStore( { mnm } );
	const jq = fakeJQuery( srv, page, jqOptions );
	globalThis.location = fakeLocation( href || ( page === 'checkout' ? 'https://shop.test/kassen/' : CART_URL ) );
	setPage( { jQuery: jq.$, checkout: page === 'checkout', cart: page !== 'checkout', dom: jq.dom } );
	await before?.( ctx, jq );
	( await import( bridgeUrl() ) ).init( ctx.store, jq.$, { cartUrl: CART_URL, read, wait } );
	if ( jq.dom[ '[data-lean-cart="checkout-lines"]' ] ) {
		( await import( pathToFileURL( path.join( jsDir, 'modules/checkout-lines.js' ) ).href ) ).init( ctx.store, jq.$, await import( pathToFileURL( path.join( jsDir, 'cart-ui.js' ) ).href ) );
	}
	jq.ready();
	return { ...ctx, ...jq };
}
const during = ( srv, a ) => srv.log.filter( e => e !== a && e.start < ( a.end ?? Infinity ) && ( e.end ?? Infinity ) > a.start );
const after = ( srv, t ) => srv.log.filter( e => e.start >= t );
const field = ( e, k ) => typeof e.data?.get === 'function' ? e.data.get( k ) : e.data?.[ k ]; // classic form data or Store API body
const find = ( srv, route, n ) => srv.log.find( e => e.route === route && ( n === undefined || field( e, 'n' ) === n || field( e, 'key' ) === n ) );

await scenario( 'event source: optimistic, write, read', async () => {
	fakeServer( [ { key: 'a', id: 1, quantity: 1 } ] );
	const { store } = await freshStore();
	const sources = [];
	document.addEventListener( 'lean-cart:updated', e => sources.push( e.detail.source ) );
	await store.fetchCart();
	await store.addItem( { id: 2, quantity: 1 }, { openDrawer: false } );
	ok( sources.join( ' ' ) === 'read optimistic write', `fetch then add: read optimistic write (got ${ sources.join( ' ' ) })` );
} );

await scenario( 'bridge: page gating', async () => {
	const { store } = await freshStore();
	const { classicPage, init } = await import( bridgeUrl() );
	const jQuery = { fn: { block() {} } };
	const pages = [
		[ 'shortcode checkout', { jQuery, checkout: true, dom: { 'form.checkout': {} } }, 'checkout' ],
		[ 'classic cart page', { jQuery, cart: true, dom: { '.woocommerce-cart-form': {} } }, 'cart' ],
		[ 'empty classic cart page', { jQuery, cart: true, dom: { '.wc-empty-cart-message': {} } }, 'cart' ],
		[ 'Lean Checkout', { jQuery, checkout: true, dom: { 'form.lean-checkout-form': {} } }, null ],
		[ 'order-pay', { jQuery, checkout: true, dom: { 'form#order_review': {} } }, null ],
		[ 'block cart', { jQuery, dom: { '.wp-block-woocommerce-cart': {} } }, null ],
		[ 'cart form without cart.js', { jQuery, dom: { '.woocommerce-cart-form': {} } }, null ],
		[ 'checkout form without checkout.js', { jQuery, cart: true, dom: { 'form.checkout': {} } }, null ],
		[ 'no blockUI', { jQuery: { fn: {} }, checkout: true, dom: { 'form.checkout': {} } }, null ],
		[ 'no jQuery', { checkout: true, dom: { 'form.checkout': {} } }, null ],
	];
	for ( const [ name, setup, want ] of pages ) {
		setPage( setup );
		ok( classicPage() === want, `${ name }: ${ want } (got ${ classicPage() })` );
	}
	const { $ } = fakeJQuery( fakeServer( [] ), 'order-pay' );
	setPage( { jQuery: $, checkout: true, dom: { 'form#order_review': {} } } );
	const prefilter = $.ajaxPrefilter;
	let hooked = 0;
	$.ajaxPrefilter = ( fn ) => prefilter( fn, hooked++ );
	init( store, $, { cartUrl: CART_URL, wait } );
	ok( hooked === 0, `init on order-pay hooks nothing into jQuery (got ${ hooked })` );
} );

await scenario( 'bridge, checkout: update_order_review overlapping a drawer write keeps the change (bug 2)', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 300 } );
	const { store, $ } = await freshBridge( 'checkout', srv, { latency: () => 300 } );
	await store.fetchCart();
	store.changeQuantity( 'a', 1 );
	await sleep( 450 ); // update-item is on the wire
	$.ajax( { type: 'POST', url: UOR, data: 'n=1' } ); // an address change
	await sleep( 100 );
	await store.whenIdle();
	await sleep( 100 );
	await store.whenIdle();
	ok( srv.maxInFlight === 1, `drawer and classic requests never overlap (max ${ srv.maxInFlight })` );
	ok( lines( srv.cart ) === 'a=2', `server keeps the drawer change a=2 (got ${ lines( srv.cart ) })` );
} );

await scenario( 'bridge, checkout: a burst of drawer changes → one update_checkout → one re-read, no loop (bug 1)', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 }, { key: 'b', id: 2, quantity: 1 } ], { latency: () => 80 } );
	const { store, triggers } = await freshBridge( 'checkout', srv, { latency: () => 120 } );
	await store.fetchCart();
	const t0 = Date.now();
	store.changeQuantity( 'a', 1 );
	await sleep( 100 );
	store.changeQuantity( 'b', 1 );
	await sleep( 100 );
	store.changeQuantity( 'a', 1 );
	await sleep( 2000 ); // everything has settled, and would have looped by now
	const uor = srv.log.filter( e => e.route === 'classic:update_order_review' );
	ok( triggers.filter( t => t === 'update_checkout' ).length === 1, `one update_checkout (got ${ triggers.filter( t => t === 'update_checkout' ).length })` );
	ok( uor.length === 1 && after( srv, t0 ).filter( e => e.route === 'cart/update-item' ).every( w => w.end <= uor[ 0 ].start ), 'one update_order_review, after the drawer writes landed' );
	const reads = uor[ 0 ] ? after( srv, uor[ 0 ].end ).filter( e => e.route === 'cart' ) : [];
	ok( reads.length === 1, `one re-read after it (got ${ reads.length })` );
	ok( after( srv, ( reads[ 0 ]?.end ?? 0 ) + 1 ).length === 0, `nothing after the re-read (got ${ after( srv, ( reads[ 0 ]?.end ?? 0 ) + 1 ).map( e => e.route ) })` );
	ok( lines( srv.cart ) === 'a=3,b=2' && srv.maxInFlight === 1, `server a=3,b=2, no overlap (got ${ lines( srv.cart ) }, max ${ srv.maxInFlight })` );
} );

await scenario( 'bridge: callers keep jQuery\'s own jqXHR; Vipps\' readyState check passes once the update has settled (finding 1)', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 300 } );
	const { store, $, checkout } = await freshBridge( 'checkout', srv, { latency: () => 100 } );
	await store.fetchCart();
	// vipps-classic-checkout.js:505 refuses the order while this is true.
	const vippsWaits = () => !! ( checkout.xhr && checkout.xhr.readyState !== 4 );
	store.changeQuantity( 'a', 1 );
	await sleep( 450 ); // the drawer write is out; an address change's update queues behind it
	$( document.body ).trigger( 'update_checkout' );
	await sleep( 50 );
	ok( checkout.xhr?.readyState === 1 && vippsWaits(), `queued: readyState 1, Vipps waits (got ${ checkout.xhr?.readyState })` );
	await sleep( 1000 ); // the write lands, the queued update runs, the bridge's own refresh runs
	await store.whenIdle();
	const xhr = checkout.xhr;
	ok( xhr && ! vippsWaits(), `settled: readyState 4, Vipps may submit (got ${ xhr?.readyState })` );
	ok( xhr.status === 200 && xhr.statusText === 'OK' && JSON.parse( xhr.responseText ).items?.[ 0 ]?.quantity === 2,
		`status, statusText and responseText are the response's (got ${ xhr.status } ${ xhr.statusText } ${ xhr.responseText })` );
	ok( xhr.getResponseHeader( 'Content-Type' )?.startsWith( 'application/json' ) && /content-type/i.test( xhr.getAllResponseHeaders() ), `response headers readable (got ${ xhr.getResponseHeader?.( 'Content-Type' ) })` );
	ok( [ 'abort', 'done', 'fail', 'always', 'then', 'state' ].every( m => typeof xhr[ m ] === 'function' ) && xhr.state() === 'resolved', 'abort and the deferred methods, resolved' );
	// Aborted while queued: what jQuery gives an aborted request, to the error callback as well.
	let errorArg;
	const aborted = $.ajax( { type: 'POST', url: UOR, data: 'n=x', error: ( j ) => { errorArg = j; } } );
	aborted.abort();
	ok( aborted.readyState === 0 && aborted.status === 0 && aborted.statusText === 'abort' && errorArg === aborted, `aborted: readyState 0, status 0, statusText abort, error gets the same jqXHR (got ${ aborted.readyState } ${ aborted.status } ${ aborted.statusText })` );
	// Vipps' own submit: await $.ajax( { url: checkout_url, dataType: 'json' } ).
	const submit = $.ajax( { type: 'POST', url: SUBMIT, data: 'x=1', dataType: 'json' } );
	const result = await Promise.race( [ submit, sleep( 3000 ) ] );
	ok( result?.result === 'success' && submit.responseJSON?.result === 'success' && submit.readyState === 4, `the awaited submit resolves with the parsed answer (got ${ JSON.stringify( result ) })` );
} );

await scenario( 'bridge, cart page: Update cart → the drawer re-reads; a drawer change refreshes the form without posting stale quantities (bug 3)', async () => {
	let failNext = false;
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 60 } );
	const { store, cart, triggers } = await freshBridge( 'cart', srv, { latency: () => 120, fail: () => {
		const f = failNext;
		failNext = false;
		return f;
	} } );
	await store.fetchCart();
	cart.form.qty = { a: 5 }; // the shopper types 5 and presses Update cart
	cart.updateCart();
	await sleep( 300 );
	await store.whenIdle();
	ok( qty( store.getState(), 'a' ) === 5, `after Update cart the drawer shows 5 (got ${ qty( store.getState(), 'a' ) })` );
	cart.form.qty = { a: 2 }; // types 2; this Update cart fails and leaves its update_cart field in the form
	failNext = true;
	cart.updateCart();
	await sleep( 300 );
	await store.whenIdle();
	ok( cart.form.hidden && lines( srv.cart ) === 'a=5', `precondition: the failed Update cart left its field, server a=5 (got ${ cart.form.hidden } ${ lines( srv.cart ) })` );
	const refreshes = triggers.filter( t => t === 'wc_update_cart' ).length;
	store.changeQuantity( 'a', 1 ); // drawer +: 5 → 6
	await sleep( 100 );
	const pressed = cart.updateCart(); // Update cart again, with the stale 2
	await sleep( 800 );
	await store.whenIdle();
	await sleep( 100 );
	await store.whenIdle();
	ok( ! pressed, 'Update cart is ignored while the form is stale' );
	ok( lines( srv.cart ) === 'a=6', `the drawer-triggered refresh posts no stale quantity: server a=6 (got ${ lines( srv.cart ) })` );
	ok( cart.form.qty.a === 6 && qty( store.getState(), 'a' ) === 6, `page form and drawer both show 6 (got ${ cart.form.qty.a } / ${ qty( store.getState(), 'a' ) })` );
	ok( triggers.filter( t => t === 'wc_update_cart' ).length - refreshes === 1, 'one wc_update_cart for the drawer change' );
	ok( srv.maxInFlight === 1, `no overlap (max ${ srv.maxInFlight })` );
} );

await scenario( 'bridge, cart page: a coupon and the update_cart its callback starts → one re-read', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 60 } );
	const { store, $, cart } = await freshBridge( 'cart', srv, { latency: () => 120 } );
	await store.fetchCart();
	const n = srv.log.length;
	$.ajax( { type: 'POST', url: 'https://shop.test/?wc-ajax=apply_coupon', data: 'coupon_code=x', complete: cart.post } );
	await sleep( 500 );
	await store.whenIdle();
	ok( srv.log.slice( n ).map( e => e.route ).join( ' ' ) === 'classic:apply_coupon classic:cart-page cart', `coupon, form post, one re-read (got ${ srv.log.slice( n ).map( e => e.route ).join( ' ' ) })` );
	ok( store.getState().coupons.map( c => c.code ).join() === 'x', 'the drawer shows the coupon' );
} );

await scenario( 'bridge, empty cart page: a drawer add does not reload the page (finding 3)', async () => {
	const srv = fakeServer( [], { latency: () => 60 } );
	const { store, cart } = await freshBridge( 'empty-cart', srv );
	await store.fetchCart();
	await store.addItem( { id: 1, quantity: 1 }, { openDrawer: false } );
	await sleep( 400 );
	await store.whenIdle();
	ok( cart.reloads === 0 && lines( srv.cart ) === 'k1=1', `no reload, server k1=1 (got ${ cart.reloads } reloads, ${ lines( srv.cart ) })` );
} );

await scenario( 'bridge, cart page: only WooCommerce\'s own requests are queued (finding 4)', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 }, { key: 'b', id: 2, quantity: 1 } ], { latency: ( r ) => r === 'cart/update-item' ? 500 : 30 } );
	const { store, $ } = await freshBridge( 'cart', srv, { latency: () => 30 } );
	await store.fetchCart();
	store.changeQuantity( 'a', 1 );
	await sleep( 450 ); // the drawer write is out
	const requests = {
		'no url': [ false, { data: 'n=no-url' } ],
		'cart url, other data': [ false, { type: 'POST', url: CART_URL, data: 'n=other-post' } ],
		'cart url, GET': [ false, { url: CART_URL + '?n=other-get' } ],
		'another plugin\'s wc-ajax': [ false, { type: 'POST', url: 'https://shop.test/?wc-ajax=bwfan_insert_abandoned_cart', data: 'n=bwfan' } ],
		'remove link': [ true, { url: CART_URL + '?remove_item=b&_wpnonce=n&n=remove' } ],
		'cart form': [ true, { type: 'POST', url: CART_URL, data: `cart[a][qty]=1&${ NONCE }&n=form` } ],
		'shipping calculator': [ true, { type: 'POST', url: CART_URL, data: 'calc_shipping_country=NO&woocommerce-shipping-calculator-nonce=n&calc_shipping=x&n=calc' } ],
		'apply_coupon': [ true, { type: 'POST', url: 'https://shop.test/?wc-ajax=apply_coupon', data: 'coupon_code=y&n=coupon' } ],
	};
	for ( const [ , s ] of Object.values( requests ) ) $.ajax( { dataType: 'html', ...s } );
	await sleep( 800 );
	await store.whenIdle();
	const write = find( srv, 'cart/update-item' );
	for ( const [ name, [ queued, s ] ] of Object.entries( requests ) ) {
		const n = new URLSearchParams( s.data || s.url.split( '?' )[ 1 ] ).get( 'n' );
		const e = srv.log.find( x => field( x, 'n' ) === n || new URL( x.url || 'https://x/' ).searchParams.get( 'n' ) === n );
		ok( e && ( e.start >= write.end ) === queued, `${ name }: ${ queued ? 'queued' : 'not queued' }` );
	}
} );

await scenario( 'bridge, submit: waits for a pending drawer write and holds the queue; after the order nothing refreshes or re-reads (finding 2)', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 }, { key: 'b', id: 2, quantity: 1 } ], { latency: () => 80 } );
	const { store, checkout, checkoutForm, triggers } = await freshBridge( 'checkout', srv, { latency: ( r ) => r === 'classic:checkout' ? 400 : 60, keepCart: true } );
	await store.fetchCart();
	store.changeQuantity( 'a', 1 ); // debounced: not queued yet
	await sleep( 50 );
	checkout.submit(); // Place order inside the debounce window
	const clicked = triggers.length;
	await sleep( 600 ); // the submit is out
	store.changeQuantity( 'b', 1 ); // a drawer change while the order is placed
	await sleep( 1500 );
	await store.whenIdle();
	const submit = find( srv, 'classic:checkout' );
	const writeA = find( srv, 'cart/update-item', 'a' );
	const writeB = find( srv, 'cart/update-item', 'b' );
	ok( checkout.placed && writeA && submit?.start >= writeA.end, 'the submit left after the pending drawer write landed' );
	ok( submit && during( srv, submit ).length === 0, `no request while the submit was out (got ${ submit && during( srv, submit ).map( e => e.route ) })` );
	ok( writeB && writeB.start >= submit.end, 'a drawer change during the submit was sent after it' );
	ok( ! triggers.slice( clicked ).includes( 'update_checkout' ), `no update_checkout after Place order (got ${ triggers.slice( clicked ) })` );
	ok( submit && after( srv, submit.end ).map( e => e.route ).join( ' ' ) === 'cart/update-item', `after the order only the drawer's own change, no update_order_review or re-read (got ${ submit && after( srv, submit.end ).map( e => e.route ).join( ' ' ) })` );
	ok( lines( srv.cart ) === 'a=2,b=2', `the order's 3-D Secure step leaves the cart, with both changes (got ${ lines( srv.cart ) })` );
	// The gateway's 3-D Secure step fails and hands the form back: the page catches up.
	const t = Date.now();
	checkoutForm.classList.remove( 'processing' );
	await sleep( 500 );
	await store.whenIdle();
	ok( after( srv, t ).map( e => e.route ).join( ' ' ) === 'classic:update_order_review cart', `then one update_order_review and one re-read (got ${ after( srv, t ).map( e => e.route ).join( ' ' ) })` );
} );

await scenario( 'bridge, submit: a failed order releases the queue and the page catches up with the drawer', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 80 } );
	const { store, checkout } = await freshBridge( 'checkout', srv, { latency: ( r ) => r === 'classic:checkout' ? 300 : 60, fail: ( r ) => r === 'classic:checkout' } );
	await store.fetchCart();
	store.changeQuantity( 'a', 1 );
	await sleep( 50 );
	checkout.submit();
	await sleep( 1500 );
	await store.whenIdle();
	const submit = find( srv, 'classic:checkout' );
	ok( submit && after( srv, submit.end ).map( e => e.route ).join( ' ' ) === 'classic:update_order_review cart', `after it: one update_order_review, one re-read (got ${ submit && after( srv, submit.end ).map( e => e.route ).join( ' ' ) })` );
	ok( lines( store.getState().items ) === 'a=2' && lines( srv.cart ) === 'a=2', `drawer and server a=2 (got ${ lines( store.getState().items ) } / ${ lines( srv.cart ) })` );
	const t = Date.now();
	await settles( store.addItem( { id: 3, quantity: 1 }, { openDrawer: false } ), 3000 );
	ok( Date.now() - t < 1000 && srv.maxInFlight === 1, `the queue is free, no overlap (${ Date.now() - t } ms, max ${ srv.maxInFlight })` );
} );

await scenario( 'bridge, abort: a queued request is never sent; one aborted in flight holds its turn; jQuery\'s events fire at the abort, never later (finding 5)', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 60 } );
	const { store, $, globals } = await freshBridge( 'checkout', srv, { latency: () => 600 } );
	await store.fetchCart();
	const calls = [];
	const x1 = $.ajax( { type: 'POST', url: UOR, data: 'n=1', success: () => calls.push( 'success1' ), error: ( x, status ) => calls.push( 'error1:' + status ), complete: () => calls.push( 'complete1' ) } );
	const x2 = $.ajax( { type: 'POST', url: UOR, data: 'n=2', success: () => calls.push( 'success2' ) } );
	x2.abort();
	let failed = '';
	x1.fail( ( x, status ) => { failed = status; } );
	await sleep( 50 );
	x1.abort();
	const abortedAt = Date.now();
	store.changeQuantity( 'a', 1 );
	await sleep( 1500 );
	await store.whenIdle();
	const sent = srv.log.filter( e => e.route === 'classic:update_order_review' );
	const write = find( srv, 'cart/update-item' );
	ok( ! sent.some( e => e.data.get( 'n' ) === '2' ), 'the request aborted before its turn was never sent' );
	ok( write && write.start >= find( srv, 'classic:update_order_review', '1' ).end, 'the drawer write waited for the aborted request to finish on the server' );
	ok( calls.join( ' ' ) === 'error1:abort complete1' && failed === 'abort', `the abort settled the caller at once and muted the late answer (got ${ calls.join( ' ' ) } / ${ failed })` );
	const events = globals.filter( g => g.data === 'n=1' );
	ok( events.map( g => g.name ).join( ' ' ) === 'ajaxSend ajaxError ajaxComplete' && events.slice( 1 ).every( g => g.t - abortedAt < 20 ), `global events: ajaxSend, then ajaxError and ajaxComplete at the abort, nothing later (got ${ events.map( g => `${ g.name }@${ g.t - abortedAt }` ).join( ' ' ) })` );
	ok( lines( srv.cart ) === 'a=2' && srv.maxInFlight === 1, `server a=2, no overlap (got ${ lines( srv.cart ) }, max ${ srv.maxInFlight })` );
} );

await scenario( 'bridge: a slow classic request keeps its turn past 20 s; a dead one gives it up at the 65 s cap (finding 6)', () => scaledTime( async () => {
	// At 1/50 speed: a 40 s update_order_review takes 800 ms; the cap is 1300 ms.
	let dead = false;
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 30 } );
	const { store, $ } = await freshBridge( 'checkout', srv, { latency: () => 800, hang: () => dead } );
	await store.fetchCart();
	$.ajax( { type: 'POST', url: UOR, data: 'n=slow' } );
	await sleep( 50 );
	await settles( store.changeQuantity( 'a', 1 ), 3000 );
	ok( find( srv, 'cart/update-item' )?.start >= find( srv, 'classic:update_order_review', 'slow' ).end, 'the drawer write waited for the 40 s request' );
	dead = true;
	$.ajax( { type: 'POST', url: UOR, data: 'n=dead' } );
	await sleep( 50 );
	ok( await settles( store.changeQuantity( 'a', 1 ), 4000 ), 'a request that never answers does not hold the queue for ever' );
	const waited = srv.log.filter( e => e.route === 'cart/update-item' )[ 1 ]?.start - find( srv, 'classic:update_order_review', 'dead' ).start;
	ok( waited >= 1250 && waited < 1800, `it gives up its turn at the cap (${ waited } ms, scaled)` );
} ) );

await scenario( 'bridge: a request jQuery had out before the bridge loaded is waited for, and holds up nothing sent later', () => scaledTime( async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 30 } );
	const { store, $ } = await freshBridge( 'checkout', srv, { latency: ( r, e ) => e.data.get( 'n' ) === 'early' ? 600 : 50 }, {
		before: async ( { store }, { $ } ) => {
			await store.fetchCart();
			$.ajax( { type: 'POST', url: UOR, data: 'n=early' } ); // checkout.js's DOM-ready update_order_review
		},
	} );
	store.changeQuantity( 'a', 1 ); // would go at 400 ms, the early request still out
	await sleep( 100 );
	$.ajax( { type: 'POST', url: UOR, data: 'n=late' } ); // counted in $.active while it waits its turn
	await sleep( 1500 );
	await store.whenIdle();
	const early = find( srv, 'classic:update_order_review', 'early' );
	const late = find( srv, 'classic:update_order_review', 'late' );
	ok( find( srv, 'cart/update-item' )?.start >= early.end, 'the drawer write waited for the early request' );
	ok( late?.end && late.end - early.end < 400, `the later request went once the early one ended, not at the cap (${ late?.end - early.end } ms after)` );
	ok( srv.maxInFlight === 1, `no overlap (max ${ srv.maxInFlight })` );
} ) );

await scenario( 'bridge, cart page: the form an Update cart brings back stays blocked while a drawer change is pending (follow-up 1)', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 2 } ], { latency: () => 300 } );
	const { store, cart } = await freshBridge( 'cart', srv, { latency: () => 300 } );
	await store.fetchCart();
	cart.form.qty = { a: 3 };
	cart.updateCart(); // Update cart 2 → 3, out until 300 ms; cart.js has the form blocked
	await sleep( 60 );
	store.changeQuantity( 'a', 1 ); // drawer +: its write leaves at 460 ms, behind the re-read
	await sleep( 300 ); // 360 ms: cart.js has swapped in the answer's form, showing 3
	ok( cart.form.qty.a === 3 && cart.form.classList.contains( 'processing' ), `the form cart.js swapped in is blocked (got qty ${ cart.form.qty.a }, blocked ${ cart.form.classList.contains( 'processing' ) })` );
	await sleep( 400 ); // 760 ms: the drawer's write is out
	const pressed = cart.updateCart(); // Update cart (or Enter) with the stale 3
	await sleep( 1500 );
	await store.whenIdle();
	ok( ! pressed, 'Update cart is ignored while the drawer change is pending' );
	ok( lines( srv.cart ) === 'a=4' && qty( store.getState(), 'a' ) === 4 && cart.form.qty.a === 4, `server, drawer and form keep the drawer's 4 (got ${ lines( srv.cart ) } / ${ qty( store.getState(), 'a' ) } / ${ cart.form.qty.a })` );
	ok( ! cart.form.classList.contains( 'processing' ), 'the refreshed form is unblocked' );
	ok( srv.maxInFlight === 1, `no overlap (max ${ srv.maxInFlight })` );
} );

await scenario( 'bridge, cart page: a drawer + whose debounce fires while Update cart is out counts from the updated cart', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 2 } ], { latency: () => 300 } );
	const { store, cart } = await freshBridge( 'cart', srv, { latency: () => 500 } );
	await store.fetchCart();
	cart.form.qty = { a: 3 };
	cart.updateCart(); // Update cart 2 → 3, out until 500 ms
	await sleep( 65 );
	store.changeQuantity( 'a', 1 ); // its write takes its turn at 465 ms, behind the form post
	await sleep( 2500 );
	await store.whenIdle();
	await sleep( 100 );
	await store.whenIdle();
	const write = find( srv, 'cart/update-item' );
	ok( write && field( write, 'quantity' ) === 4, `the write sends 4, one above the updated 3 (got ${ write && field( write, 'quantity' ) })` );
	ok( lines( srv.cart ) === 'a=4' && qty( store.getState(), 'a' ) === 4 && cart.form.qty.a === 4, `server, drawer and form at 4 (got ${ lines( srv.cart ) } / ${ qty( store.getState(), 'a' ) } / ${ cart.form.qty.a })` );
	ok( srv.maxInFlight === 1, `no overlap (max ${ srv.maxInFlight })` );
} );

await scenario( 'bridge: a request out before the bridge loaded and aborted then keeps the queue until the server is done with it (follow-up 2)', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 30 } );
	let early;
	let nativeAbort;
	const { store, $ } = await freshBridge( 'checkout', srv, { latency: ( r, e ) => e.data.get( 'n' ) === 'early' ? 600 : 50 }, {
		before: async ( { store }, { $ } ) => {
			await store.fetchCart();
			nativeAbort = XMLHttpRequest.prototype.abort;
			early = $.ajax( { type: 'POST', url: UOR, data: 'n=early' } ); // checkout.js's DOM-ready update_order_review
		},
	} );
	await sleep( 50 );
	let other;
	$.ajax( { type: 'POST', url: 'https://shop.test/?wc-ajax=bwfan_insert_abandoned_cart', data: 'n=other', xhr: () => ( other = new XMLHttpRequest() ) } ).abort();
	ok( other.aborted, 'a request sent after the bridge loaded, aborted while the early one is out, really aborts' );
	early.abort(); // checkout.js's next update aborts it ...
	ok( early.state() === 'rejected' && early.statusText === 'abort', 'the caller sees the abort at once' );
	$.ajax( { type: 'POST', url: UOR, data: 'n=next' } ); // ... and sends its own
	store.changeQuantity( 'a', 1 );
	await sleep( 1500 );
	await store.whenIdle();
	const e = find( srv, 'classic:update_order_review', 'early' );
	const next = find( srv, 'classic:update_order_review', 'next' );
	const write = find( srv, 'cart/update-item' );
	ok( next?.start >= e.end && write?.start >= e.end, `the next update and the drawer write waited for the server to finish the aborted request (early ended ${ e.end - e.start } ms in; next at ${ next?.start - e.start }, write at ${ write?.start - e.start })` );
	ok( during( srv, e ).every( x => x.route === 'classic:bwfan_insert_abandoned_cart' ), `nothing queued overlapped it (got ${ during( srv, e ).map( x => x.route ) })` );
	ok( XMLHttpRequest.prototype.abort === nativeAbort, 'XMLHttpRequest.prototype.abort is restored once the wait is over' );
} );

await scenario( 'bridge: a caller\'s timeout counts from its turn, not while it waits for one (follow-up 3)', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: ( r ) => r === 'cart/update-item' ? 500 : 30 } );
	const { store, $ } = await freshBridge( 'checkout', srv, { latency: ( r, e ) => e.data.get( 'n' ) === 'slow' ? 400 : 60 } );
	await store.fetchCart();
	store.changeQuantity( 'a', 1 );
	await sleep( 450 ); // the drawer write is out for 500 ms
	const queued = $.ajax( { type: 'POST', url: UOR, data: 'n=queued', timeout: 300 } );
	await sleep( 900 );
	ok( queued.state() === 'resolved' && find( srv, 'classic:update_order_review', 'queued' ), `a request that waited past its timeout is sent and answered (got ${ queued.state() } ${ queued.statusText })` );
	await store.whenIdle();
	const slow = $.ajax( { type: 'POST', url: UOR, data: 'n=slow', timeout: 200 } );
	await sleep( 300 );
	ok( slow.statusText === 'timeout', `one that runs past its timeout once sent still times out (got ${ slow.statusText })` );
	await sleep( 300 );
	await store.whenIdle();
} );

await scenario( 'bridge, checkout page load: update_order_review goes first, then the drawer\'s one read (follow-up 4)', async () => {
	for ( const loaded of [ 'before DOM ready', 'after the update had ended' ] ) {
		const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 200 } );
		const { store, $ } = await freshBridge( 'checkout', srv, { latency: () => 200, initCheckout: true }, {
			read: true,
			before: loaded === 'before DOM ready' ? null : async ( ctx, jq ) => {
				jq.ready();
				await sleep( 400 );
			},
		} );
		await sleep( 900 );
		await store.whenIdle();
		ok( routes( srv ).join( ' ' ) === 'classic:update_order_review cart' && qty( store.getState(), 'a' ) === 1,
			`module loaded ${ loaded }: the update, then one read; the drawer has the cart (got ${ routes( srv ).join( ' ' ) })` );
		$( document.body ).trigger( 'update_checkout' ); // a later burst still re-reads once
		await sleep( 700 );
		await store.whenIdle();
		ok( routes( srv ).slice( 2 ).join( ' ' ) === 'classic:update_order_review cart', `then a later update, one re-read (got ${ routes( srv ).slice( 2 ).join( ' ' ) })` );
	}
} );

await scenario( 'bridge, a checkout page without Lean Cart markup (FunnelKit): no reads at all (follow-up 4)', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 60 } );
	const { store, $ } = await freshBridge( 'checkout', srv, { latency: () => 100, drawer: false, initCheckout: true }, { read: true } );
	await sleep( 400 );
	$( document.body ).trigger( 'update_checkout' );
	await sleep( 400 );
	await store.whenIdle();
	ok( routes( srv ).join( ' ' ) === 'classic:update_order_review classic:update_order_review', `two updates, no cart read (got ${ routes( srv ).join( ' ' ) })` );
} );

await scenario( 'bridge, cart page and other pages: init makes the first read when asked to', async () => {
	for ( const page of [ 'cart', 'order-pay' ] ) {
		const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 60 } );
		const { store } = await freshBridge( page, srv, {}, { read: true } );
		await sleep( 200 );
		await store.whenIdle();
		ok( routes( srv ).join( ' ' ) === 'cart' && qty( store.getState(), 'a' ) === 1, `${ page }: one read (got ${ routes( srv ).join( ' ' ) })` );
	}
} );

// ── Checkout lines (modules/checkout-lines.js) ──────────────────────────────

await scenario( 'checkout lines: a read with no lines leaves WooCommerce\'s rows showing', async () => {
	const srv = fakeServer( [], { latency: () => 60 } );
	const list = { innerHTML: '', children: [], setAttribute() {}, contains: () => false, addEventListener() {} };
	let root;
	await freshBridge( 'checkout', srv, { latency: () => 100, initCheckout: true }, {
		read: true,
		before: ( ctx, jq ) => {
			root = { hidden: true, querySelector: ( sel ) => sel.includes( 'checkout-items' ) ? list : null, closest: () => jq.checkoutForm };
			jq.dom[ '[data-lean-cart="checkout-lines"]' ] = root;
		},
	} );
	await sleep( 600 );
	ok( routes( srv ).includes( 'cart' ) && root.hidden, `after an empty read the mount is still hidden (read ${ routes( srv ).includes( 'cart' ) }, hidden ${ root.hidden })` );
} );

await scenario( 'checkout lines: where focus goes after a re-render', async () => {
	const { focusTarget } = await import( pathToFileURL( path.join( jsDir, 'cart-ui.js' ) ).href );
	const line = ( key, quantity, maximum = 9999 ) => ( { key, quantity, quantityLimits: { minimum: 1, maximum, multiple_of: 1 } } );
	const items = [ line( 'a', 2 ), line( 'b', 1 ), line( 'c', 3, 3 ) ];
	const cases = [
		[ 'the same control while it can take focus', { key: 'a', action: 'increase', index: 0 }, { key: 'a', action: 'increase' } ],
		[ '− at the minimum (disabled): the line\'s +', { key: 'b', action: 'decrease', index: 1 }, { key: 'b', action: 'increase' } ],
		[ '+ at the stock limit (disabled): the line\'s −', { key: 'c', action: 'increase', index: 2 }, { key: 'c', action: 'decrease' } ],
		[ 'the title link stays on the title', { key: 'b', action: 'title', index: 1 }, { key: 'b', action: 'title' } ],
		[ 'a removed line: the remove button of the line now in its place', { key: 'x', action: 'remove', index: 1 }, { key: 'b', action: 'remove' } ],
		[ 'the removed last line: the remove button of the line before', { key: 'x', action: 'remove', index: 3 }, { key: 'c', action: 'remove' } ],
	];
	for ( const [ name, had, want ] of cases ) {
		const got = focusTarget( had, items );
		ok( JSON.stringify( got ) === JSON.stringify( want ), `${ name } (got ${ JSON.stringify( got ) })` );
	}
	ok( focusTarget( { key: 'x', action: 'remove', index: 0 }, [] ) === null, 'no line left: null (the mount takes focus)' );
	const single = { key: 's', quantity: 1, quantityLimits: { minimum: 1, maximum: 1, multiple_of: 1 } };
	ok( focusTarget( { key: 's', action: 'remove', index: 0 }, [ single ] ).action === 'remove', 'a sold-individually line keeps focus on remove' );
} );

await scenario( 'checkout lines: shown once painted, totals marked updating on a change, a cross-tab read brings the totals in step once', async () => {
	// Before coupons 142,56 + 35,64 VAT; after a coupon 100 + 25.
	const totals = { line_subtotal: '14256', line_subtotal_tax: '3564', line_total: '10000', line_total_tax: '2500' };
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1, totals, children: [ { key: 'c1', id: 9, quantity: 2 } ] } ], { latency: () => 60 } );
	const clicks = [];
	const list = { innerHTML: '', children: [], setAttribute() {}, contains: () => false, addEventListener: ( t, fn ) => clicks.push( fn ) };
	const status = { textContent: '' };
	let root;
	const { store, triggers, blocks, checkoutForm } = await freshBridge( 'checkout', srv, { latency: () => 100, initCheckout: true }, {
		read: true,
		mnm: true,
		before: ( ctx, jq ) => {
			root = { hidden: true, querySelector: ( sel ) => sel.includes( 'checkout-items' ) ? list : status, closest: () => jq.checkoutForm };
			jq.dom[ '[data-lean-cart="checkout-lines"]' ] = root;
		},
	} );
	ok( root.hidden, 'hidden before the first read (WooCommerce\'s rows show)' );
	await sleep( 600 );
	await store.whenIdle();
	ok( ! root.hidden && /data-cart-item-key="a"/.test( list.innerHTML ) && /data-cart-item-key="c1"/.test( list.innerHTML ), `after the read: shown, the box and its contents rendered (hidden ${ root.hidden })` );
	ok( ( list.innerHTML.match( /type="button"/g ) || [] ).length === 3 && ! /<button(?![^>]*type="button")/.test( list.innerHTML ), 'every button is type="button" (the lines sit inside form.checkout)' );
	ok( ( list.innerHTML.match( /data-cart-action=/g ) || [] ).length === 3 && /cart-item--child" data-cart-item-key="c1"/.test( list.innerHTML ), 'the box contents are listed under the box, without controls of their own' );
	const price = list.innerHTML.match( /class="cart-item-price">([^<]*)</ )?.[ 1 ];
	ok( price === '178,20\u00a0kr', `the line shows its subtotal before coupons with both decimals, "178,20 kr" (got "${ price }")` );
	const before = triggers.filter( t => t === 'update_checkout' ).length;
	const blocked = blocks.length;
	// The shopper presses + on the box in the summary.
	const btn = { dataset: { cartAction: 'increase' } };
	const row = { dataset: { cartItemKey: 'a' }, querySelector: () => ( { textContent: 'a' } ) };
	btn.closest = () => row;
	clicks.forEach( fn => fn( { target: { closest: () => btn } } ) );
	store.changeQuantity( 'a', 1 );
	ok( blocks.slice( blocked ).includes( '.woocommerce-checkout-review-order-table' ), 'the change marks the classic totals as updating at once' );
	await sleep( 1200 );
	await store.whenIdle();
	ok( triggers.filter( t => t === 'update_checkout' ).length - before === 1, `one update_checkout for the change (got ${ triggers.filter( t => t === 'update_checkout' ).length - before })` );
	ok( status.textContent === 'a, antall 2', `screen reader status: "<name>, antall 2" (got "${ status.textContent }")` );
	// Another tab sets the box to 5; this tab's storage event re-reads.
	srv.cart[ 0 ].quantity = 5;
	const t = Date.now();
	await store.fetchCart();
	await sleep( 600 );
	await store.whenIdle();
	ok( after( srv, t ).map( e => e.route ).join( ' ' ) === 'cart classic:update_order_review cart', `the read, one update_order_review, one re-read, then quiet (got ${ after( srv, t ).map( e => e.route ).join( ' ' ) })` );
	// While an order is being placed, a changed read triggers nothing.
	checkoutForm.classList.add( 'processing' );
	srv.cart[ 0 ].quantity = 6;
	const n = triggers.length;
	await store.fetchCart();
	await sleep( 100 );
	ok( ! triggers.slice( n ).includes( 'update_checkout' ), 'not while the order is being placed' );
	checkoutForm.classList.remove( 'processing' );
	await sleep( 600 );
	await store.whenIdle();
} );


// A list element for the checkout lines and the drawer: parses the lines' markup enough for paintLines()
// (rows, their controls, focus). Each paint makes new elements, as innerHTML does.
function fakeList() {
	const list = { sets: 0, html: '', gen: 0, clicks: [], setAttribute() {}, addEventListener: ( t, fn ) => list.clicks.push( fn ) };
	let made = {};
	const make = ( id, props ) => made[ id ] ||= { owner: list, gen: list.gen, ...props };
	const row = ( key ) => make( 'row:' + key, { dataset: { cartItemKey: key }, querySelector: () => ( { textContent: key } ) } );
	const control = ( key, action ) => {
		const el = make( key + ':' + action, { dataset: action === 'title' ? {} : { cartAction: action }, focus() { document.activeElement = el; } } );
		el.closest = ( sel ) => sel === '[data-cart-item-key]' ? row( key ) : sel === '[data-cart-action]' && action !== 'title' ? el : null;
		return el;
	};
	Object.defineProperties( list, {
		innerHTML: { get: () => list.html, set( v ) { list.html = v; list.sets++; list.gen++; made = {}; } },
		children: { get: () => [ ...list.html.matchAll( /class="cart-item(?: cart-item--container)?" data-cart-item-key="([^"]+)"/g ) ].map( m => row( m[ 1 ] ) ) },
	} );
	list.contains = ( el ) => el?.owner === list;
	list.control = control;
	list.querySelector = ( sel ) => {
		const [ , key, what ] = sel.match( /data-cart-item-key="([^"]+)"\] (.+)$/ ) || [];
		const action = what === '.cart-item-title' ? 'title' : what?.match( /data-cart-action="(\w+)"/ )?.[ 1 ];
		return key && list.html.includes( `data-cart-item-key="${ key }"` ) ? control( key, action ) : null;
	};
	return list;
}

// The checkout lines' mount around `list`, put on the page before the bridge loads.
function mountLines( list, status = { textContent: '' } ) {
	const root = { hidden: true, focus() { document.activeElement = root; } };
	return { root, status, before: ( ctx, jq ) => {
		root.querySelector = ( sel ) => sel.includes( 'checkout-items' ) ? list : status;
		root.closest = () => jq.checkoutForm;
		jq.dom[ '[data-lean-cart="checkout-lines"]' ] = root;
	} };
}

await scenario( 'prices: whole amounts short, others with both decimals', async () => {
	const { store } = await freshStore();
	const got = [ 17900, 17820, 181320, 0, 5 ].map( store.formatPrice );
	ok( JSON.stringify( got ) === JSON.stringify( [ '179 kr', '178,20 kr', '1 813,20 kr', '0 kr', '0,05 kr' ] ), `179 kr, 178,20 kr, 1 813,20 kr, 0 kr, 0,05 kr (got ${ got.join( ' | ' ) })` );
} );

await scenario( 'checkout lines: focus after a repaint stays on the control used, and is never taken from outside the list', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 }, { key: 'b', id: 2, quantity: 1, totals: { line_subtotal: '100' } } ], { latency: () => 60 } );
	const list = fakeList();
	const { before } = mountLines( list );
	const { store } = await freshBridge( 'checkout', srv, { latency: () => 60, initCheckout: true }, { read: true, before } );
	await sleep( 400 );
	await store.whenIdle();
	// Focus on the summary's + of a, and + pressed.
	list.control( 'a', 'increase' ).focus();
	const pressed = document.activeElement;
	store.changeQuantity( 'a', 1 );
	ok( list.gen > pressed.gen && document.activeElement?.owner === list && document.activeElement.gen === list.gen && document.activeElement.dataset.cartAction === 'increase',
		`after the repaint focus is on the new + of the same line (gen ${ document.activeElement?.gen } of ${ list.gen }, ${ document.activeElement?.dataset?.cartAction })` );
	await sleep( 900 );
	await store.whenIdle();
	// Focus in the drawer, on its own + of a (a row with the same key): a summary repaint leaves it there.
	const drawerPlus = { dataset: { cartAction: 'increase' }, closest: () => ( { dataset: { cartItemKey: 'a' } } ), focus() {} };
	document.activeElement = drawerPlus;
	const sets = list.sets;
	store.changeQuantity( 'a', 1 );
	ok( list.sets > sets && document.activeElement === drawerPlus, `a summary repaint does not take focus from the drawer (repainted ${ list.sets > sets }, focus kept ${ document.activeElement === drawerPlus })` );
	await sleep( 900 );
	await store.whenIdle();
	// A read that changes nothing does not repaint (focus and screen readers left alone).
	const quiet = list.sets;
	await store.fetchCart();
	ok( list.sets === quiet, `an unchanged read does not repaint (${ list.sets - quiet } repaints)` );
} );

await scenario( 'checkout lines: a failed remove is not announced as removed; a press during the order does nothing', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 }, { key: 'b', id: 2, quantity: 1 } ], { latency: () => 60, fail: ( r ) => r === 'cart/remove-item' ? 500 : null } );
	const list = fakeList();
	const { before, status } = mountLines( list );
	const { store, checkoutForm } = await freshBridge( 'checkout', srv, { latency: () => 60, initCheckout: true }, { read: true, before } );
	await sleep( 400 );
	await store.whenIdle();
	const remove = list.control( 'a', 'remove' );
	list.clicks.forEach( fn => fn( { target: remove } ) );
	await store.removeItem( 'a' );
	await store.whenIdle();
	ok( qty( store.getState(), 'a' ) === 1 && ! /fjernet/.test( status.textContent ), `the line is back and the status does not say it was removed (got "${ status.textContent }")` );
	// Enter on a focused summary + while the order is being placed: the click goes no further.
	checkoutForm.classList.add( 'processing' );
	let stopped = 0;
	list.clicks.forEach( fn => fn( { target: list.control( 'a', 'increase' ), preventDefault: () => stopped++, stopPropagation: () => stopped++ } ) );
	ok( stopped === 2, `the press is cancelled and stopped before the cart's click handler (${ stopped } of 2)` );
	checkoutForm.classList.remove( 'processing' );
	await sleep( 300 );
	await store.whenIdle();
} );

await scenario( 'checkout: a change that empties the cart goes to the cart page; not during an order', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 60 } );
	const { store, checkoutForm } = await freshBridge( 'checkout', srv, { latency: () => 60, initCheckout: true }, { read: true } );
	await sleep( 400 );
	await store.whenIdle();
	const t = Date.now();
	await store.removeItem( 'a' );
	await sleep( 300 );
	await store.whenIdle();
	ok( location.replaced.join( ' ' ) === CART_URL, `the cart page replaces the checkout, once (got ${ location.replaced.join( ' ' ) || 'none' })` );
	ok( ! after( srv, t ).some( e => e.route === 'classic:update_order_review' ), `no update_order_review after the emptying change (got ${ after( srv, t ).map( e => e.route ).join( ' ' ) })` );
	// During an order: no reload until the order has failed and the form is handed back.
	srv.cart = [ { key: 'b', id: 2, quantity: 1 } ];
	await store.fetchCart();
	checkoutForm.classList.add( 'processing' );
	await store.removeItem( 'b' );
	await sleep( 300 );
	await store.whenIdle();
	ok( location.replaced.length === 1, `none while the order is being placed (got ${ location.replaced.length - 1 })` );
	checkoutForm.classList.remove( 'processing' );
	await sleep( 100 );
	ok( location.replaced.length === 2, `then one, once it has failed (got ${ location.replaced.length - 1 })` );
} );

await scenario( 'checkout from /kassen/?add-to-cart=: removing the last line lands on the cart page, without re-running the URL', async () => {
	const srv = fakeServer( [ { key: 'k5', id: 5, quantity: 1 } ], { latency: () => 60 } );
	const list = fakeList();
	const { before } = mountLines( list );
	const { store } = await freshBridge( 'checkout', srv, { latency: () => 60, initCheckout: true }, { read: true, before, href: 'https://shop.test/kassen/?add-to-cart=5' } );
	await sleep( 400 );
	await store.whenIdle();
	await store.removeItem( 'k5' );
	await sleep( 300 );
	await store.whenIdle();
	ok( location.replaced.join( ' ' ) === CART_URL && location.reloads === 0 && location.assigned.length === 0,
		`location.replace( the cart page ), no reload (it re-sends ?add-to-cart=) and no history entry (replaced ${ location.replaced.join( ' ' ) || 'none' }, ${ location.reloads } reloads, assigned ${ location.assigned.join( ' ' ) || 'none' })` );
} );

await scenario( 'checkout: a read that finds the cart emptied elsewhere (another tab, an order placed there) goes to the cart page', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 60, fail: ( r, d, s ) => r === 'cart/remove-item' && s.refuseRemove ? 500 : null } );
	const list = fakeList();
	const { before } = mountLines( list );
	const { store, checkoutForm } = await freshBridge( 'checkout', srv, { latency: () => 60, initCheckout: true }, { read: true, before } );
	const refill = async () => {
		srv.cart = [ { key: 'a', id: 1, quantity: 1 } ];
		await store.fetchCart();
		await sleep( 300 );
		await store.whenIdle();
		location.replaced.length = 0;
	};
	await sleep( 400 );
	await store.whenIdle();
	srv.cart = [];
	let t = Date.now();
	await store.fetchCart();
	await sleep( 100 );
	ok( location.replaced.join( ' ' ) === CART_URL && location.reloads === 0, `location.replace( the cart page ) (got ${ location.replaced.join( ' ' ) || 'none' }, ${ location.reloads } reloads)` );
	ok( ! after( srv, t ).some( e => e.route === 'classic:update_order_review' ), `no update_order_review, which would answer "session expired" (got ${ after( srv, t ).map( e => e.route ).join( ' ' ) })` );
	// While an order is being placed here, it waits for the form to be handed back.
	await refill();
	checkoutForm.classList.add( 'processing' );
	srv.cart = [];
	await store.fetchCart();
	await sleep( 100 );
	ok( location.replaced.length === 0, `not while the order is being placed (got ${ location.replaced.length })` );
	checkoutForm.classList.remove( 'processing' );
	await sleep( 100 );
	ok( location.replaced.join( ' ' ) === CART_URL, `then, once the form is handed back (got ${ location.replaced.join( ' ' ) || 'none' })` );
	// A read that answers while a remove of the last line is pending shows no lines; the remove fails: stay.
	await refill();
	srv.refuseRemove = true;
	const read = store.fetchCart();
	store.removeItem( 'a' ).catch( () => {} );
	await read;
	await sleep( 300 );
	await store.whenIdle();
	ok( location.replaced.length === 0 && qty( store.getState(), 'a' ) === 1, `a read under a pending remove that then fails: no leaving (got ${ location.replaced.join( ' ' ) || 'none' }, a=${ qty( store.getState(), 'a' ) })` );
} );

await scenario( 'checkout lines: a read that changes the lines on every refresh triggers one refresh, not a loop', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: ( r, d, s ) => ( r === 'cart' && s.drift && s.cart[ 0 ].quantity++, 60 ) } );
	const list = fakeList();
	const { before } = mountLines( list );
	const { store } = await freshBridge( 'checkout', srv, { latency: () => 60, initCheckout: true }, { read: true, before } );
	await sleep( 400 );
	await store.whenIdle();
	srv.cart[ 0 ].quantity = 5; // another tab ...
	srv.drift = true; // ... and from now on every read shows another quantity
	const t = Date.now();
	await store.fetchCart();
	await sleep( 1500 );
	await store.whenIdle();
	const uor = after( srv, t ).filter( e => e.route === 'classic:update_order_review' ).length;
	ok( uor === 1, `one update_order_review (got ${ uor }: ${ after( srv, t ).map( e => e.route ).join( ' ' ) })` );
} );

await scenario( 'bridge, cart page: when the in-turn re-read fails, the change is sent from the cart the store has, without the write-timeout wait', () => scaledTime( async () => {
	let reads = 0;
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 2 } ], { latency: () => 30, hang: ( r ) => r === 'cart' && srv.armed && ! reads++ } );
	const { store, cart } = await freshBridge( 'cart', srv, { latency: () => 600 } );
	await store.fetchCart();
	srv.armed = true; // the next cart read never answers (times out at 400 ms, scaled)
	cart.form.qty = { a: 3 };
	cart.updateCart(); // Update cart 2 → 3, out until 600 ms: the store's cart is outdated after it
	await sleep( 30 );
	store.changeQuantity( 'a', 1 ); // its write is queued at 430 ms, behind the post: its re-read is the next read
	await sleep( 1500 );
	await store.whenIdle();
	const read = srv.log.find( e => e.route === 'cart' && e.start > find( srv, 'classic:cart-page' ).start );
	const write = find( srv, 'cart/update-item' );
	ok( write && field( write, 'quantity' ) === 3, `the change is sent, counted from the store's cart (2 + 1) as before 0.2.3 (got ${ write && field( write, 'quantity' ) })` );
	ok( write && read?.end && write.start - read.end < 150, `it leaves right after the failed read, not after the 10 s write settle (${ write && read?.end ? write.start - read.end : '?' } ms, scaled settle 200)` );
	ok( srv.maxInFlight === 1, `no overlap (max ${ srv.maxInFlight })` );
} ) );

await scenario( 'markup: product text is escaped for attributes too', async () => {
	const { esc, renderItem } = await import( pathToFileURL( path.join( jsDir, 'cart-ui.js' ) ).href );
	ok( esc( `a"b'c<d>&` ) === 'a&quot;b&#39;c&lt;d&gt;&amp;', `esc() escapes quotes, tags and ampersands (got ${ esc( `a"b'c<d>&` ) })` );
	const title = 'Te" onfocus="alert(1)';
	const html = renderItem( { key: 'k', title, image: { src: 'x.jpg', alt: title }, permalink: 'https://shop.test/p"q', metaRows: [], badges: [], children: [], quantity: 1,
		quantityLimits: { minimum: 1, maximum: 9 }, lineTotal: '1 kr' } );
	ok( ! html.includes( 'onfocus="' ) && ! html.includes( 'p"q' ), 'a name or URL with a quote cannot add an attribute' );
} );

await scenario( 'drawer: focus stays on the control used across a repaint; an error shows only where focus is', async () => {
	await freshStore();
	const items = fakeList();
	const errors = [ 'drawer', 'summary' ].map( name => ( { name, hidden: true, textContent: '' } ) );
	const regions = errors.map( el => ( { el, contains: ( a ) => a?.region === el.name } ) );
	errors.forEach( ( el, n ) => { el.closest = () => regions[ n ]; } );
	items.parentElement = { querySelector: () => null };
	document.querySelectorAll = ( sel ) => sel === '[data-lean-cart="items"]' ? [ items ] : sel === '[data-lean-cart="error"]' ? errors : [];
	const ui = await import( pathToFileURL( path.join( jsDir, 'cart-ui.js' ) ).href + '?run=' + run );
	ui.init();
	const line = ( quantity ) => ( { key: 'a', title: 'a', image: null, permalink: '', metaRows: [], badges: [], children: [], isChild: false, quantity, quantityLimits: { minimum: 1, maximum: 9 }, lineTotal: '1 kr' } );
	const update = ( quantity ) => document.dispatchEvent( new CustomEvent( 'lean-cart:updated', { detail: { state: { items: [ line( quantity ) ], itemCount: quantity, totals: {}, recurringTotals: [] }, source: 'optimistic' } } ) );
	update( 1 );
	items.control( 'a', 'increase' ).focus();
	update( 2 );
	ok( document.activeElement?.owner === items && document.activeElement.gen === items.gen && document.activeElement.dataset.cartAction === 'increase', `the drawer's new + has focus after the repaint (gen ${ document.activeElement?.gen } of ${ items.gen })` );
	document.activeElement = { region: 'summary' };
	document.dispatchEvent( new CustomEvent( 'lean-cart:error', { detail: { message: 'Bare 2 på lager' } } ) );
	ok( errors[ 1 ].textContent === 'Bare 2 på lager' && ! errors[ 1 ].hidden && errors[ 0 ].hidden && ! errors[ 0 ].textContent, `the summary's alert has it, the drawer's does not (drawer "${ errors[ 0 ].textContent }")` );
	document.activeElement = null;
	document.dispatchEvent( new CustomEvent( 'lean-cart:error', { detail: { message: 'x' } } ) );
	ok( errors.every( el => el.textContent === 'x' ), 'with focus in neither, both show it' );
	errors.forEach( el => clearTimeout( el._errorTimer ) );
} );

await scenario( 'seed: the cart the page was rendered with paints as a read, once, and the next change re-reads first', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 3 } ], { latency: () => 60 } );
	const { store, commits } = await freshStore();
	const sources = [];
	document.addEventListener( 'lean-cart:updated', e => sources.push( e.detail.source ) );
	store.seed( { items: [ { key: 'a', id: 1, name: 'a', quantity: 2, prices: { price: '100' }, totals: {} } ], totals: {} } );
	ok( qty( store.getState(), 'a' ) === 2 && sources.join( ' ' ) === 'read' && routes( srv ).length === 0, `state from the seed, published as one read, no request (got a=${ qty( store.getState(), 'a' ) }, ${ sources.join( ' ' ) }, ${ routes( srv ).join( ' ' ) })` );
	await store.changeQuantity( 'a', 1 );
	ok( routes( srv ).join( ' ' ) === 'cart cart/update-item' && field( find( srv, 'cart/update-item' ), 'quantity' ) === 4, `the change re-reads first and counts from the server's 3 (got ${ routes( srv ).join( ' ' ) }, sent ${ field( find( srv, 'cart/update-item' ), 'quantity' ) })` );
	const n = commits.length;
	store.seed( { items: [ { key: 'a', id: 1, name: 'a', quantity: 9, prices: {}, totals: {} } ], totals: {} } );
	ok( commits.length === n && qty( store.getState(), 'a' ) === 4, 'a seed after the store has a cart does nothing' );
} );

await scenario( 'seed: cart-init applies it after the extension modules\' normalizers (a Mix-and-Match box nests its contents)', async () => {
	fakeServer( [] );
	globalThis.document = new EventTarget();
	document.createElement = () => ( { set innerHTML( v ) { this.value = v; } } );
	document.cookie = '';
	document.querySelector = () => null;
	document.querySelectorAll = () => [];
	globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
	globalThis.addEventListener = () => {};
	window.jQuery = undefined;
	const raw = { items: [
		{ key: 'box', id: 1, name: 'box', quantity: 1, prices: { price: '100' }, totals: {}, extensions: { mix_and_match: { child_items: [ 'c1' ] } } },
		{ key: 'c1', id: 9, name: 'c1', quantity: 2, prices: { price: '0' }, totals: {}, extensions: { mix_and_match: { container: 'box' } } },
	], totals: {} };
	const config = window.leanCartConfig;
	window.leanCartConfig = { ...config, cartUrl: CART_URL, checkoutUrl: '', modules: { mixAndMatch: true }, cart: raw };
	try {
		await import( pathToFileURL( path.join( jsDir, 'cart-init.js' ) ).href );
		await sleep( 200 );
		const state = window.leanCart.store.getState();
		const box = state?.items.find( i => i.key === 'box' );
		ok( box?.children[ 0 ]?.key === 'c1' && state.items.length === 1, `the box carries c1, which is not a line of its own (box children ${ box?.children.map( c => c.key ) }, lines ${ state?.items.map( i => i.key ) })` );
	} finally {
		window.leanCartConfig = config;
	}
} );

// A module that fails to load, as a 404, a dropped connection or a content blocker makes it: a resolve hook
// sends the import of `modules/<name>.js` to a missing file when the importing module's URL carries
// ?broken=<name>, and passes the marker on to the rest of that module graph (fresh module instances).
register( 'data:text/javascript,' + encodeURIComponent( `export async function resolve( specifier, context, next ) {
	const broken = context.parentURL && new URL( context.parentURL ).searchParams.get( 'broken' );
	if ( ! broken ) return next( specifier, context );
	if ( specifier.endsWith( '/' + broken + '.js' ) || specifier.endsWith( '/' + broken ) ) return { url: 'file:///nonexistent/' + broken + '.js', shortCircuit: true };
	const resolved = await next( specifier, context );
	return resolved.url.startsWith( 'file:' ) ? { ...resolved, url: resolved.url.split( '?' )[ 0 ] + '?broken=' + broken } : resolved;
}` ) );

await scenario( 'the bridge and the checkout lines import nothing themselves (a dynamic import of a module with imports resolves after the checkout\'s DOM-ready scripts)', async () => {
	for ( const name of [ 'classic-pages', 'checkout-lines' ] ) {
		const src = readFileSync( path.join( jsDir, 'modules', name + '.js' ), 'utf8' );
		ok( ! /^\s*import\b|\bimport\s*\(\s*['"`]/m.test( src ), `${ name }.js has no import` );
	}
} );

await scenario( 'cart-init starts the checkout lines once the bridge runs; a classic-page module that fails to load leaves the drawer working, and without the lines module the bridge runs on', async () => {
	const config = window.leanCartConfig;
	for ( const broken of [ 'none', 'classic-pages', 'checkout-lines' ] ) {
		const when = broken === 'none' ? 'every module loads' : broken + '.js fails to load';
		const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], { latency: () => 30 } );
		globalThis.document = new EventTarget();
		document.createElement = () => ( { set innerHTML( v ) { this.value = v; } } );
		document.cookie = 'wp_woocommerce_session_x=1';
		document.querySelectorAll = () => [];
		globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
		globalThis.addEventListener = () => {};
		const jq = fakeJQuery( srv, 'checkout' );
		let prefilters = 0;
		const prefilter = jq.$.ajaxPrefilter;
		jq.$.ajaxPrefilter = ( fn ) => prefilter( fn, prefilters++ );
		document.activeElement = null;
		const list = fakeList();
		mountLines( list ).before( null, jq );
		globalThis.location = fakeLocation( 'https://shop.test/kassen/' );
		setPage( { jQuery: jq.$, checkout: true, dom: jq.dom } );
		window.leanCart = undefined;
		window.leanCartConfig = { ...config, cartUrl: CART_URL, checkoutUrl: '', modules: {} };
		try {
			await import( pathToFileURL( path.join( jsDir, 'cart-init.js' ) ).href + '?broken=' + broken );
			jq.ready();
			await sleep( 300 );
			const store = window.leanCart?.store;
			ok( !! store, `${ when }: cart-init still runs (window.leanCart ${ store ? 'set' : 'missing' })` );
			await store?.whenIdle();
			ok( qty( store?.getState(), 'a' ) === 1, `${ when }: the drawer has the cart (got ${ JSON.stringify( store?.getState()?.items.map( i => i.key ) ) })` );
			await store?.changeQuantity( 'a', 1 );
			ok( lines( srv.cart ) === 'a=2', `${ when }: a drawer change is sent (server ${ lines( srv.cart ) })` );
			ok( ( prefilters === 1 ) === ( broken !== 'classic-pages' ), `${ when }: the bridge ${ broken === 'classic-pages' ? 'is not' : 'is' } queueing WooCommerce's requests (${ prefilters } prefilters)` );
			// The lines only with the bridge: their changes leave the totals blocked until its refresh.
			ok( /data-cart-item-key="a"/.test( list.html ) === ( broken === 'none' ), `${ when }: the checkout lines ${ broken === 'none' ? 'show' : 'do not start' } (${ list.sets } paints)` );
		} finally {
			window.leanCartConfig = config;
		}
	}
} );

console.log( failed ? `\n${ failed } check(s) failed` : '\nall checks passed' );
process.exit( failed ? 1 : 0 );
