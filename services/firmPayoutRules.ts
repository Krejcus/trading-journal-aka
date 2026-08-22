import type { FirmPayoutRules } from '../lib/propFirmRules';
import { payoutRuleTemplateForFirm } from '../lib/propFirmRules';
import { supabase } from './supabase';

interface FirmPayoutRulesRow {
  firm_key: string;
  plan_name: string;
  rules: FirmPayoutRules;
}

const normalizedFirmKey = (firmKey: string): string => {
  const value = firmKey.trim().toUpperCase();
  if (!value || value.length > 120) throw new Error('firm-key-invalid');
  return value;
};

/** Výchozí kopie šablony; volající ji může bezpečně upravit. */
export function defaultRulesForFirm(firmKey: string): FirmPayoutRules | null {
  return payoutRuleTemplateForFirm(firmKey);
}

export async function loadFirmPayoutRules(firmKey: string): Promise<FirmPayoutRules | null> {
  const key = normalizedFirmKey(firmKey);
  const { data, error } = await supabase
    .from('firm_payout_rules')
    .select('firm_key,plan_name,rules')
    .eq('firm_key', key)
    .maybeSingle<FirmPayoutRulesRow>();
  if (error) throw new Error(`Načtení payout pravidel selhalo: ${error.message}`);
  return data?.rules ? { ...data.rules, planName: data.plan_name } : defaultRulesForFirm(key);
}

export async function saveFirmPayoutRules(
  firmKey: string,
  rules: FirmPayoutRules,
): Promise<FirmPayoutRules> {
  const key = normalizedFirmKey(firmKey);
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) throw new Error('Pro uložení payout pravidel je nutné přihlášení.');
  const timestamp = new Date().toISOString();
  const { data, error } = await supabase.from('firm_payout_rules').upsert({
    user_id: authData.user.id,
    firm_key: key,
    plan_name: rules.planName,
    rules,
    updated_at: timestamp,
  }, { onConflict: 'user_id,firm_key' }).select('firm_key,plan_name,rules').single<FirmPayoutRulesRow>();
  if (error || !data) throw new Error(`Uložení payout pravidel selhalo: ${error?.message ?? 'missing-row'}`);
  return { ...data.rules, planName: data.plan_name };
}
