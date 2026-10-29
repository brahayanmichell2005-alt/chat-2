import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { getLogger } from "./logger.js";

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, "NOT_FOUND", `Ruta no encontrada: ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const correlationId = String(req.id ?? "");
  if (err instanceof ZodError) {
    res.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Datos inválidos",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      correlationId,
    });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ code: err.code, message: err.message, details: err.details, correlationId });
    return;
  }
  if (err?.name === "MulterError") {
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    res.status(tooBig ? 413 : 400).json({ code: tooBig ? "FILE_TOO_LARGE" : "UPLOAD_ERROR", message: tooBig ? "El archivo supera el máximo de 5 MB" : "Error al subir el archivo", correlationId });
    return;
  }
  // JSON mal formado u otros errores de body-parser
  if (typeof err?.status === "number" && err.status >= 400 && err.status < 500 && err.type) {
    res.status(err.status).json({ code: "BAD_REQUEST", message: "Solicitud inválida", correlationId });
    return;
  }
  getLogger().error({ err, correlationId }, "Error no controlado");
  res.status(500).json({ code: "INTERNAL_ERROR", message: "Error interno del servidor", correlationId });
};
