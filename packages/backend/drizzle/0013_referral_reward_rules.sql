-- Referral reward rules and calculations
-- Part of #140, depends on #141, #142

-- Enum types
CREATE TYPE referral_funding_source AS ENUM (
  'marketplace_commission',
  'affiliate_commission',
  'subscription_revenue',
  'fixed_acquisition_budget'
);

CREATE TYPE referral_conversion_kind AS ENUM (
  'order',
  'subscription_signup',
  'affiliate_click',
  'campaign_conversion'
);

CREATE TYPE referral_reward_formula_type AS ENUM (
  'percentage',
  'fixed'
);

CREATE TYPE referral_currency_behavior AS ENUM (
  'funding_currency',
  'partner_currency',
  'fixed_usd'
);

CREATE TYPE referral_hold_policy AS ENUM (
  'none',
  'fixed_days',
  'refund_window',
  'custom'
);

CREATE TYPE referral_reversal_reason AS ENUM (
  'order_refund',
  'chargeback',
  'affiliate_rejected',
  'subscription_refund',
  'fraud_self_referral',
  'budget_invalid',
  'dispute_lost'
);

CREATE TYPE referral_rule_status AS ENUM (
  'draft',
  'active',
  'superseded',
  'retired'
);

CREATE TYPE referral_reward_status AS ENUM (
  'pending',
  'held',
  'released',
  'reversed',
  'recovery'
);

-- Referral rule versions (immutable after activation)
CREATE TABLE referral_rule_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  campaign_scope TEXT,
  program_scope TEXT,
  conversion_kind referral_conversion_kind NOT NULL,
  funding_source referral_funding_source NOT NULL,
  formula_type referral_reward_formula_type NOT NULL,
  formula_value INTEGER NOT NULL, -- percentage in basis points (10000 = 100%) or fixed amount in minor units
  currency_behavior referral_currency_behavior NOT NULL DEFAULT 'funding_currency',
  currency_code CHAR(3),
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  hold_policy referral_hold_policy NOT NULL DEFAULT 'none',
  hold_policy_config JSONB,
  per_conversion_cap_minor INTEGER,
  per_conversion_min_minor INTEGER,
  partner_cap_minor INTEGER,
  campaign_cap_minor INTEGER,
  refund_reversal_policy JSONB NOT NULL DEFAULT '{}',
  terms_version TEXT NOT NULL,
  created_by UUID NOT NULL,
  approved_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  status referral_rule_status NOT NULL DEFAULT 'draft',
  superseded_by UUID,
  CONSTRAINT unique_rule_version UNIQUE (rule_id, version),
  CONSTRAINT valid_effective_range CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT valid_percentage CHECK (
    formula_type != 'percentage' OR (formula_value >= 0 AND formula_value <= 10000)
  ),
  CONSTRAINT valid_fixed CHECK (
    formula_type != 'fixed' OR formula_value >= 0
  ),
  CONSTRAINT currency_required_for_fixed_usd CHECK (
    currency_behavior != 'fixed_usd' OR currency_code IS NOT NULL
  )
);

CREATE INDEX idx_referral_rule_versions_rule_id ON referral_rule_versions (rule_id);
CREATE INDEX idx_referral_rule_versions_active ON referral_rule_versions (status, effective_from, effective_to)
  WHERE status = 'active';
CREATE INDEX idx_referral_rule_versions_funding ON referral_rule_versions (funding_source);

-- Referral rewards (append-only, one per conversion)
CREATE TABLE referral_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_version_id UUID NOT NULL REFERENCES referral_rule_versions (id),
  partner_id UUID NOT NULL,
  campaign_id UUID,
  conversion_id UUID NOT NULL,
  conversion_kind referral_conversion_kind NOT NULL,
  funding_source referral_funding_source NOT NULL,
  funding_record_id UUID NOT NULL,
  funding_record_version INTEGER NOT NULL,
  funding_amount_minor INTEGER NOT NULL,
  funding_currency CHAR(3) NOT NULL,
  reward_amount_minor INTEGER NOT NULL,
  reward_currency CHAR(3) NOT NULL,
  formula_type referral_reward_formula_type NOT NULL,
  formula_value INTEGER NOT NULL,
  hold_policy referral_hold_policy NOT NULL,
  hold_until TIMESTAMPTZ,
  status referral_reward_status NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ,
  CONSTRAINT unique_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT valid_reward_amount CHECK (reward_amount_minor >= 0),
  CONSTRAINT reward_not_exceeds_funding CHECK (reward_amount_minor <= funding_amount_minor)
);

CREATE INDEX idx_referral_rewards_partner ON referral_rewards (partner_id);
CREATE INDEX idx_referral_rewards_campaign ON referral_rewards (campaign_id);
CREATE INDEX idx_referral_rewards_conversion ON referral_rewards (conversion_id, conversion_kind);
CREATE INDEX idx_referral_rewards_funding ON referral_rewards (funding_record_id, funding_record_version);
CREATE INDEX idx_referral_rewards_status ON referral_rewards (status);
CREATE INDEX idx_referral_rewards_rule_version ON referral_rewards (rule_version_id);

-- Referral reward reversals (append-only)
CREATE TABLE referral_reward_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reward_id UUID NOT NULL REFERENCES referral_rewards (id),
  reason referral_reversal_reason NOT NULL,
  reversal_amount_minor INTEGER NOT NULL,
  reversal_currency CHAR(3) NOT NULL,
  funding_record_id UUID,
  funding_record_version INTEGER,
  reference_id UUID,
  reference_type TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  liability_created BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT unique_reversal_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT valid_reversal_amount CHECK (reversal_amount_minor > 0)
);

CREATE INDEX idx_referral_reward_reversals_reward ON referral_reward_reversals (reward_id);
CREATE INDEX idx_referral_reward_reversals_idempotency ON referral_reward_reversals (idempotency_key);

-- Campaign budget allocations for fixed_acquisition_budget
CREATE TABLE referral_campaign_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL,
  rule_version_id UUID NOT NULL REFERENCES referral_rule_versions (id),
  allocated_minor INTEGER NOT NULL,
  currency CHAR(3) NOT NULL,
  spent_minor INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exhausted_at TIMESTAMPTZ,
  CONSTRAINT valid_allocated CHECK (allocated_minor >= 0),
  CONSTRAINT valid_spent CHECK (spent_minor >= 0 AND spent_minor <= allocated_minor)
);

CREATE INDEX idx_referral_campaign_budgets_campaign ON referral_campaign_budgets (campaign_id);
CREATE INDEX idx_referral_campaign_budgets_rule ON referral_campaign_budgets (rule_version_id);

-- Partner balance impact for reversals after payment
CREATE TABLE referral_partner_balance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL,
  reward_id UUID NOT NULL REFERENCES referral_rewards (id),
  reversal_id UUID REFERENCES referral_reward_reversals (id),
  event_type TEXT NOT NULL, -- 'reward_released', 'reward_reversed', 'recovery_created', 'recovery_settled'
  amount_minor INTEGER NOT NULL,
  currency CHAR(3) NOT NULL,
  balance_after_minor INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_referral_partner_balance_events_partner ON referral_partner_balance_events (partner_id);
CREATE INDEX idx_referral_partner_balance_events_reward ON referral_partner_balance_events (reward_id);
