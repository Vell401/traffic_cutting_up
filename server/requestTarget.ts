/** Parse untrusted HTTP targets without swallowing unrelated programming errors. */
export function parseRequestTarget(target: string): URL | null {
  try {
    return new URL(target, 'http://x');
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && error.code === 'ERR_INVALID_URL') return null;
    throw error;
  }
}
