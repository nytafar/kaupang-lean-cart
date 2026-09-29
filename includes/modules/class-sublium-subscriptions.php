<?php
/**
 * Sublium Subscriptions integration module.
 *
 * Loaded only when Sublium Subscriptions is active.
 */

defined( 'ABSPATH' ) || exit;

class Lean_Cart_Sublium_Subscriptions {

	public const EXT_NAMESPACE = 'kaupang_lean_cart_sublium';

	private ?array $recurring_carts_cache = null;

	public function __construct() {
		add_filter( 'kaupang/lean-cart/config', [ $this, 'extend_config' ] );
		add_filter( 'woocommerce_store_api_add_to_cart_data', [ $this, 'capture_add_to_cart_data' ], 10, 2 );
		add_action( 'woocommerce_add_to_cart', [ $this, 'apply_plan_after_add_to_cart' ], 20, 6 );
		add_action( 'woocommerce_blocks_loaded', [ $this, 'register_store_api_data' ] );
	}

	public function extend_config( array $config ): array {
		$config['i18n']['subliumSubscription'] = __( 'Abonnement', 'kaupang-lean-cart' );
		$config['i18n']['subliumRecurring']    = __( 'Fornyes', 'kaupang-lean-cart' );
		$config['i18n']['subliumToday']        = __( 'Betales i dag', 'kaupang-lean-cart' );
		$config['i18n']['subliumNextPayment']  = __( 'Neste betaling', 'kaupang-lean-cart' );
		$config['i18n']['subliumSignupFee']    = __( 'Oppstartsavgift', 'kaupang-lean-cart' );
		$config['i18n']['subliumTrial']        = __( 'Prøveperiode', 'kaupang-lean-cart' );

		return $config;
	}

	public function capture_add_to_cart_data( array $add_to_cart_data, \WP_REST_Request $request ): array {
		$raw_plan_id = $request->get_param( 'sublium_plan_id' );

		if ( null === $raw_plan_id ) {
			return $add_to_cart_data;
		}

		$plan_id = absint( $raw_plan_id );

		if ( $plan_id > 0 ) {
			$add_to_cart_data['cart_item_data']['kaupang_lean_cart_sublium_plan_id'] = $plan_id;
		}

		return $add_to_cart_data;
	}

	public function apply_plan_after_add_to_cart( $cart_item_key, $product_id, $quantity, $variation_id, $variation, $cart_item_data ): void {
		if ( empty( $cart_item_data['kaupang_lean_cart_sublium_plan_id'] ) ) {
			return;
		}

		if ( ! class_exists( '\Sublium_WCS\Includes\Helpers\PlanPrice' ) ) {
			return;
		}

		$plan_id = absint( $cart_item_data['kaupang_lean_cart_sublium_plan_id'] );
		if ( $plan_id <= 0 || empty( WC()->cart->cart_contents[ $cart_item_key ] ) ) {
			return;
		}

		$cart_item = WC()->cart->cart_contents[ $cart_item_key ];
		$result    = \Sublium_WCS\Includes\Helpers\PlanPrice::apply_plan_to_cart_item( $cart_item_key, $plan_id, $cart_item );

		if ( ! is_wp_error( $result ) ) {
			$this->set_initial_price_data( $cart_item_key, $plan_id );
			unset( WC()->cart->cart_contents[ $cart_item_key ]['kaupang_lean_cart_sublium_plan_id'] );
			WC()->cart->calculate_totals();
		}
	}

	public function register_store_api_data(): void {
		if ( ! function_exists( 'woocommerce_store_api_register_endpoint_data' ) ) {
			return;
		}

		woocommerce_store_api_register_endpoint_data( [
			'endpoint'        => \Automattic\WooCommerce\StoreApi\Schemas\V1\CartItemSchema::IDENTIFIER,
			'namespace'       => self::EXT_NAMESPACE,
			'data_callback'   => [ $this, 'cart_item_data' ],
			'schema_callback' => [ $this, 'cart_item_schema' ],
			'schema_type'     => ARRAY_A,
		] );

		woocommerce_store_api_register_endpoint_data( [
			'endpoint'        => \Automattic\WooCommerce\StoreApi\Schemas\V1\CartSchema::IDENTIFIER,
			'namespace'       => self::EXT_NAMESPACE,
			'data_callback'   => [ $this, 'cart_data' ],
			'schema_callback' => [ $this, 'cart_schema' ],
			'schema_type'     => ARRAY_A,
		] );
	}

