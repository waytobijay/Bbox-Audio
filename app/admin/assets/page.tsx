import { AdminPage } from "@/components/admin/AdminShell";
import { AssetsManager } from "@/components/admin/AssetsManager";

export const dynamic = "force-dynamic";

export default function AssetsPage() {
  return (
    <AdminPage
      title="Assets"
      description="Music, overlays, banners and clips for long-form video. Uploaded once — every backend reads from here."
    >
      <AssetsManager />
    </AdminPage>
  );
}
