import { createRoot } from "react-dom/client";
import App from "./App";
import type { OfflineData } from "./offline";

const mount = document.getElementById("app");
if (!mount) throw new Error("案内画面の表示先が見つかりません。");

const embedded = document.getElementById("standalone-data")?.textContent;
const offlineData = embedded ? JSON.parse(embedded) as OfflineData : undefined;

createRoot(mount).render(<App offlineData={offlineData} />);
