// Connectors bring data in. Three shapes share one contract: they yield raw messages for a
// source, and the engine archives and normalizes them the same way whatever their origin.
//   push   -> the device/gateway calls us (implemented: lib/engine/ingest.ts + /api/push)
//   pull   -> we poll a remote API on a schedule (not implemented yet)
//   upload -> a user uploads a file that is split into messages (not implemented yet)
import type { Source } from "./sources";

export type ConnectorKind = "push" | "pull" | "upload";

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
