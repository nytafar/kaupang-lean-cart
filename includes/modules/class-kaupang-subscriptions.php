<?php
/**
 * kaupang-subscriptions integration module.
 *
 * Loaded only when kaupang-subscriptions is active and its storefront sells
 * subscriptions (its `enabled` setting; Lean_Cart::load_modules()). kaupang-subscriptions serves the
 * Store API data (namespace `kaupang-subscriptions`) and the update callback
 * (`set_plan`), and hands Lean Cart the product page's plan field itself
 * (its lean-cart-plan.js form extractor). This module only adds the strings
 * modules/kaupang-subscriptions.js uses to map that data to the cart's neutral
 * fields (purchaseMode, subscriptionSummary, subscriptionNote, planChoice).
 */

defined( 'ABSPATH' ) || exit;

class Lean_Cart_Kaupang_Subscriptions {

	public function __construct() {
		add_filter( 'kaupang/lean-cart/config', [ $this, 'extend_config' ] );
	}

	public function extend_config( array $config ): array {
		$config['i18n']['subscription'] ??= __( 'Abonnement', 'kaupang-lean-cart' );
		/* translators: the name of a cart line's plan choice (screen reader, before the product name) */
		$config['i18n']['planChoice']    = __( 'Kjøp', 'kaupang-lean-cart' );
		/* translators: the plan choice's option for buying once */
		$config['i18n']['oneTime']       = __( 'Engangskjøp', 'kaupang-lean-cart' );
		/* translators: a recurring cart line that joins the customer's package: %s is how often, e.g. "hver levering" */
		$config['i18n']['joinsPackage']  = __( 'Blir med i pakken din, %s', 'kaupang-lean-cart' );
		$config['i18n']['everyDelivery'] = __( 'hver levering', 'kaupang-lean-cart' );
		$config['i18n']['everyOther']    = __( 'annenhver levering', 'kaupang-lean-cart' );
		/* translators: %d: every n-th delivery (3 and up) */
		$config['i18n']['everyNth']      = __( 'hver %d. levering', 'kaupang-lean-cart' );

		return $config;
	}
}
