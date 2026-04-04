declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (response: { credential: string }) => void }) => void;
          renderButton: (element: Element, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

export {};