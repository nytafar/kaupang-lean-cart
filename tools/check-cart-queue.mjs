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
const realTimeout = AbortSignal.timeout.bind( AbortSignal );
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
			{ key: i.key, id: i.id, name: i.key, quantity: i.quantity, prices: { price: '100' }, totals: {},
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
		try {
			if ( hang( route, data, srv ) ) {
				await new Promise( ( _, reject ) => signal?.addEventListener( 'abort', () => reject( signal.reason ) ) );
			}
			await sleep( latency( route, data, srv ) );
		} finally {
			srv.inFlight--;
			entry.end = Date.now();
		}
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
		document.createElement = () => ( { set innerHTML( v ) { this.value = v; } } );
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
	setLocks( { request: ( name, job ) => { const turn = tail.then( () => job( { name } ) ); tail = turn.catch( () => {} ); return turn; } } );
	try {
		const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 }, { key: 'b', id: 2, quantity: 1 } ], { latency: () => 200 } );
		const tab1 = ( await freshStore() ).store;
		const tab2 = ( await freshStore( { sameBus: true } ) ).store;
		await Promise.all( [ tab1.fetchCart(), tab2.fetchCart() ] );
		const all = Promise.all( [ tab1.changeQuantity( 'a', 1 ), tab2.addItem( { id: 3, quantity: 1 }, { openDrawer: false } ), tab2.changeQuantity( 'b', 2 ) ] );
		ok( await settles( all ), 'every promise settles' );
		ok( srv.maxInFlight === 1, `server never sees two requests at once across tabs (max ${ srv.maxInFlight })` );
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

console.log( failed ? `\n${ failed } check(s) failed` : '\nall checks passed' );
process.exit( failed ? 1 : 0 );
