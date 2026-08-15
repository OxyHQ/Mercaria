<?php
/**
 * Seed the disposable WooCommerce site with the catalogue the #69 runbook (§4.2)
 * requires. Run through `wp eval-file`, so every object below is created by
 * WooCommerce's OWN CRUD classes against a real database — there is no fixture
 * layer and nothing is stubbed.
 *
 * What §4.2 asks for, and where each requirement is satisfied:
 *
 *   1. a `variable` product with several variations across 2 option axes
 *      → SHAPE-A (global taxonomy attributes) and SHAPE-D (custom attributes)
 *   2. a `simple` product                          → SHAPE-B, SHAPE-C, fillers
 *   3. stock managed at the PARENT and the VARIATION level, including at least
 *      one variation reported as `manage_stock: 'parent'`
 *      → SHAPE-A: parent manages stock, two variations decline to
 *        (WC_Product_Variation::get_manage_stock() then answers 'parent')
 *   4. more than 100 products, to exceed one REST page → 4 shapes + 120 fillers
 *   5. one variable product with more than 100 variations (scenario W8)
 *      → SHAPE-D, 11 colours x 10 sizes = 110 variations
 *   6. products with several images, and one with none
 *      → SHAPE-A has 3, SHAPE-B has 2, SHAPE-C has none
 *   7. at least 2 orders                            → one processing, one
 *      completed with a real coupon discount and a real ES VAT line
 *
 * SHAPE-A uses GLOBAL (taxonomy) attributes and SHAPE-D uses CUSTOM ones on
 * purpose: those are two different wire shapes on the products endpoint, and a
 * real site is the only thing that settles which one a merchant's store emits.
 *
 * Idempotent: a completed seed records its version in an option and a re-run
 * reports the existing catalogue instead of duplicating it.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit( 1 );
}

const MERCARIA_SEED_VERSION = '1';
const MERCARIA_SEED_OPTION  = 'mercaria_e2e_seed_version';
const MERCARIA_FILLER_COUNT = 120;
const MERCARIA_MEGA_COLOURS = 11;
const MERCARIA_MEGA_SIZES   = 10;

/** Stop the whole run loudly — a half-seeded site must not read as a success. */
function mercaria_fail( string $message ): void {
	WP_CLI::error( $message );
}

function mercaria_log( string $message ): void {
	WP_CLI::log( $message );
}

if ( ! class_exists( 'WooCommerce' ) ) {
	mercaria_fail( 'WooCommerce is not active — activate it before seeding.' );
}

if ( get_option( MERCARIA_SEED_OPTION ) === MERCARIA_SEED_VERSION ) {
	mercaria_log( 'Catalogue already seeded at version ' . MERCARIA_SEED_VERSION . ' — nothing to do.' );
	mercaria_report();
	return;
}

require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';

wp_defer_term_counting( true );

// ---------------------------------------------------------------------------
// Store configuration: EUR, a real Spanish address, and real VAT.
// ---------------------------------------------------------------------------

update_option( 'woocommerce_currency', 'EUR' );
update_option( 'woocommerce_currency_pos', 'right_space' );
update_option( 'woocommerce_price_decimal_sep', ',' );
update_option( 'woocommerce_price_thousand_sep', '.' );
update_option( 'woocommerce_store_address', 'Carrer de Mercaria 1' );
update_option( 'woocommerce_store_city', 'Barcelona' );
update_option( 'woocommerce_store_postcode', '08001' );
update_option( 'woocommerce_default_country', 'ES:B' );
update_option( 'woocommerce_calc_taxes', 'yes' );
update_option( 'woocommerce_prices_include_tax', 'no' );
update_option( 'woocommerce_manage_stock', 'yes' );
// Skip the onboarding wizard so the REST surface is the only thing in play.
update_option( 'woocommerce_onboarding_profile', array( 'skipped' => true, 'completed' => true ) );
update_option( 'woocommerce_task_list_hidden', 'yes' );

