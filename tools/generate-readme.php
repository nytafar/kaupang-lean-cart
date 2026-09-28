#!/usr/bin/env php
<?php
/**
 * Generate WordPress-compliant readme.txt from README.md + readme.meta.json.
 *
 * Usage: php tools/generate-readme.php
 *
 * Reads README.md as the canonical source, CHANGELOG.md for the changelog and readme.meta.json for WP metadata.
 * Outputs a simplified readme.txt that passes the WordPress.org validator.
 *
 * This script is run automatically by the pre-commit hook.
 */

$root = dirname( __DIR__ );
$meta_file = $root . '/readme.meta.json';
$md_file   = $root . '/README.md';
$out_file  = $root . '/readme.txt';

if ( ! file_exists( $meta_file ) ) {
	fwrite( STDERR, "Error: readme.meta.json not found.\n" );
	exit( 1 );
}
if ( ! file_exists( $md_file ) ) {
	fwrite( STDERR, "Error: README.md not found.\n" );
	exit( 1 );
}

$meta = json_decode( file_get_contents( $meta_file ), true );
$md   = file_get_contents( $md_file );

/**
 * Extract a markdown section by ## heading.
 */
function section( string $md, string $title ): string {
	$escaped = preg_quote( $title, '/' );
	$pattern = '/^##\s+' . $escaped . '\s*$\R(.*?)(?=^##\s|\z)/ms';
	return preg_match( $pattern, $md, $m ) ? trim( $m[1] ) : '';
}

/**
 * Strip GitHub-only elements: badges, images, details blocks, HTML tags,
 * fenced code blocks (not supported in WP readme), and horizontal rules.
 */
function strip_github( string $text ): string {
	// Remove badge images.
	$text = preg_replace( '/\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)/', '', $text );
	// Remove standalone images.
	$text = preg_replace( '/!\[[^\]]*\]\([^)]+\)/', '', $text );
	// Remove <details> blocks.
	$text = preg_replace( '/<details[\s\S]*?<\/details>/mi', '', $text );
	// Remove horizontal rules.
	$text = preg_replace( '/^---+\s*$/m', '', $text );
	// Convert fenced code blocks to indented code (WP readme format).
	$text = preg_replace_callback( '/^```[a-z]*\n(.*?)^```/ms', function( $m ) {
		return preg_replace( '/^/m', '    ', $m[1] );
	}, $text );
	// Collapse multiple blank lines.
	$text = preg_replace( '/\n{3,}/', "\n\n", $text );
	return trim( $text );
}

/**
 * Convert markdown headings to WP readme format.
 * ### heading -> = heading =
 */
function convert_headings( string $text ): string {
	$text = preg_replace( '/^###\s+(.+)$/m', '= $1 =', $text );
	return $text;
}

/**
 * Convert FAQ from markdown to WP format.
 * **Question?** -> = Question? =
 */
function convert_faq( string $text ): string {
	$text = preg_replace( '/^\*\*(.+?)\*\*\s*$/m', '= $1 =', $text );
	return $text;
}

/**
 * Convert CHANGELOG.md (Keep a Changelog) to WP readme format: drop [Unreleased], ## [x.y.z] - date -> = x.y.z =.
 */
function convert_changelog( string $text ): string {
	$text = preg_replace( '/^## \[Unreleased\].*?(?=^## |\z)/ms', '', $text );
	$text = preg_replace( '/^## \[([^\]]+)\].*$/m', '= $1 =', $text );
	$text = preg_replace( '/^### (.+)$/m', '$1:', $text );
	$text = preg_replace( '/^- /m', '* ', $text );
	return $text;
}

// Build output.
$out = array();

// Header block.
$out[] = '=== ' . $meta['pluginName'] . ' ===';
$out[] = 'Contributors: ' . implode( ', ', $meta['contributors'] );
if ( ! empty( $meta['authorURI'] ) ) {
	$out[] = 'Author URI: ' . $meta['authorURI'];
}
$out[] = 'Tags: ' . implode( ', ', $meta['tags'] );
$out[] = 'Requires at least: ' . $meta['requiresAtLeast'];
$out[] = 'Tested up to: ' . $meta['testedUpTo'];
$out[] = 'Requires PHP: ' . $meta['requiresPHP'];
$out[] = 'Stable tag: ' . $meta['stableTag'];
$out[] = 'License: ' . $meta['license'];
$out[] = 'License URI: ' . $meta['licenseUri'];
$out[] = '';
$out[] = $meta['shortDescription'];

// Description.
$desc = section( $md, 'Description' );
if ( $desc ) {
	$out[] = '';
	$out[] = '== Description ==';
	$out[] = '';
	$out[] = strip_github( convert_headings( $desc ) );
}

// Installation.
$install = section( $md, 'Installation' );
if ( $install ) {
	$out[] = '';
	$out[] = '== Installation ==';
	$out[] = '';
	$out[] = strip_github( $install );
}

// Usage.
$usage = section( $md, 'Usage' );
if ( $usage ) {
	$out[] = '';
	$out[] = '== Usage ==';
	$out[] = '';
	$out[] = strip_github( convert_headings( $usage ) );
}

// FAQ.
$faq = section( $md, 'FAQ' );
if ( $faq ) {
	$out[] = '';
	$out[] = '== Frequently Asked Questions ==';
	$out[] = '';
	$out[] = strip_github( convert_faq( $faq ) );
}

// Screenshots (no admin UI — headless cart).
$out[] = '';
$out[] = '== Screenshots ==';
$out[] = '';
$out[] = 'No screenshots. Lean Cart is a headless cart layer with no admin interface — all visual output is controlled by your theme.';

// Changelog: CHANGELOG.md (Keep a Changelog) from the first version section on.
$changelog = is_file( $root . '/CHANGELOG.md' ) ? convert_changelog( (string) file_get_contents( $root . '/CHANGELOG.md' ) ) : '';
$changelog = preg_match( '/^= .*/ms', $changelog, $cm ) ? trim( $cm[0] ) : '';
if ( $changelog ) {
	$out[] = '';
	$out[] = '== Changelog ==';
	$out[] = '';
	$out[] = strip_github( $changelog );
}

$result = implode( "\n", $out ) . "\n";
file_put_contents( $out_file, $result );

$size = strlen( $result );
fwrite( STDERR, "Generated readme.txt ({$size} bytes)\n" );
