import { customType } from "drizzle-orm/pg-core";

// drizzle-orm/pg-core (0.45.x) has no built-in `bytea` column — this defines
// the minimal one. node-postgres already decodes a `bytea` column into a
// Buffer and encodes a Buffer straight back on insert, so no toDriver/
// fromDriver conversion is needed, only the dataType string.
//
// `customType` is generic but JS has no call syntax for supplying a type
// argument — same situation as `hc<ApiRoutes>` in apps/web/src/lib/api.js,
// and the same fix: the instantiation happens inside a JSDoc `@type` cast,
// where the full TS type grammar is available, and the call itself is
// untouched at runtime.
export const bytea = /** @type {typeof customType<{ data: Buffer, driverData: Buffer }>} */ (
  customType
)({
  dataType() {
    return "bytea";
  },
});
