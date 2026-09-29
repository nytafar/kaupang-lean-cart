<?php
/**
 * Self-check for the page-cache-safe notices module.
 *
 *   wp eval-file wp-content/plugins/kaupang-lean-cart/tools/check-notices.php
 *
 * Exits non-zero on failure.
 */

defined( 'ABSPATH' ) || exit;

$fail = function ( string $msg ) {
	WP_CLI::error( $msg );
};

if ( ! class_exists( 'Lean_Cart_Notices' ) ) {
	$fail( 'Lean_Cart_Notices not loaded.' );
}

// WP-CLI doesn't boot the frontend session; notices need one.
WC()->frontend_includes();
WC()->initialize_session();
wc_clear_notices();

$notices = new Lean_Cart_Notices();
$hook    = 'woocommerce_before_single_product';

// Live page: WooCommerce's printer stays.
add_filter( 'kaupang/lean-cart/live_notices', '__return_true' );
$notices->wrap_notices();
if ( false === has_action( $hook, 'woocommerce_output_all_notices' ) ) {
	$fail( 'Live page lost woocommerce_output_all_notices.' );
}
remove_filter( 'kaupang/lean-cart/live_notices', '__return_true' );

// Cacheable page: swapped for the <noscript> printer at the same priority.
add_filter( 'kaupang/lean-cart/live_notices', '__return_false' );
$notices->wrap_notices();
if ( false !== has_action( $hook, 'woocommerce_output_all_notices' ) ) {
	$fail( 'Cacheable page still prints live notices.' );
}
if ( 10 !== has_action( $hook, [ $notices, 'output_noscript_notices' ] ) ) {
	$fail( 'Noscript printer not attached at priority 10.' );
}

// The printer wraps the whole notices block in <noscript>.
wc_add_notice( 'lean-cart-check', 'success' );
ob_start();
$notices->output_noscript_notices();
$html = ob_get_clean();
if ( ! preg_match( '#^<noscript><div class="woocommerce-notices-wrapper">.*lean-cart-check.*</div></noscript>$#s', $html ) ) {
	$fail( "Unexpected noscript output:\n" . $html );
}

wc_clear_notices();
WP_CLI::success( 'Notices: live on cart/checkout/account/POST, <noscript> elsewhere.' );
