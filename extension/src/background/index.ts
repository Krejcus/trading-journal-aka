/// <reference types="chrome"/>
import { pageReadActivePosition, pageCaptureChart, pageCaptureMultiTF, pageGetLayout, pageComputeCounterfactual, pageReadBoxLevels } from '../lib/positionReader';

chrome.runtime.onInstalled.addListener(() => {
    console.log("Alpha Bridge v2 Service Worker running!");
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "captureVisibleTab") {
        chrome.tabs.captureVisibleTab(
            chrome.windows.WINDOW_ID_CURRENT,
            { format: "png" },
            (dataUrl) => {
                if (chrome.runtime.lastError) {
                    sendResponse({ success: false, error: chrome.runtime.lastError.message });
                } else {
                    sendResponse({ success: true, dataUrl });
                }
            }
        );
        return true;
    }

    // Přečte Long/Short position box z grafu. Content script nevidí page globaly,
    // takže reader pustíme v MAIN world tabu, ze kterého zpráva přišla.
    if (request.action === "readPosition") {
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) { sendResponse({ ok: false, reason: 'no-tab' }); return true; }
        chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: pageReadActivePosition,
            args: [request.boxId ?? null],
        }).then((results) => {
            const r = results && results[0] ? results[0].result : null;
            sendResponse(r || { ok: false, reason: 'no-result' });
        }).catch((err) => {
            sendResponse({ ok: false, reason: String(err) });
        });
        return true;
    }

    // Čistý snímek grafu přes TradingView clientSnapshot (MAIN world).
    if (request.action === "captureChart") {
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) { sendResponse({ ok: false, reason: 'no-tab' }); return true; }
        chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: pageCaptureChart,
        }).then((results) => {
            const r = results && results[0] ? results[0].result : null;
            sendResponse(r || { ok: false, reason: 'no-result' });
        }).catch((err) => {
            sendResponse({ ok: false, reason: String(err) });
        });
        return true;
    }

    // Lehké čtení úrovní boxu (auto-sync poll) — MAIN world.
    if (request.action === "readBoxLevels") {
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) { sendResponse({ ok: false }); return true; }
        chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: pageReadBoxLevels,
            args: [request.boxId ?? null],
        }).then((results) => {
            const r = results && results[0] ? results[0].result : null;
            sendResponse(r || { ok: false });
        }).catch(() => {
            sendResponse({ ok: false });
        });
        return true;
    }

    // Layout grafu (počet panelů / TF) — MAIN world.
    if (request.action === "getLayout") {
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) { sendResponse({ ok: false, reason: 'no-tab' }); return true; }
        chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: pageGetLayout,
        }).then((results) => {
            const r = results && results[0] ? results[0].result : null;
            sendResponse(r || { ok: false, reason: 'no-result' });
        }).catch((err) => {
            sendResponse({ ok: false, reason: String(err) });
        });
        return true;
    }

    // Counterfactual "co kdyby" pro 3 SL placementy (FVG/OTE/swing). MAIN world.
    if (request.action === "computeCounterfactual") {
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) { sendResponse({ ok: false, reason: 'no-tab' }); return true; }
        chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: pageComputeCounterfactual,
            args: [request.overrideLevels || null, request.boxId ?? null, request.flatByMin ?? null, request.entryOverride ?? null],
        }).then((results) => {
            const r = results && results[0] ? results[0].result : null;
            sendResponse(r || { ok: false, reason: 'no-result' });
        }).catch((err) => {
            sendResponse({ ok: false, reason: String(err) });
        });
        return true;
    }

    // Multi-timeframe snapshot (per-panel frames, vyrámuje na obchod, vrátí zpět). MAIN world.
    if (request.action === "captureMultiTF") {
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) { sendResponse({ ok: false, reason: 'no-tab' }); return true; }
        chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: pageCaptureMultiTF,
            args: [request.frames || [['60'], ['240']]],
        }).then((results) => {
            const r = results && results[0] ? results[0].result : null;
            sendResponse(r || { ok: false, reason: 'no-result' });
        }).catch((err) => {
            sendResponse({ ok: false, reason: String(err) });
        });
        return true;
    }
});
