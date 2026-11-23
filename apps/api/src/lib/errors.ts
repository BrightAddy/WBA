import type { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, fields?: Record<string, string>) =>
  new AppError(400, code, message, fields);
export const unauthorized = (message = "Sign in to continue.") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "You don't have access to that.") => new AppError(403, "forbidden", message);
export const conflict = (code: string, message: string, fields?: Record<string, string>) =>
  new AppError(409, code, message, fields);
export const tooMany = (message: string) => new AppError(429, "rate_limited", message);

export function fromZod(err: ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    fields[key] ??= issue.message;
  }
  return badRequest("invalid_input", "Check the highlighted fields.", fields);
}
