import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.alphatrade.native',
  appName: 'AlphaTrade',
  webDir: 'dist-native',
  // Bridge responses can contain auth sessions. Never print native call payloads,
  // including in locally signed Debug builds used on a physical phone.
  loggingBehavior: 'none',
  server: {
    iosScheme: 'capacitor',
  },
  ios: {
    path: 'capacitor-ios',
  },
  plugins: {
    LocalNotifications: {
      presentationOptions: ['badge', 'sound', 'banner', 'list'],
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'banner', 'list'],
    },
  },
};

export default config;
