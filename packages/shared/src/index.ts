import { z } from "zod";

export const PERMISSIONS = [
  "users.read", "users.write", "roles.read",
  "settings.read", "settings.write", "audit.read", "ai.manage",
  "whatsapp.read", "whatsapp.manage",
  "conversations.read_all", "conversations.read_assigned", "conversations.reply", "conversations.assign",
  "catalog.read", "catalog.write",
  "customers.read", "customers.write",
  "quotes.read", "quotes.write", "quotes.discount",
  "orders.read", "orders.write", "orders.confirm",
  "payments.read", "payments.write", "payments.verify",
  "appointments.read", "appointments.write",
  "warranties.read", "warranties.write", "warranties.decide",
  "reports.read",
] as const;
export type PermissionCode = (typeof PERMISSIONS)[number];

export const ROLE_CODES = ["admin", "supervisor", "agent"] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(12, "Mínimo 12 caracteres").max(128);

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const createUserSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(2).max(120),
  password: passwordSchema,
  roleCodes: z.array(z.enum(ROLE_CODES)).min(1),
});

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    roleCodes: z.array(z.enum(ROLE_CODES)).min(1).optional(),
    password: passwordSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Sin cambios" });

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  correlationId?: string;
}
