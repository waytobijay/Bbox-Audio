import { AdminPage } from "@/components/admin/AdminShell";
import { VoicesManager } from "@/components/admin/VoicesManager";

export const dynamic = "force-dynamic";

export default function VoicesPage() {
  return (
    <AdminPage
      title="Voices"
      description="Clone once. Every backend caches the clip on first use — including after a Colab restart."
    >
      <VoicesManager />
    </AdminPage>
  );
}
