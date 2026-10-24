/**
 * Mix and Match extension module.
 *
 * Registers a normalizer that reads MnM parent-child data
 * from Store API extensions and restructures flat cart items
 * into nested groups.
 *
 * After all items are normalized, a post-processor groups
 * children under their parent containers.
 */

import config from '@kaupang/lean-cart/config';

export function init( store ) {
	// Feed MnM child quantities into the Store API add-to-cart call.
	// Without this, Lean Cart's form interception strips the MnM payload
	// and the container is added with 0 price and no children.
	store.addFormExtractor( ( form ) => {
		if ( ! form.classList.contains( 'mnm_form' ) ) return null;

		const mnmConfig = {};
		// Inputs are named "mnm_quantity[<child_id>]" where <child_id> is
		// the child product_id (or variation_id if a variation is selected).
		form.querySelectorAll( 'input[name^="mnm_quantity"]' ).forEach( ( el ) => {
			if ( el.type === 'checkbox' && ! el.checked ) return;
			const m = el.name.match( /mnm_quantity\[(\d+)\]/ );
			if ( ! m ) return;
			const qty = Number( el.value );
			if ( ! Number.isFinite( qty ) || qty <= 0 ) return;
			mnmConfig[ m[1] ] = ( mnmConfig[ m[1] ] || 0 ) + qty;
		} );

		// Always send mnm_config (even when empty) so MnM's validator
		// can reject a misconfigured container instead of silently
		// letting it through with 0 price.
		return { mnm_config: mnmConfig };
	} );

	// Phase 1: Mark individual items as containers or children.
	store.addNormalizer( ( item, raw ) => {
		const ext = raw.extensions?.mix_and_match;
		if ( ! ext ) return item;

		// Container: has child_items array.
		if ( Array.isArray( ext.child_items ) && ext.child_items.length > 0 ) {
			item.type = 'mix-and-match';
			item.childKeys = ext.child_items;
			item.badges.push( config.i18n?.mnmContainer || 'Sammensetning' );
		}

		// Child: has a container reference.
		if ( ext.container ) {
			item.isChild = true;
			item.parentKey = ext.container;
		}

		return item;
	} );

	// Phase 2: Nest children under their parent containers.
	//
	// This runs as a cart normalizer, not a `lean-cart:updated`
	// listener: normalizers execute inside normalizeCart(), before
	// the store commits and emits the event, so the restructured
	// (nested) shape is already in place when the renderer runs. A
	// post-commit event listener would race the renderer — the UI
	// subscribes to lean-cart:updated first (and the MnM module is
	// loaded via async import, so its listener would register even
	// later), leaving children unrendered until a subsequent commit.
	store.addCartNormalizer( ( cart ) => {
		const containers = new Map();

		for ( const item of cart.items ) {
			if ( item.childKeys ) {
				item.children = [];
				containers.set( item.key, item );
			}
		}

		// Nothing to restructure if no MnM containers.
		if ( containers.size === 0 ) return cart;

		const restructured = [];

		for ( const item of cart.items ) {
			if ( item.isChild && item.parentKey && containers.has( item.parentKey ) ) {
				containers.get( item.parentKey ).children.push( item );
			} else {
				restructured.push( item );
			}
		}

		cart.items = restructured;
		return cart;
	} );
}
