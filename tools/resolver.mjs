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
