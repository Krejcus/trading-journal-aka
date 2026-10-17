import { useEffect, useState } from 'react';
import { buildDrawingMigrationPreview, type DrawingMigrationPreview } from '../services/chartAnnotationMigration';
import {
  activateDrawingLayer,
  drawingLayerActive,
  drawingLayerPulled,
  drawingLayerUserId,
  importDrawingsIntoLayer,
  subscribeDrawingLayer,
} from '../services/chartDrawingLayer';
import { announceChartProfileChange } from '../services/chartProfileToast';

/**
 * Automatický jednorázový převod starých kreseb do vrstvy podle trhu a času —
 * na každém zařízení zvlášť (localStorage je per prohlížeč), bez potvrzování.
 *
 * Je to bezpečné: běží až po prvním načtení serveru, převedené kresby dostanou
 * nejstarší možný čas úpravy (verze na serveru — převedená jinde a třeba
 * upravená nebo smazaná — vždycky vyhraje) a staré klíče v localStorage
 * zůstávají jako záloha. Automatické vrstvy grafu a backtest se nepřevádí.
 */

const readPreview = (): DrawingMigrationPreview => {
  const entries: [string, string | null][] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith('alphatrade:candlekit:')) entries.push([key, window.localStorage.getItem(key)]);
  }
  return buildDrawingMigrationPreview(entries);
};

const drawingsLabel = (count: number) => (count === 1 ? 'kresba' : count < 5 ? 'kresby' : 'kreseb');

export default function DrawingMigrationPrompt() {
  // Až po prvním načtení serveru — převod musí vidět, co už ve vrstvě je.
  const readOwner = () => (drawingLayerPulled() ? drawingLayerUserId() : null);
  const [owner, setOwner] = useState<string | null>(readOwner);

  useEffect(() => subscribeDrawingLayer(() => setOwner(readOwner())), []);
  useEffect(() => {
    if (!owner || drawingLayerActive()) return;
    // Mezitím odhlášení nebo jiný účet — nic nepřevádět.
    if (drawingLayerUserId() !== owner) return;
    try {
      const preview = readPreview();
      const imported = importDrawingsIntoLayer(preview.drawings.map(item => item.drawing));
      activateDrawingLayer();
      if (imported > 0) {
        announceChartProfileChange(`Převedeno ${imported} ${drawingsLabel(imported)} z tohoto zařízení — teď jsou ve všech grafech a na všech zařízeních`);
      }
    } catch { /* bez úložiště není co převádět */ }
  }, [owner]);

  return null;
}
