import { isPublishableNotionState } from './notion-content-sync.js';

// Blob records created before the Notion state gate can still have the old
// `status: 'published'` flag. Once a record is tied to a Notion page, its
// current mirrored editorial state is authoritative; otherwise a generated or
// review-only record could remain public until a later sync happens to rewrite
// it. Historical records without Notion provenance retain the legacy status
// rule, so this does not withdraw unrelated archived publications.
export function isPublicArticle(article) {
  if (article?.public === false || article?.status !== 'published') return false;
  const notionPageId = String(article?.notion?.pageId || '').trim();
  return !notionPageId || isPublishableNotionState(article.notion?.state);
}
