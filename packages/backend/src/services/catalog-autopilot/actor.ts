/**
 * Who the catalogue autopilot acts as.
 *
 * Every row it writes names an actor (`reviewed_by_oxy_user_id`,
 * `requested_by_oxy_user_id`), and those columns hold Oxy account ids. The
 * autopilot is not an account, so it uses a value no Oxy id can take — the
 * `system` convention referral enrollment already writes — made specific
 * enough that a reader of any row can tell which code path wrote it.
 */
export const CATALOG_AUTOPILOT_ACTOR = 'system:catalog-autopilot';
