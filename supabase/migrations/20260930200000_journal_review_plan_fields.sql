-- 30. 9. 2026: hodnocení obchodu z Tradovate dostalo vlastní plán a důvod
-- „mimo plán“. Pojistka importovaných obchodů propouští vlastníkovi jen pole
-- hodnocení — nová pole se přidávají do stejného seznamu. Fakty z brokera
-- (ceny, P&L, časy, účet) se dál měnit nedají.
--   plannedStopLoss / plannedTakeProfit  tvůj plán (jen pro R, nikdy P&L)
--   invalidReasons                       důvody „mimo plán“ (pole textů)
--   invalidNote                          co se stalo a co příště jinak
create or replace function public.protect_journal_trade_identity() returns trigger
language plpgsql security invoker set search_path='' as $$
declare
  k text;
  v jsonb;
  review jsonb := '{}'::jsonb;
begin
  if tg_op='INSERT' and coalesce(new.data->>'copierTradeId','') ~ '^copier-[0-9]+(-[0-9]+)?$' then
    perform pg_advisory_xact_lock(hashtextextended('journal:' || new.user_id::text,0));
    if exists(select 1 from public.tradovate_journal_projection_heads h where h.user_id=new.user_id) then
      raise exception 'journal-legacy-import-retired' using errcode='22023';
    end if;
  elsif tg_op='UPDATE' and current_user in ('authenticated','anon') then
    if old.data ? 'journalSupersededBy' then new.data := new.data || jsonb_build_object('journalSupersededBy',old.data->'journalSupersededBy'); end if;
    if coalesce(old.data->>'copierTradeId','') like 'journal:%' then
      -- Owner review cannot modify broker facts or erase provenance, even from
      -- an older browser that sends a full trade snapshot. Service import owns facts.
      for k,v in select key,value from jsonb_each(coalesce(new.data,'{}'::jsonb)) loop
        if k in ('notes','sessionPreNotes','sessionPostNotes','screenshot','screenshots','drawings',
          'signal','emotions','mistakes','planAdherence','isValid','executionStatus','needsReview',
          'setupType','tags','htfConfluence','ltfConfluence','enrichmentSkipped','isBE',
          'slPlacement','targetType','targetLevel','management','shareNotes','isPublic',
          'miniViewRange','miniViewLayout','miniViewSecondaryRange','miniViewSecondaryTimeframe',
          'plannedStopLoss','plannedTakeProfit','invalidReasons','invalidNote')
          and (k <> 'executionStatus' or v in ('"Valid"'::jsonb,'"Invalid"'::jsonb)) then
          review := review || jsonb_build_object(k,v);
        end if;
      end loop;
      new.data := old.data || review;
      new.user_id := old.user_id;
      new.instrument := old.instrument;
      new.pnl := old.pnl;
      new.direction := old.direction;
      new.date := old.date;
      new.timestamp := old.timestamp;
      new.data := new.data || jsonb_build_object('copierTradeId',old.data->'copierTradeId');
      if old.data ? 'journalLegacyCopierTradeId' then new.data := new.data || jsonb_build_object('journalLegacyCopierTradeId',old.data->'journalLegacyCopierTradeId'); end if;
      new.account_id := old.account_id;
    end if;
  end if;
  return new;
end; $$;
