<?php
/**
 * Mix and Match Products integration module.
 *
 * Loaded only when WC_Mix_and_Match is active.
 * The Store API extension is already provided by WC_MNM_Store_API.
 * This module adds i18n strings and any extra config the JS
 * normalizer needs for parent-child grouping.
 *
 * JS-side responsibility (assets/js/modules/mix-and-match.js):
 *   - Registers a form extractor via store.addFormExtractor() that reads
 *     mnm_quantity[<child_id>] inputs from form.mnm_form and returns
 *     { mnm_config: { <child_id>: qty, ... } } for the Store API body.
 *   - Without this extractor, Lean Cart's form interception strips the
 *     MnM payload and the container is added with 0 price and no children.
 */

defined( 'ABSPATH' ) || exit;

class Lean_Cart_Mix_And_Match {

	public function __construct() {
		add_filter( 'kaupang/lean-cart/config', [ $this, 'extend_config' ] );

		// Server-side safety net: reject MnM containers added without mnm_config.
		// This surfaces the bug loudly if the JS extractor ever stops running.
		add_action( 'woocommerce_store_api_validate_add_to_cart', [ $this, 'validate_mnm_config' ], 9, 2 );
	}

	/**
	 * Reject MnM container add-to-cart requests that are missing mnm_config.
	 *
	 * $request here is the add-to-cart *array* (not a WP_REST_Request), so
	 * mnm_config lives under cart_item_data — it gets placed there by MnM's
	 * own woocommerce_store_api_add_to_cart_data filter, which only fires
	 * when the original request body carried an mnm_config key.
	 *
	 * @param \WC_Product $product The product being added.
	 * @param array       $request Add-to-cart data array.
	 *
	 * @throws \Automattic\WooCommerce\StoreApi\Exceptions\RouteException
	 */
	public function validate_mnm_config( $product, $request ) {
		if ( ! function_exists( 'wc_mnm_is_product_container_type' ) ) {
			return;
		}
		if ( ! wc_mnm_is_product_container_type( $product ) ) {
			return;
		}
		if ( isset( $request['cart_item_data']['mnm_config'] ) ) {
			return;
		}

		throw new \Automattic\WooCommerce\StoreApi\Exceptions\RouteException(
			'kaupang_lean_cart_mnm_missing_config',
			esc_html__( 'Please choose your items before adding this product to the cart.', 'kaupang-lean-cart' ),
			400
		);
	}

	public function extend_config( array $config ): array {
		$config['i18n']['mnmContainer']   = __( 'Sammensetning', 'kaupang-lean-cart' );
		$config['i18n']['mnmItemsSelected'] = __( '%d valgt', 'kaupang-lean-cart' );

		return $config;
	}
}
