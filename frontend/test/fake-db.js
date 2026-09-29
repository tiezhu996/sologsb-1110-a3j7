// 仅供合并引擎单元测试使用的内存假 db（esbuild 将业务代码对 utils/db 的导入重定向到这里）

const stores = new Map();
function store(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name);
}

function makeTable(name) {
  const rows = () => store(name);
  return {
    toCollection() {
      return {
        primaryKeys: async () => [...rows().keys()],
      };
    },
    toArray: async () => [...rows().values()].map((v) => structuredClone(v)),
    bulkPut: async (items) => {
      for (const item of items) rows().set(item.id, structuredClone(item));
    },
    put: async (item) => rows().set(item.id, structuredClone(item)),
    delete: async (id) => rows().delete(id),
    bulkDelete: async (ids) => ids.forEach((id) => rows().delete(id)),
    clear: async () => rows().clear(),
  };
}

export const db = {
  boards: makeTable('boards'),
  chambers: makeTable('chambers'),
  lacquers: makeTable('lacquers'),
  stringings: makeTable('stringings'),
  mergeConflicts: makeTable('mergeConflicts'),
  meta: makeTable('meta'),
  async transaction(_mode, _tables, fn) {
    await fn();
  },
};

/** 测试初始化数据 / 断言用 */
export const __fake = {
  reset: () => stores.clear(),
  put: async (table, rows) => {
    for (const r of rows) store(table).set(r.id, structuredClone(r));
  },
  rows: (table) => [...store(table).values()].map((v) => structuredClone(v)),
};
