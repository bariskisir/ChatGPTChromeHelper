/** Small defensive helpers for parsing unknown payloads and normalizing errors. */
import type { ErrorResult, Result } from './types';

/** Coerces unknown values into safe record objects for defensive parsing. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Converts unknown error values into readable fallback strings. */
export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return fallback;
}

/** Converts an unknown error into the standard extension error result shape. */
export function toErrorResult(error: unknown): ErrorResult {
  return { ok: false, error: getErrorMessage(error) };
}

/** Throws when a typed result object represents an error instead of success data. */
export function unwrapResult<T extends object>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(result.error);
  }

  return result;
}
