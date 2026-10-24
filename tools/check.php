<?php
/**
 * Check: Lean Cart loads through core script modules (one import map, static
 * imports preloaded, config as module data) and keeps its cross-context hooks.
 *
 *   gp wp <site> eval-file wp-content/plugins/kaupang-lean-cart/tools/check.php
 *
 * Calls only Lean Cart's own wp_enqueue_scripts callback (firing the whole
 * action under CLI runs every plugin's), then prints what core would print in
 * the footer. Writes nothing. Exits non-zero on failure. No admin assets, so no
 * foreign-screen check (Pattern E): the plugin hooks no admin_enqueue_scripts.
 */

defined( 'ABSPATH' ) || exit;

$failed = 0;
$ok     = static function ( bool $cond, string $msg ) use ( &$failed ): void {
	WP_CLI::log( ( $cond ? 'ok   ' : 'FAIL ' ) . $msg );
	$failed += $cond ? 0 : 1;
};

$ok( class_exists( 'Lean_Cart_Assets', false ), 'Lean Cart is loaded (WooCommerce active)' );
if ( $failed ) {
	WP_CLI::error( 'nothing to check' );
}

/** Lean Cart's callbacks on a hook, as "Class::method". */
$own = static function ( string $hook ): array {
	$found = [];
	foreach ( $GLOBALS['wp_filter'][ $hook ]->callbacks ?? [] as $cbs ) {
		foreach ( $cbs as $cb ) {
			$fn = $cb['function'];
			if ( is_array( $fn ) && is_object( $fn[0] ) && str_starts_with( get_class( $fn[0] ), 'Lean_Cart' ) ) {
				$found[ get_class( $fn[0] ) . '::' . $fn[1] ] = $fn;
			}
		}
	}
	return $found;
};

/** A fresh front-end request's script state, Lean Cart's enqueue run, and what core prints in the footer. */
$render = static function () use ( $own ): string {
	$GLOBALS['wp_script_modules'] = null;
	$GLOBALS['wp_styles']         = null;
	foreach ( $own( 'wp_enqueue_scripts' ) as $name => $fn ) {
		if ( 'Lean_Cart_Assets::enqueue' === $name ) {
			call_user_func( $fn );
		}
	}
	$m = wp_script_modules();
	ob_start();
	$m->print_import_map();
	$m->print_enqueued_script_modules();
	$m->print_script_module_preloads();
	$m->print_script_module_data();
	return (string) ob_get_clean();
};

$data = static function ( string $html ): array {
	preg_match( '#<script[^>]*\bid="wp-script-module-data-@kaupang/lean-cart/config"[^>]*>(.*?)</script>#s', $html, $m );
	return json_decode( $m[1] ?? 'null', true ) ?: [];
};

// ── Loading: no own map, no tag rewrite ─────────────────────────
$ok( [] === $own( 'script_loader_tag' ), 'no script_loader_tag filter of its own' );
$ok( [] === array_filter( array_keys( $own( 'wp_head' ) ), static fn( $n ) => str_contains( $n, 'importmap' ) ), 'no import map printed of its own' );
$ok( [] === $own( 'admin_enqueue_scripts' ), 'no admin assets' );

// ── A catalogue page ────────────────────────────────────────────
$html = $render();
$ok( 1 === substr_count( $html, 'type="importmap"' ), 'one import map (core\'s)' );
foreach ( [ 'config', 'api', 'store', 'ui', 'add' ] as $name ) {
	$ok( (bool) preg_match( '#<link rel="modulepreload" href="[^"]+" id="@kaupang/lean-cart/' . $name . '-js-modulepreload"#', $html ), "static import @kaupang/lean-cart/{$name} is preloaded" );
}
$ok( (bool) preg_match( '#<script(?=[^>]*\btype="module")(?=[^>]*\bsrc="[^"]+/cart-init\.js\?ver=\d+")[^>]*\bid="@kaupang/lean-cart/init-js-module"#', $html ), 'the entry point prints as a module' );
$ok( ! str_contains( $html, 'classic-pages-js-modulepreload' ) && str_contains( $html, '"@kaupang/lean-cart/classic-pages"' ), 'the classic-pages bridge is in the map, not preloaded (dynamic)' );
$config = $data( $html );
$ok( isset( $config['storeApiBase'], $config['nonce'], $config['i18n'], $config['modules'] ), 'config printed as module data' );
$ok( ! empty( $config['drawerCss'] ) && str_contains( $config['drawerCss'], 'lean-cart.css?ver=' ), 'drawer CSS is left to the first interaction (drawerCss set)' );
$ok( ! in_array( 'kaupang-lean-cart-styles', wp_styles()->queue, true ), 'no stylesheet in <head>' );

