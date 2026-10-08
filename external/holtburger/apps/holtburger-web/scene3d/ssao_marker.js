// scene3d/ssao_marker.js — the one uniform terrain_grass.js and ssao.js share
// (2026-10-07). Dense grass blades are a field of thin occluders, and depth-only
// AO darkened every lawn into a smudge (measured on the 1070: the whole near
// field, not just the wall feet). So while the AO composite exists the grass
// fragment writes ALPHA 0 into the HDR buffer as a marker; the composite gives
// marked pixels a fraction of the AO and puts alpha back to 1 before anything
// else reads it (the canvas is alpha:true / premultiplied — an unrestored 0
// would show the page through the grass). 0 = no composite = grass writes its
// normal alpha. A leaf module: no imports, so the grass stays three-free.
export const SSAO_GRASS_MARKER = { value: 0 };
