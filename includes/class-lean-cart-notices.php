<?php
/**
 * Page-cache-safe WooCommerce notices.
 *
 * Lean Cart gives its own feedback, and its Store API calls never create
 * session notices. Session notices only come from classic (no-JS) form posts.
 * Two rules keep those working without leaking into shared cached HTML:
 *
 * 1. On GET views of catalogue/content pages, notices print inside <noscript>:
 *    no-JS visitors see them, JS visitors don't. Cart, checkout and account
 *    keep live notices (filter: kaupang/lean-cart/live_notices), and so does any POST
 *    response, since it is never cached and may carry form validation errors.
 *
 * 2. While notices are pending, a short-lived `lc_notice` cookie is set (filter:
 *    kaupang/lean-cart/notice_cookie). A page cache should treat that cookie as a full
 *    bypass, so the page that prints the notice is rendered fresh and never
 *    stored. The cookie is cleared on the first request with nothing pending.
 */

defined( 'ABSPATH' ) || exit;

class Lean_Cart_Notices {

	public function __construct() {
		add_action( 'template_redirect', [ $this, 'wrap_notices' ] );
		add_action( 'template_redirect', [ $this, 'sync_cookie' ], PHP_INT_MAX );
		add_filter( 'wp_redirect', [ $this, 'sync_cookie_on_redirect' ] );
	}

	/**
	 * Swap woocommerce_output_all_notices for the <noscript> variant on every
	 * hook it is attached to (WooCommerce's and any a theme added).
	 */
	public function wrap_notices(): void {
		$is_get = in_array( $_SERVER['REQUEST_METHOD'] ?? 'GET', [ 'GET', 'HEAD' ], true );

		/**
		 * Filter: kaupang/lean-cart/live_notices
		 *
		 * Return true to print notices normally on the current request.
		 *
		 * @param bool $live Default: cart, checkout, account, or a non-GET request.
		 */
		if ( apply_filters( 'kaupang/lean-cart/live_notices', ! $is_get || is_cart() || is_checkout() || is_account_page() ) ) {
			return;
		}

		foreach ( $GLOBALS['wp_filter'] as $hook => $callbacks ) {
			$priority = $callbacks->has_filter( $hook, 'woocommerce_output_all_notices' );
			if ( false !== $priority ) {
				remove_action( $hook, 'woocommerce_output_all_notices', $priority );
				add_action( $hook, [ $this, 'output_noscript_notices' ], $priority );
			}
		}
	}

	public function output_noscript_notices(): void {
		echo '<noscript>';
		woocommerce_output_all_notices();
		echo '</noscript>';
	}

	public function sync_cookie(): void {
		if ( ! function_exists( 'WC' ) || ! WC()->session || headers_sent() ) {
			return;
		}

		/**
		 * Filter: kaupang/lean-cart/notice_cookie
		 *
		 * Name of the cookie flagging pending session notices.
		 *
		 * @param string $name Default 'lc_notice'.
		 */
		$name    = apply_filters( 'kaupang/lean-cart/notice_cookie', 'lc_notice' );
		$pending = wc_notice_count() > 0;
		$flagged = isset( $_COOKIE[ $name ] );

		if ( $pending && ! $flagged ) {
			wc_setcookie( $name, '1' );
		} elseif ( ! $pending && $flagged ) {
			wc_setcookie( $name, '', time() - HOUR_IN_SECONDS );
		}
	}

	/**
	 * Classic form handlers (add-to-cart, login, …) add a notice and redirect
	 * before template_redirect, so flag the cookie on the redirect response too.
	 */
	public function sync_cookie_on_redirect( $location ) {
		$this->sync_cookie();
		return $location;
	}
}
