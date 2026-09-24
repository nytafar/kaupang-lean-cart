<?php
/**
 * WooCommerce integration hooks.
 *
 * Disables legacy cart fragments and wires up the custom hook
 * registry that developers can use to extend the cart.
 */

defined( 'ABSPATH' ) || exit;

class Lean_Cart_Hooks {

	public function __construct() {
		add_action( 'wp_enqueue_scripts', [ $this, 'disable_legacy_fragments' ], 20 );
		add_filter( 'woocommerce_cart_fragment_refresh', '__return_false' );
		add_filter( 'rest_post_dispatch', [ $this, 'sync_cart_cookies' ], 10, 3 );
	}

	/**
	 * Re-set the cart cookies once a Store API request has finished.
	 *
	 * Core sets them on woocommerce_add_to_cart, before totals are calculated,
	 * so woocommerce_cart_hash comes out different from the hash every later
	 * page load writes for the same cart; update-item and remove-item set no
	 * cookies at all. Lean Cart keys its count snapshot on that hash, so it
	 * must match. By rest_post_dispatch the response (and its totals) is built
	 * and headers are not yet sent; core dedupes the Set-Cookie headers.
	 *
	 * @param WP_HTTP_Response $response
	 * @param WP_REST_Server   $server
	 * @param WP_REST_Request  $request
	 */
	public function sync_cart_cookies( $response, $server, $request ) {
		if ( str_starts_with( $request->get_route(), '/wc/store/' ) && function_exists( 'WC' ) && WC()->cart ) {
			WC()->cart->maybe_set_cart_cookies();
		}
		return $response;
	}

	/**
	 * Dequeue the legacy wc-cart-fragments script.
	 *
	 * This system sends PHP-rendered HTML blobs via AJAX and holds
	 * a PHP session lock that blocks concurrent WP requests.
	 * Replaced entirely by Store API JSON fetches.
	 */
	public function disable_legacy_fragments(): void {
		wp_dequeue_script( 'wc-cart-fragments' );
	}
}
