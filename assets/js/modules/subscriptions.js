/**
 * Subscriptions extension module.
 *
 * Registers a normalizer that reads subscription data from
 * the Store API extensions and enriches the cart item model
 * with billing summaries, badges, and meta rows.
 */

import config from '@kaupang/lean-cart/config';

function buildBillingSummary( ext ) {
	const periods = config.subscriptionPeriods || {};
	const intervals = config.subscriptionIntervals || {};

	const period = periods[ ext.billing_period ] || ext.billing_period;
	const interval = parseInt( ext.billing_interval, 10 ) || 1;

	if ( interval === 1 ) {
		return ( intervals.singular || 'Hver %s' ).replace( '%s', period );
	}
	return ( intervals.plural || 'Hver %1$d. %2$s' )
		.replace( '%1$d', interval )
		.replace( '%2$s', period );
}

export function init( store ) {
	store.addNormalizer( ( item, raw ) => {
		const ext = raw.extensions?.subscriptions;
		if ( ! ext || ! ext.billing_period ) return item;

		item.type = 'subscription';
		item.subscriptionSummary = buildBillingSummary( ext );
		item.badges.push( config.i18n?.subscription || 'Abonnement' );

		// Sign-up fee.
		const signupFee = parseInt( ext.sign_up_fees || 0, 10 );
		if ( signupFee > 0 ) {
			item.metaRows.push( {
				key: 'signup_fee',
				value: `${ config.i18n?.signupFee || 'Oppstartsavgift' }: ${ store.formatPrice( signupFee ) }`,
			} );
		}

		// Trial period.
		const trialLength = parseInt( ext.trial_length || 0, 10 );
		if ( trialLength > 0 ) {
			const trialPeriod = ( config.subscriptionPeriods || {} )[ ext.trial_period ] || ext.trial_period;
			item.metaRows.push( {
				key: 'trial',
				value: `${ config.i18n?.freeTrial || 'Gratis prøveperiode' }: ${ trialLength } ${ trialPeriod }`,
			} );
		}

		return item;
	} );
}