$existing_rates = WC_Tax::get_rates_for_tax_class( '' );
if ( empty( $existing_rates ) ) {
	WC_Tax::_insert_tax_rate(
		array(
			'tax_rate_country'  => 'ES',
			'tax_rate_state'    => '',
			'tax_rate'          => '21.0000',
			'tax_rate_name'     => 'IVA',
			'tax_rate_priority' => 1,
			'tax_rate_compound' => 0,
			'tax_rate_shipping' => 1,
			'tax_rate_order'    => 0,
			'tax_rate_class'    => '',
		)
	);
	mercaria_log( 'Inserted a real 21% ES VAT rate.' );
}

// ---------------------------------------------------------------------------
// Images — real PNG files written into the uploads directory and attached.
// ---------------------------------------------------------------------------

/**
 * Write a real PNG to the uploads directory and register it as an attachment.
 * Returns the attachment id.
 */
function mercaria_make_image( string $slug, array $rgb ): int {
	$uploads = wp_upload_dir();
	if ( ! empty( $uploads['error'] ) ) {
		mercaria_fail( 'uploads directory unusable: ' . $uploads['error'] );
	}

	$filename = 'mercaria-e2e-' . $slug . '.png';
	$path     = trailingslashit( $uploads['path'] ) . $filename;

	$image = imagecreatetruecolor( 600, 600 );
	if ( false === $image ) {
		mercaria_fail( 'GD could not allocate an image.' );
	}
	$background = imagecolorallocate( $image, $rgb[0], $rgb[1], $rgb[2] );
	imagefilledrectangle( $image, 0, 0, 599, 599, $background );
	$ink = imagecolorallocate( $image, 255 - $rgb[0], 255 - $rgb[1], 255 - $rgb[2] );
	imagestring( $image, 5, 20, 285, strtoupper( $slug ), $ink );
	if ( ! imagepng( $image, $path ) ) {
		mercaria_fail( 'could not write ' . $path );
	}
	imagedestroy( $image );

	$attachment_id = wp_insert_attachment(
		array(
			'post_mime_type' => 'image/png',
			'post_title'     => 'Mercaria e2e ' . $slug,
			'post_content'   => '',
			'post_status'    => 'inherit',
		),
		$path
	);
	if ( is_wp_error( $attachment_id ) || ! $attachment_id ) {
		mercaria_fail( 'wp_insert_attachment failed for ' . $filename );
	}
	wp_update_attachment_metadata( $attachment_id, wp_generate_attachment_metadata( $attachment_id, $path ) );

	return (int) $attachment_id;
}

$image_ids = array(
	'slate'  => mercaria_make_image( 'slate', array( 60, 70, 90 ) ),
	'amber'  => mercaria_make_image( 'amber', array( 220, 160, 40 ) ),
	'moss'   => mercaria_make_image( 'moss', array( 70, 130, 90 ) ),
	'linen'  => mercaria_make_image( 'linen', array( 235, 228, 210 ) ),
);
mercaria_log( 'Created ' . count( $image_ids ) . ' real image attachments.' );

// ---------------------------------------------------------------------------
// SHAPE-A — variable product on GLOBAL taxonomy attributes, 2 axes,
// parent-managed stock plus per-variation overrides.
// ---------------------------------------------------------------------------

/**
 * Create (or reuse) a global product attribute and make its taxonomy usable in
 * THIS request — WooCommerce only registers attribute taxonomies on `init`, and
 * we are creating one after that has already run.
 */
