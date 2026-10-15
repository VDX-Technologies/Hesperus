import Image from "next/image";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getT } from "@/lib/i18n";

async function signIn(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(formData.get("email")),
    password: String(formData.get("password")),
  });
  redirect(error ? "/login?error=1" : "/");
}

export default async function Login(props: PageProps<"/login">) {
  const { error } = await props.searchParams;
  const { t } = await getT();
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form action={signIn} className="card flex w-full max-w-sm flex-col gap-4 p-8">
        <div className="mb-2 flex items-center gap-3">
          <Image src="/vdx-symbol.png" alt="" width={36} height={36} />
          <div>
            <div className="text-lg font-semibold tracking-tight">
              VDX <span className="font-normal">Core</span>
            </div>
            <div className="text-xs text-dim">VDX Technologies</div>
          </div>
        </div>
        <label className="flex flex-col gap-1 text-sm text-mist">
          {t.email}
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label className="flex flex-col gap-1 text-sm text-mist">
          {t.password}
          <input name="password" type="password" required autoComplete="current-password" />
        </label>
        {error && <p className="text-sm text-alarm">{t.wrongLogin}</p>}
        <button className="mt-2 rounded-lg bg-frost py-2.5 font-medium text-ink-950 hover:bg-white">{t.signIn}</button>
      </form>
    </main>
  );
}
