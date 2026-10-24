// Where the shared register views lead inside Research: its own pages, never another console's.
import type { ObjectPaths } from "@/components/registers/objects-view";

export const researchPaths = (slug: string): ObjectPaths => ({
  types: `/research/o/${slug}/types`,
  objects: (x) => `/research/o/${slug}/objects/${encodeURIComponent(x)}`,
  editType: (key) => `/research/o/${slug}/types/edit${key ? `?key=${key}` : ""}`,
});
