<?php
/**
 * Script and style registration, localization.
 *
 * Enqueues the cart JS entry point as a native ES module and
 * injects the leanCartConfig object with Store API nonce,
 * currency settings, active modules, and i18n strings.
 */

defined( 'ABSPATH' ) || exit;

class Lean_Cart_Assets {

	private string $js_ver;

	public function __construct() {
		$this->js_ver = $this->compute_js_ver();

		add_action( 'wp_enqueue_scripts', [ $this, 'enqueue' ] );
		add_filter( 'script_loader_tag', [ $this, 'add_module_type' ], 10, 2 );
		add_action( 'wp_head', [ $this, 'print_importmap' ], 1 );
	}

	private function compute_js_ver(): string {
		$js_dir = KAUPANG_LEAN_CART_PATH . 'assets/js/';
		$ver = 0;
		foreach ( glob( $js_dir . '*.js' ) as $f ) {
			$ver = max( $ver, filemtime( $f ) );
		}
		foreach ( glob( $js_dir . 'modules/*.js' ) as $f ) {
			$ver = max( $ver, filemtime( $f ) );
		}
		return (string) ( $ver ?: KAUPANG_LEAN_CART_VERSION );
	}

	public function enqueue(): void {
		$this->enqueue_styles();
		$this->enqueue_scripts();
	}

	private function enqueue_styles(): void {
		/**
		 * Filter: kaupang/lean-cart/disable_styles
		 *
		 * Return true to prevent the plugin from enqueuing its CSS.
		 * Useful when the theme provides its own cart styles.
		 *
		 * @param bool $disable Default false.
		 */
		if ( apply_filters( 'kaupang/lean-cart/disable_styles', false ) ) {
			return;
		}

		$css_file = KAUPANG_LEAN_CART_PATH . 'assets/css/lean-cart.css';

		wp_enqueue_style(
			'kaupang-lean-cart-styles',
			KAUPANG_LEAN_CART_URL . 'assets/css/lean-cart.css',
			[],
			file_exists( $css_file ) ? filemtime( $css_file ) : KAUPANG_LEAN_CART_VERSION
		);
	}

	private function enqueue_scripts(): void {
		wp_enqueue_script(
			'kaupang-lean-cart-init',
			KAUPANG_LEAN_CART_URL . 'assets/js/cart-init.js',
			[],
			$this->js_ver,
			[ 'strategy' => 'defer', 'in_footer' => true ]
		);

		$config = $this->build_config();

		wp_add_inline_script(
			'kaupang-lean-cart-init',
			'window.leanCartConfig = ' . wp_json_encode( $config ) . ';',
			'before'
		);

		/**
		 * Action: kaupang/lean-cart/enqueue_scripts
		 *
		 * Fires after lean cart scripts are enqueued.
		 * Use this to enqueue additional scripts that depend on the cart.
		 */
		do_action( 'kaupang/lean-cart/enqueue_scripts' );
	}

