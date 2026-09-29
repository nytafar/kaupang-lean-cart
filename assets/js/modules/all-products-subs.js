/**
 * All Products for WooCommerce Subscriptions extension module.
 *
 * Registers a normalizer that reads APfS scheme data from the
 * custom Store API extension (kaupang_lean_cart_apfs) and sets the
 * purchaseMode on each cart item.
 */

const config = window.leanCartConfig;

export function init( store ) {
	// Lift the chosen purchase plan (APfS scheme radios) into the
	// Store API add-item payload — the same fields a classic submit
	// would post. PHP relays them into $_REQUEST so APfS's own
	// add-to-cart handler applies the scheme.
	store.addFormExtractor( ( form ) => {
		const checked = form.querySelectorAll(
			'input[name^="convert_to_sub"]:checked'
		);
		if ( ! checked.length ) return null;

		const fields = {};
		checked.forEach( ( input ) => {
			fields[ input.name ] = input.value;
		} );
		return fields;
	} );

	store.addNormalizer( ( item, raw ) => {
		const ext = raw.extensions?.kaupang_lean_cart_apfs;
		if ( ! ext ) return item;

		if ( ext.is_subscription ) {
			item.purchaseMode = 'subscription';
			if ( ext.scheme_description ) {
				item.subscriptionSummary = item.subscriptionSummary || ext.scheme_description;
			}
			if ( ! item.badges.includes( config.i18n?.purchaseSubscribe || 'Abonnement' ) ) {
				item.badges.push( config.i18n?.purchaseSubscribe || 'Abonnement' );
			}
		} else {
			item.purchaseMode = 'one-time';
		}

		return item;
	} );
}
