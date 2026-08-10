/**
 * Composing a transactional message — PURE, and item-free by construction
 * (#108 notifications, privacy rules 4, 8 and 9).
 *
 * Nothing here reads the database, the clock or the configuration beyond the
 * link base URL it is handed. It takes facts and returns a subject and a body,
 * which is what makes every privacy rule below testable without a fixture that
 * has to be set up right.
 *
 * ## What a template CANNOT say, because it is never given it
 *
 * {@link GuestMessageFacts} carries an order number, a seller display name, a
 * count and a coarse status. It has no field for an item title, a price, a
 * shipping address, a payment method, another seller's order, or the recipient's
 * own address — so #108 privacy rule 4 ("minimise item detail in subjects") and
 * rule 8 ("do not disclose one seller's order data to another seller") are
 * properties of the parameter list rather than of the prose. A template that
 * wanted to leak one would not compile.
 *
 * ## One checkout-level entry point, seller-specific bodies
 *
 * Every message links to the GROUP's portal. A per-order message additionally
 * names its own seller and order number, which is #108's "distinguish
 * seller-specific orders while providing one checkout-level entry point" — and
 * because a message is enqueued per order, a two-seller group produces two
 * separate messages rather than one that mentions both.
 *
 * ## Locale
 *
 * `guest_checkouts.locale` is snapshotted onto the message at enqueue and
 * arrives here. The catalogue below is English plus a Spanish rendering,
 * because those are the two languages this repository's own instructions are
 * written in; an unknown tag falls back to English rather than failing, since a
 * message in the wrong language is a worse outcome than no message only in
 * theory. Adding a language is adding a record entry — no new column, no
 * migration, and queued messages pick it up because the TEMPLATE is code and
 * the row stores a kind.
 */

import type { GuestPortalMessageKind } from '@mercaria/shared-types';
import { GUEST_PORTAL_LINK_BEARING_MESSAGE_KINDS } from '@mercaria/shared-types';

/** Everything a template may know. See the module docblock for what is absent. */
export interface GuestMessageFacts {
  readonly kind: GuestPortalMessageKind;
  /** The printed, sequential, PUBLIC order number — absent on group-level messages. */
  readonly orderNumber?: string;
  /** The seller's public display name — absent on group-level messages. */
  readonly sellerLabel?: string;
  /** How many sibling orders the group has. A count, never a list. */
  readonly orderCount: number;
  /** Where the recipient goes. Carries a credential ONLY for link-bearing kinds. */
  readonly portalUrl: string;
}

/** The two supported renderings. `en` is the fallback for anything else. */
type SupportedLocale = 'en' | 'es';

/** One kind's copy in one language. */
interface Copy {
  readonly subject: (facts: GuestMessageFacts) => string;
  readonly body: (facts: GuestMessageFacts) => string;
}

/** The reference the body appends: an order number, or the group's size. */
function reference(facts: GuestMessageFacts, plural: (count: number) => string): string {
  return facts.orderNumber ?? plural(facts.orderCount);
}

