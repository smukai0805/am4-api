export function isPublicArticle(article) {
  return article?.public !== false && article?.status === 'published';
}
