<?php
/**
 * Plugin Name: Mercaria E2E — W9 header stripper
 * Description: Removes X-WP-TotalPages from wc/v3 responses so runbook scenario W9 (a host behind a caching/security plugin that strips response headers) can actually be run. OFF unless explicitly enabled.
 * Version:     1.0.0
 *
 * A must-use plugin, so it cannot be deactivated from the admin UI by accident
 * and its state is one option rather than a file somebody might half-remove.
 *
 * WHAT IT STRIPS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * Only `X-WP-TotalPages`, and only on `/wc/v3` routes.
 *
 * `X-WP-Total` is left ALONE on purpose. W9 asks for two observations — every
 * product still imports, and NOTHING is archived — and the first needs an
 * independent oracle for how many products there actually are. Stripping both
 * would leave the measurement and the thing it measures reading the same
 * (absent) source, which is a check that cannot fail. A real caching plugin
 * would strip more; this strips exactly the header the scenario turns on.
 *
 * `/wp/v2` routes are untouched, which gives a positive control: if the header
 * is missing THERE too, something other than this plugin is eating headers.
 *
 * THE MARKER HEADER
 *
 * `X-Mercaria-E2E-Header-Strip: on|off` is added to every `/wc/v3` response
 * whether or not stripping is active. Its ABSENCE therefore means this plugin
 * is not installed at all, which is a different state from "installed and off" —
 * so a sibling can tell from any single response which of the three they are
 * measuring, and can attribute a run to the right mode afterwards.
 *
 * @package Mercaria_E2E
 */

defined( 'ABSPATH' ) || exit;

const MERCARIA_E2E_STRIP_OPTION = 'mercaria_e2e_strip_totalpages';
const MERCARIA_E2E_STRIP_HEADER = 'X-WP-TotalPages';
const MERCARIA_E2E_MARKER_HEADER = 'X-Mercaria-E2E-Header-Strip';

/**
 * Is stripping enabled? Default OFF — an absent option must never read as on.
 */
function mercaria_e2e_strip_enabled(): bool {
	return '1' === (string) get_option( MERCARIA_E2E_STRIP_OPTION, '' );
}

add_filter(
	'rest_post_dispatch',
	/**
	 * @param WP_HTTP_Response $response Response object.
	 * @param WP_REST_Server   $server   Server instance.
	 * @param WP_REST_Request  $request  Request used to generate the response.
	 * @return WP_HTTP_Response
	 */
	static function ( $response, $server, $request ) {
		unset( $server );

		if ( ! $response instanceof WP_HTTP_Response || ! $request instanceof WP_REST_Request ) {
			return $response;
		}

		$route = (string) $request->get_route();
		if ( 0 !== strpos( $route, '/wc/v3' ) ) {
			return $response;
		}

		$enabled = mercaria_e2e_strip_enabled();
		$headers = $response->get_headers();

		if ( $enabled ) {
			// Header names are case-insensitive on the wire, so remove by
			// comparison rather than by the one spelling WordPress happens to
			// use today.
			foreach ( array_keys( $headers ) as $name ) {
				if ( 0 === strcasecmp( (string) $name, MERCARIA_E2E_STRIP_HEADER ) ) {
					unset( $headers[ $name ] );
				}
			}
		}

		$headers[ MERCARIA_E2E_MARKER_HEADER ] = $enabled ? 'on' : 'off';
		$response->set_headers( $headers );

		return $response;
	},
	// Late, so anything else that adds the header has already done so.
	PHP_INT_MAX,
	3
);
