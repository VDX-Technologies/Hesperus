import { requireAdmin } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { Header } from "@/components/header";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await requireAdmin();
  const { t, locale } = await getT();
  return (
    <div className="min-h-screen lg:pl-64">
      <Header title={t.vendor} t={t} locale={locale} path="/admin" isAdmin={false} nav={[{ href: "/admin", label: t.customers }, { href: "/admin/engine", label: t.engine }, { href: "/admin/firmware", label: t.firmware }, { href: "/admin/agent", label: "Agent" }, { href: "/admin/settings", label: t.engineSettings }]} />
      <main className="mx-auto max-w-7xl px-4 pb-16 pt-5 sm:px-6 lg:px-8 lg:pt-7">{children}</main>
    </div>
  );
}
