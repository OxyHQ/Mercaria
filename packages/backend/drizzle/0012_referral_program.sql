-- Referral Program Pilot Schema
-- Supports bounded customer and merchant referral pilots with measured economics

-- Referral programs (pilots) with immutable configuration
CREATE TABLE referral_program (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    
    -- Pilot cohort configuration
    legal_entity_id UUID NOT NULL,
    program_owner_id UUID NOT NULL,
    supported_countries TEXT[] NOT NULL DEFAULT '{}',
    payout_currency TEXT NOT NULL,
    
    -- Pilot type: 'customer_acquisition' | 'merchant_acquisition' | 'creator_commerce'
    pilot_type TEXT NOT NULL CHECK (pilot_type IN ('customer_acquisition', 'merchant_acquisition', 'creator_commerce')),
    
    -- Immutable commission rule (JSON for flexibility, validated at creation)
    commission_rule JSONB NOT NULL,
    
    -- Attribution rule (single rule per pilot)
    attribution_rule JSONB NOT NULL,
    
    -- Caps
    per_partner_cap_cents BIGINT NOT NULL,
    program_wide_cap_cents BIGINT NOT NULL,
    
    -- Dates
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    
    -- Kill switches
    attribution_enabled BOOLEAN NOT NULL DEFAULT true,
    commission_enabled BOOLEAN NOT NULL DEFAULT true,
    payout_enabled BOOLEAN NOT NULL DEFAULT true,
    
    -- Status
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended', 'archived')),
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    CONSTRAINT valid_dates CHECK (end_date > start_date),
    CONSTRAINT positive_caps CHECK (per_partner_cap_cents > 0 AND program_wide_cap_cents > 0)
);

CREATE INDEX idx_referral_program_status ON referral_program(status);
CREATE INDEX idx_referral_program_dates ON referral_program(start_date, end_date);

-- Allowlisted partners for a program
CREATE TABLE referral_partner (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id UUID NOT NULL REFERENCES referral_program(id) ON DELETE CASCADE,
    oxy_user_id UUID NOT NULL,
    
    -- Partner tier/type
    partner_type TEXT NOT NULL CHECK (partner_type IN ('affiliate', 'creator', 'agency', 'platform')),
    
    -- Onboarding status
    onboarding_status TEXT NOT NULL DEFAULT 'invited' CHECK (onboarding_status IN ('invited', 'pending_review', 'approved', 'suspended', 'rejected', 'offboarded')),
    
    -- Tax and payout info (encrypted at rest)
    tax_info JSONB,
    payout_details JSONB,
    
    -- Partner-specific caps (can be lower than program default)
    partner_cap_cents BIGINT,
    
    -- Tracking
    invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at TIMESTAMPTZ,
    suspended_at TIMESTAMPTZ,
    suspension_reason TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    UNIQUE (program_id, oxy_user_id)
);

CREATE INDEX idx_referral_partner_program ON referral_partner(program_id);
CREATE INDEX idx_referral_partner_oxy_user ON referral_partner(oxy_user_id);
CREATE INDEX idx_referral_partner_status ON referral_partner(onboarding_status);

-- Attribution events (clicks, code entries, link visits)
CREATE TABLE referral_attribution (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id UUID NOT NULL REFERENCES referral_program(id) ON DELETE CASCADE,
    partner_id UUID NOT NULL REFERENCES referral_partner(id) ON DELETE CASCADE,
    
    -- Subject (customer or merchant being referred)
    subject_oxy_user_id UUID,
    subject_guest_id UUID,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('customer', 'merchant')),
    
    -- Attribution method
    attribution_method TEXT NOT NULL CHECK (attribution_method IN ('link', 'code', 'qr', 'deeplink')),
    attribution_code TEXT,
    referrer_url TEXT,
    landing_page_url TEXT,
    
    -- Client context for fraud detection
    ip_hash TEXT,
    user_agent_hash TEXT,
    device_fingerprint_hash TEXT,
    
    -- Timing
    attributed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    
    -- Conversion tracking
    converted_at TIMESTAMPTZ,
    conversion_id UUID,
    conversion_type TEXT CHECK (conversion_type IN ('first_purchase', 'merchant_activation', 'first_order')),
    
    -- Status
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'converted', 'expired', 'invalidated', 'disputed')),
    invalidation_reason TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    CONSTRAINT subject_identifier CHECK (
        (subject_type = 'customer' AND (subject_oxy_user_id IS NOT NULL OR subject_guest_id IS NOT NULL))
        OR (subject_type = 'merchant' AND subject_oxy_user_id IS NOT NULL)
    )
);

