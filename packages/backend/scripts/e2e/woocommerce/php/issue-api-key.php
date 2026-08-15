<?php
/**
 * Mint a WooCommerce REST API key with READ/WRITE permissions.
 *
 * This is the same thing WooCommerce's own admin screen does — WC_Admin_API_Keys
 * generates `ck_`/`cs_` values with `wc_rand_hash()`, stores the CONSUMER KEY as
 * an HMAC (`wc_api_hash`) and the secret verbatim, and keeps the last seven
 * characters as `truncated_key` for the admin list. Nothing here reaches around
 * WooCommerce: `wc_rand_hash`, `wc_api_hash` and the `woocommerce_api_keys`
 * table are WooCommerce's own, so the key this produces is indistinguishable
 * from one created in the browser.
 *
 * Read/Write is required rather than convenient: webhook registration is a POST,
 * and a read-only key makes every registration a refusal (runbook W7).
 *
 * The plaintext key and secret exist exactly once — in the single JSON line this
 * writes to stdout. The caller is responsible for putting them somewhere with
 * mode 600 and never echoing them.
 *
 * Usage:  wp eval-file issue-api-key.php [description]
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit( 1 );
}

global $wpdb;

if ( ! function_exists( 'wc_rand_hash' ) || ! function_exists( 'wc_api_hash' ) ) {
	WP_CLI::error( 'WooCommerce is not loaded — activate it first.' );
}

$description = isset( $args[0] ) && '' !== $args[0] ? $args[0] : 'Mercaria e2e (#69)';

$user = get_user_by( 'login', 'mercaria_e2e' );
if ( ! $user ) {
	// Fall back to the first administrator, so a differently-named admin still works.
	$admins = get_users( array( 'role' => 'administrator', 'number' => 1 ) );
	$user   = $admins ? $admins[0] : null;
}
if ( ! $user ) {
	WP_CLI::error( 'no administrator account to attach the key to.' );
}
if ( ! user_can( $user, 'manage_woocommerce' ) ) {
	WP_CLI::error( 'user ' . $user->user_login . ' cannot manage_woocommerce, so its key would be refused by every WooCommerce REST route.' );
}

$table = $wpdb->prefix . 'woocommerce_api_keys';

// Revoke any key this script previously issued. A consumer key is stored as a
// one-way hash, so an existing row can never be recovered — leaving it behind
// would accumulate live credentials nobody holds.
$revoked = (int) $wpdb->query( $wpdb->prepare( "DELETE FROM {$table} WHERE description = %s", $description ) ); // phpcs:ignore

$consumer_key    = 'ck_' . wc_rand_hash();
$consumer_secret = 'cs_' . wc_rand_hash();

$inserted = $wpdb->insert(
	$table,
	array(
		'user_id'         => $user->ID,
		'description'     => $description,
		'permissions'     => 'read_write',
		'consumer_key'    => wc_api_hash( $consumer_key ),
		'consumer_secret' => $consumer_secret,
		'truncated_key'   => substr( $consumer_key, -7 ),
	),
	array( '%d', '%s', '%s', '%s', '%s', '%s' )
);

if ( ! $inserted ) {
	WP_CLI::error( 'could not insert the API key row: ' . $wpdb->last_error );
}

$row = $wpdb->get_row( $wpdb->prepare( "SELECT key_id, permissions FROM {$table} WHERE key_id = %d", $wpdb->insert_id ) ); // phpcs:ignore
if ( ! $row || 'read_write' !== $row->permissions ) {
	WP_CLI::error( 'the key was written but did not read back as read_write.' );
}

// stdout carries ONLY this line: the caller parses it and must not log it.
echo wp_json_encode(
	array(
		'siteUrl'        => untrailingslashit( get_option( 'siteurl' ) ),
		'consumerKey'    => $consumer_key,
		'consumerSecret' => $consumer_secret,
		'keyId'          => (int) $row->key_id,
		'permissions'    => $row->permissions,
		'userLogin'      => $user->user_login,
		'description'    => $description,
		'revokedPrior'   => $revoked,
	)
);
echo "\n";
