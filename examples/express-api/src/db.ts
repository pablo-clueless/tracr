/** Stands in for a real driver. Declared as a sink in tracr.config.ts. */
export const query = (sql: string, params: unknown[]): unknown[] => {
  void sql;
  void params;
  return [];
};