CREATE INDEX idx_referral_attribution_program ON referral_attribution(program_id);
CREATE INDEX idx_referral_attribution_partner ON referral_attribution(partner_id);
CREATE INDEX idx_referral_attribution_subject ON referral_attribution(subject_oxy_user_id, subject_guest_id);
CREATE INDEX idx_referral_attribution_status ON referral_attribution(status);
CREATE INDEX idx_referral_attribution_expires ON referral_attribution(expires_at);
CREATE INDEX idx_referral_attribution_code ON referral_attribution(attribution_code) WHERE attribution_code IS NOT NULL;

-- Commission calculations (immutable once created)
CREATE TABLE referral_commission (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id UUID NOT NULL REFERENCES referral_program(id) ON DELETE CASCADE,
    partner_id UUID NOT NULL REFERENCES referral_partner(id) ON DELETE CASCADE,
    attribution_id UUID NOT NULL REFERENCES referral_attribution(id) ON DELETE CASCADE,
    
    -- Revenue source
    revenue_source_type TEXT NOT NULL CHECK (revenue_source_type IN ('marketplace_fee', 'pro_net_revenue', 'fixed_bounty')),
    revenue_source_id UUID NOT NULL, -- order_id, subscription_id, etc.
    revenue_amount_cents BIGINT NOT NULL,
    revenue_currency TEXT NOT NULL,
    
    -- Commission calculation
    commission_rate_bps INTEGER, -- basis points, null for fixed bounty
    commission_fixed_cents BIGINT, -- fixed amount in cents, null for percentage
    commission_amount_cents BIGINT NOT NULL,
    commission_currency TEXT NOT NULL,
    
    -- Hold period
    hold_until TIMESTAMPTZ NOT NULL,
    
    -- Status
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'held', 'approved', 'reversed', 'paid', 'cancelled')),
    
    -- Reversal tracking
    reversed_at TIMESTAMPTZ,
    reversal_reason TEXT CHECK (reversal_reason IN ('refund', 'chargeback', 'fraud', 'dispute', 'merchant_revocation', 'program_cap', 'manual')),
    reversal_amount_cents BIGINT,
    
    -- Approval
    approved_at TIMESTAMPTZ,
    approved_by UUID,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    CONSTRAINT valid_commission CHECK (
        (commission_rate_bps IS NOT NULL AND commission_fixed_cents IS NULL)
        OR (commission_rate_bps IS NULL AND commission_fixed_cents IS NOT NULL)
    ),
    CONSTRAINT positive_commission CHECK (commission_amount_cents > 0)
);

CREATE INDEX idx_referral_commission_program ON referral_commission(program_id);
CREATE INDEX idx_referral_commission_partner ON referral_commission(partner_id);
CREATE INDEX idx_referral_commission_attribution ON referral_commission(attribution_id);
CREATE INDEX idx_referral_commission_status ON referral_commission(status);
CREATE INDEX idx_referral_commission_hold ON referral_commission(hold_until);
CREATE INDEX idx_referral_commission_revenue_source ON referral_commission(revenue_source_type, revenue_source_id);

