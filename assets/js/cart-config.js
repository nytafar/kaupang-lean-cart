/**
 * Cart Config — the settings PHP passes in.
 *
 * Core prints them as JSON (filter `script_module_data_@kaupang/lean-cart/config`,
 * Lean_Cart_Assets::module_data()). Every module that needs them imports this one.
 */

export default JSON.parse( document.getElementById( 'wp-script-module-data-@kaupang/lean-cart/config' )?.textContent || '{}' );
