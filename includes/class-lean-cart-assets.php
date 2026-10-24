<?php
/**
 * Script modules and the drawer stylesheet.
 *
 * Core script modules (one import map, printed by core): the entry point
 * @kaupang/lean-cart/init with its static imports preloaded, and the extension
 * and classic-page modules as dynamic imports. The config goes through
 * script_module_data_@kaupang/lean-cart/config.
 */

defined( 'ABSPATH' ) || exit;

class Lean_Cart_Assets {

	/** Statically imported modules: id suffix => [ file, static deps ]. */
	private const CORE = [
		'config' => [ 'cart-config.js', [] ],
		'api'    => [ 'cart-api.js', [ 'config' ] ],
		'store'  => [ 'cart-store.js', [ 'api', 'config' ] ],
		'ui'     => [ 'cart-ui.js', [ 'config' ] ],
		'add'    => [ 'cart-add.js', [ 'store' ] ],
	];

	/** Extension modules (modules/<name>.js) => their key in config.modules. */
	private const EXTENSIONS = [
		'subscriptions'         => 'subscriptions',
		'mix-and-match'         => 'mixAndMatch',
		'all-products-subs'     => 'allProductsSubs',
		'sublium-subscriptions' => 'subliumSubscriptions',
	];

	private string $css_url = '';

	public function __construct() {
		add_action( 'wp_enqueue_scripts', [ $this, 'enqueue' ] );
		add_filter( 'script_module_data_@kaupang/lean-cart/config', [ $this, 'module_data' ] );
	}

	/** Which extension modules this shop runs: modules/<name> => active. */
	private static function extensions(): array {
		return [
			'subscriptions'         => class_exists( 'WC_Subscriptions' ),
			'mix-and-match'         => class_exists( 'WC_Mix_and_Match' ),
			'all-products-subs'     => class_exists( 'WCS_ATT' ),
			'sublium-subscriptions' => class_exists( '\Sublium_WCS\Plugin' ) || function_exists( 'sublium_init' ),
		];
	}

	public function enqueue(): void {
		$this->register_styles();
		$this->enqueue_modules();
	}

	private function register_styles(): void {
		$this->css_url = '';

		/**
		 * Filter: kaupang/lean-cart/disable_styles
		 *
		 * Return true to prevent the plugin from loading its CSS.
		 * Useful when the theme provides its own cart styles.
		 *
		 * @param bool $disable Default false.
		 */
		if ( apply_filters( 'kaupang/lean-cart/disable_styles', false ) ) {
			return;
		}

		$css_file = KAUPANG_LEAN_CART_PATH . 'assets/css/lean-cart.css';
		$ver      = file_exists( $css_file ) ? (string) filemtime( $css_file ) : KAUPANG_LEAN_CART_VERSION;

		wp_register_style( 'kaupang-lean-cart-styles', KAUPANG_LEAN_CART_URL . 'assets/css/lean-cart.css', [], $ver );
		$this->css_url = add_query_arg( 'ver', $ver, KAUPANG_LEAN_CART_URL . 'assets/css/lean-cart.css' );

		// The checkout lines show with the page. Elsewhere everything it styles
		// sits in the closed drawer, and cart-init.js fetches it on the first
		// interaction (config.drawerCss).
		if ( Lean_Cart_Hooks::checkout_lines() ) {
			wp_enqueue_style( 'kaupang-lean-cart-styles' );
		}
	}

	private function enqueue_modules(): void {
		$id  = static fn( string $name ): string => '@kaupang/lean-cart/' . $name;
		$url = static fn( string $file ): string => KAUPANG_LEAN_CART_URL . 'assets/js/' . $file;
		$ver = static fn( string $file ): string => (string) filemtime( KAUPANG_LEAN_CART_PATH . 'assets/js/' . $file );

		foreach ( self::CORE as $name => [ $file, $deps ] ) {
			wp_register_script_module( $id( $name ), $url( $file ), array_map( $id, $deps ), $ver( $file ) );
		}

		// A page with the checkout lines runs the bridge, the lines and the
		// extensions at once (imported by cart-init.js): preload them there.
		// The JS still import()s them, so one that fails to load leaves the drawer.
		$import  = Lean_Cart_Hooks::seeds_checkout() ? 'static' : 'dynamic';
		$dynamic = [];
		foreach ( array_keys( array_filter( self::extensions() ) ) as $name ) {
			wp_register_script_module( $id( $name ), $url( "modules/{$name}.js" ), [ $id( 'config' ) ], $ver( "modules/{$name}.js" ) );
			$dynamic[] = [ 'id' => $id( $name ), 'import' => $import ];
		}
		// No imports of their own (cart-init.js passes what they need).
		foreach ( [ 'classic-pages', 'checkout-lines' ] as $name ) {
			wp_register_script_module( $id( $name ), $url( "modules/{$name}.js" ), [], $ver( "modules/{$name}.js" ) );
			$dynamic[] = [ 'id' => $id( $name ), 'import' => $import ];
		}

		wp_enqueue_script_module(
			$id( 'init' ),
			$url( 'cart-init.js' ),
			array_merge( array_map( $id, array_keys( self::CORE ) ), $dynamic ),
			$ver( 'cart-init.js' )
		);

		/**
		 * Action: kaupang/lean-cart/enqueue_scripts
		 *
		 * Fires after lean cart's script modules are enqueued.
		 * Use this to enqueue additional scripts that depend on the cart.
		 */
		do_action( 'kaupang/lean-cart/enqueue_scripts' );
	}

	/**
	 * The config, printed by core in the footer as JSON for cart-config.js.
	 * Built when it prints: on the shortcode checkout the cart is calculated by then.
	 */
	public function module_data( array $data ): array {
		$config = $this->build_config();

		$config['drawerCss'] = $this->css_url && ! wp_style_is( 'kaupang-lean-cart-styles', 'enqueued' ) && ! wp_style_is( 'kaupang-lean-cart-styles', 'done' )
			? $this->css_url
			: '';

		$cart = Lean_Cart_Hooks::seeds_checkout() ? Lean_Cart_Hooks::cart_seed() : null;
		if ( $cart ) {
			$config['cart'] = $cart;
		}

		return $data + $config;
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
			'modules'      => array_combine( self::EXTENSIONS, self::extensions() ),
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
}