-- Payout ledger
CREATE TABLE referral_payout (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id UUID NOT NULL REFERENCES referral_program(id) ON DELETE CASCADE,
    partner_id UUID NOT NULL REFERENCES referral_partner(id) ON DELETE CASCADE,
    
    -- Payout period
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    
    -- Amounts
    gross_commission_cents BIGINT NOT NULL,
    fx_fee_cents BIGINT NOT NULL DEFAULT 0,
    payout_fee_cents BIGINT NOT NULL DEFAULT 0,
    net_payout_cents BIGINT NOT NULL,
    payout_currency TEXT NOT NULL,
    
    -- Commissions included
    commission_ids UUID[] NOT NULL DEFAULT '{}',
    
    -- Status
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'returned', 'cancelled')),
    
    -- External payout reference
    external_payout_id TEXT,
    payout_provider TEXT,
    
    -- Timing
    initiated_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    failure_reason TEXT,
    
    -- Returned payout handling
    returned_at TIMESTAMPTZ,
    return_reason TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    CONSTRAINT positive_payout CHECK (net_payout_cents > 0),
    CONSTRAINT valid_period CHECK (period_end > period_start)
);

CREATE INDEX idx_referral_payout_program ON referral_payout(program_id);
CREATE INDEX idx_referral_payout_partner ON referral_payout(partner_id);
CREATE INDEX idx_referral_payout_status ON referral_payout(status);
CREATE INDEX idx_referral_payout_period ON referral_payout(period_start, period_end);