	private function build_config(): array {
		$wc_price_format = get_woocommerce_price_format();

		$config = [
			'storeApiBase' => esc_url_raw( rest_url( 'wc/store/v1/' ) ),
			'nonce'        => wp_create_nonce( 'wc_store_api' ),
			'checkoutUrl'  => wc_get_checkout_url(),
			'cartUrl'      => wc_get_cart_url(),
			'currency'     => [
				'code'      => get_woocommerce_currency(),
				'symbol'    => html_entity_decode( get_woocommerce_currency_symbol() ),
				'minorUnit' => wc_get_price_decimals(),
				'locale'    => str_replace( '_', '-', get_locale() ),
			],
			'showVariationLabels' => apply_filters( 'kaupang/lean-cart/show_variation_labels', false ),
			'modules'      => [
				'subscriptions'        => class_exists( 'WC_Subscriptions' ),
				'mixAndMatch'          => class_exists( 'WC_Mix_and_Match' ),
				'allProductsSubs'      => class_exists( 'WCS_ATT' ),
				'subliumSubscriptions' => class_exists( '\Sublium_WCS\Plugin' ) || function_exists( 'sublium_init' ),
			],
			'i18n'         => apply_filters( 'kaupang/lean-cart/i18n', [
				'emptyCart'    => __( 'Handlekurven er tom', 'kaupang-lean-cart' ),
				'item'         => __( 'vare', 'kaupang-lean-cart' ),
				'items'        => __( 'varer', 'kaupang-lean-cart' ),
				'remove'       => __( 'Fjern', 'kaupang-lean-cart' ),
				'subtotal'     => __( 'Delsum', 'kaupang-lean-cart' ),
				'total'        => __( 'Totalt', 'kaupang-lean-cart' ),
				'shipping'     => __( 'Frakt', 'kaupang-lean-cart' ),
				'freeShipping' => __( 'Gratis', 'kaupang-lean-cart' ),
				'updateError'  => __( 'Kunne ikke oppdatere', 'kaupang-lean-cart' ),
				/* translators: the classic checkout's order lines (screen reader name) */
				'checkoutLines' => __( 'Varer i bestillingen', 'kaupang-lean-cart' ),
				/* translators: screen reader, after a quantity change: 1: product name, 2: new quantity */
				'lineQuantity' => __( '%1$s, antall %2$s', 'kaupang-lean-cart' ),
				/* translators: screen reader, after a line was removed: product name */
				'lineRemoved'  => __( '%s er fjernet', 'kaupang-lean-cart' ),
			] ),
		];

		/**
		 * Filter: kaupang/lean-cart/config
		 *
		 * Modify the configuration object passed to the JS cart.
		 * Extension modules use this to add their own config keys.
		 *
		 * @param array $config The configuration array.
		 */
		return apply_filters( 'kaupang/lean-cart/config', $config );
	}

	/**
	 * Print an import map so sub-module URLs include a cache-busting version.
	 */
	public function print_importmap(): void {
		if ( ! $this->js_ver ) {
			return;
		}

		$base = KAUPANG_LEAN_CART_URL . 'assets/js/';
		$v    = $this->js_ver;

		/**
		 * Filter: kaupang/lean-cart/importmap_imports
		 *
		 * A page may contain only ONE import map, so sibling plugins that ship
		 * ES modules (e.g. lean-checkout) add their entries here instead of
		 * printing a second <script type="importmap"> the browser would ignore.
		 *
		 * @param array<string,string> $imports Bare-URL => versioned-URL map.
		 */
		$defaults = [
			$base . 'cart-store.js' => $base . 'cart-store.js?ver=' . $v,
			$base . 'cart-api.js'   => $base . 'cart-api.js?ver=' . $v,
			$base . 'cart-ui.js'    => $base . 'cart-ui.js?ver=' . $v,
			$base . 'cart-add.js'   => $base . 'cart-add.js?ver=' . $v,
		];

		// Extension modules load via dynamic import from cart-init; without
		// map entries their URLs carry no version and edits never bust the
		// browser cache.
		foreach ( glob( KAUPANG_LEAN_CART_PATH . 'assets/js/modules/*.js' ) as $module ) {
			$name = 'modules/' . basename( $module );
			$defaults[ $base . $name ] = $base . $name . '?ver=' . $v;
		}

		$imports = apply_filters( 'kaupang/lean-cart/importmap_imports', $defaults );

		echo '<script type="importmap">' . wp_json_encode( [ 'imports' => $imports ] ) . '</script>' . "\n";
	}

	/**
	 * Add type="module" to the cart entry-point script tag.
	 *
	 * WordPress outputs type="text/javascript" by default.
	 * We must replace it (not append) to avoid a duplicate type attribute,
	 * which would cause the browser to use the first one (text/javascript)
	 * and silently break ES module imports.
	 */
		public function add_module_type( string $tag, string $handle ): string {
			if ( 'kaupang-lean-cart-init' === $handle ) {
				// Replace existing type attribute or add type="module" for ES module support
				if ( strpos( $tag, 'type=' ) !== false ) {
					$tag = preg_replace( '/type="[^"]*"/', 'type="module"', $tag );
				} else {
					$tag = str_replace( '<script ', '<script type="module" ', $tag );
				}
			}
			return $tag;
		}
}
