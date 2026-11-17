// Synthetic answers of the four GETs the account record is built from, shaped
// like reads of a free personal account on 2026-11-17 (key paths and types,
// no values). Every string carries MARK, ids and names included, so a test
// can serialize the record and look for it, except the values the record
// keeps and the tests assert: plan_type, structure, the web model slug and
// the two times that are read. The empty custom-instruction strings are
// empty, as on that account. Some of the 44 announcement keys, 54 features
// and 7 offers are left out; nothing reads them. A memory's own keys were
// not recorded (only the count), so the items here are invented.
import { MARK } from './fixtures.mts';

type Json = Record<string, unknown>;

// The account's key in accounts_check: a UUID on the site. It carries MARK
// here, since the record must not keep it.
export const ACCOUNT_KEY = `${MARK}-aaaaaaaa-0000-4000-8000-0000000000aa`;

// Made up, in the offset form; the record writes them in UTC with Z.
export const CREATED_TIME = '2023-01-02T03:04:05.678901+00:00';
export const CREATED_TIME_UTC = '2023-01-02T03:04:05.678901Z';
export const CANCELS_AT = '2026-12-01T10:20:30+00:00';
export const CANCELS_AT_UTC = '2026-12-01T10:20:30Z';

export const MEMORY_COUNT = 9;

export function userSystemMessages(): Json {
  return {
    object: `${MARK}_user_system_message_detail`,
    about_user_message: '',
    about_model_message: '',
    // A nickname, which does not count as an instruction.
    name_user_message: `${MARK} nick`,
    role_user_message: '',
    traits_model_message: '',
    other_user_message: '',
    personality_type_selection: `${MARK}-default`,
    disabled_tools: [],
    enabled: true,
    traits_enabled: true,
    personality_traits: { emoji: `${MARK}-some` },
  };
}

function accountEntry(): Json {
  return {
    account: {
      account_user_role: `${MARK}-account-owner`,
      account_user_id: `${MARK}-user-id`,
      trial_state: null,
      is_trial: false,
      is_view_only: false,
      account_owner_id: `${MARK}-owner-id`,
      account_residency_region: `${MARK}-region`,
      account_compute_residency: `${MARK}-region`,
      account_compute_residency_display_name: `${MARK} region`,
      account_compute_residency_description: `${MARK} region description`,
      account_has_processing_residency: null,
      processor: {
        a001: { has_customer_object: true, processor_entity: `${MARK}-entity` },
        b001: { has_transaction_history: false },
        c001: { has_transaction_history: false },
      },
      account_id: `${MARK}-account-id`,
      created_time: CREATED_TIME,
      organization_id: null,
      is_most_recent_expired_subscription_gratis: false,
      has_previously_paid_subscription: true,
      name: null,
      profile_picture_id: null,
      profile_picture_url: null,
      structure: 'personal',
      workspace_type: null,
      is_usage_based_seat_enabled: false,
      subscription_seat_pools_enabled: false,
      plan_type: 'free',
      tbo_config: {
        plan_eligible: false,
        tbo_available: false,
        pro_upsell_eligible: false,
        waitlist_info: `${MARK} waitlist`,
        upgrade_plan_types: [`${MARK}-plan`],
      },
      plan_display_name: `${MARK} Free`,
      is_zdr: false,
      pthdnu: `${MARK}-digest`,
      is_deactivated: false,
      eligible_for_reactivation: true,
      user_segmentation_info: null,
      reseller_hosted_account: false,
      reseller_id: null,
      ekm_config: null,
      is_hipaa_compliant_workspace: false,
      hipaa_workspace_baa_metadata: null,
      is_finserv_enabled_workspace: false,
      is_fedramp_compliant_workspace: false,
      is_conversation_classifier_enabled_for_workspace: true,
      started_as_free_workspace: false,
      disable_account_switching: true,
      enable_account_switching: false,
    },
    features: [`${MARK}-feature-1`, `${MARK}-feature-2`],
    plugin_incentives_ui_enabled: false,
    entitlement: {
      subscription_id: `${MARK}-subscription-id`,
      has_active_subscription: false,
      is_active_subscription_gratis: false,
      // The last paid plan, not the plan: it read a paid plan on a free account.
      subscription_plan: `${MARK}-plusplan`,
      expires_at: `${MARK}-expires-at`,
      renews_at: null,
      cancels_at: CANCELS_AT,
      billing_period: `${MARK}-monthly`,
      scheduled_plan_change: null,
      billing_currency: `${MARK}-currency`,
      discount: null,
      applied_discounts: [],
      applied_benefits: [],
      trial: null,
      is_eligible_for_cp: false,
      is_delinquent: false,
      became_delinquent_timestamp: null,
      grace_period_end_timestamp: null,
      grace_period_id: null,
    },
    last_active_subscription: {
      subscription_id: `${MARK}-subscription-id`,
      purchase_origin_platform: `${MARK}-web`,
      will_renew: false,
      cancellation_outcome: null,
    },
    is_eligible_for_yearly_plus_subscription: false,
    is_eligible_for_yearly_plus_new_user_subscription: true,
    is_eligible_for_yearly_plus_existing_user_subscription: false,
    is_pro_200_purchase_available: true,
    is_eligible_for_free_thinking_preview_upsell: true,
    can_access_with_session: true,
    sso_connection_name: null,
    has_eligible_promotion: null,
    eligible_offers: {
      offers: [{ id: `${MARK}-offer`, epl_enabled: false, revenuecat_offering_ids: [`${MARK}-offering`] }],
      eligible_purchase_platforms: [`${MARK}-platform`],
      default_offer_id: `${MARK}-offer`,
    },
  };
}

