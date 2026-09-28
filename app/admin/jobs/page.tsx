import { AdminPage } from "@/components/admin/AdminShell";
import { JobsList } from "@/components/admin/JobsList";

export const dynamic = "force-dynamic";

export default function JobsPage() {
  return (
    <AdminPage
      title="Jobs"
      description="Every render started through the API. Play it, download it, or see why it failed."
    >
      <JobsList />
    </AdminPage>
  );
}
