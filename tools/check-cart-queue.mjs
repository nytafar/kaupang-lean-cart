/**
 * Check: cart writes are serialised and the store commits the server's truth.
 *
 * Drives the real cart-store.js + cart-api.js against a fake Store API that
 * behaves like WooCommerce's cart session: each request reads the cart when it
 * starts and saves the whole cart when it ends, so overlapping writes lose
 * updates. Latency is set per request. Exits non-zero on any failure.
 *
 *   node tools/check-cart-queue.mjs [dir-with-cart-store.js]
 *
 * Node 18+ (structuredClone, fetch Response, CustomEvent), no dependencies.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const jsDir = path.resolve( process.argv[ 2 ] || path.join( path.dirname( fileURLToPath( import.meta.url ) ), '../assets/js' ) );
const sleep = ( ms ) => new Promise( r => setTimeout( r, ms ) );
const timeout = ( p, ms ) => Promise.race( [ p.then( () => true ), sleep( ms ).then( () => false ) ] );

globalThis.window = globalThis;
window.leanCartConfig = {
	storeApiBase: 'https://shop.test/wp-json/wc/store/v1/',
	nonce: 'n',
	currency: { locale: 'nb-NO', code: 'NOK', minorUnit: 2 },
};

// ── Fake Store API with WooCommerce's read-modify-write session ─────────────

function fakeServer( items, { latency = () => 50, fail = () => null } = {} ) {
	const srv = { cart: items, inFlight: 0, maxInFlight: 0, gets: 0 };
	const raw = ( cart ) => ( {
		items: cart.map( i => ( { key: i.key, id: i.id, name: i.key, quantity: i.quantity, prices: { price: '100' }, totals: {} } ) ),
		coupons: [], totals: {},
	} );
	const reply = ( status, body ) => new Response( JSON.stringify( body ), { status, headers: { Nonce: 'n' } } );

	globalThis.fetch = async ( url, { method = 'GET', body } = {} ) => {
		const route = url.slice( window.leanCartConfig.storeApiBase.length );
		const data = body ? JSON.parse( body ) : {};
		const isWrite = method !== 'GET';
		if ( ! isWrite ) srv.gets++;
		if ( isWrite ) srv.maxInFlight = Math.max( srv.maxInFlight, ++srv.inFlight );
		const cart = structuredClone( srv.cart ); // session read at request start
		await sleep( latency( route, data ) );
		if ( isWrite ) srv.inFlight--;
		const failure = fail( route, data );
		if ( failure ) return reply( failure, { code: 'fail', message: 'fail', data: failure === 409 ? { cart: raw( srv.cart ) } : {} } );
		if ( route === 'cart/add-item' ) {
			const key = 'k' + data.id + ( data.variation?.length ? 'v' + data.variation[ 0 ].value : '' );
			const line = cart.find( i => i.key === key );
			line ? ( line.quantity += data.quantity ) : cart.push( { key, id: data.id, quantity: data.quantity } );
		} else if ( route === 'cart/update-item' ) {
			cart.find( i => i.key === data.key ).quantity = data.quantity;
		} else if ( route === 'cart/remove-item' ) {
			cart.splice( cart.findIndex( i => i.key === data.key ), 1 );
		}
		if ( isWrite ) srv.cart = cart; // session saved at request end
		return reply( 200, raw( cart ) );
	};
	return srv;
}

// ── Harness ─────────────────────────────────────────────────────────────────

let run = 0;
let failed = 0;
const qty = ( cart, key ) => cart?.items.find( i => i.key === key )?.quantity ?? 0;
const lines = ( items ) => items.map( i => `${ i.key }=${ i.quantity }` ).sort().join( ',' );

function ok( cond, label ) {
	console.log( `${ cond ? 'ok  ' : 'FAIL' } ${ label }` );
	if ( ! cond ) failed++;
}

// Fresh store module (fresh state) and a fresh event bus per scenario.
async function freshStore() {
	globalThis.document = new EventTarget();
	document.createElement = () => ( { set innerHTML( v ) { this.value = v; } } );
	const store = await import( pathToFileURL( path.join( jsDir, 'cart-store.js' ) ).href + '?run=' + ++run );
	const commits = [];
	document.addEventListener( 'lean-cart:updated', e => commits.push( e.detail.state ) );
	return { store, commits };
}

async function scenario( name, fn ) {
	console.log( `# ${ name }` );
	await fn();
	await sleep( 600 ); // let stragglers of a broken store die before the next fake server
}

// ── Scenarios ───────────────────────────────────────────────────────────────

// D-121: line at 2, `+` twice, then add a variation while the quantity write is in flight.
await scenario( 'D-121: + + then add a variation', async () => {
	const srv = fakeServer( [ { key: 'k10714', id: 10714, quantity: 2 } ], { latency: () => 300 } );
	const { store, commits } = await freshStore();
	await store.fetchCart();
	const p1 = store.changeQuantity( 'k10714', 1 );
	await sleep( 50 );
	const p2 = store.changeQuantity( 'k10714', 1 );
	await sleep( 500 ); // the debounced update-item is now on the wire
	const p3 = store.addItem( { id: 10, quantity: 1, variation: [ { attribute: 'attribute_pa_x', value: 'a' } ] }, { openDrawer: false } );
	const settled = await timeout( Promise.all( [ p1, p2, p3 ] ), 3000 );
	ok( settled, 'every promise settles (incl. the superseded changeQuantity)' );
	ok( srv.maxInFlight === 1, `server never sees two writes at once (max in flight ${ srv.maxInFlight })` );
	ok( lines( srv.cart ) === 'k10714=4,k10va=1', `server cart is k10714=4,k10va=1 (got ${ lines( srv.cart ) })` );
	ok( lines( store.getState().items ) === lines( srv.cart ), `state equals the server cart (got ${ lines( store.getState().items ) })` );
	const first4 = commits.findIndex( c => qty( c, 'k10714' ) === 4 );
	ok( first4 >= 0 && commits.slice( first4 ).every( c => qty( c, 'k10714' ) === 4 ), 'once shown at 4, no older response shows it lower' );
} );

// Mini-cart: rapid +/− on two lines, writes overlapping across keys.
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
	ok( await timeout( Promise.all( ps ), 3000 ), 'every promise settles' );
	ok( srv.maxInFlight === 1, `server never sees two writes at once (max in flight ${ srv.maxInFlight })` );
	ok( lines( srv.cart ) === 'a=5,b=2', `server cart is a=5,b=2 (got ${ lines( srv.cart ) })` );
	ok( lines( store.getState().items ) === lines( srv.cart ), `state equals the server cart (got ${ lines( store.getState().items ) })` );
} );

// A failed write rolls back to the server's real cart, not a snapshot that predates another op's success.
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
	ok( await timeout( Promise.all( [ p1, p2 ] ), 3000 ), 'every promise settles' );
	ok( lines( srv.cart ) === 'a=1,b=1,k3=1', `server cart is a=1,b=1,k3=1 (got ${ lines( srv.cart ) })` );
	ok( lines( store.getState().items ) === lines( srv.cart ), `state equals the server cart (got ${ lines( store.getState().items ) })` );
} );

await scenario( 'failed write with a 409 uses the cart in the error', async () => {
	const srv = fakeServer( [ { key: 'a', id: 1, quantity: 1 } ], {
		latency: () => 100,
		fail: ( r ) => r === 'cart/update-item' ? 409 : null,
	} );
	const { store } = await freshStore();
	await store.fetchCart();
	const gets = srv.gets;
	ok( await timeout( store.changeQuantity( 'a', 1 ), 3000 ), 'promise settles' );
	ok( qty( store.getState(), 'a' ) === 1, `state shows the server's quantity 1 (got ${ qty( store.getState(), 'a' ) })` );
	ok( srv.gets === gets, 'no extra fetch when the error carries the cart' );
} );

console.log( failed ? `\n${ failed } check(s) failed` : '\nall checks passed' );
process.exit( failed ? 1 : 0 );
