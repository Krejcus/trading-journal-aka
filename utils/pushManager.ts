export const VAPID_PUBLIC_KEY = 'BCwmYrmEguddSKE2FKQX0dv1gPwEDbwmuSXhN7wiNJ8tH0Aw2wHTVHpblm8_bDMUkgVqkvPSLJ32aqY84t_tOO4';

/**
 * Converts VAPID key base64 string to Uint8Array required by PushManager
 */
export const urlBase64ToUint8Array = (base64String: string) => {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
};

export const subscribeUserToPush = async (): Promise<any | null> => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        return null;
    }

    try {
        let reg = await navigator.serviceWorker.getRegistration();

        if (!reg) {
            reg = await navigator.serviceWorker.register('/sw.js');
        }

        // Wait for Service Worker to be ACTIVE (up to 5s)
        if (!reg.active) {
            await new Promise((resolve) => {
                let attempts = 0;
                const check = () => {
                    if (reg?.active || attempts > 50) resolve(null);
                    else {
                        attempts++;
                        setTimeout(check, 100);
                    }
                };
                check();
            });
        }

        if (!reg.active) return null;

        const convertedVapidKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);

        const subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: convertedVapidKey
        }).catch(async () => {
            const old = await reg!.pushManager.getSubscription();
            if (old) await old.unsubscribe();
            return reg!.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: convertedVapidKey
            });
        });

        return subscription.toJSON();
    } catch (err) {
        console.error("Push Subscription Error:", err);
        return null;
    }
};
