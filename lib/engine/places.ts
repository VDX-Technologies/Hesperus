import type { TenantDb } from "./db";

export type PlaceKind = "site" | "area";

export interface Place {
  id: string;
  kind: PlaceKind;
  name: string;
  parentId: string | null;
  children: Place[];
}

const typeId = (db: TenantDb, kind: PlaceKind) =>
  db.shared.query<{ id: string }>(
    `select id from object_types where module = 'core' and key = $1 and tenant_id is null`, [kind],
  ).then((r) => r.rows[0].id);

export async function createPlace(db: TenantDb, p: { kind: PlaceKind; name: string; parentId?: string | null }): Promise<string> {
  if (p.kind === "area" && !p.parentId) throw new Error("an area needs a parent place");
  const { rows } = await db.query<{ id: string }>(
    `insert into objects (tenant_id, type_id, name) values ($1, $2, $3) returning id`,
    [db.tenantId, await typeId(db, p.kind), p.name.trim()],
  );
  if (p.kind === "area") await movePlace(db, rows[0].id, p.parentId!);
  return rows[0].id;
}

export async function renamePlace(db: TenantDb, id: string, name: string): Promise<void> {
  await db.query(
    `update objects set name = $3 where tenant_id = $1 and id = $2
       and type_id in (select id from object_types where module = 'core' and key in ('site', 'area'))`,
    [db.tenantId, id, name.trim()],
  );
}

export async function movePlace(db: TenantDb, id: string, parentId: string): Promise<void> {
  await db.query(
    `insert into links (tenant_id, type, src_id, dst_id) values ($1, 'part_of', $2, $3)
     on conflict (src_id) where type = 'part_of' do update set dst_id = excluded.dst_id`,
    [db.tenantId, id, parentId],
  );
}

export async function deletePlace(db: TenantDb, id: string): Promise<void> {
  const parent = (await db.query<{ dst_id: string }>(
    `select dst_id from links where tenant_id = $1 and type = 'part_of' and src_id = $2`, [db.tenantId, id],
  )).rows[0]?.dst_id ?? null;
  if (parent)
    await db.query(
      `update links set dst_id = $3 where tenant_id = $1 and dst_id = $2 and type in ('part_of', 'located_in')`,
      [db.tenantId, id, parent],
    );
  await db.query(
    `delete from objects where tenant_id = $1 and id = $2
       and type_id in (select id from object_types where module = 'core' and key in ('site', 'area'))`,
    [db.tenantId, id],
  );
}

export async function setObjectPlace(db: TenantDb, objectId: string, placeId: string | null): Promise<void> {
  if (!placeId) {
    await db.query(`delete from links where tenant_id = $1 and type = 'located_in' and src_id = $2`, [db.tenantId, objectId]);
    return;
  }
  await db.query(
    `insert into links (tenant_id, type, src_id, dst_id) values ($1, 'located_in', $2, $3)
     on conflict (src_id) where type = 'located_in' do update set dst_id = excluded.dst_id`,
    [db.tenantId, objectId, placeId],
  );
}

export async function placeTree(db: TenantDb): Promise<Place[]> {
  const { rows } = await db.query<{ id: string; kind: PlaceKind; name: string | null; parent: string | null }>(
    `select o.id, t.key kind, o.name, l.dst_id parent
     from objects o join object_types t on t.id = o.type_id
     left join links l on l.tenant_id = o.tenant_id and l.type = 'part_of' and l.src_id = o.id
     where o.tenant_id = $1 and t.module = 'core' and t.key in ('site', 'area')
     order by t.key desc, o.name`,
    [db.tenantId],
  );
  const byId = new Map<string, Place>(
    rows.map((r) => [r.id, { id: r.id, kind: r.kind, name: r.name ?? "", parentId: r.parent, children: [] }]),
  );
  const roots: Place[] = [];
  for (const p of byId.values()) {
    const parent = p.parentId ? byId.get(p.parentId) : undefined;
    (parent ? parent.children : roots).push(p);
  }
  return roots;
}

export function flattenPlaces(tree: Place[], path: string[] = []): { place: Place; path: string[] }[] {
  return tree.flatMap((p) => [{ place: p, path: [...path, p.name] }, ...flattenPlaces(p.children, [...path, p.name])]);
}
