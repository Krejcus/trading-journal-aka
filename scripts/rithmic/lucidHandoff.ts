import WebSocket from 'ws';

/** Only new servers advertise maintenance. No command frame is ever sent to an older service. */
export function requestLucidHandoff(port: number, token: string, account: string, pid: number, grantedAt: number): Promise<'handoff' | 'legacy'> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, { origin: 'http://localhost:3000' });
    let committed = false;
    const timer = setTimeout(() => finish(committed ? undefined : 'Předání služby vypršelo.'), 30_000);
    let requested = false;
    let done = false;
    function finish(error?: string, outcome: 'handoff' | 'legacy' = 'handoff') {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.terminate();
      if (error) reject(new Error(error)); else resolve(outcome);
    }
    ws.on('error', () => finish(committed ? undefined : 'Běžící službu nelze ověřit.'));
    ws.on('close', () => finish(committed ? undefined : 'Spojení skončilo bez potvrzení předání.'));
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return finish('Neplatná odpověď služby.'); }
      if (message.type === 'hello' && !requested) {
        if (message.system !== 'LucidTrading' || message.account !== account || message.live !== true || message.closeOnly || message.readOnly) {
          return finish('Tato instance neumí předání nebo patří jinému účtu/režimu. Zůstává v provozu.');
        }
        if (message.maintenancePid == null) return finish(undefined, 'legacy');
        if (message.maintenancePid !== pid) return finish('Běžící proces se změnil.');
        requested = true;
        ws.send(JSON.stringify({ maintenanceRestart: { pid, grantedAt } }));
      } else if (requested && !committed && message.type === 'maintenanceReady') {
        committed = true;
        ws.send(JSON.stringify({ maintenanceCommit: true }));
      } else if (requested && message.type === 'maintenanceReply') {
        finish(message.accepted === true ? undefined : 'Služba zůstává v provozu. Stav účtu, příkazy nebo souhlas brání restartu.');
      }
    });
  });
}
