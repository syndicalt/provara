import { DashboardNav } from "../../components/dashboard-nav";
import { DemoBanner } from "../../components/demo-banner";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <DemoBanner />
      <div className="flex flex-1">
        <DashboardNav />
        <main className="flex-1 ml-56">{children}</main>
      </div>
    </div>
  );
}
