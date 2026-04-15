import { DashboardNav } from "../../components/dashboard-nav";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <DashboardNav />
      <main className="flex-1 ml-56">{children}</main>
    </div>
  );
}
