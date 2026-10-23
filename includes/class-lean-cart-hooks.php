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
		add_action( 'woocommerce_checkout_order_review', [ $this, 'print_checkout_lines' ], 5 );
		add_filter( 'kaupang/lean-cart/config', [ $this, 'seed_checkout_cart' ] );
	}

	/**
	 * Whether the shortcode checkout's order review gets Lean Cart's lines: the
	 * checkout page, not its endpoints (order-pay, order-received), not a
	 * FunnelKit checkout (its own layout and summary), and the filter on.
	 */
	private function checkout_lines(): bool {
		if ( ! is_checkout() || is_wc_endpoint_url() || ( function_exists( 'wfacp_template' ) && wfacp_template() ) ) {
			return false;
		}

		/**
		 * Filter: kaupang/lean-cart/checkout_lines
		 *
		 * Return false to keep WooCommerce's own item rows in the classic
		 * checkout's order review instead of Lean Cart's editable lines.
		 *
		 * @param bool $enabled Default true.
		 */
		return (bool) apply_filters( 'kaupang/lean-cart/checkout_lines', true );
	}

	/**
	 * Give the checkout lines the cart in the page (leanCartConfig.cart), so
	 * they paint with the page instead of after the first cart read, seconds
	 * in. WooCommerce's own hydration, as its block checkout does: a Store API
	 * GET of the cart run in-process, with extensions' hydration hooks
	 * (Mix-and-Match), nonce check off for the GET only, and the session's
	 * notices set aside and put back, so the page shows none twice.
	 *
	 * ponytail: the shortcode in the page content only, not WooCommerce's
	 * "classic shortcode" block; that page keeps painting after the first read.
	 *
	 * @param array $config Lean Cart's JS config.
	 */
	public function seed_checkout_cart( $config ) {
		$hydration = 'Automattic\WooCommerce\Blocks\Domain\Services\Hydration';
		if ( ! $this->checkout_lines() || ! wc_post_content_has_shortcode( 'woocommerce_checkout' ) || ! WC()->cart || WC()->cart->is_empty()
			|| ! class_exists( $hydration ) || ! class_exists( 'Automattic\WooCommerce\Blocks\Package' ) ) {
			return $config;
		}
		try {
			$cart = \Automattic\WooCommerce\Blocks\Package::container()->get( $hydration )->get_rest_api_response_data( '/wc/store/v1/cart' )['body'] ?? null;
		} catch ( \Throwable $e ) {
			$cart = null; // no seed: the lines paint after the first read, as without one
		}
		if ( is_array( $cart ) && ! empty( $cart['items'] ) ) {
			foreach ( $cart['items'] as &$item ) {
				unset( $item['description'], $item['short_description'] ); // unused by the lines, most of the page weight
			}
			unset( $item );
			$config['cart'] = $cart;
		}
		return $config;
	}

	/**
	 * Mount for Lean Cart's item lines in the shortcode checkout's order review.
	 *
	 * Printed before the review table (woocommerce_order_review runs at 10),
	 * outside the fragment update_order_review replaces. Hidden until
	 * modules/checkout-lines.js has shown lines in it; until then, and if the
	 * JS never runs, WooCommerce's own rows are the summary. Not on FunnelKit
	 * checkout pages, which fire this hook in their own layout and have their
	 * own order summary.
	 */
	public function print_checkout_lines(): void {
		if ( ! $this->checkout_lines() ) {
			return;
		}

		// The two rules that make the mount a state, here rather than in
		// lean-cart.css so they hold with kaupang/lean-cart/disable_styles too
		// (else WooCommerce's rows and Lean Cart's lines both show). !important:
		// themes lay these rows out with long selectors.
		echo '<style>.lean-cart--checkout[hidden]{display:none!important}'
			. '.lean-cart--checkout:not([hidden])~.woocommerce-checkout-review-order-table :is(thead,tr.cart_item){display:none!important}</style>';
		echo '<div class="lean-cart lean-cart--checkout" data-lean-cart="checkout-lines" tabindex="-1" hidden>'
			. '<div data-lean-cart="checkout-items" role="list"></div>'
			. '<div data-lean-cart="error" role="alert" hidden></div>'
			. '<div class="screen-reader-text" data-lean-cart="checkout-status" role="status"></div>'
			. '</div>';
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
