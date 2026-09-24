<?php
/**
 * Main plugin class.
 *
 * Loads core classes and conditionally loads extension modules
 * when their parent plugins are active.
 */

defined( 'ABSPATH' ) || exit;

final class Lean_Cart {

	private static ?Lean_Cart $instance = null;

	public static function get_instance(): self {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		$this->load_core();
		$this->load_modules();

		/**
		 * Fires after Lean Cart is fully initialized.
		 *
		 * Theme and other plugins can hook here to integrate
		 * with the cart (e.g., bridge lean-cart:open events to
		 * their own drawer/panel system).
		 */
		do_action( 'lean_cart_loaded' );
	}

	private function load_core(): void {
		require_once LEAN_CART_PATH . 'includes/class-lean-cart-assets.php';
		require_once LEAN_CART_PATH . 'includes/class-lean-cart-hooks.php';
		require_once LEAN_CART_PATH . 'includes/class-lean-cart-notices.php';

		new Lean_Cart_Assets();
		new Lean_Cart_Hooks();
		new Lean_Cart_Notices();
	}

	/**
	 * Conditionally load extension modules.
	 *
	 * Each module is loaded only when its parent plugin is active,
	 * adding zero overhead otherwise.
	 */
	private function load_modules(): void {
		if ( class_exists( 'WC_Subscriptions' ) ) {
			require_once LEAN_CART_PATH . 'includes/modules/class-subscriptions.php';
			new Lean_Cart_Subscriptions();
		}

		if ( class_exists( 'WC_Mix_and_Match' ) ) {
			require_once LEAN_CART_PATH . 'includes/modules/class-mix-and-match.php';
			new Lean_Cart_Mix_And_Match();
		}

		if ( class_exists( 'WCS_ATT' ) ) {
			require_once LEAN_CART_PATH . 'includes/modules/class-all-products-subs.php';
			new Lean_Cart_All_Products_Subs();
		}

		if ( class_exists( '\Sublium_WCS\Plugin' ) || function_exists( 'sublium_init' ) ) {
			require_once LEAN_CART_PATH . 'includes/modules/class-sublium-subscriptions.php';
			new Lean_Cart_Sublium_Subscriptions();
		}
	}
}
