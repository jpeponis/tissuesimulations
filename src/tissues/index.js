// src/tissues/index.js — registry of tissue definitions (docs/EXTENDING.md).
// tools/build_single.mjs bundles src/tissues/*.js with this file last, so it
// may only import from sibling tissue files (one-line local imports).
import { TISSUE_FIBROUS } from './fibrous.js';
import { TISSUE_CARTILAGE } from './cartilage.js';

export const TISSUES = Object.freeze({
  fibrous: TISSUE_FIBROUS,
  cartilage: TISSUE_CARTILAGE,
});

export const TISSUE_DEFAULT = 'fibrous';
