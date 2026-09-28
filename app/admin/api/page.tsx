import { headers } from "next/headers";
import { AdminPage } from "@/components/admin/AdminShell";
import { ApiDocs } from "@/components/admin/ApiDocs";

export const dynamic = "force-dynamic";

/** Snippets are only copy-ready if they carry this deployment's real host. */
async function appUrl(): Promise<string> {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${host.startsWith("localhost") ? "http" : "https"}://${host}`;
}

export default async function ApiPage() {
  return (
    <AdminPage
      title="API & n8n"
      description="Every snippet below already has your URL in it — copy and run."
    >
      <ApiDocs appUrl={await appUrl()} />
    </AdminPage>
  );
}