const EN: Record<GuestPortalMessageKind, Copy> = {
  order_confirmation: {
    subject: () => 'Mercaria — your order is confirmed',
    body: (f) =>
      `Thanks for your order. ${reference(f, (n) => `${n} order${n === 1 ? '' : 's'}`)} ` +
      `${f.sellerLabel === undefined ? '' : `from ${f.sellerLabel} `}` +
      `is confirmed.\n\nOpen your order:\n${f.portalUrl}\n\n` +
      'This link is single-use and expires shortly. If it has expired you can ask for a new one ' +
      'from the same page.',
  },
  payment_pending: {
    subject: () => 'Mercaria — your payment is still processing',
    body: (f) =>
      `Your payment for ${reference(f, (n) => `${n} order${n === 1 ? '' : 's'}`)} has not ` +
      `finished yet. Nothing is required from you.\n\nCheck the current state:\n${f.portalUrl}`,
  },
  payment_failed: {
    subject: () => 'Mercaria — your payment did not go through',
    body: (f) => `Your payment was not completed and no order was placed.\n\n${f.portalUrl}`,
  },
  payment_delayed_success: {
    subject: () => 'Mercaria — your payment went through',
    body: (f) =>
      `Your payment completed and ${reference(f, (n) => `${n} order${n === 1 ? '' : 's'}`)} ` +
      `is confirmed.\n\n${f.portalUrl}`,
  },
  order_processing: {
    subject: () => 'Mercaria — your order is being prepared',
    body: (f) => `${orderLine(f)} is being prepared.\n\n${f.portalUrl}`,
  },
  order_shipped: {
    subject: () => 'Mercaria — your order is on its way',
    body: (f) => `${orderLine(f)} has been dispatched.\n\n${f.portalUrl}`,
  },
  tracking_updated: {
    subject: () => 'Mercaria — delivery update',
    body: (f) => `There is a new delivery update for ${orderLine(f)}.\n\n${f.portalUrl}`,
  },
  order_ready_for_pickup: {
    subject: () => 'Mercaria — ready to collect',
    body: (f) => `${orderLine(f)} is ready to collect.\n\n${f.portalUrl}`,
  },
  order_delivered: {
    subject: () => 'Mercaria — your order arrived',
    body: (f) => `${orderLine(f)} has been delivered.\n\n${f.portalUrl}`,
  },
  order_cancelled: {
    subject: () => 'Mercaria — your order was cancelled',
    body: (f) => `${orderLine(f)} was cancelled.\n\n${f.portalUrl}`,
  },
  refund_pending: {
    subject: () => 'Mercaria — your refund is on its way',
    body: (f) => `A refund for ${orderLine(f)} has been started.\n\n${f.portalUrl}`,
  },
  refund_completed: {
    subject: () => 'Mercaria — your refund is complete',
    body: (f) => `The refund for ${orderLine(f)} is complete.\n\n${f.portalUrl}`,
  },
  return_request_updated: {
    subject: () => 'Mercaria — your return request was updated',
    body: (f) => `There is an update on your return for ${orderLine(f)}.\n\n${f.portalUrl}`,
  },
  refund_failed: {
    subject: () => 'Mercaria — there was a problem with your refund',
    body: (f) =>
      `The refund for ${orderLine(f)} did not go through. Nothing is needed from you — we are ` +
      `sorting it out.\n\n${f.portalUrl}`,
  },
  cancellation_request_received: {
    subject: () => 'Mercaria — we have your cancellation request',
    body: (f) =>
      `We passed your cancellation request for ${orderLine(f)} to the seller.\n\n${f.portalUrl}`,
  },
  cancellation_request_approved: {
    subject: () => 'Mercaria — your cancellation was approved',
    body: (f) =>
      `The seller approved your cancellation for ${orderLine(f)}.\n\n${f.portalUrl}`,
  },
  cancellation_request_rejected: {
    subject: () => 'Mercaria — your cancellation was not approved',
    body: (f) =>
      `The seller could not cancel ${orderLine(f)}. The reason is on your order ` +
      `page.\n\n${f.portalUrl}`,
  },
  return_request_received: {
    subject: () => 'Mercaria — we have your return request',
    body: (f) => `We passed your return request for ${orderLine(f)} to the seller.\n\n${f.portalUrl}`,
  },
  support_response_available: {
    subject: () => 'Mercaria — there is a reply about your order',
    body: (f) =>
      `There is a new message about ${orderLine(f)}. Read and reply on your order ` +
      `page.\n\n${f.portalUrl}`,
  },
  buyer_action_required: {
    subject: () => 'Mercaria — something needs you before a deadline',
    body: (f) =>
      `${orderLine(f)} needs an action from you before a deadline. The details are on your ` +
      `order page.\n\n${f.portalUrl}`,
  },
  claim_completed: {
    subject: () => 'Mercaria — your orders are now in your Oxy account',
    body: (f) =>
      `${reference(f, (n) => `${n} order${n === 1 ? '' : 's'}`)} now belongs to your Oxy ` +
      `account and appears in your order history.\n\n${f.portalUrl}`,
  },
  access_link_recovery: {
    subject: () => 'Mercaria — your secure access link',
    body: (f) =>
      'Somebody asked for access to a Mercaria order placed with this address.\n\n' +
      `Open it:\n${f.portalUrl}\n\n` +
      'This link is single-use and expires shortly. If you did not ask for it, you can ignore ' +
      'this message — it grants nothing until it is opened.',
  },
  access_link_step_up: {
    subject: () => 'Mercaria — confirm it is you',
    body: (f) =>
      'To continue with the change you asked for, confirm this address.\n\n' +
      `Confirm:\n${f.portalUrl}\n\nThis link is single-use and expires shortly.`,
  },
  access_security_notice: {
    subject: () => 'Mercaria — access to your order was changed',
    body: (f) =>
      'Access links for a Mercaria order placed with this address were revoked, and any other ' +
      'device that had access has been signed out.\n\n' +
      `If this was not you, request a new access link:\n${f.portalUrl}`,
  },
};

