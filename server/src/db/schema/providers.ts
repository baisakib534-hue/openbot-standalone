import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Custom model providers registered from inside the deployment.
 *
 * This table is the durable half of the provider overlay. It deliberately holds the same facts
 * as a `providers.local.json` row — endpoint, key-variable NAME, default model — and never a key
 * value. A key supplied in chat is encrypted into the credentials vault under coordinates derived
 * from the provider id; this row only says where resolution should look.
 */
export const customProviders = pgTable("custom_providers", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  baseUrl: text("base_url").notNull(),
  keyVariable: text("key_variable").notNull(),
  defaultModel: text("default_model").notNull(),
  api: text("api").notNull().default("chat"),
  baseUrlVariable: text("base_url_variable").notNull(),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