// ── The shortcode checkout: the lines show with the page ────────
add_filter( 'woocommerce_is_checkout', '__return_true' );
$html = $render();
remove_filter( 'woocommerce_is_checkout', '__return_true' );
$ok( in_array( 'kaupang-lean-cart-styles', wp_styles()->queue, true ), 'checkout: the stylesheet is in <head>' );
$ok( '' === ( $data( $html )['drawerCss'] ?? null ), 'checkout: drawerCss empty' );

// ── Styles off ──────────────────────────────────────────────────
add_filter( 'kaupang/lean-cart/disable_styles', '__return_true' );
$html = $render();
remove_filter( 'kaupang/lean-cart/disable_styles', '__return_true' );
$ok( '' === ( $data( $html )['drawerCss'] ?? null ) && ! wp_style_is( 'kaupang-lean-cart-styles', 'registered' ), 'disable_styles: no sheet, no drawerCss' );

// ── JS: every import is a registered id (a relative path would load a second store) ──
$html   = $render();
$mapped = array_keys( json_decode( preg_replace( '#^.*?<script[^>]*\btype="importmap"[^>]*>(.*?)</script>.*$#s', '$1', $html ), true )['imports'] ?? [] );
$mapped[] = '@kaupang/lean-cart/init';
$dir      = KAUPANG_LEAN_CART_PATH . 'assets/js/';
foreach ( array_merge( glob( $dir . '*.js' ), glob( $dir . 'modules/*.js' ) ) as $file ) {
	$src = (string) file_get_contents( $file );
	preg_match_all( '#(?:^import\b[^\'"]*|\bimport\s*\(\s*)[\'"]([^\'"]+)[\'"]#m', $src, $m );
	$active = $config['modules'] ?? [];
	foreach ( $m[1] as $spec ) {
		$ext = substr( $spec, strlen( '@kaupang/lean-cart/' ) );
		$off = isset( array_flip( [ 'subscriptions', 'mix-and-match', 'all-products-subs', 'sublium-subscriptions' ] )[ $ext ] ) && ! in_array( $ext, $mapped, true );
		$ok( str_starts_with( $spec, '@kaupang/lean-cart/' ) && ( in_array( $spec, $mapped, true ) || $off ), basename( $file ) . " imports {$spec}" . ( $off ? ' (extension inactive here, not mapped)' : '' ) );
	}
	$ok( ! str_contains( $src, 'window.leanCartConfig' ), basename( $file ) . ' reads no window.leanCartConfig' );
}

// ── Hooks that work outside the page view ───────────────────────
$ok( isset( $own( 'rest_post_dispatch' )['Lean_Cart_Hooks::sync_cart_cookies'] ), 'Store API responses sync the cart cookies (rest_post_dispatch)' );
$ok( false === apply_filters( 'woocommerce_cart_fragment_refresh', true ), 'legacy cart fragments are off' );
$ok( isset( $own( 'woocommerce_checkout_order_review' )['Lean_Cart_Hooks::print_checkout_lines'] ), 'the checkout lines mount prints in the order review' );
$ok( isset( $own( 'template_redirect' )['Lean_Cart_Notices::wrap_notices'] ), 'page-cache-safe notices are hooked' );

// Storefront load budget (conventions.md §5B).
if (class_exists('WP_CLI') && is_array(WP_CLI::get_runner()->find_command_to_run(['kaupang-assets', 'audit']))) {
	$audit = WP_CLI::runcommand('kaupang-assets audit --plugins=kaupang-lean-cart --budget', ['return' => 'all', 'exit_error' => false]);
	echo $audit->stdout . "\n";
	$ok($audit->return_code === 0 && $audit->stdout !== '', 'kaupang-assets audit --plugins=kaupang-lean-cart --budget exits 0');
} else {
	echo "  skip storefront budget: `wp kaupang-assets audit` is not available here\n";
}

$failed ? WP_CLI::error( "{$failed} check(s) failed" ) : WP_CLI::success( 'Lean Cart loads through core script modules.' );
