<?php
/**
 * All Products for WooCommerce Subscriptions integration module.
 *
 * Loaded only when WCS_ATT is active.
 * APfS does not extend the Store API cart item data natively,
 * so this module registers a custom extension to expose the
 * active subscription scheme on each cart item.
 */

defined( 'ABSPATH' ) || exit;

class Lean_Cart_All_Products_Subs {

	public function __construct() {
		add_filter( 'lean_cart_config', [ $this, 'extend_config' ] );
		add_filter( 'woocommerce_store_api_add_to_cart_data', [ $this, 'relay_scheme_fields' ], 10, 2 );
		add_action( 'woocommerce_blocks_loaded', [ $this, 'register_store_api_data' ] );
	}

	public function extend_config( array $config ): array {
		$config['i18n']['purchaseOneTime']    = __( 'Engangskjøp', 'lean-cart' );
		$config['i18n']['purchaseSubscribe']  = __( 'Abonnement', 'lean-cart' );

		return $config;
	}

	/**
	 * Relay the chosen scheme into the classic request globals.
	 *
	 * APfS reads `convert_to_sub_{id}` from $_REQUEST inside its
	 * `woocommerce_add_cart_item_data` handler — which runs during a
	 * Store API add too, but the REST body never reaches $_REQUEST.
	 * The form extractor (assets/js/modules/all-products-subs.js) lifts
	 * the checked scheme radio into the add-item payload; replaying it
	 * here reproduces the classic submit exactly, so APfS's own
	 * validation, defaults and price application run untouched.
	 */
	public function relay_scheme_fields( array $add_to_cart_data, \WP_REST_Request $request ): array {
		foreach ( $request->get_params() as $key => $value ) {
			if ( 0 === strpos( $key, 'convert_to_sub' ) && is_scalar( $value ) ) {
				$_REQUEST[ $key ] = wc_clean( (string) $value );
			}
		}

		return $add_to_cart_data;
	}

	/**
	 * Register custom Store API extension data for APfS cart items.
	 *
	 * Exposes the active subscription scheme so the JS normalizer
	 * can display purchase mode (one-time vs subscription).
	 */
	public function register_store_api_data(): void {
		if ( ! function_exists( 'woocommerce_store_api_register_endpoint_data' ) ) {
			return;
		}

		woocommerce_store_api_register_endpoint_data( [
			'endpoint'        => \Automattic\WooCommerce\StoreApi\Schemas\V1\CartItemSchema::IDENTIFIER,
			'namespace'       => 'lean_cart_apfs',
			'data_callback'   => [ $this, 'cart_item_data' ],
			'schema_callback' => [ $this, 'cart_item_schema' ],
			'schema_type'     => ARRAY_A,
		] );
	}

	/**
	 * Add APfS scheme data to each cart item in the Store API response.
	 *
	 * The description defaults to the scheme's cadence through WCS's own
	 * localized period strings ("Hver 2. måned"), matching the theme's
	 * plan headlines; a theme re-voices it via the
	 * `lean_cart_apfs_scheme_description` filter.
	 */
	public function cart_item_data( array $cart_item ): array {
		$scheme_key = $cart_item['wcsatt_data']['active_subscription_scheme'] ?? null;

		// null = not a SATT decision; false/'0' = an explicit one-time choice.
		if ( empty( $scheme_key ) ) {
			return [
				'active_scheme_key'  => '',
				'is_subscription'    => false,
				'scheme_description' => '',
			];
		}

		$description = '';
		$product     = $cart_item['data'] ?? null;

		if ( $product instanceof \WC_Product && class_exists( 'WCS_ATT_Product_Schemes' ) ) {
			$schemes = \WCS_ATT_Product_Schemes::get_subscription_schemes( $product );
			$scheme  = $schemes[ $scheme_key ] ?? null;

			if ( $scheme && function_exists( 'wcs_get_subscription_period_strings' ) ) {
				$cadence = wcs_get_subscription_period_strings( (int) $scheme->get_interval(), $scheme->get_period() );

				/* translators: %s: subscription cadence ("2. måned"), localized by Woo Subscriptions. */
				$description = sprintf( __( 'Hver %s', 'lean-cart' ), $cadence );
			}
		}

		return [
			'active_scheme_key'  => (string) $scheme_key,
			'is_subscription'    => true,
			'scheme_description' => apply_filters( 'lean_cart_apfs_scheme_description', $description, (string) $scheme_key, $cart_item ),
		];
	}

	/**
	 * Schema for the APfS extension data.
	 */
	public function cart_item_schema(): array {
		return [
			'active_scheme_key' => [
				'description' => __( 'Active subscription scheme key', 'lean-cart' ),
				'type'        => 'string',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
			'is_subscription' => [
				'description' => __( 'Whether the item is in subscription mode', 'lean-cart' ),
				'type'        => 'boolean',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
			'scheme_description' => [
				'description' => __( 'Human-readable plan description', 'lean-cart' ),
				'type'        => 'string',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
		];
	}
}
