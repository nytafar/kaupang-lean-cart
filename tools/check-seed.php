<?php
/**
 * Self-check for the shortcode checkout's cart seed (Lean_Cart_Hooks::cart_seed()):
 * the classic checkout computes, shows and saves the same with it as without it.
 *
 *   wp eval-file wp-content/plugins/kaupang-lean-cart/tools/check-seed.php
 *
 * A guest cart of two shippable products, built in memory and never saved (the
 * session's save at shutdown is unhooked; no add-to-cart hooks run), calculated
 * as the shortcode does. Shipping methods may be quoted live (Bring). Run it on
 * WooCommerce 10.x and 11.x: before 11.1 WooCommerce restores neither the cart
 * context nor, when the route throws an \Error, the notices and nonce check.
 * Exits non-zero on failure.
 */

defined( 'ABSPATH' ) || exit;

$fail = function ( string $msg ) {
	WP_CLI::error( $msg );
};

if ( ! method_exists( 'Lean_Cart_Hooks', 'cart_seed' ) ) {
	$fail( 'Lean_Cart_Hooks::cart_seed() not loaded.' );
}

WC()->frontend_includes();
wc_load_cart();
remove_action( 'shutdown', [ WC()->session, 'save_data' ], 20 );

$products = array_slice( array_filter(
	wc_get_products( [ 'type' => 'simple', 'status' => 'publish', 'stock_status' => 'instock', 'limit' => 30 ] ),
	fn( $p ) => $p->is_purchasable() && $p->needs_shipping() && ! $p->is_sold_individually()
), 0, 2 );
if ( count( $products ) < 2 ) {
	$fail( 'Needs two purchasable, shippable simple products in stock.' );
}
$contents = [];
foreach ( $products as $product ) {
	$key              = WC()->cart->generate_cart_id( $product->get_id() );
	$contents[ $key ] = [ 'key' => $key, 'product_id' => $product->get_id(), 'variation_id' => 0, 'variation' => [], 'quantity' => 1,
		'data' => $product, 'data_hash' => wc_get_cart_item_data_hash( $product ) ];
}
WC()->cart->set_cart_contents( $contents );
WC()->customer->set_shipping_country( 'NO' );
WC()->customer->set_shipping_postcode( '0150' );
WC()->customer->set_billing_country( 'NO' );

// The cases where WooCommerce's block mode differs from the shortcode's: a pickup
// rate listed first (block mode defaults to the first other rate) and "hide
// shipping costs until an address is entered" (block mode hides delivery rates).
add_filter( 'pre_option_woocommerce_shipping_cost_requires_address', fn() => 'yes' );
add_filter( 'woocommerce_package_rates', fn( $rates ) => [ 'local_pickup:9999' => new WC_Shipping_Rate( 'local_pickup:9999', 'Hent selv', 0, [], 'local_pickup', 9999 ) ] + $rates );

// What the classic checkout computes, shows or saves.
$snapshot = function () {
	return [
		'session'   => ( fn() => $this->_data )->call( WC()->session ),
		'totals'    => WC()->cart->get_totals(),
		'context'   => WC()->cart->cart_context,
		'packages'  => array_map( fn( $p ) => array_map( fn( $r ) => $r->get_cost(), $p['rates'] ?? [] ), WC()->shipping()->get_packages() ),
		'nonce off' => apply_filters( 'woocommerce_store_api_disable_nonce_check', false ),
	];
};
$same = function ( array $without, array $with, string $case ) use ( $fail ) {
	foreach ( $without as $what => $value ) {
		if ( $value !== $with[ $what ] ) {
			$fail( "$case: the seed changed the $what:\n" . wp_json_encode( [ 'without' => $value, 'with' => $with[ $what ] ], JSON_PRETTY_PRINT ) );
		}
	}
};

// 1. A cart nothing has calculated yet: no seed, and the read calculates nothing.
$calculated = $GLOBALS['wp_actions']['woocommerce_after_calculate_totals'] ?? 0;
unset( $GLOBALS['wp_actions']['woocommerce_after_calculate_totals'] );
$without = $snapshot();
$seed    = Lean_Cart_Hooks::cart_seed();
$same( $without, $snapshot(), 'Uncalculated cart' );
if ( null !== $seed || did_action( 'woocommerce_after_calculate_totals' ) ) {
	$fail( 'Uncalculated cart: the seed read it, or calculated it (in block mode).' );
}
$GLOBALS['wp_actions']['woocommerce_after_calculate_totals'] = $calculated;

// 2. As the shortcode renders it (WC_Shortcode_Checkout::checkout()), with a notice waiting.
do_action( 'woocommerce_check_cart_items' );
WC()->cart->calculate_totals();
wc_add_notice( 'lean-cart-check', 'notice' );
$without = $snapshot();
if ( empty( $without['packages'] ) || ! isset( $without['session']['chosen_shipping_methods'] ) ) {
	$fail( 'The cart has no shipping package or chosen method to compare.' );
}
$seed = Lean_Cart_Hooks::cart_seed();
$same( $without, $snapshot(), 'Calculated cart' );
if ( ! $seed || count( $seed['items'] ) !== 2 ) {
	$fail( 'Calculated cart: no seed with both lines: ' . wp_json_encode( $seed ) );
}
$lines = count( $seed['items'] );
$keys = array_keys( $seed );
sort( $keys );
if ( [ 'coupons', 'extensions', 'items', 'needs_shipping', 'shipping_rates', 'totals' ] !== $keys ) {
	$fail( 'The seed carries more than the store reads: ' . implode( ', ', $keys ) );
}
$extra = array_diff( array_keys( $seed['items'][0] ), [ 'key', 'id', 'type', 'name', 'quantity', 'quantity_limits', 'permalink', 'variation', 'item_data', 'extensions', 'prices', 'totals', 'images' ] );
if ( $extra || array_keys( $seed['items'][0]['prices'] ) !== [ 'price' ] || count( $seed['items'][0]['images'] ) > 1 ) {
	$fail( 'A seed line carries more than the store reads: ' . wp_json_encode( $seed['items'][0] ) );
}
// The calculated cart has a chosen method, so the drawer can tell a rate from "not calculated yet".
$rates = array_merge( ...array_column( $seed['shipping_rates'], 'shipping_rates' ) );
if ( ! $rates || array_diff( array_merge( ...array_map( 'array_keys', $rates ) ), [ 'selected' ] ) || ! in_array( true, array_column( $rates, 'selected' ), true ) ) {
	$fail( 'The seed\'s shipping rates are not only `selected`, with one selected: ' . wp_json_encode( $seed['shipping_rates'] ) );
}

// 3. The route throws an \Error (not an \Exception, which WooCommerce catches).
$throw = function () {
	throw new \Error( 'lean-cart-check' );
};
add_action( 'woocommerce_store_api_cart_errors', $throw );
$without = $snapshot();
$seed    = Lean_Cart_Hooks::cart_seed();
remove_action( 'woocommerce_store_api_cart_errors', $throw );
$same( $without, $snapshot(), 'Route throwing an \Error' );
if ( null !== $seed ) {
	$fail( 'Route throwing an \Error: a seed anyway.' );
}

wc_clear_notices();
WP_CLI::success( sprintf( 'Seed: %d lines; session, totals, cart context, shipping and nonce check as without it (WooCommerce %s).', $lines, WC()->version ) );
