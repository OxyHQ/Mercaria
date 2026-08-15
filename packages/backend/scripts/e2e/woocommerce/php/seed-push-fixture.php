<?php
/**
 * A small fixture in its OWN SKU and barcode namespace, for the plugin-push
 * scenarios (#69 §4.3 / plugin scenarios 3, 4 and 8).
 *
 * WHY IT EXISTS. `product_variants_sku_key` is `UNIQUE (sku) WHERE sku IS NOT
 * NULL` with **no store scope**, and `product_variants_barcode_key` is the same
 * (Mercaria #296). The pull connection already owns every `MERC-E2E-*` SKU in
 * that database, so pushing the main catalogue fails every product — in a
 * different store, which makes no difference. This fixture collides with
 * nothing, so a push scenario measures the ingest rather than the unique index.
 *
 * THE BARCODES ARE DELIBERATE. Every product and variation carries an EAN-13 in
 * the **`029` restricted-distribution prefix**, which GS1 reserves for in-store
 * and internal use and never assigns to a real product — so these can never
 * collide with a genuine GTIN, which is the half of #296 that matters most (two
 * merchants selling the same phone share a GTIN by definition). Check digits are
 * computed rather than typed, so every one is a structurally valid EAN-13.
 *
 * The plugin reads a barcode through `WC_Product::get_global_unique_id()`
 * (`class-mercaria-wc-product-mapper.php` `get_barcode`), which is WooCommerce
 * 9.2+'s GTIN field — so that is the field set here. Before this fixture, NO
 * product on this site carried one, so the barcode path had never been
 * exercised at all.
 *
 * STOCK IS MANAGED AT THE VARIATION LEVEL, DELIBERATELY. The variable product's
 * parent does NOT manage stock, so no variation can report `manage_stock:
 * 'parent'`. That shape is the subject of plugin issue #1 and belongs in a
 * fixture built to reproduce it — not in one built to measure the ingest, where
 * it would re-measure the oversell instead.
 *
 * Idempotent: a completed run records its version and a re-run reports rather
 * than duplicating.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit( 1 );
}

const MERCPUSH_VERSION     = '1';
const MERCPUSH_OPTION      = 'mercaria_push_fixture_version';
const MERCPUSH_SKU_PREFIX  = 'MERCPUSH-';
/** GS1 restricted-distribution prefix: reserved for internal use, never a real product. */
const MERCPUSH_EAN_PREFIX  = '029';
const MERCPUSH_SIMPLE_COUNT = 7;

if ( ! class_exists( 'WooCommerce' ) ) {
	WP_CLI::error( 'WooCommerce is not active.' );
}

if ( get_option( MERCPUSH_OPTION ) === MERCPUSH_VERSION ) {
	WP_CLI::log( 'Push fixture already seeded at version ' . MERCPUSH_VERSION . '.' );
	mercpush_report();
	return;
}

require_once ABSPATH . 'wp-admin/includes/image.php';

/**
 * Build a structurally valid EAN-13 from a 9-digit body, in the 029 prefix.
 * The check digit is COMPUTED — a hand-typed one that fails validation would
 * make a barcode-rejection test pass for the wrong reason.
 */
function mercpush_ean( int $sequence ): string {
	$body = MERCPUSH_EAN_PREFIX . str_pad( (string) $sequence, 9, '0', STR_PAD_LEFT );
	if ( 12 !== strlen( $body ) ) {
		WP_CLI::error( 'EAN body is not 12 digits: ' . $body );
	}
	$sum = 0;
	for ( $i = 0; $i < 12; $i++ ) {
		$sum += (int) $body[ $i ] * ( 0 === $i % 2 ? 1 : 3 );
	}
	$check = ( 10 - ( $sum % 10 ) ) % 10;
	return $body . $check;
}

