# FundedNext Futures — catalogue verification, 15 September 2026

The shared account-firm registry already contains the self-hosted FundedNext logo. LIVE now resolves `FNFT…` account names to that firm for presentation and onboarding. An explicitly saved firm still wins. Identity detection does not infer a plan, account size, phase, DLL add-on, or persist changes to existing profiles.

## Supported presets

- Rapid Pro DLL OFF / DLL ON and Rapid Daily: 25K, 50K, 100K.
- Legacy: 25K, 50K, 100K.
- Flex: 50K, 100K, 150K.
- Retired Rapid: 25K, 50K, 100K; retired Bolt: 50K. These remain selectable for existing accounts and are labelled as older plans.

The 19 presets have evaluation values plus explicit funded-phase overrides. Legacy 50K changes from 3 mini / 30 micro in evaluation to 5 / 50 funded; retired Rapid uses a 1:5 ratio and Bolt a 1:3 ratio. Funded phase has no evaluation profit target. Rapid Pro and retired Rapid use 40% funded consistency; Legacy, Flex, Daily and Bolt do not. Pro requires an explicit DLL ON/OFF choice. No CFD Stellar plans or automatic real-money live-allocation limits are included.

Legacy and retired Rapid stop their trailing floor at nominal balance; Flex, Pro, Daily and Bolt stop at nominal balance + $100. Broker-confirmed thresholds still take precedence over the catalogue fallback. This catalogue does not implement a new broker enforcement mechanism.

## Official sources

- [Current families and retired plans](https://helpfutures.fundednext.com/en/articles/14255818-what-types-and-sizes-of-challenges-are-available-at-fundednext-futures).
- [Maximum loss limits and trailing locks](https://helpfutures.fundednext.com/en/articles/14298225-what-is-the-maximum-loss-limit-at-fundednext-futures-and-how-does-it-work).
- [Contract limits by family and phase](https://helpfutures.fundednext.com/en/articles/14262297-what-is-the-contract-limit-policy-at-fundednext-futures).
- [Rapid Pro/Daily overview](https://helpfutures.fundednext.com/en/articles/15877643-what-is-fundednext-futures-rapid-pro-daily-challenge), [Pro targets](https://helpfutures.fundednext.com/en/articles/15878027-how-do-i-pass-fundednext-futures-rapid-pro-challenge), [Daily targets](https://helpfutures.fundednext.com/en/articles/15878178-what-is-the-profit-target-in-the-fundednext-futures-rapid-daily-challenge).
- [DLL and soft breach](https://helpfutures.fundednext.com/en/articles/14298201-what-is-the-daily-loss-limit-at-fundednext-futures-how-do-i-calculate-my-daily-loss-limit), [Pro add-on](https://helpfutures.fundednext.com/en/articles/15878144-how-does-the-daily-loss-limit-add-on-works-on-the-rapid-pro-challenge-and-fundednext-account).
- [Legacy rules](https://helpfutures.fundednext.com/en/articles/14282252-how-do-i-pass-fundednext-futures-legacy-challenge), [Legacy targets](https://helpfutures.fundednext.com/en/articles/14282332-what-is-the-profit-target-in-the-fundednext-futures-legacy-challenge), [Flex targets](https://helpfutures.fundednext.com/en/articles/14878840-what-is-the-profit-target-in-the-fundednext-futures-flex-challenge).
- [Retired Rapid](https://helpfutures.fundednext.com/en/articles/14282756-how-do-i-pass-fundednext-futures-rapid-challenge), [Rapid funded consistency](https://helpfutures.fundednext.com/en/articles/14282890-what-is-the-consistency-rule-in-the-fundednext-futures-rapid-challenge-and-fundednext-account), [Bolt](https://fundednext.com/futures/bolt).

The general help centre is authoritative for purchase availability; the older marketing Bolt page remains online. Prices/promotions are deliberately not part of the risk catalogue. Limited Labs instant products and their perpetual-consistency/payout calculations require separate modelling; they are not silently treated as Flex or Rapid.

## Integration and verification

Connection settings now scope the form to that connection's accounts. The missing-plan banner scopes it to accounts missing a plan. Selecting a different FundedNext phase recalculates its defaults; ambiguous plans/live allocations clear previous defaults. Bulk changes retain explicit manual edits while clearing absent DLL/consistency values from a previously selected plan.

Payout eligibility is separate from risk presets. FundedNext onboarding does not overwrite the single firm-wide payout template: a trader can own multiple FundedNext plans/sizes with different reward rules. No new claim of automated payout eligibility, broker readiness, or execution conformance is made.

Browser checks on localhost confirmed the actual third connection with FundedNext logo and five accounts, a five-account settings dialog, Legacy evaluation 30 micro / funded 50 micro, and a batch switch from Pro DLL ON to Flex clearing the old DLL and consistency fields. Test forms were closed without saving. No profile changes, broker orders, worker restart or production deployment were performed for these checks.
