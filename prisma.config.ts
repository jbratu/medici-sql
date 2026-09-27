import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // Prisma CLI only (db push / migrate diff). The runtime client resolves
    // its URL in src/database/client.ts (env MEDICI_SQL_DATABASE_URL).
    url: process.env.MEDICI_SQL_DATABASE_URL ?? "file:./medici-sql.db",
  },
});
