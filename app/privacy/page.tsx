import fs from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';
import { renderMarkdown } from '@/lib/miniMarkdown';
import styles from './privacy.module.css';

/**
 * Public Privacy Policy, linked from the iOS app (AppLinks.privacyPolicy) and
 * required by App Store guideline 5.1.1.
 *
 * The text lives in docs/privacy-policy.md (owner-reviewed DRAFT) and is
 * rendered here by lib/miniMarkdown.ts. `force-static` makes Next prerender the
 * page at `next build`, so the Markdown is read once during the build and the
 * finished HTML ships inside .next/ — the running Fly container never needs
 * docs/ on disk. If the file is missing at build time the build fails loudly
 * rather than serving a broken policy. (The Docker build context must include
 * the file; see the docs/privacy-policy.md exception in .dockerignore.)
 *
 * This route is outside middleware.ts's `/api/:path*` matcher, so it is served
 * without a session JWT by design.
 */
export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Privacy Policy — Vital',
  description: 'How Vital collects, uses, and protects your health and fitness data.',
};

export default function PrivacyPage() {
  const markdown = fs.readFileSync(path.join(process.cwd(), 'docs', 'privacy-policy.md'), 'utf8');
  return (
    <main className={styles.page}>
      <article className={styles.doc} dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown) }} />
    </main>
  );
}