const ES: Record<GuestPortalMessageKind, Copy> = {
  order_confirmation: {
    subject: () => 'Mercaria — tu pedido está confirmado',
    body: (f) =>
      `Gracias por tu compra. ${reference(f, (n) => `${n} pedido${n === 1 ? '' : 's'}`)} ` +
      `${f.sellerLabel === undefined ? '' : `de ${f.sellerLabel} `}` +
      `está confirmado.\n\nAbre tu pedido:\n${f.portalUrl}\n\n` +
      'Este enlace es de un solo uso y caduca en breve. Si ha caducado, puedes pedir otro desde ' +
      'la misma página.',
  },
  payment_pending: {
    subject: () => 'Mercaria — tu pago sigue procesándose',
    body: (f) =>
      `El pago de ${reference(f, (n) => `${n} pedido${n === 1 ? '' : 's'}`)} aún no ha ` +
      `terminado. No necesitas hacer nada.\n\nConsulta el estado:\n${f.portalUrl}`,
  },
  payment_failed: {
    subject: () => 'Mercaria — tu pago no se completó',
    body: (f) => `El pago no se completó y no se creó ningún pedido.\n\n${f.portalUrl}`,
  },
  payment_delayed_success: {
    subject: () => 'Mercaria — tu pago se completó',
    body: (f) =>
      `El pago se completó y ${reference(f, (n) => `${n} pedido${n === 1 ? '' : 's'}`)} ` +
      `está confirmado.\n\n${f.portalUrl}`,
  },
  order_processing: {
    subject: () => 'Mercaria — estamos preparando tu pedido',
    body: (f) => `${orderLine(f)} se está preparando.\n\n${f.portalUrl}`,
  },
  order_shipped: {
    subject: () => 'Mercaria — tu pedido va en camino',
    body: (f) => `${orderLine(f)} ha salido.\n\n${f.portalUrl}`,
  },
  tracking_updated: {
    subject: () => 'Mercaria — novedades del envío',
    body: (f) => `Hay novedades del envío de ${orderLine(f)}.\n\n${f.portalUrl}`,
  },
  order_ready_for_pickup: {
    subject: () => 'Mercaria — listo para recoger',
    body: (f) => `${orderLine(f)} está listo para recoger.\n\n${f.portalUrl}`,
  },
  order_delivered: {
    subject: () => 'Mercaria — tu pedido ha llegado',
    body: (f) => `${orderLine(f)} se ha entregado.\n\n${f.portalUrl}`,
  },
  order_cancelled: {
    subject: () => 'Mercaria — tu pedido se ha cancelado',
    body: (f) => `${orderLine(f)} se ha cancelado.\n\n${f.portalUrl}`,
  },
  refund_pending: {
    subject: () => 'Mercaria — tu reembolso está en camino',
    body: (f) => `Se ha iniciado el reembolso de ${orderLine(f)}.\n\n${f.portalUrl}`,
  },
  refund_completed: {
    subject: () => 'Mercaria — tu reembolso está completo',
    body: (f) => `El reembolso de ${orderLine(f)} está completo.\n\n${f.portalUrl}`,
  },
  return_request_updated: {
    subject: () => 'Mercaria — novedades de tu devolución',
    body: (f) => `Hay novedades de tu devolución de ${orderLine(f)}.\n\n${f.portalUrl}`,
  },
  refund_failed: {
    subject: () => 'Mercaria — ha habido un problema con tu reembolso',
    body: (f) =>
      `El reembolso de ${orderLine(f)} no se ha completado. No necesitas hacer nada: lo estamos ` +
      `resolviendo.\n\n${f.portalUrl}`,
  },
  cancellation_request_received: {
    subject: () => 'Mercaria — hemos recibido tu solicitud de cancelación',
    body: (f) =>
      `Hemos enviado tu solicitud de cancelación de ${orderLine(f)} al vendedor.\n\n${f.portalUrl}`,
  },
  cancellation_request_approved: {
    subject: () => 'Mercaria — tu cancelación se ha aprobado',
    body: (f) => `El vendedor ha aprobado la cancelación de ${orderLine(f)}.\n\n${f.portalUrl}`,
  },
  cancellation_request_rejected: {
    subject: () => 'Mercaria — tu cancelación no se ha aprobado',
    body: (f) =>
      `El vendedor no ha podido cancelar ${orderLine(f)}. El motivo está en la página de tu ` +
      `pedido.\n\n${f.portalUrl}`,
  },
  return_request_received: {
    subject: () => 'Mercaria — hemos recibido tu solicitud de devolución',
    body: (f) =>
      `Hemos enviado tu solicitud de devolución de ${orderLine(f)} al vendedor.\n\n${f.portalUrl}`,
  },
  support_response_available: {
    subject: () => 'Mercaria — hay una respuesta sobre tu pedido',
    body: (f) =>
      `Hay un mensaje nuevo sobre ${orderLine(f)}. Puedes leerlo y responder en la página de tu ` +
      `pedido.\n\n${f.portalUrl}`,
  },
  buyer_action_required: {
    subject: () => 'Mercaria — necesitamos algo tuyo antes de una fecha límite',
    body: (f) =>
      `${orderLine(f)} necesita una acción tuya antes de una fecha límite. Tienes los detalles ` +
      `en la página de tu pedido.\n\n${f.portalUrl}`,
  },
  claim_completed: {
    subject: () => 'Mercaria — tus pedidos ya están en tu cuenta de Oxy',
    body: (f) =>
      `${reference(f, (n) => `${n} pedido${n === 1 ? '' : 's'}`)} ya pertenece a tu cuenta de ` +
      `Oxy y aparece en tu historial.\n\n${f.portalUrl}`,
  },
  access_link_recovery: {
    subject: () => 'Mercaria — tu enlace de acceso seguro',
    body: (f) =>
      'Alguien ha pedido acceso a un pedido de Mercaria hecho con esta dirección.\n\n' +
      `Ábrelo:\n${f.portalUrl}\n\n` +
      'El enlace es de un solo uso y caduca en breve. Si no lo has pedido tú, puedes ignorar ' +
      'este mensaje: no da acceso a nada hasta que se abre.',
  },
  access_link_step_up: {
    subject: () => 'Mercaria — confirma que eres tú',
    body: (f) =>
      'Para continuar con el cambio que has pedido, confirma esta dirección.\n\n' +
      `Confirmar:\n${f.portalUrl}\n\nEl enlace es de un solo uso y caduca en breve.`,
  },
  access_security_notice: {
    subject: () => 'Mercaria — se ha cambiado el acceso a tu pedido',
    body: (f) =>
      'Se han revocado los enlaces de acceso a un pedido de Mercaria hecho con esta dirección, ' +
      'y cualquier otro dispositivo con acceso se ha desconectado.\n\n' +
      `Si no has sido tú, pide un enlace nuevo:\n${f.portalUrl}`,
  },
};

