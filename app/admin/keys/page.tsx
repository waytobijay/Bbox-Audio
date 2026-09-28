import { AdminPage } from "@/components/admin/AdminShell";
import { KeysManager } from "@/components/admin/KeysManager";

export const dynamic = "force-dynamic";

export default function KeysPage() {
  return (
    <AdminPage
      title="API Keys"
      description="For n8n and anything else that calls VoiceForge. Shown once, stored only as a hash."
    >
      <KeysManager />
    </AdminPage>
  );
}
