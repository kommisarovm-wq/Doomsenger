import type { Config } from "@netlify/functions";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { accounts, phoneCodes, sessions } from "../../db/schema.js";

const CODE_TTL_MS = 5 * 60_000; // код действует 5 минут
const RESEND_MS = 60_000; // повторная отправка — не чаще раза в минуту
const MAX_ATTEMPTS = 5;

// Номер приводится к виду +79991234567 (8… и 10 цифр считаем российскими)
function normalizePhone(value: unknown) {
  let digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : "";
}

// Поиск аккаунта по номеру, в том числе записанному при регистрации в другом формате
async function accountByPhone(phone: string) {
  const digits = phone.slice(1);
  const variants = digits.startsWith("7") ? [digits, `8${digits.slice(1)}`, digits.slice(1)] : [digits];
  const [account] = await db
    .select()
    .from(accounts)
    .where(inArray(sql`regexp_replace(${accounts.phone}, '\\D', '', 'g')`, variants))
    .limit(1);
  return account ?? null;
}

const hashCode = (phone: string, code: string) => createHash("sha256").update(`${phone}:${code}`).digest("hex");

// Отправка SMS через SMS.ru
async function sendSms(phone: string, text: string) {
  const apiId = process.env.SMSRU_API_ID;
  if (!apiId) throw new Error("SMS-сервис не настроен");
  const params = new URLSearchParams({ api_id: apiId, to: phone.slice(1), msg: text, json: "1" });
  const res = await fetch(`https://sms.ru/sms/send?${params}`);
  const data = await res.json().catch(() => null);
  const status = data?.sms?.[phone.slice(1)];
  if (data?.status !== "OK" || status?.status !== "OK") {
    console.error("SMS.ru:", data?.status_text || status?.status_text || res.status);
    throw new Error("Не удалось отправить SMS");
  }
}

// Проверка кода: при успехе код удаляется, при ошибке считаются попытки
async function verifyCode(phone: string, code: string) {
  const [row] = await db.select().from(phoneCodes).where(eq(phoneCodes.phone, phone));
  if (!row || row.expiresAt.getTime() < Date.now() || row.attempts >= MAX_ATTEMPTS) {
    return "Код устарел — запросите новый";
  }
  const expected = Buffer.from(row.codeHash, "hex");
  const actual = Buffer.from(hashCode(phone, code), "hex");
  if (!/^\d{4,6}$/.test(code) || !timingSafeEqual(expected, actual)) {
    await db.update(phoneCodes).set({ attempts: row.attempts + 1 }).where(eq(phoneCodes.phone, phone));
    return "Неверный код";
  }
  await db.delete(phoneCodes).where(eq(phoneCodes.phone, phone));
  return null;
}

// Данные аккаунта, которые можно отдавать в браузер (без пароля)
function publicAccount(a: typeof accounts.$inferSelect) {
  return {
    email: a.email,
    firstName: a.firstName,
    lastName: a.lastName,
    phone: a.phone,
    gender: a.gender,
    dob: a.dob,
    nick: a.nick,
    about: a.about,
    photo: a.photo,
  };
}

async function createSession(accountId: number) {
  const token = randomBytes(32).toString("hex");
  await db.insert(sessions).values({ token, accountId });
  return token;
}