function mercaria_global_attribute( string $label, string $slug, array $terms ): array {
	$attribute_id = 0;
	foreach ( wc_get_attribute_taxonomies() as $existing ) {
		if ( $existing->attribute_name === $slug ) {
			$attribute_id = (int) $existing->attribute_id;
			break;
		}
	}
	if ( ! $attribute_id ) {
		$attribute_id = wc_create_attribute(
			array(
				'name'         => $label,
				'slug'         => $slug,
				'type'         => 'select',
				'order_by'     => 'menu_order',
				'has_archives' => false,
			)
		);
		if ( is_wp_error( $attribute_id ) ) {
			mercaria_fail( 'wc_create_attribute failed: ' . $attribute_id->get_error_message() );
		}
	}

	$taxonomy = wc_attribute_taxonomy_name( $slug );
	if ( ! taxonomy_exists( $taxonomy ) ) {
		register_taxonomy(
			$taxonomy,
			array( 'product' ),
			array( 'hierarchical' => false, 'show_ui' => false, 'query_var' => true, 'rewrite' => false )
		);
	}

	$term_slugs = array();
	foreach ( $terms as $term ) {
		$existing = get_term_by( 'name', $term, $taxonomy );
		if ( ! $existing ) {
			$inserted = wp_insert_term( $term, $taxonomy );
			if ( is_wp_error( $inserted ) ) {
				mercaria_fail( 'wp_insert_term failed for ' . $term . ': ' . $inserted->get_error_message() );
			}
			$existing = get_term( $inserted['term_id'], $taxonomy );
		}
		$term_slugs[ $term ] = $existing->slug;
	}

	return array(
		'attribute_id' => (int) $attribute_id,
		'taxonomy'     => $taxonomy,
		'term_slugs'   => $term_slugs,
	);
}

$colour_axis = mercaria_global_attribute( 'Colour', 'colour', array( 'Slate', 'Amber', 'Moss' ) );
$size_axis   = mercaria_global_attribute( 'Size', 'size', array( 'Small', 'Medium', 'Large' ) );

$shape_a = new WC_Product_Variable();
$shape_a->set_name( 'Mercaria E2E Jacket (global attributes)' );
$shape_a->set_sku( 'MERC-E2E-A-JACKET' );
$shape_a->set_status( 'publish' );
$shape_a->set_catalog_visibility( 'visible' );
$shape_a->set_description( '<p>A <strong>variable</strong> product whose axes are GLOBAL taxonomy attributes. Its parent manages stock, and two variations inherit that pool.</p>' );
$shape_a->set_short_description( 'Two option axes, parent-managed stock, three images.' );
$shape_a->set_regular_price( '' );
$shape_a->set_manage_stock( true );
$shape_a->set_stock_quantity( 50 );
$shape_a->set_backorders( 'no' );
$shape_a->set_image_id( $image_ids['slate'] );
$shape_a->set_gallery_image_ids( array( $image_ids['amber'], $image_ids['moss'] ) );

$attr_colour = new WC_Product_Attribute();
$attr_colour->set_id( $colour_axis['attribute_id'] );
$attr_colour->set_name( $colour_axis['taxonomy'] );
$attr_colour->set_options( array_values( $colour_axis['term_slugs'] ) );
$attr_colour->set_position( 0 );
$attr_colour->set_visible( true );
$attr_colour->set_variation( true );

$attr_size = new WC_Product_Attribute();
$attr_size->set_id( $size_axis['attribute_id'] );
$attr_size->set_name( $size_axis['taxonomy'] );
$attr_size->set_options( array_values( $size_axis['term_slugs'] ) );
$attr_size->set_position( 1 );
$attr_size->set_visible( true );
$attr_size->set_variation( true );

$shape_a->set_attributes( array( $attr_colour, $attr_size ) );
$shape_a_id = $shape_a->save();
if ( ! $shape_a_id ) {
	mercaria_fail( 'SHAPE-A did not save.' );
}
wp_set_object_terms( $shape_a_id, array_values( $colour_axis['term_slugs'] ), $colour_axis['taxonomy'] );
wp_set_object_terms( $shape_a_id, array_values( $size_axis['term_slugs'] ), $size_axis['taxonomy'] );

