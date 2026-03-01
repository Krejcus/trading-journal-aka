/// <reference types="chrome"/>

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
});