const CATALOGUE: Record<SupportedLocale, Record<GuestPortalMessageKind, Copy>> = {
  en: EN,
  es: ES,
};

/** `Order MRC-000123 from Acme`, or the group's size when no order is named. */
function orderLine(facts: GuestMessageFacts): string {
  if (facts.orderNumber === undefined) {
    return `${facts.orderCount} order${facts.orderCount === 1 ? '' : 's'}`;
  }
  return facts.sellerLabel === undefined
    ? `Order ${facts.orderNumber}`
    : `Order ${facts.orderNumber} from ${facts.sellerLabel}`;
}

/**
 * The rendering a locale tag selects.
 *
 * Matches the PRIMARY subtag only (`es-419`, `es-ES` and `es` all render
 * Spanish), because a regional variant of a language Mercaria writes is still
 * that language, and refusing one would send English to a Spanish speaker over
 * a hyphen.
 */
export function resolveMessageLocale(locale: string | null | undefined): SupportedLocale {
  const primary = (locale ?? '').trim().toLowerCase().split('-')[0];
  return primary === 'es' ? 'es' : 'en';
}

/** The composed subject and body. Pure. */
export function renderGuestMessage(
  facts: GuestMessageFacts,
  locale: string | null | undefined,
): { locale: SupportedLocale; subject: string; body: string } {
  const resolved = resolveMessageLocale(locale);
  const copy = CATALOGUE[resolved][facts.kind];
  return { locale: resolved, subject: copy.subject(facts), body: copy.body(facts) };
}

/**
 * Whether this kind's link carries a credential.
 *
 * Re-exported from the vocabulary rather than re-derived, so the send path and
 * the DTO contract cannot disagree about which messages mint an exchange grant
 * — a disagreement whose two failure modes are "the link does nothing" and "a
 * message nobody expected to grant access grants it".
 */
export function messageCarriesAccessLink(kind: GuestPortalMessageKind): boolean {
  return GUEST_PORTAL_LINK_BEARING_MESSAGE_KINDS.includes(kind);
}

/**
 * The portal URL a message points at.
 *
 * The token, when there is one, rides in the FRAGMENT (ADR 0003 T4): a fragment
 * is never sent to a server, so it cannot reach an access log, a proxy log, a
 * `Referer` header or a third-party resource on the page. The credential-free
 * form is the same URL without one, which is what every non-link-bearing kind
 * gets.
 *
 * Refuses an unset base rather than defaulting one: a link built on a guessed
 * host either does not work or works somewhere Mercaria does not control.
 */
export function buildPortalUrl(baseUrl: string, exchangeToken?: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    throw new Error(
      'GUEST_MAGIC_LINK_BASE_URL is not set. A transactional message cannot link to a portal ' +
        'without it, and guessing a host would produce a link Mercaria does not control.',
    );
  }
  return exchangeToken === undefined ? trimmed : `${trimmed}#${exchangeToken}`;
}
