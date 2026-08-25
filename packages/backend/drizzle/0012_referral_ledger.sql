CREATE TYPE referral_reward_status AS ENUM ('pending', 'held', 'ested', 'payable', 'paid', 'eversed', 'voided');

CREATE TABLE referral_reward_entries (
  id UUID PRIMARY KEY,
  partner_id UUID NOT NULL,
  attribution_id UUID NOT NULL,
  conversion_id UUID NOT NULL,
  rule_version VARCHAR(50) NOT NULL,
  funding_source_type VARCHAR(50) NOT NULL,
  funding_record_id UUID NOT NULL,
  amount_base DECIMAL(19, 4) NOT NULL,
  currency_base VARCHAR(3) NOT NULL,
  amount_reward DECIMAL(19, 4) NOT NULL,
  currency_reward VARCHAR(3) NOT NULL,
  status referral_reward_status NOT NULL DEFAULT 'pending',
  hold_until TIMESTAMP WITH TIME ZONE,
  vested_at TIMESTAMP WITH TIME ZONE,
  paid_at TIMESTAMP WITH TIME ZONE,
  reversed_at TIMESTAMP WITH TIME ZONE,
  reversal_entry_id UUID,
  idempotency_key VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payout_batches (
  id UUID PRIMARY KEY,
  partner_id UUID NOT NULL,
  currency VARCHAR(3) NOT NULL,
  gross_amount DECIMAL(19, 4) NOT NULL,
  net_amount DECIMAL(19, 4) NOT NULL,
  withholding_amount DECIMAL(19, 4) DEFAULT 0,
  status VARCHAR(50) NOT NULL,
  provider_reference VARCHAR(255),
  idempotency_key VARCHAR(255) UNIQUE NOT NULL,
  audit_actor_id UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  paid_at TIMESTAMP WITH TIME ZONE,
  failure_reason TEXT
);

CREATE TABLE payout_batch_entries (
  payout_batch_id UUID REFERENCES payout_batches(id),
  reward_entry_id UUID REFERENCES referral_reward_entries(id),
  PRIMARY KEY (payout_batch_id, reward_entry_id)
);

CREATE INDEX idx_referral_reward_partner ON referral_reward_entries(partner_id);
CREATE INDEX idx_referral_reward_status ON referral_reward_entries(status);
CREATE INDEX idx_payout_batch_partner ON payout_batches(partner_id);