<?php
/**
 * Plugin Name: WooCommerce Lean Cart
 * Plugin URI:  https://github.com/nytafar/woocommerce-lean-cart
 * Description: A minimal, modular WooCommerce cart built on the Store API. Replaces legacy cart fragments with a vanilla JS state layer and event-driven UI.
 * Version:     0.1.0
 * Author:      Lasse Jellum
 * Author URI:  https://jellum.net
 * Text Domain: lean-cart
 * Requires PHP: 8.0
 * Requires at least: 6.0
 * Requires Plugins: woocommerce
 * WC requires at least: 8.0
 * WC tested up to: 11.1
 * License: GPL-2.0-or-later
 *
 * @package LeanCart
 */

defined( 'ABSPATH' ) || exit;

define( 'LEAN_CART_VERSION', '0.1.0' );
define( 'LEAN_CART_PATH', plugin_dir_path( __FILE__ ) );
define( 'LEAN_CART_URL', plugin_dir_url( __FILE__ ) );

/**
 * HPOS: never touches orders (Store API cart only). Blocks: Store API client; live notices kept on cart/checkout.
 */
add_action( 'before_woocommerce_init', function () {
	if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', __FILE__, true );
	}
} );

/**
 * Boot the plugin after WooCommerce is loaded.
 */
add_action( 'plugins_loaded', function () {
	if ( ! class_exists( 'WooCommerce' ) ) {
		return;
	}

	require_once LEAN_CART_PATH . 'includes/class-lean-cart.php';
	Lean_Cart::get_instance();
} );
