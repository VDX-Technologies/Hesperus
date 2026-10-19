// Connectors bring data in. Three shapes share one contract: they yield raw messages for a
// source, and the engine archives and normalizes them the same way whatever their origin.
//   push   -> the device/gateway calls us (implemented: lib/engine/ingest.ts + /api/push)
//   pull   -> we poll a remote API on a schedule (not implemented yet)
//   upload -> a user uploads a CSV whose rows become messages (lib/engine/upload.ts)
import { parseCsv } from "./csv";
import type { Source } from "./sources";

export type ConnectorKind = "push" | "pull" | "upload" | "manual";

export type RawMessage = Record<string, unknown>;

export interface Connector {
  kind: ConnectorKind;
  /** Turns whatever the connector received into raw messages. */
  messages(source: Source, input: unknown): Promise<RawMessage[]> | RawMessage[];
}

export class ConnectorError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Push: the request body is one message or an array of messages. */
export const pushConnector: Connector = {
  kind: "push",
  messages(_source, body) {
    const items = Array.isArray(body) ? body : [body];
    for (const m of items) {
      if (!m || typeof m !== "object" || Array.isArray(m)) throw new ConnectorError(400, "each message must be a JSON object");
    }
    return items as RawMessage[];
  },
};

/**
 * How an upload source reads its files, kept in sources.config: `mapping` names the message
 * field of each CSV column (unmapped columns are dropped) and `fixed` adds the same fields to
 * every row (e.g. which register the file belongs to).
 */
export interface UploadConfig {
  mapping: Record<string, string>;
  fixed?: Record<string, unknown>;
}

export const uploadConfig = (source: Source): UploadConfig => {
  const c = source.config as Partial<UploadConfig>;
  return { mapping: c.mapping && typeof c.mapping === "object" ? c.mapping : {}, fixed: c.fixed ?? {} };
};

/**
 * Upload: the input is CSV text, or a table already read from a file (see extract.ts); one message
 * per data row, through the source's mapping.
 */
export const uploadConnector: Connector = {
  kind: "upload",
  messages(source, input) {
    const { text, table, maxRows = Infinity } = (input ?? {}) as { text?: unknown; table?: { headers: string[]; rows: string[][] }; maxRows?: number };
    let csv;
    if (table) {
      if (table.rows.length > maxRows) throw new ConnectorError(413, `more than ${maxRows} rows`);
      csv = table;
    } else {
      if (typeof text !== "string") throw new ConnectorError(400, "expected CSV text or a table");
      try {
        csv = parseCsv(text, maxRows);
      } catch (e) {
        if (e instanceof RangeError) throw new ConnectorError(413, e.message);
        throw new ConnectorError(400, (e as Error).message);
      }
    }
    const { mapping, fixed } = uploadConfig(source);
    const columns = csv.headers.map((h) => mapping[h] || null);
    if (!columns.some(Boolean)) throw new ConnectorError(422, "no column of the file is mapped");
    return csv.rows.map((cells) => {
      const m: RawMessage = { ...fixed };
      columns.forEach((field, i) => {
        const v = cells[i]?.trim();
        if (field && v) m[field] = v;
      });
      return m;
    });
  },
};
