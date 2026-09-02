import Anthropic from '@anthropic-ai/sdk';

/**
 * Isolated in its own module so coach.test.ts can mock this one relative
 * specifier instead of '@anthropic-ai/sdk' itself — under this project's
 * test invocation (`node --import tsx --experimental-test-module-mocks
 * --test`), a bare package specifier mocked via mock.module() does not
 * reliably intercept a *nested* module's static import of that same
 * package (verified against this exact flag order); a relative specifier
 * does.
 */
export const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