// Six variations. The last TWO decline to manage their own stock, so the REST
// API reports `manage_stock: 'parent'` for them — the provider branch §4.2.3
// names.
$shape_a_plan = array(
	array( 'Slate', 'Small', '89.00', 12 ),
	array( 'Slate', 'Medium', '89.00', 4 ),
	array( 'Amber', 'Small', '94.50', 0 ),
	array( 'Amber', 'Large', '94.50', 9 ),
	array( 'Moss', 'Medium', '99.95', null ),
	array( 'Moss', 'Large', '99.95', null ),
);
$shape_a_parent_managed = 0;
foreach ( $shape_a_plan as $index => $row ) {
	list( $colour, $size, $price, $stock ) = $row;
	$variation = new WC_Product_Variation();
	$variation->set_parent_id( $shape_a_id );
	$variation->set_status( 'publish' );
	$variation->set_sku( sprintf( 'MERC-E2E-A-%02d', $index + 1 ) );
	$variation->set_regular_price( $price );
	$variation->set_attributes(
		array(
			$colour_axis['taxonomy'] => $colour_axis['term_slugs'][ $colour ],
			$size_axis['taxonomy']   => $size_axis['term_slugs'][ $size ],
		)
	);
	if ( null === $stock ) {
		// Inherit the parent's pool → REST reports manage_stock: 'parent'.
		$variation->set_manage_stock( false );
		$variation->set_stock_status( 'instock' );
		++$shape_a_parent_managed;
	} else {
		$variation->set_manage_stock( true );
		$variation->set_stock_quantity( $stock );
		$variation->set_stock_status( $stock > 0 ? 'instock' : 'outofstock' );
	}
	if ( ! $variation->save() ) {
		mercaria_fail( 'SHAPE-A variation ' . ( $index + 1 ) . ' did not save.' );
	}
}
WC_Product_Variable::sync( $shape_a_id );
mercaria_log( 'SHAPE-A: variable product #' . $shape_a_id . ' with ' . count( $shape_a_plan ) . ' variations (' . $shape_a_parent_managed . ' inheriting the parent stock pool).' );

// ---------------------------------------------------------------------------
// SHAPE-B — simple product, variation-level stock, two images.
// SHAPE-C — simple product with NO image at all.
// ---------------------------------------------------------------------------

$shape_b = new WC_Product_Simple();
$shape_b->set_name( 'Mercaria E2E Enamel Mug' );
$shape_b->set_sku( 'MERC-E2E-B-MUG' );
$shape_b->set_status( 'publish' );
$shape_b->set_catalog_visibility( 'visible' );
$shape_b->set_regular_price( '14.90' );
$shape_b->set_sale_price( '11.90' );
$shape_b->set_description( '<p>A plain <em>simple</em> product with a sale price and two images.</p>' );
$shape_b->set_manage_stock( true );
$shape_b->set_stock_quantity( 37 );
$shape_b->set_image_id( $image_ids['linen'] );
$shape_b->set_gallery_image_ids( array( $image_ids['moss'] ) );
$shape_b_id = $shape_b->save();
if ( ! $shape_b_id ) {
	mercaria_fail( 'SHAPE-B did not save.' );
}

$shape_c = new WC_Product_Simple();
$shape_c->set_name( 'Mercaria E2E Unphotographed Widget' );
$shape_c->set_sku( 'MERC-E2E-C-NOIMAGE' );
$shape_c->set_status( 'publish' );
$shape_c->set_catalog_visibility( 'visible' );
$shape_c->set_regular_price( '5.00' );
$shape_c->set_description( 'Deliberately has no image, so the importer\'s empty-gallery path is exercised.' );
$shape_c->set_manage_stock( false );
$shape_c->set_stock_status( 'instock' );
$shape_c_id = $shape_c->save();
if ( ! $shape_c_id ) {
	mercaria_fail( 'SHAPE-C did not save.' );
}
mercaria_log( 'SHAPE-B: simple #' . $shape_b_id . ' (2 images). SHAPE-C: simple #' . $shape_c_id . ' (no images).' );

