<?php
// Read by `wp kaupang-assets audit --budget`. Unlisted page types fall back to '*', then to the default (2 files, nothing else).
// Lean Cart renders on every page (header count, drawer): see README "Load map".
return [
	'autoload' => [],
	'pages'    => [
		// Main, Lean_Cart, Assets, Hooks, Notices, plus one class per active extension plugin
		// (staging: Subscriptions, Mix and Match, All Products for Subscriptions).
		'*'             => [ 'files' => 8, 'handles' => [], 'modules' => [ '@kaupang/lean-cart/init' ] ],
		// The order review's lines show with the page, so the stylesheet is in <head>.
		'checkout'      => [ 'handles' => [ 'kaupang-lean-cart-styles' ] ],
		// lean-checkout's summary is Lean Cart's markup; lean-checkout enqueues the sheet there.
		'lean_checkout' => [ 'handles' => [ 'kaupang-lean-cart-styles' ] ],
	],
];
