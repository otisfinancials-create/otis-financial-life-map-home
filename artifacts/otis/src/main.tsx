import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./index.css";

// PWA service worker: precaches the app shell only (no API caching) and
// auto-updates in the background when a new build ships.
registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(<App />);