// ---------------------------------------------------------------------------
// SHAPE-D — the W8 product: MORE than 100 variations, on CUSTOM attributes.
// ---------------------------------------------------------------------------

$mega_colours = array( 'Ink', 'Rust', 'Sage', 'Clay', 'Bone', 'Plum', 'Teal', 'Sand', 'Coal', 'Fern', 'Mist' );
$mega_sizes   = array( '34', '36', '38', '40', '42', '44', '46', '48', '50', '52' );
if ( count( $mega_colours ) !== MERCARIA_MEGA_COLOURS || count( $mega_sizes ) !== MERCARIA_MEGA_SIZES ) {
	mercaria_fail( 'the SHAPE-D axes do not match the declared sizes.' );
}

$shape_d = new WC_Product_Variable();
$shape_d->set_name( 'Mercaria E2E Trousers (110 variations)' );
$shape_d->set_sku( 'MERC-E2E-D-TROUSERS' );
$shape_d->set_status( 'publish' );
$shape_d->set_catalog_visibility( 'visible' );
$shape_d->set_description( '<p>Scenario W8: more variations than one REST page of the variations endpoint.</p>' );
$shape_d->set_manage_stock( false );
$shape_d->set_image_id( $image_ids['amber'] );

$attr_mega_colour = new WC_Product_Attribute();
$attr_mega_colour->set_id( 0 ); // custom (non-taxonomy) attribute
$attr_mega_colour->set_name( 'Colourway' );
$attr_mega_colour->set_options( $mega_colours );
$attr_mega_colour->set_position( 0 );
$attr_mega_colour->set_visible( true );
$attr_mega_colour->set_variation( true );

$attr_mega_size = new WC_Product_Attribute();
$attr_mega_size->set_id( 0 );
$attr_mega_size->set_name( 'Waist' );
$attr_mega_size->set_options( $mega_sizes );
$attr_mega_size->set_position( 1 );
$attr_mega_size->set_visible( true );
$attr_mega_size->set_variation( true );

$shape_d->set_attributes( array( $attr_mega_colour, $attr_mega_size ) );
$shape_d_id = $shape_d->save();
if ( ! $shape_d_id ) {
	mercaria_fail( 'SHAPE-D did not save.' );
}

$mega_created = 0;
foreach ( $mega_colours as $colour_index => $colour ) {
	foreach ( $mega_sizes as $size_index => $size ) {
		$variation = new WC_Product_Variation();
		$variation->set_parent_id( $shape_d_id );
		$variation->set_status( 'publish' );
		$variation->set_sku( sprintf( 'MERC-E2E-D-%s-%s', strtoupper( substr( $colour, 0, 3 ) ), $size ) );
		$variation->set_regular_price( number_format( 59 + $size_index * 1.5, 2, '.', '' ) );
		$variation->set_attributes(
			array(
				'colourway' => $colour,
				'waist'     => $size,
			)
		);
		$variation->set_manage_stock( true );
		$variation->set_stock_quantity( ( $colour_index * 7 + $size_index * 3 ) % 20 );
		$variation->set_stock_status( 'instock' );
		if ( ! $variation->save() ) {
			mercaria_fail( 'SHAPE-D variation ' . $colour . '/' . $size . ' did not save.' );
		}
		++$mega_created;
	}
}
WC_Product_Variable::sync( $shape_d_id );
if ( $mega_created <= 100 ) {
	mercaria_fail( 'SHAPE-D created only ' . $mega_created . ' variations; scenario W8 needs more than 100.' );
}
mercaria_log( 'SHAPE-D: variable product #' . $shape_d_id . ' with ' . $mega_created . ' variations.' );

// ---------------------------------------------------------------------------
// Fillers — enough simple products to push the catalogue past one REST page.
// ---------------------------------------------------------------------------

