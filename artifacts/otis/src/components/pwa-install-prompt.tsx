import { useEffect, useState } from "react";
import { X, Share, PlusSquare } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "otis-pwa-install-dismissed";

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

/**
 * "Install Otis" affordance:
 * - Chrome/Edge/Android: captures `beforeinstallprompt` and shows a real
 *   install button.
 * - iOS Safari (no install API): shows Add-to-Home-Screen instructions.
 * Hidden when already installed (standalone) or previously dismissed.
 */
export function PwaInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");

  useEffect(() => {
    if (isStandalone()) return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    if (isIos()) setShowIosHint(true);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (dismissed || isStandalone() || (!deferred && !showIosHint)) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") setDismissed(true);
    setDeferred(null);
  };

  return (
    <div
      data-testid="pwa-install-prompt"
      className="fixed bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-xl border border-[#D6DBE3] bg-white p-4 shadow-lg"
    >
      <button
        aria-label="Dismiss install prompt"
        data-testid="button-pwa-dismiss"
        onClick={dismiss}
        className="absolute right-2 top-2 text-muted-foreground/60 hover:text-foreground transition-colors"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="flex items-start gap-3">
        <img src={`${import.meta.env.BASE_URL}pwa-192.png`} alt="Otis" className="h-10 w-10 rounded-lg" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">Install Otis on your phone</p>
          {deferred ? (
            <>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Get the full app experience — Otis on your home screen, full screen, no browser bar.
              </p>
              <button
                data-testid="button-pwa-install"
                onClick={install}
                className="mt-2 rounded-md bg-[#0A1628] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0A1628]/90 transition-colors"
              >
                Install app
              </button>
            </>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Tap <Share className="inline h-3.5 w-3.5 align-text-bottom" /> Share, then{" "}
              <span className="whitespace-nowrap">
                <PlusSquare className="inline h-3.5 w-3.5 align-text-bottom" /> "Add to Home Screen"
              </span>{" "}
              to install Otis.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
