import { register } from './registry.js';
import shot from './shot.js';
import edit from './edit.js';
import storyboard from './storyboard.js';
import bible from './bible.js';
import audio from './audio.js';

[shot, edit, storyboard, bible, audio].forEach(register);

export * from './registry.js';