// The account under its own key, then the same account again under default,
// in that order, as the site sent them.
export function accountsCheck(): Json {
  return {
    accounts: { [ACCOUNT_KEY]: accountEntry(), default: accountEntry() },
    account_ordering: [ACCOUNT_KEY],
  };
}

export function settingsUser(): Json {
  return {
    announcements: {
      'oai/apps/hasSeenOnboarding': `${MARK}-seen-at`,
      'oai/apps/hasSeenMemoryOnboarding': `${MARK}-seen-at`,
      'oai/apps/hasSeenAutoSwitchNux': 11,
      'oai/apps/hasSeenBidiNux': 1,
    },
    eligible_announcements: [`${MARK}-announcement`],
    eligible_announcement_strings: {
      'oai/apps/hasSeenNoPaymentTrialStarted': { title: `${MARK} title`, description: `${MARK} description`, got_it_button: `${MARK} got it` },
    },
    persistent_announcements: [],
    settings: {
      response_presentation: { mode: `${MARK}-rich` },
      training_allowed: true,
      show_expanded_code_view: false,
      codex_training_allowed: false,
      model_sticky_for_new_chats: false,
      lockdown_mode_enabled: false,
      precise_location_allowed: true,
      hive_referenced_in_internal_knowledge: true,
      connector_search_enabled: false,
      task_suggestions_enabled: true,
      rKAMeJfyrM_settings: { enabled: false, start_time: null, end_time: null },
      h17180r_gmail: true,
      moonshine: true,
      m3m: true,
      m3m_opted_out: false,
      golden_hour: true,
      bazaar_history_enabled: true,
      free_ads_opt_out: false,
      sunshine: true,
      voice_name: `${MARK}-voice`,
      show_legacy_models: true,
      last_used_model_config: {
        slugs: { web: 'gpt-5-3', default: `${MARK}-default-slug`, ios_app: `${MARK}-ios-slug` },
        juices: { web: { 'gpt-5-thinking': `${MARK}-juice` }, default: { 'gpt-5-thinking': `${MARK}-juice` } },
      },
      voice_training_allowed: false,
      video_training_allowed: false,
      chat_theme: `${MARK}-orange`,
      pepper_onboarding_entrypoint: `${MARK}-entry`,
      voice_enabled: true,
      wingman_thinking_effort: `${MARK}-instant`,
      model_picker_reasoning_effort_visibility: { enabled: [`${MARK}-low`], source: `${MARK}-source`, uses_defaults: true },
    },
    available_options: { backend_reasoning_effort: [`${MARK}-instant`] },
    permissions: null,
    flags: { bazaar: { consent_required: false, consent_presentation_id: null }, eclipse: true, image_gen_holdout_active: false },
  };
}

export function memories(count = MEMORY_COUNT): Json {
  return {
    memories: Array.from({ length: count }, (_, n) => ({ id: `${MARK}-memory-${n}`, content: `${MARK} memory ${n}` })),
    memory_max_tokens: 5000000,
    memory_num_tokens: 479,
  };
}

export interface FixtureAnswer {
  status: number;
  body: unknown;
}

// All four answered 200, as on 2026-11-17. Fresh objects on each call, so a
// test can change one.
export function accountAnswers(): Record<string, FixtureAnswer> {
  return {
    user_system_messages: { status: 200, body: userSystemMessages() },
    accounts_check: { status: 200, body: accountsCheck() },
    settings_user: { status: 200, body: settingsUser() },
    memories: { status: 200, body: memories() },
  };
}
