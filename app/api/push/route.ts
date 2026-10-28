import { ConnectorError, pushConnector } from "@/lib/engine/connectors";
import { csvMessages, ingestCustom } from "@/lib/engine/custom-ingest";
import { ingestPush } from "@/lib/engine/ingest";
import { CUSTOM } from "@/lib/engine/registers";
import { ValidationError } from "@/lib/engine/package";
import { markSeen } from "@/lib/engine/sources";
import { authSource, readBody } from "@/lib/engine/source-auth";
import { getPackage } from "@/lib/packages";
import { after } from "next/server";
import { mailerFromEnv } from "@/lib/engine/mail";
import { notifyPush } from "@/lib/research-pipeline";

const MAX_BODY = 4_000_000;

export async function POST(request: Request) {
  const auth = await authSource(request, "write", (s) => s.connector === "push" ? null : "source does not accept push");
  if ("error" in auth) return auth.error;
  const { db, source } = auth;
  const custom = source.module === CUSTOM;
  const pkg = custom ? null : getPackage(source.module);
  if (!custom && !pkg) return Response.json({ error: `module "${source.module}" is not installed` }, { status: 500 });

  const csv = custom && /^text\/csv\b/i.test(request.headers.get("content-type") ?? "");
  let text: string;
  try {
    const bytes = await readBody(request, MAX_BODY);
    if (bytes instanceof Response) return bytes;
    text = new TextDecoder().decode(bytes);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  let body: unknown;
  if (!csv) {
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
  }
  try {
    if (custom) {
      const messages = csv
        ? await csvMessages(db, source, new URL(request.url).searchParams.get("type") ?? "", text)
        : await pushConnector.messages(source, body);
      const result = await ingestCustom(db, source, messages);
      after(() =>
        notifyPush(db, source, messages, result, { mailer: mailerFromEnv(), origin: new URL(request.url).origin }).catch((e) => {
          if (!(e instanceof ConnectorError)) console.error(e);
        }),
      );
      return Response.json(result, { status: result.rejected.length && !result.accepted ? 422 : 200 });
    }
    const result = await ingestPush(db, source, await pushConnector.messages(source, body), pkg!);
    return Response.json(result, { status: result.rejected.length && !result.accepted ? 422 : 200 });
  } catch (e) {
    const status = e instanceof ConnectorError ? e.status : e instanceof ValidationError || e instanceof RangeError ? 400 : null;
    if (status === null) throw e;
    const error = (e as Error).message;
    if (custom) await markSeen(db, source, error).catch(() => undefined);
    return Response.json({ error }, { status });
  }
}
