// lexa's dashboard — thin server wrapper. fetches once, hands off to the interactive client UI.
import { loadDashboard } from "@/lib/dashboard";
import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Dashboard() {
  const data = await loadDashboard();
  if (!data) {
    return <main style={{ fontFamily: "system-ui", background: "#0f1115", color: "#eee", minHeight: "100vh", padding: 24 }}>no account yet — text lexa first, then refresh.</main>;
  }
  return <DashboardClient initial={data} />;
}