	public function cart_item_data( array $cart_item ): array {
		if ( empty( $cart_item['sublium_wcs_plan'] ) ) {
			return [
				'is_sublium_subscription' => false,
			];
		}

		$plan_id = absint( $cart_item['sublium_wcs_plan'] );
		$product = $cart_item['data'] ?? null;
		$plan    = null;

		if ( $product instanceof \WC_Product && class_exists( '\Sublium_WCS\Includes\Main\Plans' ) ) {
			$plan = \Sublium_WCS\Includes\Main\Plans::get_plan_by_id( $plan_id, $product );
		}

		return [
			'is_sublium_subscription' => true,
			'plan_id'                 => $plan_id,
			'plan_type'               => $plan && method_exists( $plan, 'get_type' ) ? absint( $plan->get_type() ) : 0,
			'summary'                 => wp_strip_all_tags( $cart_item['sublium_wcs_plan_summary'] ?? '' ),
			'signup_fee'              => $this->price_to_minor_units( $cart_item['sublium_signup_fee'] ?? 0 ),
			'initial_price'           => $this->price_to_minor_units( $cart_item['sublium_initial_price'] ?? $cart_item['sublium_downpayment'] ?? 0 ),
			'has_downpayment'         => ! empty( $cart_item['sublium_enable_downpayment'] ),
			'trial_days'              => $plan && method_exists( $plan, 'get_free_trial' ) ? absint( $plan->get_free_trial() ) : 0,
			'next_payment_date'       => $plan && method_exists( $plan, 'get_next_payment_date' ) ? (string) $plan->get_next_payment_date() : '',
			'recurring_cart_key'      => '',
		];
	}

