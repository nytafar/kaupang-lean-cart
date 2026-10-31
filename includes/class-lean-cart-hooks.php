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
	}

	/**
	 * Whether the shortcode checkout's order review gets Lean Cart's lines: the
	 * checkout page, not its endpoints (order-pay, order-received), not a
	 * FunnelKit checkout (its own layout and summary), and the filter on.
	 */
	public static function checkout_lines(): bool {
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
	 * Whether this page carries the cart for the checkout lines (the config's
	 * `cart`, added by Lean_Cart_Assets::module_data() when core prints the
	 * config in the footer, once the shortcode has calculated the cart).
	 *
	 * ponytail: the shortcode in the page content only, not WooCommerce's
	 * "classic shortcode" block; that page keeps painting after the first read.
	 */
	public static function seeds_checkout(): bool {
		return self::checkout_lines() && wc_post_content_has_shortcode( 'woocommerce_checkout' ) && WC()->cart && ! WC()->cart->is_empty();
	}

	/**
	 * The cart as a Store API cart response, trimmed to what the store's
	 * normalizers read, or null. WooCommerce's own hydration, as its block
	 * checkout uses: a GET of the cart route run in-process, with extensions'
	 * hydration hooks (Mix-and-Match).
	 *
	 * It must leave the classic checkout as without it, on WooCommerce 10.x and
	 * 11.x alike:
	 * - only a cart the page has calculated: the route would calculate it
	 *   itself, in block mode (another default shipping method, saved; shipping
	 *   hidden until an address is entered);
	 * - put back on every exit what the read changes: the cart's context, which
	 *   WooCommerce restores only from 11.1 (and leaves on 'store-api' before),
	 *   the shipping packages, the whole session (notices, chosen shipping
	 *   method), and the Store API nonce check, which before 11.1 an \Error in
	 *   the route leaves off for the rest of the request.
	 */
	public static function cart_seed(): ?array {
		$hydration = 'Automattic\WooCommerce\Blocks\Domain\Services\Hydration';
		if ( ! did_action( 'woocommerce_after_calculate_totals' ) || ! WC()->cart || ! WC()->session instanceof WC_Session
			|| ! class_exists( $hydration ) || ! class_exists( 'Automattic\WooCommerce\Blocks\Package' ) ) {
			return null;
		}
		$service  = \Automattic\WooCommerce\Blocks\Package::container()->get( $hydration );
		$context  = WC()->cart->cart_context;
		$packages = WC()->shipping()->packages;
		// WC_Session has no public way to read or put back all of its data.
		$session = ( fn() => [ $this->_data, $this->_dirty ] )->call( WC()->session );
		try {
			$cart = $service->get_rest_api_response_data( '/wc/store/v1/cart' )['body'] ?? null;
		} catch ( \Throwable $e ) {
			$cart = null; // no seed: the lines paint after the first read, as without one
		} finally {
			WC()->cart->cart_context   = $context;
			WC()->shipping()->packages = $packages;
			( function ( $saved ) {
				[ $this->_data, $this->_dirty ] = $saved;
			} )->call( WC()->session, $session );
			remove_filter( 'woocommerce_store_api_disable_nonce_check', [ $service, 'disable_nonce_check_callback' ] );
		}
		if ( ! is_array( $cart ) || empty( $cart['items'] ) ) {
			return null;
		}

		// What normalizeCart(), normalizeItem() and the extension modules read; not
		// addresses, payment methods, cross-sells or descriptions, and of the shipping
		// rates only whether each package has one selected.
		$keep = static fn( $data, array $keys ) => array_intersect_key( (array) $data, array_flip( $keys ) );
		$seed = $keep( $cart, [ 'items', 'coupons', 'totals', 'needs_shipping', 'extensions' ] );
		$seed['shipping_rates'] = array_map(
			static fn( $package ) => [ 'shipping_rates' => array_map( static fn( $rate ) => $keep( $rate, [ 'selected' ] ), (array) ( ( (array) $package )['shipping_rates'] ?? [] ) ) ],
			(array) ( $cart['shipping_rates'] ?? [] )
		);
		$seed['totals'] = $keep( $cart['totals'] ?? [], [ 'total_items', 'total_items_tax', 'total_price', 'total_tax', 'total_shipping', 'total_shipping_tax' ] );
		$seed['items']  = array_map(
			static function ( $item ) use ( $keep ) {
				$line           = $keep( $item, [ 'key', 'id', 'type', 'name', 'quantity', 'quantity_limits', 'permalink', 'variation', 'item_data', 'extensions' ] );
				$line['prices'] = $keep( $item['prices'] ?? [], [ 'price' ] );
				$line['totals'] = $keep( $item['totals'] ?? [], [ 'line_subtotal', 'line_subtotal_tax', 'line_total', 'line_total_tax' ] );
				$line['images'] = empty( $item['images'] ) ? [] : [ $keep( current( $item['images'] ), [ 'src', 'thumbnail', 'srcset', 'alt' ] ) ];
				return $line;
			},
			$cart['items']
		);
		return $seed;
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
		if ( ! self::checkout_lines() ) {
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
