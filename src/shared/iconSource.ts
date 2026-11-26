export function isPublishedIconDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1_048_576 &&
    /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon);base64,[a-z0-9+/=]+$/i.test(value)
}
