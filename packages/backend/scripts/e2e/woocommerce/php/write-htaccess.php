<?php
/**
 * Write the rewrite rules WordPress itself generates into `.htaccess`.
 *
 * `wp rewrite flush --hard` refuses with "Regenerating a .htaccess file requires
 * special configuration" and writes NOTHING, because `got_mod_rewrite()` asks
 * `apache_get_modules()` — and WP-CLI runs in a PHP-CLI container that is not
 * Apache and never will be. The rules are still correct for the Apache container
 * that serves the site, so this writes exactly what
 * `WP_Rewrite::mod_rewrite_rules()` produces, through WordPress's own
 * `insert_with_markers`.
 *
 * This is load-bearing, not cosmetic: with the default (plain) permalink
 * structure WordPress serves the REST API only at `?rest_route=`, and the
 * connector builds `{site}/wp-json/wc/v3`, so `/wp-json/…` would 404.
 *
 * The `HTTP_AUTHORIZATION` line the rules carry is what preserves the
 * `Authorization: Basic …` header WooCommerce's REST authentication reads.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit( 1 );
}

global $wp_rewrite;

if ( '' === get_option( 'permalink_structure' ) ) {
	WP_CLI::error( 'no permalink structure is set — run `wp rewrite structure` first.' );
}

$rules = $wp_rewrite->mod_rewrite_rules();
if ( ! is_string( $rules ) || '' === trim( $rules ) ) {
	WP_CLI::error( 'WordPress produced no rewrite rules.' );
}

$path = ABSPATH . '.htaccess';
if ( ! insert_with_markers( $path, 'WordPress', explode( "\n", $rules ) ) ) {
	WP_CLI::error( 'could not write ' . $path );
}

// Read it back: a write that silently did nothing is exactly the failure mode
// the WP-CLI warning above already represents once.
$written = file_get_contents( $path );
if ( ! is_string( $written ) || false === strpos( $written, 'RewriteRule' ) ) {
	WP_CLI::error( $path . ' does not contain the rewrite rules after writing.' );
}

WP_CLI::success( 'wrote ' . strlen( $written ) . ' bytes of rewrite rules to .htaccess' );
