export type AppError = {
  code: string;
  message: string;
  detail?: string;
};

export type AppResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };
