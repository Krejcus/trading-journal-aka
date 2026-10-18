-- Deník dne: poznámky „Hlava“ (osobní) a „Plán na týden“ dostanou vlastní
-- předponu klíče (mind:<uuid>, week:<uuid>) místo note:<uuid>. Starší klienti
-- (nativní iPhone build) čtou jen note:* — osobní zápisy tak neuvidí, nepošlou
-- do exportu ani do grafu obchodu a při úpravě je nepřepíšou na obyčejnou
-- poznámku. Jen rozšíření povoleného tvaru klíče; data se nemění.

alter table public.day_journal_entries
  drop constraint if exists day_journal_entries_entry_key_shape;

alter table public.day_journal_entries
  add constraint day_journal_entries_entry_key_shape check (
    (kind <> 'note' and entry_key = kind || ':' || session)
    or (kind = 'note' and entry_key ~ '^(note|mind|week):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  );
