import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { DomainError } from './errors';

type Params = Record<string, string>;

type Handler<P extends Params = Params> = (
  req: Request,
  ctx: { params: P },
) => Promise<Response>;

/**
 * Wraps a route handler. Maps DomainError → JSON+status, ZodError → 400,
 * everything else → 500. Generic over the params shape so routes that take
 * `[id]` can declare `withErrors<{ id: string }>(...)` and avoid the
 * `string | undefined` from `noUncheckedIndexedAccess`.
 */
export function withErrors<P extends Params = Params>(handler: Handler<P>): Handler<P> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof DomainError) {
        return NextResponse.json(
          { error: err.code, message: err.message },
          { status: err.status },
        );
      }
      if (err instanceof ZodError) {
        return NextResponse.json(
          {
            error: 'VALIDATION',
            message: 'Invalid request body.',
            issues: err.flatten(),
          },
          { status: 400 },
        );
      }
      console.error('[api] unhandled error', err);
      return NextResponse.json(
        { error: 'INTERNAL', message: 'Unexpected server error.' },
        { status: 500 },
      );
    }
  };
}
