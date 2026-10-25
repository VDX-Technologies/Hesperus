import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getT, timeAgo } from "@/lib/i18n";
import { crossTenantAccess, crossTenantDb } from "@/lib/engine/db";
import { recordPlatform } from "@/lib/engine/audit";
import { storeFromEnv } from "@/lib/engine/store";
import { metered } from "@/lib/engine/health";
import { addRelease, deleteRelease, FirmwareError, listReleases, setCurrent } from "@/lib/engine/firmware";
import { SectionTitle } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { SubmitButton } from "@/components/submit-button";

const PATH = "/admin/firmware";

async function flash(msg: string) {
  (await cookies()).set("firmware_flash", msg, { path: PATH, maxAge: 30, httpOnly: true, sameSite: "strict" });
  redirect(PATH);
}

const db = () => crossTenantDb(crossTenantAccess.admin);

async function upload(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) return flash("error: .bin");
  const version = String(formData.get("version") ?? "").trim();
  let release;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    release = await metered(db(), storeFromEnv(), (store) => addRelease(db(), store, {
      version,
      bytes,
      signature: String(formData.get("signature") ?? ""),
      notes: String(formData.get("notes") ?? ""),
      current: formData.get("current") === "1",
      userId: user.id,
    }));
  } catch (e) {
    if (e instanceof FirmwareError) return flash(`error: ${e.message}`);
    throw e;
  }
  await recordPlatform(db(), user, "firmware.upload", { version, sha256: release.sha256, signed: !!release.signature, size: release.size, current: release.current });
  await flash(`uploaded:${version}`);
}

async function makeCurrent(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const version = String(formData.get("version") ?? "") || null;
  await setCurrent(db(), version);
  await recordPlatform(db(), user, "firmware.current", { version });
  await flash("ok");
}

async function remove(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const version = String(formData.get("version"));
  await deleteRelease(db(), version);
  await recordPlatform(db(), user, "firmware.delete", { version });
  await flash("ok");
}

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

export default async function FirmwarePage() {
  await requireAdmin();
  const { t, locale } = await getT();
  const releases = await listReleases(db());
  const msg = (await cookies()).get("firmware_flash")?.value;
  const host = (await headers()).get("host");
  const manifest = `https://${host}/api/firmware/manifest`;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.firmware}</h1>
      {msg && (
        <div className={`mt-4 rounded-lg border p-3 text-sm ${msg.startsWith("error") ? "border-alarm/50 text-alarm" : "border-ok/50 text-ok"}`}>
          {msg === "ok" ? t.save + " ✓" : msg.startsWith("uploaded:") ? `${t.firmwareUploaded} ${msg.slice(9)} ✓` : msg}
        </div>
      )}
      <p className="mt-3 text-sm text-dim">
        {t.firmwareHelp.split("{url}")[0]}
        <span className="num text-mist">{manifest}</span>
        {t.firmwareHelp.split("{url}")[1]}
      </p>

      <SectionTitle>{t.firmwareUpload}</SectionTitle>
      <form action={upload} className="card grid gap-4 p-5 text-sm sm:max-w-lg">
        <label className="grid gap-1">
          <span>{t.firmwareFile}</span>
          <input name="file" type="file" accept=".bin,application/octet-stream" required />
        </label>
        <label className="grid gap-1">
          <span>{t.firmwareVersion}</span>
          <input name="version" placeholder="1.2.0" pattern="\d{1,3}\.\d{1,3}\.\d{1,3}" required className="num w-32" />
        </label>
        <label className="grid gap-1">
          <span>{t.firmwareSignature}</span>
          <input name="signature" placeholder="base64" className="num" autoComplete="off" />
          <span className="text-xs text-dim">{t.firmwareSignatureHelp}</span>
        </label>
        <label className="grid gap-1">
          <span>{t.firmwareNotes}</span>
          <textarea name="notes" rows={2} />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="current" value="1" defaultChecked />
          <span>{t.firmwareMakeCurrent}</span>
        </label>
        <div>
          <SubmitButton pending={t.firmwareUploading} className="btn">
            {t.firmwareUpload}
          </SubmitButton>
        </div>
      </form>

      <SectionTitle
        right={
          releases.some((r) => r.current) && (
            <form action={makeCurrent}>
              <button className="btn text-xs text-warn">{t.firmwareStop}</button>
            </form>
          )
        }
      >
        {t.firmwareReleases}
      </SectionTitle>
      <div className="card divide-y divide-line-soft">
        {!releases.length && <p className="px-5 py-3 text-sm text-dim">{t.firmwareNone}</p>}
        {!!releases.length && !releases.some((r) => r.current) && <p className="px-5 py-3 text-sm text-warn">{t.firmwareStopped}</p>}
        {releases.map((r) => (
          <div key={r.version} className={`flex flex-wrap items-center gap-3 px-5 py-3 text-sm ${r.current ? "bg-ok/5" : ""}`}>
            <span className="num w-20 font-medium">{r.version}</span>
            {r.current ? (
              <span className="rounded border border-ok/50 px-2 py-0.5 text-xs text-ok">{t.firmwareCurrent}</span>
            ) : (
              <form action={makeCurrent}>
                <input type="hidden" name="version" value={r.version} />
                <button className="btn text-xs">{t.firmwareSetCurrent}</button>
              </form>
            )}
            <span className="num w-20 text-xs text-dim">{kb(r.size)}</span>
            <span className="num hidden text-xs text-dim sm:inline" title={r.sha256 ? "SHA-256" : "MD5"}>{(r.sha256 ?? r.md5).slice(0, 8)}</span>
            <span className={`text-xs ${r.signature ? "text-ok" : "text-warn"}`}>{r.signature ? t.firmwareSigned : t.firmwareUnsigned}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-mist">{r.notes}</span>
            <span className="num w-28 text-xs text-dim">{timeAgo(r.created_at.toISOString(), locale, t)}</span>
            <form action={remove}>
              <input type="hidden" name="version" value={r.version} />
              <ConfirmButton message={t.firmwareDeleteConfirm} className="btn text-xs text-alarm">
                ×
              </ConfirmButton>
            </form>
          </div>
        ))}
      </div>
    </div>
  );
}
