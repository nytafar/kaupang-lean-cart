/**
 * kaupang-subscriptions extension module.
 *
 * Maps the plugin's Store API data (cart item `extensions['kaupang-subscriptions']`,
 * plan §11.2) to the cart's neutral fields, so the cart's UI names no engine:
 * purchaseMode, a badge, the cadence (subscriptionSummary), whether the line
 * joins the customer's package (subscriptionNote), and the choice between
 * one-time and the plan's rhythms (planChoice), each option carrying the
 * `set_plan` update it sends. The product page's plan field reaches the
 * add-to-cart request through kaupang-subscriptions' own form extractor.
 */

import config from '@kaupang/lean-cart/config';

const NS = 'kaupang-subscriptions';

export function init( store ) {
	const t = config.i18n || {};
	const every = ( n ) => n === 1 ? t.everyDelivery || 'hver levering'
		: n === 2 ? t.everyOther || 'annenhver levering'
		: ( t.everyNth || 'hver %d. levering' ).replace( '%d', n );
	const price = ( minor ) => Number.isFinite( minor ) ? store.formatPrice( minor ) : '';

	store.addNormalizer( ( item, raw ) => {
		const ext = raw.extensions?.[ NS ];
		if ( ! ext ) return item;
		const options = Array.isArray( ext.options ) ? ext.options : [];

		if ( ext.recurring ) {
			item.purchaseMode = 'subscription';
			item.badges.push( t.subscription || 'Abonnement' );
			item.subscriptionSummary = ext.label || null;
			if ( ext.into_package && ext.every > 0 ) {
				item.subscriptionNote = ( t.joinsPackage || 'Blir med i pakken din, %s' ).replace( '%s', every( ext.every ) );
			}
		} else if ( options.length ) {
			item.purchaseMode = 'one-time';
		}

		if ( options.length ) {
			const choose = ( rhythm ) => ( { namespace: NS, data: { action: 'set_plan', key: item.key, rhythm } } );
			item.planChoice = {
				label: t.planChoice || 'Kjøp',
				options: [
					{ label: t.oneTime || 'Engangskjøp', price: price( ext.one_time_price ), selected: ! ext.recurring, update: choose( '0' ) },
					...options.map( o => ( { label: o.label, price: price( o.price ), selected: !! ext.recurring && o.key === ext.rhythm, update: choose( o.key ) } ) ),
				],
			};
		}

		return item;
	} );
}
