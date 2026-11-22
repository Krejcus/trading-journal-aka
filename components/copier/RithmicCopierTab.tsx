// Záložka LIVE „Kopírka“ (22. 11. 2026): obrazovka kopírky nad SKUTEČNÝM účtem ze služby Rithmic na Macu.
// Kopírka ve službě zatím není → jen tvůj účet jako leader, žádní followeři, žádné vymyšlené čísla.
// Zapnutí řekne, že se připravuje; akce bez napojení (zastavit, šablony, zavření, doplnění) se vůbec neukážou.
// JEN ČTENÍ: spojení se službou slouží jen ke čtení stavu; nic odtud neposílá příkazy (INV-UI-*).
import React, { useMemo } from 'react';
import { useRithmicLocalTrading } from '../../hooks/useRithmicLocalTrading';
import { rithmicLocalAuth, rithmicLocalUrl } from '../../lib/rithmicLocalLink';
import { rithmicCopierViewFromService, type CopierGate } from '../../lib/rithmicCopierView';
import { RithmicCopierPhone, RithmicCopierScreen, type CopierActions } from './RithmicCopierScreen';

const NOT_READY: CopierGate = { label: 'Kopírka ve službě Rithmic', detail: 'se připravuje — zapnout půjde, až služba na Macu bude umět kopírovat na followery', ok: false };
const ACTIONS: CopierActions = { onArm: () => ({ ok: false, gate: NOT_READY }), onDisarm: () => undefined };

const RithmicCopierTab: React.FC<{ open: boolean; narrow: boolean; isDark: boolean; /** Jen zkušební stránka: lokální simulace služby. */ simulationUrl?: string }> = ({ open, narrow, isDark, simulationUrl }) => {
  const url = useMemo(() => simulationUrl ?? rithmicLocalUrl(), [simulationUrl]);
  const auth = useMemo(() => (simulationUrl ? null : rithmicLocalAuth()), [simulationUrl]);
  const trading = useRithmicLocalTrading({ url, enabled: open && url != null, auth });
  const summary = trading.position?.summary?.kind === 'position' ? trading.position.summary : null;
  const positionKnown = trading.link === 'open' && trading.helloFresh && trading.state != null && trading.position?.issueKind !== 'unknown';
  const view = useMemo(() => rithmicCopierViewFromService({
    accountName: trading.accountName, system: trading.system, closedPnl: trading.silent ? null : trading.accountClosedPnl, positionKnown,
    position: summary ? { side: summary.side, quantity: summary.quantity, entry: summary.entry, stop: summary.stop, target: summary.target } : null,
    price: trading.price, pointValue: trading.pointValue, maxContracts: trading.maxContracts,
  }), [trading.accountName, trading.system, trading.accountClosedPnl, trading.silent, positionKnown, summary?.side, summary?.quantity, summary?.entry, summary?.stop, summary?.target, trading.price, trading.pointValue, trading.maxContracts]); // eslint-disable-line react-hooks/exhaustive-deps
  const empty = url == null ? 'Kopírka běží přes službu Rithmic na Macu. Tohle zařízení s ní zatím není propojené (PC: odkaz s tokenem z Macu, telefon: spárování).'
    : trading.link !== 'open' ? 'Služba Rithmic na Macu není připojená. Jakmile poběží, ukáže se tu tvůj účet.'
      : 'Stav účtu u Rithmicu zatím není znám — čekám na první zprávu služby.';
  const note = <>Kopírka pro Rithmic se <b>připravuje</b>. Zatím tu vidíš jen svůj účet ze služby na Macu; followery půjde přidat a kopírku zapnout, až to služba bude umět.</>;
  const shown = view ?? { accounts: {}, groups: [], pointValue: 2, price: null };
  return narrow
    ? <RithmicCopierPhone view={shown} actions={ACTIONS} isDark={isDark} note={note} emptyNote={empty} />
    : <RithmicCopierScreen view={shown} actions={ACTIONS} isDark={isDark} note={note} emptyNote={empty} />;
};

export default RithmicCopierTab;