/** A real PNG attachment, in this fixture's own namespace. */
function mercpush_image( string $slug, array $rgb ): int {
	$uploads = wp_upload_dir();
	$path    = trailingslashit( $uploads['path'] ) . 'mercaria-push-' . $slug . '.png';

	$image = imagecreatetruecolor( 500, 500 );
	imagefilledrectangle( $image, 0, 0, 499, 499, imagecolorallocate( $image, $rgb[0], $rgb[1], $rgb[2] ) );
	imagestring( $image, 5, 20, 240, 'PUSH ' . strtoupper( $slug ), imagecolorallocate( $image, 255, 255, 255 ) );
	if ( ! imagepng( $image, $path ) ) {
		WP_CLI::error( 'could not write ' . $path );
	}
	imagedestroy( $image );

	$id = wp_insert_attachment(
		array( 'post_mime_type' => 'image/png', 'post_title' => 'Mercaria push ' . $slug, 'post_status' => 'inherit' ),
		$path
	);
	if ( is_wp_error( $id ) || ! $id ) {
		WP_CLI::error( 'attachment failed for ' . $slug );
	}
	wp_update_attachment_metadata( $id, wp_generate_attachment_metadata( $id, $path ) );
	return (int) $id;
}

$img_a = mercpush_image( 'alpha', array( 40, 90, 140 ) );
$img_b = mercpush_image( 'beta', array( 150, 60, 60 ) );

$ean = 1;

// --- the variable product: 2 axes, VARIATION-level stock -------------------

$variable = new WC_Product_Variable();
$variable->set_name( 'Mercaria Push Jacket' );
$variable->set_sku( MERCPUSH_SKU_PREFIX . 'VAR-JACKET' );
$variable->set_status( 'publish' );
$variable->set_catalog_visibility( 'visible' );
$variable->set_description( '<p>Push fixture: two option axes, stock managed on each variation.</p>' );
// NOT parent-managed, deliberately: no variation may report manage_stock 'parent'.
$variable->set_manage_stock( false );
$variable->set_global_unique_id( mercpush_ean( $ean++ ) );
$variable->set_image_id( $img_a );
$variable->set_gallery_image_ids( array( $img_b ) );

$axis_colour = new WC_Product_Attribute();
$axis_colour->set_id( 0 );
$axis_colour->set_name( 'Shade' );
$axis_colour->set_options( array( 'Indigo', 'Ochre', 'Verdigris' ) );
$axis_colour->set_position( 0 );
$axis_colour->set_visible( true );
$axis_colour->set_variation( true );

$axis_size = new WC_Product_Attribute();
$axis_size->set_id( 0 );
$axis_size->set_name( 'Fit' );
$axis_size->set_options( array( 'Regular', 'Tall' ) );
$axis_size->set_position( 1 );
$axis_size->set_visible( true );
$axis_size->set_variation( true );

$variable->set_attributes( array( $axis_colour, $axis_size ) );
$variable_id = $variable->save();
if ( ! $variable_id ) {
	WP_CLI::error( 'the push variable product did not save.' );
}

$variation_n = 0;
foreach ( array( 'Indigo', 'Ochre', 'Verdigris' ) as $shade ) {
	foreach ( array( 'Regular', 'Tall' ) as $fit ) {
		++$variation_n;
		$variation = new WC_Product_Variation();
		$variation->set_parent_id( $variable_id );
		$variation->set_status( 'publish' );
		$variation->set_sku( sprintf( '%sVAR-JACKET-%02d', MERCPUSH_SKU_PREFIX, $variation_n ) );
		$variation->set_global_unique_id( mercpush_ean( $ean++ ) );
		$variation->set_regular_price( number_format( 74 + $variation_n * 2.5, 2, '.', '' ) );
		$variation->set_attributes( array( 'shade' => $shade, 'fit' => $fit ) );
		// Each variation owns its stock. No inheritance anywhere in this fixture.
		$variation->set_manage_stock( true );
		$variation->set_stock_quantity( 5 + $variation_n * 3 );
		$variation->set_stock_status( 'instock' );
		if ( ! $variation->save() ) {
			WP_CLI::error( 'push variation ' . $variation_n . ' did not save.' );
		}
	}
}
WC_Product_Variable::sync( $variable_id );

// --- the simple products ---------------------------------------------------