-- Pilot metrics snapshots (for reporting)
CREATE TABLE referral_metrics_snapshot (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id UUID NOT NULL REFERENCES referral_program(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    
    -- Funnel metrics
    human_clicks BIGINT NOT NULL DEFAULT 0,
    eligible_referred_subjects BIGINT NOT NULL DEFAULT 0,
    qualified_conversions BIGINT NOT NULL DEFAULT 0,
    
    -- Revenue metrics
    native_revenue_cents BIGINT NOT NULL DEFAULT 0,
    
    -- Commission metrics
    pending_commission_cents BIGINT NOT NULL DEFAULT 0,
    approved_commission_cents BIGINT NOT NULL DEFAULT 0,
    reversed_commission_cents BIGINT NOT NULL DEFAULT 0,
    paid_commission_cents BIGINT NOT NULL DEFAULT 0,
    
    -- Unit economics
    customer_acquisition_cost_cents BIGINT,
    merchant_acquisition_cost_cents BIGINT,
    payback_period_days INTEGER,
    
    -- Quality metrics
    refund_rate_bps INTEGER,
    dispute_rate_bps INTEGER,
    cancellation_rate_bps INTEGER,
    self_referral_interventions BIGINT NOT NULL DEFAULT 0,
    fraud_interventions BIGINT NOT NULL DEFAULT 0,
    false_positive_appeals BIGINT NOT NULL DEFAULT 0,
    overturned_appeals BIGINT NOT NULL DEFAULT 0,
    
    -- Operational metrics
    partner_applications BIGINT NOT NULL DEFAULT 0,
    payout_ready_partners BIGINT NOT NULL DEFAULT 0,
    payout_failures BIGINT NOT NULL DEFAULT 0,
    returned_payouts BIGINT NOT NULL DEFAULT 0,
    support_tickets BIGINT NOT NULL DEFAULT 0,
    avg_resolution_hours NUMERIC(10,2),
    
    -- Budget
    budget_utilization_bps INTEGER,
    
    -- Retention
    repeat_revenue_30d_cents BIGINT,
    repeat_revenue_90d_cents BIGINT,
    
    -- Compliance
    privacy_complaints BIGINT NOT NULL DEFAULT 0,
    disclosure_complaints BIGINT NOT NULL DEFAULT 0,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    UNIQUE (program_id, snapshot_date)
);

CREATE INDEX idx_referral_metrics_program_date ON referral_metrics_snapshot(program_id, snapshot_date);

-- Stop threshold configuration
CREATE TABLE referral_stop_threshold (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id UUID NOT NULL REFERENCES referral_program(id) ON DELETE CASCADE,
    
    threshold_type TEXT NOT NULL CHECK (threshold_type IN (
        'negative_net_contribution',
        'excess_refund_rate',
        'excess_dispute_rate',
        'self_referral_rate',
        'account_farm_rate',
        'attribution_conflict_rate',
        'payout_mismatch_rate',
        'partner_support_backlog',
        'disclosure_complaints',
        'privacy_incident',
        'reconciliation_failure',
        'budget_exhaustion',
        'merchant_quality_deterioration',
        'security_finding'
    )),
    
    -- Threshold value (interpretation depends on type)
    threshold_value NUMERIC(20,4) NOT NULL,
    threshold_window_days INTEGER NOT NULL DEFAULT 7,
    
    -- Action
    action TEXT NOT NULL DEFAULT 'pause_attribution' CHECK (action IN ('pause_attribution', 'pause_commission', 'pause_payout', 'pause_all', 'alert_only')),
    
    enabled BOOLEAN NOT NULL DEFAULT true,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    UNIQUE (program_id, threshold_type)
);

-- Threshold breach events
CREATE TABLE referral_threshold_breach (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    threshold_id UUID NOT NULL REFERENCES referral_stop_threshold(id) ON DELETE CASCADE,
    
    measured_value NUMERIC(20,4) NOT NULL,
    breached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    -- Response
    action_taken TEXT NOT NULL,
    action_taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    action_taken_by UUID,
    
    -- Resolution
    resolved_at TIMESTAMPTZ,
    resolved_by UUID,
    resolution_note TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_referral_threshold_breach_threshold ON referral_threshold_breach(threshold_id);
CREATE INDEX idx_referral_threshold_breach_breached ON referral_threshold_breach(breached_at);

-- Partner communication log
CREATE TABLE referral_partner_communication (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id UUID NOT NULL REFERENCES referral_program(id) ON DELETE CASCADE,
    partner_id UUID NOT NULL REFERENCES referral_partner(id) ON DELETE CASCADE,
    
    communication_type TEXT NOT NULL CHECK (communication_type IN (
        'invitation',
        'terms_acceptance',
        'onboarding_requirement',
        'payout_notification',
        'threshold_warning',
        'suspension_notice',
        'appeal_decision',
        'program_update',
        'disclosure_reminder'
    )),
    
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_by UUID,
    
    -- Delivery tracking
    delivery_status TEXT NOT NULL DEFAULT 'sent' CHECK (delivery_status IN ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed')),
    external_message_id TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_referral_communication_partner ON referral_partner_communication(partner_id);
CREATE INDEX idx_referral_communication_type ON referral_partner_communication(communication_type);

-- Appeals
CREATE TABLE referral_appeal (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id UUID NOT NULL REFERENCES referral_program(id) ON DELETE CASCADE,
    partner_id UUID NOT NULL REFERENCES referral_partner(id) ON DELETE CASCADE,
    
    -- Related entities
    commission_id UUID REFERENCES referral_commission(id) ON DELETE SET NULL,
    attribution_id UUID REFERENCES referral_attribution(id) ON DELETE SET NULL,
    
    appeal_type TEXT NOT NULL CHECK (appeal_type IN ('commission_reversal', 'attribution_invalidation', 'suspension', 'payout_failure', 'fraud_flag')),
    
    -- Appeal content
    reason TEXT NOT NULL,
    evidence JSONB,
    
    -- Status
    status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_review', 'approved', 'denied', 'escalated')),
    
    -- Decision
    decided_at TIMESTAMPTZ,
    decided_by UUID,
    decision_reason TEXT,
    decision_outcome JSONB,
    
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_referral_appeal_partner ON referral_appeal(partner_id);
CREATE INDEX idx_referral_appeal_status ON referral_appeal(status);

-- Updated_at triggers
CREATE TRIGGER update_referral_program_updated_at
    BEFORE UPDATE ON referral_program
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_referral_partner_updated_at
    BEFORE UPDATE ON referral_partner
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_referral_attribution_updated_at
    BEFORE UPDATE ON referral_attribution
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_referral_commission_updated_at
    BEFORE UPDATE ON referral_commission
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_referral_payout_updated_at
    BEFORE UPDATE ON referral_payout
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_referral_stop_threshold_updated_at
    BEFORE UPDATE ON referral_stop_threshold
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_referral_appeal_updated_at
    BEFORE UPDATE ON referral_appeal
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