$filler_ids   = array();
$filler_words = array( 'Kettle', 'Lantern', 'Notebook', 'Satchel', 'Tumbler', 'Coaster', 'Planter', 'Doorstop' );
for ( $i = 1; $i <= MERCARIA_FILLER_COUNT; $i++ ) {
	$product = new WC_Product_Simple();
	$product->set_name( sprintf( 'Mercaria E2E %s %03d', $filler_words[ $i % count( $filler_words ) ], $i ) );
	$product->set_sku( sprintf( 'MERC-E2E-F-%03d', $i ) );
	$product->set_status( 'publish' );
	$product->set_catalog_visibility( 'visible' );
	$product->set_regular_price( number_format( 6 + ( $i % 40 ) * 1.25, 2, '.', '' ) );
	$product->set_description( 'Catalogue filler ' . $i . ' — real product, real row.' );
	$product->set_manage_stock( true );
	$product->set_stock_quantity( ( $i * 3 ) % 25 );
	$product->set_stock_status( ( ( $i * 3 ) % 25 ) > 0 ? 'instock' : 'outofstock' );
	// Every third filler carries one image; the rest carry none.
	if ( 0 === $i % 3 ) {
		$product->set_image_id( $image_ids[ array_keys( $image_ids )[ $i % 4 ] ] );
	}
	$id = $product->save();
	if ( ! $id ) {
		mercaria_fail( 'filler product ' . $i . ' did not save.' );
	}
	$filler_ids[] = $id;
}
mercaria_log( 'Fillers: ' . count( $filler_ids ) . ' simple products.' );

// ---------------------------------------------------------------------------
// A real coupon and two real orders.
// ---------------------------------------------------------------------------

$coupon_code = 'mercaria-e2e-10';
if ( ! wc_get_coupon_id_by_code( $coupon_code ) ) {
	$coupon = new WC_Coupon();
	$coupon->set_code( $coupon_code );
	$coupon->set_discount_type( 'percent' );
	$coupon->set_amount( 10 );
	$coupon->set_individual_use( false );
	$coupon->save();
	mercaria_log( 'Created coupon ' . $coupon_code . ' (10%).' );
}

/** Build one real order through WooCommerce's own order CRUD. */
function mercaria_make_order( array $lines, string $status, bool $with_coupon ): int {
	$order = wc_create_order( array( 'status' => 'pending' ) );
	if ( is_wp_error( $order ) ) {
		mercaria_fail( 'wc_create_order failed: ' . $order->get_error_message() );
	}

	foreach ( $lines as $line ) {
		$product = wc_get_product( $line['product_id'] );
		if ( ! $product ) {
			mercaria_fail( 'order line references a product that does not exist: ' . $line['product_id'] );
		}
		$order->add_product( $product, $line['quantity'] );
	}

	$address = array(
		'first_name' => 'Marta',
		'last_name'  => 'Prova',
		'company'    => '',
		'address_1'  => 'Carrer de Prova 42',
		'address_2'  => '',
		'city'       => 'Barcelona',
		'state'      => 'B',
		'postcode'   => '08002',
		'country'    => 'ES',
		'email'      => 'buyer@mercaria.invalid',
		'phone'      => '+34600000000',
	);
	$order->set_address( $address, 'billing' );
	unset( $address['email'], $address['phone'] );
	$order->set_address( $address, 'shipping' );

	$shipping = new WC_Order_Item_Shipping();
	$shipping->set_method_title( 'Flat rate' );
	$shipping->set_method_id( 'flat_rate' );
	$shipping->set_total( '4.95' );
	$order->add_item( $shipping );

	if ( $with_coupon ) {
		$applied = $order->apply_coupon( 'mercaria-e2e-10' );
		if ( is_wp_error( $applied ) ) {
			mercaria_fail( 'apply_coupon failed: ' . $applied->get_error_message() );
		}
	}

	$order->set_currency( 'EUR' );
	$order->set_payment_method( 'cod' );
	$order->set_payment_method_title( 'Cash on delivery' );
	$order->calculate_taxes( array( 'country' => 'ES', 'state' => 'B', 'postcode' => '08002', 'city' => 'Barcelona' ) );
	$order->calculate_totals( false );
	$order->set_status( $status );
	$order->save();

	if ( (float) $order->get_total() <= 0 ) {
		mercaria_fail( 'order ' . $order->get_id() . ' totalled zero — the seed is not usable.' );
	}

	return $order->get_id();
}

