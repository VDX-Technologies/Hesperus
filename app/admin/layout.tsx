import { requireAdmin } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { Header } from "@/components/header";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await requireAdmin();
  const { t, locale } = await getT();
  return (
    <>
      <Header title={t.vendor} t={t} locale={locale} path="/admin" isAdmin={false} nav={[{ href: "/admin", label: t.customers }, { href: "/admin/engine", label: t.engine }, { href: "/admin/settings", label: t.engineSettings }]} />
      <main className="mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6">{children}</main>
    </>
  );
}
