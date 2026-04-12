import type { ImgHTMLAttributes } from 'react';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/**
 * Static image wrapper that auto-prefixes the configured basePath.
 *
 * Use this for any local asset (e.g. `/svgs/foo.svg`, `/github.svg`) so the
 * site works both on the dev server (basePath empty) and on GitHub Pages
 * (basePath = `/agenTest`). External URLs (`http(s)://...`) are passed through
 * untouched.
 *
 * Wraps a plain <img> rather than next/image because we need static export
 * and small inline SVGs don't benefit from optimization anyway.
 */
export function Img({ src, alt = '', ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  const resolved = typeof src === 'string' && src.startsWith('/') ? `${BASE_PATH}${src}` : src;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={resolved} alt={alt} {...rest} />;
}