$order_ids = array();
// One paid-but-unfulfilled order over a simple product and a variation.
$order_ids[] = mercaria_make_order(
	array(
		array( 'product_id' => $shape_b_id, 'quantity' => 2 ),
		array( 'product_id' => $shape_c_id, 'quantity' => 1 ),
	),
	'processing',
	false
);
// One completed order carrying a real discount and real VAT.
$order_ids[] = mercaria_make_order(
	array(
		array( 'product_id' => $filler_ids[0], 'quantity' => 3 ),
		array( 'product_id' => $shape_b_id, 'quantity' => 1 ),
	),
	'completed',
	true
);
mercaria_log( 'Orders: ' . implode( ', ', array_map( static fn( $id ) => '#' . $id, $order_ids ) ) );

wp_defer_term_counting( false );
wc_delete_product_transients();
wc_delete_shop_order_transients();

update_option( MERCARIA_SEED_OPTION, MERCARIA_SEED_VERSION );

/**
 * Count what is actually in the database and REFUSE to report success if the
 * catalogue is short. A seed that ran without error and created three products
 * is the failure this exists to catch.
 */
function mercaria_report(): void {
	global $wpdb;

	$published = (int) $wpdb->get_var(
		"SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'product' AND post_status = 'publish'"
	);
	$variations = (int) $wpdb->get_var(
		"SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'product_variation' AND post_status = 'publish'"
	);
	$max_variations = (int) $wpdb->get_var(
		"SELECT COUNT(*) AS c FROM {$wpdb->posts} WHERE post_type = 'product_variation' AND post_status = 'publish' GROUP BY post_parent ORDER BY c DESC LIMIT 1"
	);
	$variable_parents = (int) $wpdb->get_var(
		"SELECT COUNT(DISTINCT post_parent) FROM {$wpdb->posts} WHERE post_type = 'product_variation' AND post_status = 'publish'"
	);
	$orders = count(
		wc_get_orders(
			array(
				'limit'  => -1,
				'return' => 'ids',
				'status' => array_keys( wc_get_order_statuses() ),
			)
		)
	);

	WP_CLI::log( '--- seeded catalogue -------------------------------' );
	WP_CLI::log( 'published products      : ' . $published );
	WP_CLI::log( 'variable parents        : ' . $variable_parents );
	WP_CLI::log( 'variations (total)      : ' . $variations );
	WP_CLI::log( 'max variations on one   : ' . $max_variations );
	WP_CLI::log( 'orders                  : ' . $orders );
	WP_CLI::log( 'store currency          : ' . get_option( 'woocommerce_currency' ) );
	WP_CLI::log( '----------------------------------------------------' );

	$shortfalls = array();
	if ( $published <= 100 ) {
		$shortfalls[] = "published products is {$published}; §4.2 needs more than 100";
	}
	if ( $max_variations <= 100 ) {
		$shortfalls[] = "the largest variation set is {$max_variations}; scenario W8 needs more than 100";
	}
	if ( $variable_parents < 2 ) {
		$shortfalls[] = "only {$variable_parents} variable parents; the seed declares 2";
	}
	if ( $orders < 2 ) {
		$shortfalls[] = "only {$orders} orders; §4.2 needs at least 2";
	}
	if ( 'EUR' !== get_option( 'woocommerce_currency' ) ) {
		$shortfalls[] = 'store currency is not EUR';
	}
	if ( $shortfalls ) {
		WP_CLI::error( "the seed is SHORT:\n  - " . implode( "\n  - ", $shortfalls ) );
	}
}

mercaria_report();
WP_CLI::success( 'Catalogue seeded at version ' . MERCARIA_SEED_VERSION . '.' );