	public function cart_item_schema(): array {
		return [
			'is_sublium_subscription' => [
				'description' => __( 'Whether this item is a Sublium subscription item.', 'kaupang-lean-cart' ),
				'type'        => 'boolean',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
			'plan_id' => [
				'description' => __( 'Sublium plan ID.', 'kaupang-lean-cart' ),
				'type'        => 'integer',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
			'plan_type' => [
				'description' => __( 'Sublium plan type.', 'kaupang-lean-cart' ),
				'type'        => 'integer',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
			'summary' => [
				'description' => __( 'Sublium plan summary.', 'kaupang-lean-cart' ),
				'type'        => 'string',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
			'signup_fee' => [
				'description' => __( 'Sign-up fee in minor currency units.', 'kaupang-lean-cart' ),
				'type'        => 'integer',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
			'initial_price' => [
				'description' => __( 'Initial price in minor currency units.', 'kaupang-lean-cart' ),
				'type'        => 'integer',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
			'has_downpayment' => [
				'description' => __( 'Whether this item has a Sublium downpayment.', 'kaupang-lean-cart' ),
				'type'        => 'boolean',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
			'trial_days' => [
				'description' => __( 'Trial duration in days.', 'kaupang-lean-cart' ),
				'type'        => 'integer',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
			'next_payment_date' => [
				'description' => __( 'Next payment date.', 'kaupang-lean-cart' ),
				'type'        => 'string',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
			'recurring_cart_key' => [
				'description' => __( 'Recurring cart grouping key.', 'kaupang-lean-cart' ),
				'type'        => 'string',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
		];
	}

	public function cart_data(): array {
		$recurring_carts = $this->get_recurring_carts();

		if ( empty( $recurring_carts ) ) {
			return [
				'has_sublium_subscriptions' => false,
				'recurring_totals'          => [],
			];
		}

		$rows = [];
		foreach ( $recurring_carts as $key => $recurring_cart ) {
			if ( ! $recurring_cart instanceof \WC_Cart ) {
				continue;
			}

			$rows[] = [
				'key'               => (string) $key,
				'plan_id'           => absint( $recurring_cart->sublium_wcs_plan ?? 0 ),
				'plan_type'         => absint( $recurring_cart->sublium_wcs_plan_type ?? 0 ),
				'billing_period'    => (string) ( $recurring_cart->billing_interval ?? '' ),
				'billing_interval'  => absint( $recurring_cart->billing_frequency ?? 0 ),
				'next_payment_date' => (string) ( $recurring_cart->next_payment_date ?? '' ),
				'subtotal'          => $this->price_to_minor_units( $recurring_cart->get_displayed_subtotal() ),
				'shipping'          => $this->price_to_minor_units( $recurring_cart->get_shipping_total() ),
				'tax'               => $this->price_to_minor_units( $recurring_cart->get_total_tax() ),
				'discount'          => $this->price_to_minor_units( $recurring_cart->get_discount_total() ),
				'total'             => $this->price_to_minor_units( $recurring_cart->get_total( 'edit' ) ),
				'item_keys'         => array_keys( $recurring_cart->cart_contents ),
			];
		}

		return [
			'has_sublium_subscriptions' => ! empty( $rows ),
			'recurring_totals'          => $rows,
		];
	}

	public function cart_schema(): array {
		return [
			'has_sublium_subscriptions' => [
				'description' => __( 'Whether the cart contains Sublium subscriptions.', 'kaupang-lean-cart' ),
				'type'        => 'boolean',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
			],
			'recurring_totals' => [
				'description' => __( 'Recurring totals for Sublium subscription groups.', 'kaupang-lean-cart' ),
				'type'        => 'array',
				'context'     => [ 'view', 'edit' ],
				'readonly'    => true,
				'items'       => [
					'type'       => 'object',
					'properties' => [
						'key'               => [ 'type' => 'string' ],
						'plan_id'           => [ 'type' => 'integer' ],
						'plan_type'         => [ 'type' => 'integer' ],
						'billing_period'    => [ 'type' => 'string' ],
						'billing_interval'  => [ 'type' => 'integer' ],
						'next_payment_date' => [ 'type' => 'string' ],
						'subtotal'          => [ 'type' => 'integer' ],
						'shipping'          => [ 'type' => 'integer' ],
						'tax'               => [ 'type' => 'integer' ],
						'discount'          => [ 'type' => 'integer' ],
						'total'             => [ 'type' => 'integer' ],
						'item_keys'         => [
							'type'  => 'array',
							'items' => [ 'type' => 'string' ],
						],
					],
				],
			],
		];
	}

	private function get_recurring_carts(): array {
		if ( null !== $this->recurring_carts_cache ) {
			return $this->recurring_carts_cache;
		}

		if ( ! class_exists( '\Sublium_WCS\Includes\Main\Cart' ) || ! WC()->cart ) {
			$this->recurring_carts_cache = [];
			return $this->recurring_carts_cache;
		}

		$this->recurring_carts_cache = \Sublium_WCS\Includes\Main\Cart::get_recurring_carts();

		return $this->recurring_carts_cache;
	}

	private function set_initial_price_data( string $cart_item_key, int $plan_id ): void {
		if ( empty( WC()->cart->cart_contents[ $cart_item_key ] ) || ! class_exists( '\Sublium_WCS\Includes\Main\Plans' ) ) {
			return;
		}

		$cart_item = WC()->cart->cart_contents[ $cart_item_key ];
		$product   = $cart_item['data'] ?? null;

		if ( ! $product instanceof \WC_Product ) {
			return;
		}

		$plan = \Sublium_WCS\Includes\Main\Plans::get_plan_by_id( $plan_id, $product );
		if ( ! $plan ) {
			return;
		}

		if ( method_exists( $plan, 'is_downpayment_enabled' ) && $plan->is_downpayment_enabled() ) {
			WC()->cart->cart_contents[ $cart_item_key ]['sublium_initial_price'] = $cart_item['sublium_downpayment'] ?? 0;
			return;
		}

		if ( method_exists( $plan, 'calculate_initial_price' ) ) {
			WC()->cart->cart_contents[ $cart_item_key ]['sublium_initial_price'] = $plan->calculate_initial_price( $product->get_price(), $product );
		}
	}

	private function price_to_minor_units( $amount ): int {
		$decimals = wc_get_price_decimals();
		return (int) round( (float) $amount * ( 10 ** $decimals ) );
	}
}
