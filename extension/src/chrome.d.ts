// The few extension APIs VisionSwap uses, typed by hand (no extra package needed).
declare namespace chrome {
  namespace runtime {
    type MessageSender = { id?: string; origin?: string; url?: string; tab?: { id?: number; windowId: number } };
    const id: string;
    function getURL(path: string): string;
    function getManifest(): { version: string; name: string };
    function requestUpdateCheck(): Promise<{ status: "throttled" | "no_update" | "update_available"; version?: string }>;
    function reload(): void;
    const onMessageExternal: {
      addListener(cb: (message: unknown, sender: MessageSender, sendResponse: (reply: unknown) => void) => boolean | void): void;
    };
  }
  namespace storage {
    type Change = { oldValue?: unknown; newValue?: unknown };
    const session: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
    const onChanged: {
      addListener(cb: (changes: Record<string, Change>, area: string) => void): void;
      removeListener(cb: (changes: Record<string, Change>, area: string) => void): void;
    };
  }
  namespace sidePanel {
    function setPanelBehavior(o: { openPanelOnActionClick: boolean }): Promise<void>;
    function open(o: { windowId: number } | { tabId: number }): Promise<void>;
  }
  namespace tabs {
    function create(o: { url: string; active?: boolean }): Promise<unknown>;
  }
}
