import { register } from './registry.js';
import shot from './shot.js';
import edit from './edit.js';
import storyboard from './storyboard.js';
import bible from './bible.js';
import audio from './audio.js';
import director from './director.js';
import critic from './critic.js';

[shot, edit, storyboard, bible, audio, director, critic].forEach(register);

export * from './registry.js';
