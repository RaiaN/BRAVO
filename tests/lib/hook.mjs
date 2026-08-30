// Entry point for `node --import ./tests/lib/hook.mjs`. Registers the resolver above so
// tests can import the kit the same way the bundler does.
import { register } from 'node:module';
register('./resolver.mjs', import.meta.url);
