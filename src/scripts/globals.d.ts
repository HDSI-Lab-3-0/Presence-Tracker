export {};

declare global {
  interface Window {
    CONVEX_URL?: string;
    CONVEX_SITE_URL?: string;
    CONVEX_AUTH_URL?: string;
    DEPLOYMENT_MODE?: string;
    ORGANIZATION_NAME?: string;
    convexClient?: any;
    userRole?: string;

    initializeApp?: () => Promise<void>;
    isAdmin?: () => boolean;

    handleAuth?: (event: Event) => Promise<boolean>;
    logout?: () => void;

    openModal?: (macAddress: string) => void;
    closeModal?: () => void;
    submitRegistration?: () => Promise<void>;
    openEditModal?: (id: string, firstName: string, lastName: string, ucsdEmail: string) => void;
    closeEditModal?: () => void;
    submitEdit?: () => Promise<void>;
    forgetDevice?: (deviceId: string, macAddress: string) => Promise<void>;

    showLogsView?: () => Promise<void>;
    hideLogsView?: () => void;
    switchTab?: (tabName: string) => void;
    exportToCSV?: () => void;

    openIntegrationsModal?: () => void;
    closeIntegrationsModal?: () => void;
    saveDiscord?: () => Promise<void>;
    saveSlack?: () => Promise<void>;
    rotateAppApiKey?: () => Promise<void>;
    saveBoundaryConfig?: () => Promise<void>;
    downloadAppLinkingJson?: () => void;
    openAppQrModal?: () => Promise<void>;
    closeAppQrModal?: () => void;

    installPWA?: () => Promise<void>;
    signInWithGoogle?: () => Promise<void>;
    signOut?: () => Promise<void>;
    toggleClockStatus?: () => Promise<void>;
  }

  interface QRCodeCtor {
    new (el: HTMLElement, options: any): void;
    CorrectLevel: {
      L: number;
      M: number;
      Q: number;
      H: number;
    };
  }

  var QRCode: QRCodeCtor;
  var L: any;
}
