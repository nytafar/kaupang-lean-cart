<?php
/**
 * WooCommerce Subscriptions integration module.
 *
 * Loaded only when WC_Subscriptions is active.
 * Adds subscription period strings and config to the JS layer.
 * The Store API extension is already provided by WC Subscriptions
 * via WC_Subscriptions_Extend_Store_Endpoint.
 */

defined( 'ABSPATH' ) || exit;

class Lean_Cart_Subscriptions {

	public function __construct() {
		add_filter( 'kaupang/lean-cart/config', [ $this, 'extend_config' ] );
	}

	public function extend_config( array $config ): array {
		$config['subscriptionPeriods'] = [
			'day'   => __( 'dag', 'kaupang-lean-cart' ),
			'week'  => __( 'uke', 'kaupang-lean-cart' ),
			'month' => __( 'måned', 'kaupang-lean-cart' ),
			'year'  => __( 'år', 'kaupang-lean-cart' ),
		];

		$config['subscriptionIntervals'] = [
			/* translators: %s: period name (e.g., "måned") */
			'singular' => __( 'Hver %s', 'kaupang-lean-cart' ),
			/* translators: %1$d: interval number, %2$s: period name */
			'plural'   => __( 'Hver %1$d. %2$s', 'kaupang-lean-cart' ),
		];

		$config['i18n']['subscription']  = __( 'Abonnement', 'kaupang-lean-cart' );
		$config['i18n']['signupFee']     = __( 'Oppstartsavgift', 'kaupang-lean-cart' );
		$config['i18n']['freeTrial']     = __( 'Gratis prøveperiode', 'kaupang-lean-cart' );

		return $config;
	}
}
