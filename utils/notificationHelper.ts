/**
 * Handles browser notification permissions and registration
 */

export const requestNotificationPermission = async () => {
    if (!('Notification' in window)) {
        console.log('Tento prohlížeč nepodporuje notifikace.');
        return false;
    }

    if (Notification.permission === 'granted') return true;

    const permission = await Notification.requestPermission();
    return permission === 'granted';
};

export const sendLocalNotification = (title: string, body: string, icon?: string) => {
    if (Notification.permission !== 'granted') return;

    // If service worker is available and registered, use that for better background support
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(registration => {
            registration.showNotification(title, {
                body,
                icon: icon || '/logos/at_logo_light_clean.png',
                badge: '/logos/at_logo_light_clean.png',
                vibrate: [200, 100, 200],
            } as any);
        });
    } else {
        // Fallback to basic Notification API
        new Notification(title, {
            body,
            icon: icon || '/logos/at_logo_light_clean.png'
        });
    }
};

/**
 * Checks if the app is installed as PWA (essential for iOS notifications)
 */
export const isPWA = () => {
    return window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone === true;
};

/**
 * Detects if the device is running iOS
 */
export const isIOS = () => {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

/**
 * Returns push notification diagnostic status for Settings UI
 */
export const getPushDiagnostics = async (): Promise<{
    isStandalone: boolean;
    isApple: boolean;
    hasNotificationAPI: boolean;
    permission: string;
    hasServiceWorker: boolean;
    hasActiveSW: boolean;
    hasActiveSubscription: boolean;
    ready: boolean;
}> => {
    const isStandalone = isPWA();
    const isApple = isIOS();
    const hasNotificationAPI = 'Notification' in window;
    const permission = hasNotificationAPI ? Notification.permission : 'unavailable';
    const hasServiceWorker = 'serviceWorker' in navigator;

    let hasActiveSW = false;
    let hasActiveSubscription = false;

    if (hasServiceWorker) {
        try {
            const reg = await navigator.serviceWorker.getRegistration();
            hasActiveSW = !!(reg?.active);
            if (reg) {
                const sub = await reg.pushManager?.getSubscription();
                hasActiveSubscription = !!sub;
            }
        } catch {}
    }

    const ready = isStandalone && hasNotificationAPI && permission === 'granted' && hasActiveSW && hasActiveSubscription;

    return {
        isStandalone,
        isApple,
        hasNotificationAPI,
        permission,
        hasServiceWorker,
        hasActiveSW,
        hasActiveSubscription,
        ready
    };
};
