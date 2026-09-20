import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopierConnectionSwitch } from '../components/CopierConnectionSwitch';
import { copierPowerDisplayKey, readCopierPowerDisplay, writeCopierPowerDisplay, COPIER_POWER_CACHE_MAX_AGE_MS } from '../lib/copierPowerDisplay';
const storage = () => {
  const entries = new Map<string,string>();
  return { getItem: (key:string) => entries.get(key) ?? null, setItem: vi.fn((key:string,value:string) => { entries.set(key,value); }) };
};
afterEach(() => vi.unstubAllGlobals());
describe('last confirmed copier power is presentation only', () => {
  it.each([true,false])('restores %s across remounts without enabling a command', connected => {
    const store = storage(); const key = copierPowerDisplayKey('user-a','group-a');
    writeCopierPowerDisplay(key,connected,store);
    vi.stubGlobal('window', { localStorage:store });
    const markup = renderToStaticMarkup(React.createElement(CopierConnectionSwitch, {
      powerDisplayKey:key, connected:!connected, statusPending:true, runtimeReady:true,
      transition:null, connectBlocked:false, onToggle:vi.fn(),
    }));
    expect(markup).toContain(`aria-checked="${connected}"`);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain(connected ? 'ZAPNUTÁ' : 'VYPNUTÁ');
    expect(markup).not.toContain('Neověřeno');
    expect(markup).not.toContain('animate-spin');
    expect(markup).toContain('data-copier-power-display="retained"');
  });
  it('fresh OFF replaces cached ON immediately', () => {
    const store = storage(); const key = copierPowerDisplayKey('a','g');
    writeCopierPowerDisplay(key,true,store);vi.stubGlobal('window',{localStorage:store});
    const markup = renderToStaticMarkup(React.createElement(CopierConnectionSwitch, {
      powerDisplayKey:key,connected:false,statusPending:false,runtimeReady:true,transition:null,connectBlocked:false,onToggle:vi.fn(),
    }));
    expect(markup).toContain('aria-checked="false"');expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('data-copier-power-display="current"');
  });
  it('never invents OFF before the first confirmation', () => {
    const markup = renderToStaticMarkup(React.createElement(CopierConnectionSwitch, {
      connected:false,statusPending:true,runtimeReady:true,transition:null,connectBlocked:false,onToggle:vi.fn(),
    }));
    expect(markup).toContain('Neověřeno');expect(markup).not.toContain('role="switch"');
  });
  it('isolates users and groups, including ambiguous separators', () => {
    const store=storage();const key=copierPowerDisplayKey('a:b','c');
    writeCopierPowerDisplay(key,true,store);
    expect(readCopierPowerDisplay(copierPowerDisplayKey('a','b:c'),store)).toBeNull();
    expect(readCopierPowerDisplay(copierPowerDisplayKey('other','c'),store)).toBeNull();
    expect(readCopierPowerDisplay(copierPowerDisplayKey('a:b','other'),store)).toBeNull();
    expect(readCopierPowerDisplay('',store)).toBeNull();
  });
  it('bounds retained age, rejects corrupt/future values, and tolerates unavailable storage', () => {
    const store=storage();const key=copierPowerDisplayKey('a','g');const now=Date.now();
    writeCopierPowerDisplay(key,true,store,now);
    expect(readCopierPowerDisplay(key,store,now+COPIER_POWER_CACHE_MAX_AGE_MS+1)).toBeNull();
    expect(readCopierPowerDisplay(key,store,now-1)).toBeNull();
    for (const value of ['broken','{}','{"connected":"false","confirmedAt":0}']) {
      store.setItem(key,value);expect(readCopierPowerDisplay(key,store)).toBeNull();
    }
    const blocked={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}};
    expect(readCopierPowerDisplay(key,blocked)).toBeNull();expect(()=>writeCopierPowerDisplay(key,true,blocked)).not.toThrow();
  });
  it('avoids storage writes on every poll but persists a changed value immediately', () => {
    const store=storage();const key=copierPowerDisplayKey('a','g');const now=Date.now();
    writeCopierPowerDisplay(key,true,store,now);writeCopierPowerDisplay(key,true,store,now+2000);
    expect(store.setItem).toHaveBeenCalledTimes(1);
    writeCopierPowerDisplay(key,false,store,now+3000);
    expect(readCopierPowerDisplay(key,store,now+3000)?.connected).toBe(false);
    expect(store.setItem).toHaveBeenCalledTimes(2);
  });
});
