import { describe, expect, it } from 'vitest';
import { copierStatusNudgeKey, copierStatusNudgeTopic, tvPriceChannelGrant } from '../server/tvPriceChannel';
import { copierStatusNudgeTopic as clientNudgeTopic } from '../lib/copierStatusNudge';

const SECRET = 's'.repeat(40);
const DEVICE = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

describe('téma budíčku statusu (30. 10.)', () => {
  it('je deterministické, odvozené ze zařízení a jiné než téma ceny', () => {
    const topic = copierStatusNudgeTopic(DEVICE, SECRET);
    expect(topic).toMatch(/^copier-nudge-[A-Za-z0-9_-]{22}$/);
    expect(copierStatusNudgeTopic(DEVICE.toUpperCase(), SECRET)).toBe(topic);
    expect(copierStatusNudgeTopic('9f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e', SECRET)).not.toBe(topic);
    expect(topic).not.toContain(tvPriceChannelGrant(DEVICE, SECRET)!.topic.slice('tv-price-'.length));
    expect(topic).not.toContain(DEVICE);
  });

  it('bez tajemství nebo s cizím ID vrátí null, nikdy nevyhodí', () => {
    expect(copierStatusNudgeTopic(DEVICE, undefined)).toBeNull();
    expect(copierStatusNudgeTopic(DEVICE, 'short')).toBeNull();
    expect(copierStatusNudgeTopic('not-a-device', SECRET)).toBeNull();
    expect(copierStatusNudgeTopic(42, SECRET)).toBeNull();
  });

  it('klient přijme jen téma ve tvaru budíčku', () => {
    expect(clientNudgeTopic(copierStatusNudgeTopic(DEVICE, SECRET))).toBe(copierStatusNudgeTopic(DEVICE, SECRET));
    for (const value of [null, undefined, 42, 'copier-kick-abc', 'tv-price-abcdefghijklmnopqrstuv', 'copier-nudge-short', `copier-nudge-${'a'.repeat(22)}x`]) {
      expect(clientNudgeTopic(value)).toBeNull();
    }
  });

  it('klíč expozice: 32 B base64url, deterministický, jiný než téma i klíč ceny; bez tajemství null', () => {
    const key = copierStatusNudgeKey(DEVICE, SECRET)!;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(copierStatusNudgeKey(DEVICE.toUpperCase(), SECRET)).toBe(key);
    expect(key).not.toBe(tvPriceChannelGrant(DEVICE, SECRET)!.key);
    expect(copierStatusNudgeTopic(DEVICE, SECRET)).not.toContain(key.slice(0, 22));
    expect(copierStatusNudgeKey(DEVICE, undefined)).toBeNull();
    expect(copierStatusNudgeKey('not-a-device', SECRET)).toBeNull();
  });
});
