// The transport kit imports its own files without extensions (`./promptTemplates`).
// Webpack resolves that; Node's ESM resolver does not. §10 keeps the kit unchanged, so
// the accommodation lives here, in test-only code, rather than in the kit.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') && !/\.[cm]?jsx?$/.test(specifier)) {
      return next(`${specifier}.js`, context);
    }
    throw err;
  }
}
