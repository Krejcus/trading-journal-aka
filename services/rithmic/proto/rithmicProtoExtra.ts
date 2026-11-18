/**
 * Doplněk k `rithmicProtoJson.ts`: zprávy, které knihovna async_rithmic 1.6.6 nemá.
 *
 * RequestOCOOrder / ResponseOCOOrder (šablony 328 / 329): pole a jejich čísla převzatá 17. 11. 2026 z vygenerovaného
 * kódu knihovny rithmic-rs (src/rti.rs, struktury RequestOcoOrder a ResponseOcoOrder). Čísla sdílených polí
 * (účet, symbol, cena, spoušť, typy, trasa…) se shodují s RequestNewOrder z naší sady. Čísla šablon knihovna
 * neuvádí — 328/329 potvrdilo měření na Rithmic Test (scripts/rithmic/measureOco.ts). Až bude oficiální dev kit,
 * porovnat.
 */
const oneOf = (values: Record<string, number>) => ({ values });
export const RITHMIC_PROTO_EXTRA: Record<string, unknown> = {
  RequestOCOOrder: {
    fields: {
      template_id: { rule: 'required', type: 'int32', id: 154467 },
      user_msg: { rule: 'repeated', type: 'string', id: 132760 },
      user_tag: { rule: 'repeated', type: 'string', id: 154119 },
      window_name: { rule: 'repeated', type: 'string', id: 154629 },
      fcm_id: { type: 'string', id: 154013 },
      ib_id: { type: 'string', id: 154014 },
      account_id: { type: 'string', id: 154008 },
      symbol: { rule: 'repeated', type: 'string', id: 110100 },
      exchange: { rule: 'repeated', type: 'string', id: 110101 },
      quantity_64: { rule: 'repeated', type: 'uint64', id: 159017, options: { packed: false } },
      price: { rule: 'repeated', type: 'double', id: 110306, options: { packed: false } },
      trigger_price: { rule: 'repeated', type: 'double', id: 149247, options: { packed: false } },
      transaction_type: { rule: 'repeated', type: 'TransactionType', id: 112003, options: { packed: false } },
      duration: { rule: 'repeated', type: 'Duration', id: 112005, options: { packed: false } },
      price_type: { rule: 'repeated', type: 'PriceType', id: 112008, options: { packed: false } },
      trade_route: { rule: 'repeated', type: 'string', id: 112016 },
      manual_or_auto: { rule: 'repeated', type: 'OrderPlacement', id: 154710, options: { packed: false } },
      trailing_stop: { rule: 'repeated', type: 'bool', id: 157063, options: { packed: false } },
      trail_by_ticks: { rule: 'repeated', type: 'int32', id: 157064, options: { packed: false } },
      trail_by_price_id: { rule: 'repeated', type: 'int32', id: 157065, options: { packed: false } },
      cancel_at_ssboe: { type: 'int32', id: 157085 },
      cancel_at_usecs: { type: 'int32', id: 157086 },
      cancel_after_secs: { type: 'int32', id: 154488 },
    },
    nested: {
      TransactionType: oneOf({ TRANSACTIONTYPE_UNSPECIFIED: 0, BUY: 1, SELL: 2 }),
      Duration: oneOf({ DURATION_UNSPECIFIED: 0, DAY: 1, GTC: 2, IOC: 3, FOK: 4 }),
      PriceType: oneOf({ PRICETYPE_UNSPECIFIED: 0, LIMIT: 1, MARKET: 2, STOP_LIMIT: 3, STOP_MARKET: 4 }),
      OrderPlacement: oneOf({ ORDERPLACEMENT_UNSPECIFIED: 0, MANUAL: 1, AUTO: 2 }),
    },
  },
  ResponseOCOOrder: {
    fields: {
      template_id: { rule: 'required', type: 'int32', id: 154467 },
      user_msg: { rule: 'repeated', type: 'string', id: 132760 },
      user_tag: { rule: 'repeated', type: 'string', id: 154119 },
      rq_handler_rp_code: { rule: 'repeated', type: 'string', id: 132764 },
      rp_code: { rule: 'repeated', type: 'string', id: 132766 },
      basket_id: { rule: 'repeated', type: 'string', id: 110300 },
      ssboe: { rule: 'repeated', type: 'int32', id: 150100, options: { packed: false } },
      usecs: { rule: 'repeated', type: 'int32', id: 150101, options: { packed: false } },
    },
  },
  /**
   * AccountAndUserUpdate (šablona 358): Rithmic ji posílá sám na spojení k příkazům, když se změní účet nebo
   * uživatel (stav, limity RMS…). Server ji posílal už 16. 11. 2026 (měření proveditelnosti). Tady se bere JEN jako
   * signál „účet se změnil → přečti limity znovu", proto jsou zapsaná jen pole totožnosti, jejichž čísla jsou
   * společná všem zprávám naší sady; ostatní pole se při čtení přeskočí. Číslo šablony a názvy dalších polí
   * (buy_limit, sell_limit, max_limit_quantity, account_status…) jsou známé jen z knihovny rithmic-rs 3.3.0 —
   * dokud nebudou ověřené proti oficiálnímu dev kitu, limity se z této zprávy NEČTOU.
   */
  AccountAndUserUpdate: {
    fields: {
      template_id: { rule: 'required', type: 'int32', id: 154467 },
      fcm_id: { type: 'string', id: 154013 },
      ib_id: { type: 'string', id: 154014 },
      account_id: { type: 'string', id: 154008 },
    },
  },
};
