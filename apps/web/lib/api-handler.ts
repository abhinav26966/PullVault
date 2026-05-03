import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { DomainError } from './errors';

type Handler = (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>;

export function withErrors(handler: Handler): Handler {
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
