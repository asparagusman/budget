/**
 * A best-effort, human-readable guess at the device from its User-Agent —
 * good enough as a default label. The operator can always rename it to
 * something more useful ("Lachlan's iPhone") via `PATCH /credentials/:id`.
 *
 * @param {string | undefined} userAgent
 */
export function guessDeviceName(userAgent) {
  if (!userAgent) return "Unnamed device";
  if (/iphone/i.test(userAgent)) return "iPhone";
  if (/ipad/i.test(userAgent)) return "iPad";
  if (/android/i.test(userAgent)) return "Android device";
  if (/macintosh|mac os x/i.test(userAgent)) return "Mac";
  if (/windows/i.test(userAgent)) return "Windows PC";
  if (/linux/i.test(userAgent)) return "Linux device";
  return "Unnamed device";
}
