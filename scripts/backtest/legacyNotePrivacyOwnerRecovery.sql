-- READ-ONLY owner recovery after B16 activation. Contains PRIVATE CONTENT.
-- Execute through an authenticated owner session and store the output privately.
-- auth.uid() must be that owner; an unauthenticated SQL session returns no rows.
-- Never copy these values back into trades.data or a public/shareable export.
begin read only;
select trade_id,user_id,notes,legacy_fragments,updated_at
from public.trade_private_notes where user_id=auth.uid() order by trade_id;
select trade_id,user_id,history,updated_at
from public.backtest_trade_note_histories where user_id=auth.uid() order by trade_id;
commit;
