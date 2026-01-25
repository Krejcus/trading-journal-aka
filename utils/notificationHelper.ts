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
