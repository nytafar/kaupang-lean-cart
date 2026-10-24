/**
 * Sublium Subscriptions extension module.
 *
 * Carries selected Sublium plan IDs through Lean Cart's Store API
 * add-to-cart flow and normalizes Sublium Store API extension data.
 */

import config from '@kaupang/lean-cart/config';

function findPlanInput( form ) {
	return form.querySelector(
		'input.sublium-option-plan, input.sublium_option_plan, input[name^="sublium-option-plan-single-product-"], input[name^="sublium_option_plan_single_product_"], input[name="sublium-option-plan"]'
	);
}

function readPlanId( form ) {
	const input = findPlanInput( form );
	if ( ! input ) return null;

	const value = Number( input.value );
	if ( ! Number.isFinite( value ) || value < 0 ) return null;

	return value;
}

export function init( store ) {
	store.addFormExtractor( ( form ) => {
		const planId = readPlanId( form );
		if ( planId === null ) return null;

		return { sublium_plan_id: planId };
	} );

	store.addNormalizer( ( item, raw ) => {
		const ext = raw.extensions?.kaupang_lean_cart_sublium;
		if ( ! ext || ! ext.is_sublium_subscription ) return item;

		item.type = 'sublium-subscription';
		item.purchaseMode = 'subscription';
		item.badges.push( config.i18n?.subliumSubscription || 'Abonnement' );

		if ( ext.summary ) {
			item.subscriptionSummary = ext.summary;
		}

		if ( ext.signup_fee > 0 ) {
			item.metaRows.push( {
				key: 'sublium_signup_fee',
				value: `${ config.i18n?.subliumSignupFee || 'Oppstartsavgift' }: ${ store.formatPrice( ext.signup_fee ) }`,
			} );
		}

		if ( ext.trial_days > 0 ) {
			item.metaRows.push( {
				key: 'sublium_trial',
				value: `${ config.i18n?.subliumTrial || 'Prøveperiode' }: ${ ext.trial_days }`,
			} );
		}

		item.sublium = ext;
		return item;
	} );

	store.addCartNormalizer( ( cart, raw ) => {
		const ext = raw.extensions?.kaupang_lean_cart_sublium;
		if ( ! ext || ! Array.isArray( ext.recurring_totals ) ) return cart;

		cart.recurringTotals = ext.recurring_totals.map( total => ( {
			key: total.key,
			planId: total.plan_id,
			planType: total.plan_type,
			billingPeriod: total.billing_period,
			billingInterval: total.billing_interval,
			nextPaymentDate: total.next_payment_date,
			subtotal: store.formatPrice( total.subtotal || 0 ),
			shipping: store.formatPrice( total.shipping || 0 ),
			tax: store.formatPrice( total.tax || 0 ),
			discount: store.formatPrice( total.discount || 0 ),
			total: store.formatPrice( total.total || 0 ),
			itemKeys: total.item_keys || [],
		} ) );

		return cart;
	} );
}
