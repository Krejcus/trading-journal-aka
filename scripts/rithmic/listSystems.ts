/** Jen čtení, bez přihlášení: vypíše názvy systémů, které brána Rithmicu nabízí (šablona 16 → 17). */
import WebSocket from 'ws';
import { decodeRithmicFrames, encodeRithmicFrame } from '../../services/rithmic/rithmicCodec';

const i = process.argv.indexOf('--gateway');
const GATEWAY = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'rprotocol-de.rithmic.com';
if (!/^rprotocol(-[a-z0-9]+)?\.rithmic\.com$/.test(GATEWAY)) { console.error('Neznámá brána.'); process.exit(2); }
const socket = new WebSocket(`wss://${GATEWAY}:443`, { perMessageDeflate: false });
const timer = setTimeout(() => { console.error('Bez odpovědi do 10 s.'); process.exit(1); }, 10_000);
socket.on('open', () => socket.send(encodeRithmicFrame(16, { user_msg: ['systems'] })));
socket.on('message', (data) => {
  for (const message of decodeRithmicFrames(data)) {
    if (message.templateId !== 17) continue;
    const names = message.fields.system_name;
    console.log(JSON.stringify({ gateway: GATEWAY, rp_code: message.fields.rp_code, systems: names }, null, 1));
    clearTimeout(timer);
    socket.close();
    setTimeout(() => process.exit(0), 200);
  }
});
socket.on('error', (error) => { console.error('Chyba spojení:', error.message); process.exit(1); });
