import { describe, expect, it } from "vitest";
import { saveObjectForm, saveObjectTypeForm } from "@/lib/object-forms";
import type { TenantDb } from "@/lib/engine/db";
import type { Author } from "@/lib/engine/manual";

const owner: Author = { id: "owner", email: "owner@example.test", role: "owner" };
const viewer: Author = { id: "viewer", email: "viewer@example.test", role: "viewer" };
const unusedDb = {} as TenantDb;

describe("shared object form validation", () => {
  it("rejects malformed type definitions without writing", async () => {
    const form = new FormData();
    form.set("definition", "{");
    await expect(saveObjectTypeForm(unusedDb, owner, form)).resolves.toEqual({ state: { error: "invalid definition" } });
  });

  it("rejects viewers before looking up an object type", async () => {
    const form = new FormData();
    form.set("type", "custom.example");
    await expect(saveObjectForm(unusedDb, viewer, form)).resolves.toEqual({ state: { error: "manualErr_403" } });
  });
});
