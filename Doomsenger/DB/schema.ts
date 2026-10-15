import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

// Аккаунты мессенджера
export const accounts = pgTable("accounts", {
  id: serial().primaryKey(),
  email: text().notNull().unique(),
  // Пароль больше не нужен: вход по коду из SMS
  passwordHash: text("password_hash").notNull().default(""),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  phone: text().notNull().default(""),
  gender: text().notNull().default(""),
  dob: text().notNull().default(""),
  nick: text().notNull().default(""),
  about: text().notNull().default(""),
  photo: text().notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// Сессии: токен хранится в браузере, пока пользователь не выйдет
export const sessions = pgTable("sessions", {
  token: text().primaryKey(),
  accountId: integer("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
});

// Коды подтверждения из SMS: один действующий код на номер
export const phoneCodes = pgTable("phone_codes", {
  phone: text().primaryKey(),
  codeHash: text("code_hash").notNull(),
  attempts: integer().notNull().default(0),
  expiresAt: timestamp("expires_at").notNull(),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
});