$simple_ids = array();
for ( $i = 1; $i <= MERCPUSH_SIMPLE_COUNT; $i++ ) {
	$product = new WC_Product_Simple();
	$product->set_name( sprintf( 'Mercaria Push Item %02d', $i ) );
	$product->set_sku( sprintf( '%sSIMPLE-%02d', MERCPUSH_SKU_PREFIX, $i ) );
	$product->set_status( 'publish' );
	$product->set_catalog_visibility( 'visible' );
	$product->set_regular_price( number_format( 9 + $i * 3.5, 2, '.', '' ) );
	$product->set_description( 'Push fixture simple product ' . $i . '.' );
	$product->set_global_unique_id( mercpush_ean( $ean++ ) );
	$product->set_manage_stock( true );
	$product->set_stock_quantity( 4 + $i * 2 );
	$product->set_stock_status( 'instock' );

	// Item 01 carries SEVERAL images; item 02 carries NONE; the rest carry one.
	if ( 1 === $i ) {
		$product->set_image_id( $img_a );
		$product->set_gallery_image_ids( array( $img_b ) );
	} elseif ( 2 === $i ) {
		$product->set_image_id( 0 );
	} else {
		$product->set_image_id( 0 === $i % 2 ? $img_a : $img_b );
	}

	$id = $product->save();
	if ( ! $id ) {
		WP_CLI::error( 'push simple product ' . $i . ' did not save.' );
	}
	$simple_ids[] = $id;
}

wc_delete_product_transients();
update_option( MERCPUSH_OPTION, MERCPUSH_VERSION );

/**
 * Count what is actually there and REFUSE to report success if it is short or
 * if anything strayed outside the reserved namespaces.
 */
function mercpush_report(): void {
	global $wpdb;

	$skus = $wpdb->get_col(
		$wpdb->prepare(
			"select meta_value from {$wpdb->postmeta} where meta_key = '_sku' and meta_value like %s",
			MERCPUSH_SKU_PREFIX . '%'
		)
	);
	$gtins = $wpdb->get_col(
		"select meta_value from {$wpdb->postmeta} where meta_key = '_global_unique_id' and meta_value <> ''"
	);
	$products = (int) $wpdb->get_var(
		$wpdb->prepare(
			"select count(*) from {$wpdb->posts} p join {$wpdb->postmeta} m on m.post_id = p.ID
			 where p.post_type = 'product' and p.post_status = 'publish'
			   and m.meta_key = '_sku' and m.meta_value like %s",
			MERCPUSH_SKU_PREFIX . '%'
		)
	);

	$stray_gtin = array_values( array_filter( $gtins, static fn( $g ) => 0 !== strpos( (string) $g, MERCPUSH_EAN_PREFIX ) ) );

	WP_CLI::log( '--- push fixture ------------------------------------' );
	WP_CLI::log( 'published products (MERCPUSH-) : ' . $products );
	WP_CLI::log( 'SKUs in the namespace          : ' . count( $skus ) );
	WP_CLI::log( 'GTINs assigned (029 prefix)    : ' . count( $gtins ) );
	WP_CLI::log( 'GTINs OUTSIDE the 029 prefix   : ' . count( $stray_gtin ) );
	WP_CLI::log( '-----------------------------------------------------' );

	$short = array();
	if ( $products < 6 ) {
		$short[] = "only {$products} published MERCPUSH- products; the request is 6-10";
	}
	if ( count( $gtins ) < $products ) {
		$short[] = 'fewer GTINs than products — the barcode path would not be exercised';
	}
	if ( $stray_gtin ) {
		$short[] = 'a GTIN outside the reserved 029 prefix exists: ' . implode( ',', $stray_gtin );
	}
	if ( count( $skus ) !== count( array_unique( $skus ) ) ) {
		$short[] = 'duplicate SKUs inside the namespace';
	}
	if ( $short ) {
		WP_CLI::error( "the push fixture is SHORT:\n  - " . implode( "\n  - ", $short ) );
	}
}

mercpush_report();
WP_CLI::success( 'Push fixture seeded at version ' . MERCPUSH_VERSION . '.' );
