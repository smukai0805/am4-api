export function isAuthorizedCronRequest(req, secret = process.env.CRON_SECRET) {
  return Boolean(secret) && req.headers?.authorization === `Bearer ${secret}`;
}
