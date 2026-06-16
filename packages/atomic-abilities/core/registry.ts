import type { AbilityFn, AbilityMeta, AbilityOpts } from "./ability.js";

/** 可选发现层：按 id 列出 / 取用能力，给数据驱动的上层用（非主路径）。 */
export interface AbilityRegistry {
  list(): AbilityMeta[];
  get<In, Out>(id: string): (input: In, opts?: AbilityOpts) => Promise<Out>;
}

export function createRegistry(abilities: AbilityFn<any, any>[]): AbilityRegistry {
  const byId = new Map(abilities.map((a) => [a.meta.id, a]));
  return {
    list: () => abilities.map((a) => a.meta),
    get<In, Out>(id: string) {
      const a = byId.get(id);
      if (!a) throw new Error(`unknown ability: ${id}`);
      return a as (input: In, opts?: AbilityOpts) => Promise<Out>;
    },
  };
}