function bearer(req: Request) {
  const header = req.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

async function accountByToken(token: string) {
  if (!token) return null;
  const [row] = await db
    .select({ account: accounts })
    .from(sessions)
    .innerJoin(accounts, eq(sessions.accountId, accounts.id))
    .where(eq(sessions.token, token));
  return row?.account ?? null;
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const error = (message: string, status: number) => Response.json({ error: message }, { status });

export default async (req: Request) => {
  const action = new URL(req.url).pathname.replace(/^\/api\//, "");

  // Отправка кода подтверждения на телефон (для входа или регистрации)
  if (action === "auth/code" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const phone = normalizePhone(body.phone);
    if (!phone) return error("Введите номер телефона полностью", 400);

    const account = await accountByPhone(phone);
    if (body.purpose === "register" && account) return error("Аккаунт с этим номером уже есть — войдите", 409);
    if (body.purpose !== "register" && !account) return error("Аккаунт с этим номером не найден", 404);

    const [previous] = await db.select().from(phoneCodes).where(eq(phoneCodes.phone, phone));
    if (previous && Date.now() - previous.sentAt.getTime() < RESEND_MS) {
      return error("Код уже отправлен — новый можно запросить через минуту", 429);
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    try {
      await sendSms(phone, `doomsenger: ваш код ${code}`);
    } catch (e) {
      return error((e as Error).message, 502);
    }
    const values = { codeHash: hashCode(phone, code), attempts: 0, expiresAt: new Date(Date.now() + CODE_TTL_MS), sentAt: new Date() };
    await db.insert(phoneCodes).values({ phone, ...values }).onConflictDoUpdate({ target: phoneCodes.phone, set: values });
    return Response.json({ phone });
  }

  // Регистрация: данные анкеты + код из SMS
  if (action === "auth/register" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const email = str(body.email).toLowerCase();
    const phone = normalizePhone(body.phone);
    const firstName = str(body.firstName, 64);
    const lastName = str(body.lastName, 64);
    if (!email.includes("@") || !firstName || !lastName || !phone) return error("Заполните все поля", 400);

    const [existing] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, email));
    if (existing) return error("Аккаунт с этой почтой уже есть — войдите", 409);
    if (await accountByPhone(phone)) return error("Аккаунт с этим номером уже есть — войдите", 409);

    const codeError = await verifyCode(phone, str(body.code, 6));
    if (codeError) return error(codeError, 400);

    const [account] = await db
      .insert(accounts)
      .values({
        email,
        firstName,
        lastName,
        phone,
        gender: str(body.gender, 16),
        dob: str(body.dob, 10),
        nick: `${firstName} ${lastName}`,
      })
      .returning();
    return Response.json({ token: await createSession(account.id), user: publicAccount(account) }, { status: 201 });
  }

  // Вход: номер телефона + код из SMS
  if (action === "auth/login" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const phone = normalizePhone(body.phone);
    const account = phone ? await accountByPhone(phone) : null;
    if (!account) return error("Аккаунт с этим номером не найден", 404);
    const codeError = await verifyCode(phone, str(body.code, 6));
    if (codeError) return error(codeError, 401);
    return Response.json({ token: await createSession(account.id), user: publicAccount(account) });
  }

  // Выход: удаляем сессию
  if (action === "auth/logout" && req.method === "POST") {
    const token = bearer(req);
    if (token) await db.delete(sessions).where(eq(sessions.token, token));
    return new Response(null, { status: 204 });
  }

  // Текущий аккаунт
  if (action === "me") {
    const account = await accountByToken(bearer(req));
    if (!account) return error("Нужно войти", 401);

    if (req.method === "GET") return Response.json({ user: publicAccount(account) });

    // Изменение профиля: ник, «о себе», фото
    if (req.method === "PATCH") {
      const body = await req.json().catch(() => ({}));
      const changes: Partial<typeof accounts.$inferInsert> = {};
      if (typeof body.nick === "string" && body.nick.trim()) changes.nick = str(body.nick, 32);
      if (typeof body.about === "string") changes.about = str(body.about, 2000);
      if (typeof body.photo === "string") {
        if (body.photo && !body.photo.startsWith("data:image/")) return error("Неверное фото", 400);
        if (body.photo.length > 1_000_000) return error("Фото слишком большое", 413);
        changes.photo = body.photo;
      }
      if (!Object.keys(changes).length) return Response.json({ user: publicAccount(account) });
      const [updated] = await db.update(accounts).set(changes).where(eq(accounts.id, account.id)).returning();
      return Response.json({ user: publicAccount(updated) });
    }
  }

  return error("Не найдено", 404);
};

export const config: Config = {
  path: ["/api/auth/code", "/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/me"],
};
